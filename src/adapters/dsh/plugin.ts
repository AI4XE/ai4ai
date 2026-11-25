import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { result, validateRequest } from '../../contract/validate.js';
import { handoffOutcome } from '../../contract/states.js';
import { REQUEST_SCHEMA } from '../../contract/schema.js';
import { fingerprint, sameIdentity } from '../../core/fingerprint.js';
import { Ai4aiStore } from '../../core/store.js';
import { currentOs, execute } from '../../core/operations.js';
import type { Identity, Request, Result } from '../../contract/types.js';
import { DshAdapter } from './adapter.js';
import { TOOL_DESCRIPTION, normalizeToolCall } from '../../contract/tool.js';
import { reconcileDshStatus, resolveDshStatus, type DshNativeStatus } from './status.js';
import { AI4AI_HOME_FALLBACK_NOTICE, resolveAi4aiStoreHome } from '../../core/ai4ai-home.js';
import { sessionActivity, sessionPointer } from '../../core/session-probe.js';
import { effectiveDshSelection, foldDshSelection } from '../../core/dsh-selection.js';
import { continueDelivery, taskDelivery, noTaskCompactDecision } from '../../core/handoff-delivery.js';

interface NativeMessage { id: string; role: string; content: { type: string; text?: string; id?: string; toolCallId?: string }[]; toolCallId?: string; isError?: boolean; turn?: number; step?: number; source?: { kind: string; ai4ai?: JournalRecord } }
interface NativeEvent { seq: number; type: string; time?: number; data: NativeMessage & { name?: string; message?: NativeMessage; isError?: boolean }; sourceEventSeqs?: number[] }
interface NativeSession {
  id: string; seq: number; inheritedEventCount: number;
  header: { cwd?: string; delegationDepth?: number };
  surface: { nodes: readonly number[]; contentGeneration: number; replaceGeneration: number };
  append(type: string, data: NativeMessage, options: object): NativeEvent;
}
interface NativeAgent { id: string; session: NativeSession; options: { subagentDepth?: number }; followup?(message: NativeMessage): void; ctx?: DshContext }
interface Execution { agent?: NativeAgent; signal: AbortSignal }
interface Decision { kind: string; messages: NativeMessage[] }
export interface DshContext {
  get?: (name: string) => unknown;
  /** Service reflection: reads a service without declaring it as a plugin injection. */
  reflect?: { get(name: string, required?: boolean): unknown };
  /** Dynamic dependency injection; the callback runs once the service exists. */
  inject?: (deps: string[], callback: (ctx: DshContext) => void | (() => void)) => unknown;
  compaction?: {
    compactNow(agent: NativeAgent, signal: AbortSignal, commandId: string): Promise<{ summarySeq: number; shadowedSeqs: number[]; shadowedTokenCount: number } | null>;
    /**
     * Step-boundary compaction of one surface span. Unlike `compactNow` it
     * requires an open turn (`owner: "current-turn"`), so a plugin can compact
     * inside the pre-step hook and let the running turn continue natively.
     * Present on DSH's compaction-basic engine; probed at runtime.
     */
    compactRegion?(start: number, end: number, agent: NativeAgent, signal?: AbortSignal): Promise<{ summarySeq: number; shadowedSeqs: number[]; shadowedTokenCount: number }>;
  };
  tools: { register(definition: { name: string; description: string; parameters: object; output: { schema: object; render(args: unknown, value: unknown): object[] }; execute(args: unknown, execution: Execution): Promise<unknown> }): () => void };
  sessions: { flush(session: NativeSession): Promise<boolean> };
  sessionQuery: { readSession(id: string): Promise<{ events: NativeEvent[] }> };
  on(event: 'agent/pre-step', listener: (payload: { agent: NativeAgent; signal: AbortSignal; turn?: number; step?: number }, next: () => Promise<Decision>) => Promise<Decision>): () => void;
}

interface JournalRecord {
  version: 2; operationId: string; fingerprint: string; phase: 'intent' | 'applied' | 'cancelled' | 'failed' | 'blocked';
  /** Self transition mode; absent means restart (older records). */
  mode?: 'restart' | 'compact';
  owner: Identity; boundary: number; task: string;
  proof?: { source: Identity; successor: Identity; mechanism: 'new-session' | 'surface-replacement' | 'native-compaction'; nativeEvidence: string };
  /** Explicit proof mechanism; absent on records written before 0.0.5. */
  proofMechanism?: 'surface-replacement' | 'native-compaction';
  reason?: string;
  /** Compact observations (no synthetic work is created). */
  continued?: boolean;
  idleAfter?: boolean;
  fallbackUsed?: boolean;
  /** Exact request covered by the fingerprint; keeps later parsing independent of optional fields. */
  request?: { operation: 'handoff'; operationId: string; target: 'self'; task?: string; mode?: 'restart' | 'compact'; continuation?: 'auto' | 'off' };
  /** True for a request delivered by the external control plane (executor-target). */
  external?: boolean;
}
interface Located { seq: number; record: JournalRecord }

const TOOL = 'ai4ai_session';
const SOURCE = 'ai4ai-coordination';
const rootAgent = (agent: NativeAgent): boolean => typeof agent.session.header.cwd === 'string' && agent.session.header.cwd.length > 0
  && agent.id === agent.session.id && [agent.session.header.delegationDepth ?? 0, agent.options.subagentDepth ?? 0].every(depth => depth === 0);

/** The DSH profile this process is running (`dsh web ...`, `dsh headless ...`). */
function currentDshProfile(): 'web' | 'headless' | 'tui' | undefined {
  const surface = process.env.DSH_SURFACE;
  if (surface === 'web' || surface === 'headless' || surface === 'tui') return surface;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === '--profile') {
      const next = args[index + 1];
      if (next === 'web' || next === 'headless' || next === 'tui') return next;
      continue;
    }
    if (value === 'web' || value === 'headless' || value === 'tui') return value;
  }
  return undefined;
}

interface TurnSummary { turns: number; lastTurnOutcome: 'completed' | 'failed' | 'cancelled' | null; lastTurnAt: string | null; turnStartedAt: string | null }

/**
 * The native session already records `turn/start` and `turn/end`; a self status
 * therefore has a real turn count instead of reporting the field unavailable.
 */
export function turnSummary(events: readonly NativeEvent[]): TurnSummary {
  let turns = 0;
  let lastTurnOutcome: TurnSummary['lastTurnOutcome'] = null;
  let lastTurnAt: string | null = null;
  let lastEndSeq = -1;
  let turnStartedAt: string | null = null;
  for (const event of events) {
    if (event.type === 'turn/end') {
      turns++;
      lastEndSeq = event.seq;
      const data = event.data as unknown as { reason?: { kind?: string } };
      const kind = data?.reason?.kind;
      lastTurnOutcome = kind === 'completed' ? 'completed' : kind === 'failed' ? 'failed' : kind === 'cancelled' || kind === 'canceled' ? 'cancelled' : null;
      if (typeof event.time === 'number') lastTurnAt = new Date(event.time).toISOString();
    } else if (event.type === 'turn/start') {
      turnStartedAt = typeof event.time === 'number' ? new Date(event.time).toISOString() : null;
    }
  }
  if (lastEndSeq >= 0 && events.length > 0) {
    const lastStart = [...events].reverse().find(event => event.type === 'turn/start');
    turnStartedAt = lastStart && lastStart.seq > lastEndSeq ? (typeof lastStart.time === 'number' ? new Date(lastStart.time).toISOString() : null) : null;
  }
  return { turns, lastTurnOutcome, lastTurnAt, turnStartedAt };
}

function identity(agent: NativeAgent): Identity {
  return {
    harness: 'dsh', workspace: agent.session.header.cwd ?? 'native-session-workspace',
    // The carrier argv names the profile (`dsh headless ...`) while DSH itself
    // exports no DSH_SURFACE; report the surface actually running.
    surface: currentDshProfile() === 'headless' ? 'headless' : 'web',
    session: agent.session.id, generation: String(agent.session.surface.contentGeneration), agent: agent.id,
  };
}

function journal(events: readonly NativeEvent[], session: NativeSession): Located[] {
  const records: Located[] = [];
  // After a surface replacement the applied record lives in the current
  // window but may sit below `inheritedEventCount` (which describes history
  // carried over from before the window). Surface nodes are the authoritative
  // current window, so include them explicitly; otherwise a status/requery
  // after a successful handoff would report "no handoff started".
  const surfaceNodes = new Set<number>(session.surface.nodes);
  for (const event of events) {
    if (event.seq < session.inheritedEventCount && !surfaceNodes.has(event.seq)) continue;
    if (event.type !== 'user/message' || event.data.source?.kind !== SOURCE) continue;
    const record = event.data.source.ai4ai;
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Native operation journal is malformed');
    // Prefer the request stored with the record: a caller may add optional
    // fields (reason, mode, surface, timeoutMs) that are part of the original
    // fingerprint. Older records without it fall back to the canonical shape.
    const source = record.request && typeof record.request === 'object'
      ? record.request
      : { operation: 'handoff', operationId: record.operationId, target: 'self', task: record.task };
    const request = validateRequest(source);
    if (record.version !== 2 || !request.ok || !record.owner || record.owner.session !== session.id
      || record.fingerprint !== fingerprint(request.value) || !Number.isSafeInteger(record.boundary)
      || (record.proofMechanism !== undefined && !['surface-replacement', 'native-compaction'].includes(record.proofMechanism))
      || (record.proof !== undefined && !['new-session', 'surface-replacement', 'native-compaction'].includes(record.proof.mechanism))
      || !['intent', 'applied', 'cancelled', 'failed', 'blocked'].includes(record.phase)) {
      throw new Error('Native operation journal is incompatible; no transition authorized');
    }
    records.push({ seq: event.seq, record });
  }
  // A successful native compaction that follows a compact intent is its
  // durable applied record. DSH's step-boundary API does not accept a caller
  // command id, and the no-task path must not inject an extra visible message
  // (D31/D36), so the compaction events themselves carry the proof. An intent
  // whose compaction failed is closed by an explicit failed record instead.
  const summaries = events.filter(event => event.type === 'compaction/summary');
  for (const entry of [...records]) {
    if (entry.record.phase !== 'intent' || entry.record.mode !== 'compact') continue;
    if (latest(records, entry.record.operationId)?.seq !== entry.seq) continue;
    const summary = summaries.find(event => event.seq > entry.seq);
    if (!summary) continue;
    const compactionId = (summary.data as unknown as { compactionId?: unknown }).compactionId;
    const end = events.find(event => event.type === 'compaction/end'
      && (event.data as unknown as { compactionId?: unknown }).compactionId === compactionId);
    if (!end || (end.data as unknown as { error?: unknown }).error) continue;
    const successor = { ...entry.record.owner, generation: String(Number(entry.record.owner.generation || 0) + 1) };
    const continued = Boolean(entry.record.task) || entry.record.external !== true;
    records.push({
      seq: end.seq,
      record: {
        ...entry.record, phase: 'applied',
        proof: { source: entry.record.owner, successor, mechanism: 'native-compaction', nativeEvidence: `session:${session.id}:compaction:${summary.seq}` },
        proofMechanism: 'native-compaction',
        reason: 'Native step-boundary summary produced',
        continued, idleAfter: !continued, fallbackUsed: false,
      },
    });
  }
  return records;
}

const latest = (records: readonly Located[], id: string): Located | undefined => records.findLast(entry => entry.record.operationId === id);

/**
 * INFRA-085 C: an `intent` blocks a new handoff only while it is the latest
 * revision of its operation. Historical intents superseded by applied,
 * cancelled or failed revisions must never block forever.
 */
export function hasUnresolvedIntent(records: readonly { record: Pick<JournalRecord, 'operationId' | 'phase'> }[]): boolean {
  const latestByOperation = new Map<string, string>();
  for (const entry of records) latestByOperation.set(entry.record.operationId, entry.record.phase);
  return [...latestByOperation.values()].some(phase => phase === 'intent');
}

function receipt(request: Request, record: JournalRecord, durable: boolean): Result {
  const status = record.phase === 'intent' ? 'pending' : record.phase === 'blocked' ? 'unknown' : record.phase === 'applied' ? (durable ? 'completed' : 'applied') : record.phase;
  // DSH applies the replacement in one native step, so `applied` is terminal.
  const lifecycle = handoffOutcome(record.phase, { appliedIsTerminal: true });
  return result(request, status, record.reason ?? status, {
    durable,
    state: lifecycle.state,
    ...(lifecycle.handoff ? { handoff: lifecycle.handoff } : {}),
    ...(record.proof ? { proof: record.proof } : {}),
    ...(record.proofMechanism ? { mechanism: record.proofMechanism } : {}),
    ...(record.continued !== undefined ? { continued: record.continued } : {}),
    ...(record.idleAfter !== undefined ? { idleAfter: record.idleAfter } : {}),
    ...(record.fallbackUsed !== undefined ? { fallbackUsed: record.fallbackUsed } : {}),
  });
}

function replacementSpan(session: NativeSession, events: readonly NativeEvent[], boundary: number): { selected: number[]; retained: NativeMessage[] } {
  const nodes = [...session.surface.nodes];
  while (nodes.length && ['system/message', 'developer/message'].includes(events[nodes[0]!]!.type)) nodes.shift();
  if (!nodes.length) throw new Error('No replaceable native conversation');
  const open = new Set<string>();
  const retained: NativeMessage[] = [];
  for (const seq of nodes) {
    const event = events[seq];
    if (!event || ['system/message', 'developer/message'].includes(event.type)) throw new Error('Protected or missing surface node');
    const message = event.type === 'user/message' ? event.data : event.data.message;
    if (!message) throw new Error('Unrecognized surface message');
    if (message.role === 'tool' && (!message.toolCallId || !open.delete(message.toolCallId))) throw new Error('Unpaired native tool result');
    for (const block of message.content) {
      if (block.type === 'tool-call') { if (!block.id || open.has(block.id)) throw new Error('Invalid tool call pairing'); open.add(block.id); }
      if (block.type === 'tool-result') { const id = block.toolCallId ?? block.id; if (!id || !open.delete(id)) throw new Error('Unpaired nested tool result'); }
    }
    if (event.type === 'user/message' && seq >= boundary && message.source?.kind !== SOURCE) {
      // The invisible control envelope is not user input and must never be
      // replayed into the successor context.
      const isControl = message.content.some(block => typeof block.text === 'string' && block.text.startsWith('[[ai4ai-control:handoff:'));
      if (!isControl) retained.push(message);
    }
  }
  if (open.size) throw new Error('Native tool calls remain unsettled');
  return { selected: nodes, retained };
}

/**
 * Select a compaction span the way DSH's own `/compact` does: the whole
 * compactable prefix, while keeping the newest surface node and never cutting
 * through an unanswered tool call. Returns null when there is nothing safe to
 * compact (a tiny history or a single protected node).
 */
export function compactionSpan(session: NativeSession, events: readonly NativeEvent[]): { start: number; end: number } | null {
  const surface = [...session.surface.nodes];
  if (!surface.length) return null;
  let first = 0;
  while (first < surface.length && ['system/message', 'developer/message'].includes(events[surface[first]!]?.type ?? '')) first++;
  if (surface.length - first < 2) return null;
  // Balance immediately before each surface node: the cut is safe only when no
  // tool call opened earlier is still unanswered.
  const balanced: boolean[] = [];
  const open = new Set<string>();
  for (const seq of surface) {
    balanced.push(open.size === 0);
    const event = events[seq];
    if (!event) throw new Error('Compaction span references a missing native event');
    const message = event.type === 'user/message' ? event.data : event.data.message;
    if (!message) throw new Error('Unrecognized surface message');
    if (message.role === 'tool' && (!message.toolCallId || !open.delete(message.toolCallId))) throw new Error('Unpaired native tool result');
    for (const block of message.content) {
      if (block.type === 'tool-call') { if (!block.id || open.has(block.id)) throw new Error('Invalid tool call pairing'); open.add(block.id); }
      if (block.type === 'tool-result') { const id = block.toolCallId ?? block.id; if (!id || !open.delete(id)) throw new Error('Unpaired nested tool result'); }
    }
  }
  // Retain the newest node so the compaction never replaces the whole window.
  let keep = surface.length - 1;
  while (keep > first && !balanced[keep]) keep--;
  if (keep <= first) return null;
  return { start: surface[first]!, end: surface[keep - 1]! };
}

export const name = 'ai4ai';
export const inject = ['tools', 'sessions', 'sessionQuery'];

/** DSH owns durable state and safe points; no daemon, shell or process replacement. */
export function apply(ctx: DshContext): () => void {
  let active = true;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(action: () => Promise<T>): Promise<T> => { const next = tail.then(action); tail = next.catch(() => undefined); return next; };
  const durable = async (session: NativeSession): Promise<boolean> => { try { return await ctx.sessions.flush(session) === true; } catch { return false; } };
  const snapshot = async (session: NativeSession): Promise<NativeEvent[]> => {
    const end = session.seq;
    const view = await ctx.sessionQuery.readSession(session.id);
    if (session.seq !== end || view.events.length !== end) throw new Error('Native session changed during observation; query again');
    return view.events;
  };

  const executorDirectory = process.env.AI4AI_EXECUTOR_DIR;

  /** Mirror the executor-side outcome for the orchestrator's reconcile. */
  const publishStatus = async (record: JournalRecord, extra: Record<string, unknown> = {}): Promise<void> => {
    if (!executorDirectory) return;
    const file = path.join(executorDirectory, 'handoff-status.json');
    const temporary = `${file}.${process.pid}.tmp`;
    const phase = record.phase === 'intent' ? 'intent' : record.phase;
    const status = {
      format: 2, kind: 'handoff-status', operationId: record.operationId, phase,
      mechanism: record.proofMechanism ?? 'surface-replacement',
      ...(record.proof ? { source: record.proof.source, successor: record.proof.successor, session: record.proof.successor.session, generation: record.proof.successor.generation } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
      ...(record.continued !== undefined ? { continued: record.continued } : {}),
      ...(record.idleAfter !== undefined ? { idleAfter: record.idleAfter } : {}),
      ...extra,
      updatedAt: new Date().toISOString(),
    };
    try { await writeFile(temporary, JSON.stringify(status, null, 2) + '\n'); await rename(temporary, file); }
    catch { /* status is best-effort; the journal remains */ }
  };

  /** Consume a durable executor-target request before the model turn. */
  const intakeExternal = async (agent: NativeAgent, session: NativeSession, records: readonly Located[]): Promise<Located | undefined> => {
    if (!executorDirectory) return undefined;
    let request: any;
    try { request = JSON.parse(await readFile(path.join(executorDirectory, 'handoff-request.json'), 'utf8')); }
    catch { return undefined; }
    if (!request || request.format !== 2 || request.kind !== 'handoff-request' || typeof request.operationId !== 'string') return undefined;
    const existing = latest(records, request.operationId);
    if (existing) return existing;
    const owner = identity(agent);
    if (Date.parse(String(request.deadlineAt)) < Date.now()) {
      const expired: JournalRecord = { version: 2, operationId: request.operationId, fingerprint: 'expired', phase: 'failed', owner, boundary: session.seq, task: '', reason: 'The executor-target handoff request expired before it could be applied' };
      await publishStatus(expired, { errorCode: 'handoff-timeout' });
      await rm(path.join(executorDirectory, 'handoff-request.json'), { force: true }).catch(() => undefined);
      return undefined;
    }
    const mode: 'restart' | 'compact' = request.mode === 'compact' ? 'compact' : 'restart';
    const task = typeof request.task === 'string' ? request.task : '';
    const canonical = { operation: 'handoff' as const, operationId: request.operationId, target: 'self' as const, ...(task ? { task } : {}), mode, ...(request.continuation !== undefined ? { continuation: request.continuation } : {}) };
    const record: JournalRecord = { version: 2, operationId: request.operationId, fingerprint: fingerprint(canonical), phase: 'intent', owner, boundary: session.seq, task, mode, request: canonical, external: true, reason: 'External executor-target handoff accepted; applying at the next safe step' };
    session.append('user/message', {
      id: randomUUID(), role: 'user',
      content: [{ type: 'text', text: `AI4AI external handoff ${record.operationId}: intent recorded; the next safe step applies it.` }],
      source: { kind: SOURCE, ai4ai: record },
    }, { surfaceOp: 'append' });
    await rm(path.join(executorDirectory, 'handoff-request.json'), { force: true }).catch(() => undefined);
    await publishStatus(record);
    return { seq: session.seq, record };
  };

  const disposeTool = ctx.tools.register({
    name: TOOL,
    description: TOOL_DESCRIPTION,
    parameters: REQUEST_SCHEMA,
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec): Promise<Result> {
      const norm = normalizeToolCall(args, { ...(process.env.AI4AI_EXECUTOR_ID ? { executorId: process.env.AI4AI_EXECUTOR_ID } : {}) });
      if (!norm.ok) {
        const operationId = norm.operationId;
        return {
          operation: 'handoff', operationId, status: 'failed', reason: norm.failure.message, durable: false,
          modelVerification: 'unknown', verification: { model: 'unknown', context: 'reported' }, notices: [], unavailable: [],
          error: { code: norm.failure.code, message: norm.failure.message, correctedCall: norm.failure.correctedCall },
        } as Result;
      }
      const validated = validateRequest(norm.request);
      if (!validated.ok) throw new Error(JSON.stringify(validated.issues));
      const request = validated.value;
      const agent = exec.agent;
      if (!active) return result(request, 'failed', 'Integration was unloaded');
      if (!agent || !rootAgent(agent)) return result(request, 'authorization-required', 'Native root-agent identity is required');
      const output = await serial(async (): Promise<Result> => {
        exec.signal.throwIfAborted();
        const session = agent.session;
        const caller = identity(agent);
        if (request.operation === 'capabilities') {
          return result(request, 'completed', 'DSH adapter capabilities are declared by the packaged adapter', {
            durable: false,
            capabilities: new DshAdapter().capabilities(currentOs()),
          });
        }
        const events = await snapshot(session);
        const records = journal(events, session);
        const stored = latest(records, request.operationId);
        if (request.operation === 'spawn' || request.operation === 'list' || request.operation === 'message' || request.operation === 'finish' || (request.target !== undefined && request.target !== 'self')) {
          const storeHome = resolveAi4aiStoreHome({ workspace: caller.workspace });
          const store = await Ai4aiStore.open(storeHome.home);
          const handled = await execute(request, { home: storeHome.home, identity: caller, adapter: new DshAdapter(), store, ...(process.env.AI4AI_EXECUTOR_ID ? { executorId: process.env.AI4AI_EXECUTOR_ID } : {}) });
          return storeHome.fallback ? { ...handled, notices: [...(handled.notices ?? []), AI4AI_HOME_FALLBACK_NOTICE] } : handled;
        }
        if (request.operation === 'status') {
          const native: DshNativeStatus = {};
          // Model and effort use the official projections fold, exactly like
          // the external adapter's persisted-session path.
          const selection = effectiveDshSelection(foldDshSelection(events.map(event => ({ type: event.type, data: event.data }))));
          if (selection) {
            native.model = selection.model;
            native.reasoningEffort = selection.reasoningEffort;
          }
          for (const event of events) {
            const data = event.data && typeof event.data === 'object' ? event.data as Record<string, any> : {};
            if (event.type === 'request/context') {
              if (typeof data.contextWindow === 'number') native.window = data.contextWindow;
            } else if (event.type === 'assistant/message' && data.usage && typeof data.usage === 'object') {
              const usage = data.usage as Record<string, unknown>;
              const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : null;
              if (input !== null) {
                const cached = ['cacheReadTokens', 'cacheWriteTokens'].reduce((sum, key) => sum + (typeof usage[key] === 'number' ? usage[key] as number : 0), 0);
                native.used = input + cached;
              }
            }
          }
          const profile = currentDshProfile();
          const details = await resolveDshStatus(agent.session.header.cwd ?? caller.workspace, session.id, native, process.env.DSH_HOME, profile ? { profile } : {});
          const turns = turnSummary(events);
          const base = stored
            ? receipt(request, stored.record, await durable(session))
            : result(request, 'completed', 'No handoff has been started for this session', { durable: true, state: 'running' });
          const pointer = await sessionPointer('dsh', agent.session.header.cwd ?? caller.workspace, session.id, (process.env.DSH_HOME ? { dshHome: process.env.DSH_HOME } : {})).catch(() => null);
          const activity = await sessionActivity(pointer?.path ?? null);
          const reconciled = reconcileDshStatus(base, details);
          const storeHome = resolveAi4aiStoreHome({ workspace: caller.workspace });
          return {
            ...base,
            ...(storeHome.fallback ? { notices: [...(base.notices ?? []), AI4AI_HOME_FALLBACK_NOTICE] } : {}),
            lastActivityAt: activity,
            lastActivityAtSource: activity ? 'session' : 'unknown',
            stateSource: 'native',
            ...(pointer ? { session: pointer } : {}),
            model: details.model,
            reasoningEffort: details.reasoningEffort,
            modelVerification: details.modelVerification,
            verification: { model: details.modelVerification, context: details.context.percentSource === 'native' ? 'native' : 'derived' },
            context: details.context,
            ...(details.autoCompact ? { autoCompact: details.autoCompact } : {}),
            ...(details.runtimeVersion ? { runtimeVersion: details.runtimeVersion } : {}),
            processState: 'alive',
            turns: turns.turns,
            queuedTurns: 0,
            lastTurnOutcome: turns.lastTurnOutcome,
            ...(turns.lastTurnAt ? { lastTurnAt: turns.lastTurnAt } : {}),
            ...(turns.turnStartedAt ? { turnStartedAt: turns.turnStartedAt } : {}),
            ...reconciled,
          };
        }
        if (request.operation === 'cancel' || request.operation === 'stop') {
          if (!stored) return result(request, 'unknown', 'No committed owned intent to cancel');
          if (stored.record.phase !== 'intent') return receipt(request, stored.record, await durable(session));
          const cancelled: JournalRecord = { ...stored.record, phase: 'cancelled', reason: 'Pending handoff cancelled by its native owner; no context transition performed' };
          const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'AI4AI handoff cancelled before application.' }], source: { kind: SOURCE, ai4ai: cancelled } };
          session.append('user/message', message, { surfaceOp: 'append', sourceEventSeqs: [stored.seq] });
          return { ...receipt(request, cancelled, await durable(session)) };
        }
        if (request.operation !== 'handoff' || request.target !== 'self') return result(request, 'unsupported', 'This DSH plugin implements task-seeded self-handoff; use the external control plane for executors');
        if (stored) return receipt(request, stored.record, await durable(session));
        if (hasUnresolvedIntent(records)) return result(request, 'failed', 'Another handoff is unresolved; reconcile it before requesting a transition');
        // The fingerprint covers the canonical handoff request, and the exact
        // object is stored so the pre-step parser can reproduce it byte for
        // byte regardless of optional fields on the original request.
        const mode: 'restart' | 'compact' = request.mode === 'compact' ? 'compact' : 'restart';
        const canonical = { operation: 'handoff' as const, operationId: request.operationId, target: 'self' as const, ...(request.task !== undefined ? { task: request.task } : {}), mode, ...(request.continuation !== undefined ? { continuation: request.continuation } : {}) };
        const record: JournalRecord = { version: 2, operationId: request.operationId, fingerprint: fingerprint(canonical), phase: 'intent', owner: caller, boundary: session.seq, task: request.task ?? '', mode, request: canonical };
        // The intent must exist in the native append-only journal: the
        // pre-step hook reads user/message records, and a tool result alone is
        // not a journal entry. The successor span excludes SOURCE records.
        const intent: NativeMessage = {
          id: randomUUID(), role: 'user',
          content: [{ type: 'text', text: `AI4AI handoff ${record.operationId}: intent recorded; the next safe step replaces this context.` }],
          source: { kind: SOURCE, ai4ai: record },
        };
        session.append('user/message', intent, { surfaceOp: 'append' });
        return { ...receipt(request, record, false) };
      });
      if (norm.notices.length === 0) return output;
      const merged = output as Result;
      return { ...merged, notices: [...(merged.notices ?? []), ...norm.notices] } as Result;
    },
  });

  /**
   * Resolve the native compaction service. The web profile mounts
   * compaction-basic inside isolated groups, so the plugin's own context may
   * not expose it as an injectable property; reflection and the agent-scoped
   * context are tried without the inject guard (Cordis throws
   * "cannot get property ... without inject" on a plain `ctx.get`).
   */
  let injectedCompaction: DshContext['compaction'] | undefined;
  try {
    // Optional dynamic injection: the plugin must still load on a profile that
    // mounts no compaction service, but when one exists this is the only
    // reliable access path (a plain property read throws the Cordis guard).
    ctx.inject?.(['compaction'], inner => {
      injectedCompaction = (inner as { compaction?: DshContext['compaction'] }).compaction;
      return () => { injectedCompaction = undefined; };
    });
  } catch { /* no dynamic injection in this host */ }

  const compactionService = (agent?: NativeAgent): DshContext['compaction'] | undefined => {
    if (injectedCompaction !== undefined) return injectedCompaction;
    for (const scope of [agent?.ctx, ctx]) {
      if (!scope) continue;
      try {
        const reflected = scope.reflect?.get?.('compaction');
        if (reflected !== undefined && reflected !== null) return reflected as DshContext['compaction'];
      } catch { /* try the next access path */ }
      try {
        const direct = scope.get?.('compaction');
        if (direct !== undefined && direct !== null) return direct as DshContext['compaction'];
      } catch { /* not injectable from this scope */ }
      try {
        const property = (scope as { compaction?: DshContext['compaction'] }).compaction;
        if (property !== undefined) return property;
      } catch { /* the Cordis guard rejected the direct read */ }
    }
    return undefined;
  };

  /** The successor identity of a same-session compact (generation token advances). */
  const compactSuccessor = (record: JournalRecord): Identity =>
    ({ ...record.owner, generation: String(Number(record.owner.generation || 0) + 1) });

  /** The durable applied record of one compact transition. */
  const compactApplied = (
    record: JournalRecord,
    summarySeq: number | undefined,
    how: 'step' | 'idle',
  ): JournalRecord => {
    const successor = compactSuccessor(record);
    const continued = Boolean(record.task) || (!record.external && how === 'step');
    return {
      ...record, phase: 'applied',
      proof: { source: record.owner, successor, mechanism: 'native-compaction', nativeEvidence: `session:${record.owner.session}:compaction:${summarySeq ?? 'none'}` },
      proofMechanism: 'native-compaction',
      reason: record.task
        ? 'Native summary produced; the task is delivered as the next input'
        : continued
          ? 'Native summary produced at the step boundary; the original task continues'
          : 'Native summary produced; the executor has no further work in this turn',
      continued,
      idleAfter: !continued,
      fallbackUsed: false,
    };
  };

  /**
   * Idle-boundary fallback for surfaces without a step-boundary compaction API.
   * `compactNow` is idle-only and reserves the idle phase synchronously, so the
   * call is made in the `agent/status` event itself (not after an await) —
   * otherwise a one-shot headless loop reaches quiescence first and cancels it.
   */
  const idleCompact = async (agent: NativeAgent, record: JournalRecord): Promise<void> => {
    const session = agent.session;
    const service = compactionService(agent);
    if (!service?.compactNow) {
      const failed: JournalRecord = { ...record, phase: 'failed', reason: 'This DSH surface exposes no compaction service; no compact handoff was performed' };
      session.append('user/message', { id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'AI4AI compact handoff is unavailable; the original context is retained.' }], source: { kind: SOURCE, ai4ai: failed } }, { surfaceOp: 'append' });
      await durable(session);
      await publishStatus(failed, { errorCode: 'dsh-compaction-unavailable' });
      return;
    }
    let result: { summarySeq: number; shadowedSeqs: number[]; shadowedTokenCount: number } | null;
    try { result = await service.compactNow(agent, new AbortController().signal, `ai4ai-${record.operationId}`); }
    catch (error) {
      const failed: JournalRecord = { ...record, phase: 'failed', reason: `Native compaction failed: ${error instanceof Error ? error.message : String(error)}` };
      session.append('user/message', { id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'AI4AI compact handoff failed; the original context is retained.' }], source: { kind: SOURCE, ai4ai: failed } }, { surfaceOp: 'append' });
      await durable(session);
      await publishStatus(failed, { errorCode: 'dsh-compaction-failed' });
      return;
    }
    const decision = noTaskCompactDecision({
      task: record.task,
      continuation: record.request?.continuation,
      mode: 'fallback',
      marker: `ai4ai-context-${record.operationId}`,
    });
    const appliedBase = compactApplied(record, result?.summarySeq, 'idle');
    const applied: JournalRecord = decision.delivery === null
      ? { ...appliedBase, continued: decision.continued, idleAfter: decision.idleAfter, fallbackUsed: decision.fallbackUsed, reason: 'Native summary produced; continuation disabled by the caller (the agent may stay idle)' }
      : { ...appliedBase, continued: decision.continued, idleAfter: decision.idleAfter, fallbackUsed: decision.fallbackUsed, reason: record.task ? (appliedBase.reason ?? 'Native summary produced; the task is delivered as the next input') : 'Native summary produced; the minimal conditional continuation wakes the agent' };
    if (decision.delivery === null) {
      await durable(session);
      await publishStatus(applied);
      return;
    }
    // An idle agent must be woken; appending to the surface alone does not open
    // a turn. The conditional continuation is the documented fallback for a
    // surface whose only compaction API is idle-bound.
    const delivery = decision.delivery;
    if (!agent.followup) {
      const failed: JournalRecord = { ...record, phase: 'failed', reason: 'The idle-bound compaction could not wake a new turn; the summary was produced but the task was not delivered' };
      session.append('user/message', { id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'AI4AI compact handoff could not deliver its task; the original context is retained.' }], source: { kind: SOURCE, ai4ai: failed } }, { surfaceOp: 'append' });
      await durable(session);
      await publishStatus(failed, { errorCode: 'dsh-compaction-delivery-failed' });
      return;
    }
    agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: delivery }], source: { kind: SOURCE, ai4ai: applied } });
    await durable(session);
    await publishStatus(applied);
  };

  const pendingIdleCompact = new Map<NativeAgent, JournalRecord>();

  /** The delivery message admitted as an external wake turn's only step input. */
  const deliveryMessage = (text: string, record: JournalRecord): NativeMessage => ({
    id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: SOURCE, ai4ai: record },
  });

  const disposeHook = ctx.on('agent/pre-step', async ({ agent, signal, turn, step }, next) => {
    const decision = await next();
    if (!active || decision.kind === 'reject' || !rootAgent(agent)) return decision;
    return serial(async () => {
      const session = agent.session;
      // The wake turn carries only the invisible envelope; drop it before any
      // model input so the carrier never sees the control channel.
      const isControl = (message: NativeMessage): boolean =>
        (message.content ?? []).some(block => typeof block.text === 'string' && block.text.startsWith('[[ai4ai-control:handoff:'));
      const hadControl = (decision.messages ?? []).some(isControl);
      if (hadControl) decision.messages = decision.messages.filter(message => !isControl(message));

      let events = await snapshot(session);
      let records = journal(events, session);
      if (hadControl) {
        // A durable executor-target request is inserted as an intent before the
        // normal selection, so it follows exactly the self-handoff safe path.
        await intakeExternal(agent, session, records);
        events = await snapshot(session);
        records = journal(events, session);
      }
      const pending = records.filter(entry => entry.record.phase === 'intent' && latest(records, entry.record.operationId)?.seq === entry.seq);
      if (!pending.length) return decision;
      if (pending.length !== 1) throw new Error('Ambiguous native handoff journal; no transition scheduled');
      const record = pending[0]!.record;
      if (!sameIdentity(record.owner, identity(agent))) return decision;
      if (!(await durable(session))) return decision;
      signal.throwIfAborted();
      const fresh = await snapshot(session);
      if (lastJournal(fresh, session, record.operationId) !== pending[0]!.seq) return decision;
      const before = identity(agent);
      // The same-session mechanisms keep the native session; only the
      // generation advances. A changed session would be a false success.
      if (before.session !== record.owner.session) throw new Error('DSH handoff changed the native session id; no transition scheduled');
      const successor = { ...before, session: record.owner.session, generation: String(session.surface.contentGeneration + 1) };
      const fail = async (reason: string, code: string): Promise<Decision> => {
        const failed: JournalRecord = { ...record, phase: 'failed', reason };
        session.append('user/message', {
          id: randomUUID(), role: 'user',
          content: [{ type: 'text', text: 'AI4AI handoff failed; the original context is retained.' }],
          source: { kind: SOURCE, ai4ai: failed },
        }, { surfaceOp: 'append' });
        await durable(session);
        await publishStatus(failed, { errorCode: code });
        return decision;
      };
      if (record.mode === 'compact') {
        const service = compactionService(agent);
        if (typeof service?.compactRegion === 'function') {
          // Native step-boundary compaction: the exact path automatic pressure
          // compaction uses. The running turn then continues from the summary.
          let result: { summarySeq: number; shadowedSeqs: number[]; shadowedTokenCount: number } | null = null;
          try {
            const span = compactionSpan(session, fresh);
            if (span) result = await service.compactRegion(span.start, span.end, agent, signal);
          } catch (error) {
            return fail(`Native compaction failed: ${error instanceof Error ? error.message : String(error)}`, 'dsh-compaction-failed');
          }
          const applied = compactApplied(record, result?.summarySeq, 'step');
          if (record.task) {
            const delivery = deliveryMessage(taskDelivery(record.task, `ai4ai-context-${record.operationId}`), applied);
            if (record.external && hadControl) {
              // The control wake turn would close with no step when its envelope
              // is dropped (agent-loop: step 0 with no admitted messages ends the
              // turn). The delivery becomes the step's single user input; the
              // summary is already the surface.
              decision.messages = [delivery];
            } else {
              // The running turn continues after the tool result; appending the
              // task to the surface makes it the next request's input.
              session.append('user/message', delivery, { surfaceOp: 'append' });
            }
          }
          await durable(session);
          await publishStatus(applied);
          return decision;
        }
        // No step-boundary API on this surface: defer to the idle boundary.
        pendingIdleCompact.set(agent, record);
        return decision;
      }
      // Restart: replace the surface with only the task material.
      const span = replacementSpan(session, fresh, record.boundary);
      const proofMechanism = 'surface-replacement' as const;
      const proof = { source: record.owner, successor, mechanism: proofMechanism, nativeEvidence: `session:${session.id}:event:${session.seq}` };
      const applied: JournalRecord = { ...record, phase: 'applied', proof, proofMechanism, reason: 'Fresh context applied in the same session; successor binding recorded' };
      const delivery = deliveryMessage(taskDelivery(record.task, `ai4ai-context-${record.operationId}`), applied);
      if (record.external && hadControl) {
        // An external wake turn needs one admitted message, so the old span is
        // replaced with an empty developer node (projects to no wire message;
        // assistant nodes cannot carry the replacement bookkeeping) and the
        // delivery is admitted as the step's only user input.
        const empty: NativeMessage = { id: randomUUID(), role: 'developer', content: [], source: { kind: SOURCE } };
        session.append('developer/message', { turn: turn ?? 1, step: step ?? 1, message: empty } as unknown as NativeMessage, { surfaceOp: { op: 'replace', startSeq: span.selected[0], endSeq: span.selected.at(-1) }, sourceEventSeqs: span.selected });
        decision.messages = [delivery];
      } else {
        for (const retained of span.retained) delivery.content.push({ type: 'text', text: 'Later user input (preserve and act on it):' }, ...retained.content);
        session.append('user/message', delivery, { surfaceOp: { op: 'replace', startSeq: span.selected[0], endSeq: span.selected.at(-1) }, sourceEventSeqs: span.selected });
      }
      await durable(session);
      await publishStatus(applied);
      return decision;
    }).catch(error => {
      // Never fail silently: a swallowed pre-step error used to leave the
      // durable request at `intent` with no diagnostic in any log.
      try { console.error(`[ai4ai] DSH pre-step handoff failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`); } catch { /* best effort */ }
      return decision;
    });
  });

  const disposeStatus = (ctx as any).on?.('agent/status', (payload: any) => {
    if (payload?.status !== 'idle' || !payload?.agent) return;
    const record = pendingIdleCompact.get(payload.agent as NativeAgent);
    if (!record) return;
    pendingIdleCompact.delete(payload.agent as NativeAgent);
    // Called directly (not through the serial queue) so `compactNow` reserves
    // the idle phase inside this event dispatch; a queued call would let a
    // one-shot headless loop reach quiescence and cancel the maintenance task.
    void idleCompact(payload.agent as NativeAgent, record).catch(() => undefined);
  });

  function lastJournal(events: readonly NativeEvent[], session: NativeSession, operationId: string): number | undefined {
    return latest(journal(events, session), operationId)?.seq;
  }

  return () => { active = false; disposeHook(); disposeStatus?.(); disposeTool(); };
}
