import { randomUUID } from 'node:crypto';
import { result, validateRequest } from '../../contract/validate.js';
import { handoffOutcome } from '../../contract/states.js';
import { REQUEST_SCHEMA } from '../../contract/schema.js';
import { fingerprint, sameIdentity } from '../../core/fingerprint.js';
import { Ai4aiStore } from '../../core/store.js';
import { currentOs, execute } from '../../core/operations.js';
import type { Identity, Request, Result } from '../../contract/types.js';
import { DshAdapter } from './adapter.js';
import { TOOL_DESCRIPTION, normalizeToolRequest } from '../../contract/tool.js';
import { reconcileDshStatus, resolveDshStatus, type DshNativeStatus } from './status.js';
import { sessionActivity, sessionPointer } from '../../core/session-probe.js';
import { effectiveDshSelection, foldDshSelection } from '../../core/dsh-selection.js';

interface NativeMessage { id: string; role: string; content: { type: string; text?: string; id?: string; toolCallId?: string }[]; toolCallId?: string; isError?: boolean; source?: { kind: string; ai4ai?: JournalRecord } }
interface NativeEvent { seq: number; type: string; time?: number; data: NativeMessage & { name?: string; message?: NativeMessage; isError?: boolean }; sourceEventSeqs?: number[] }
interface NativeSession {
  id: string; seq: number; inheritedEventCount: number;
  header: { cwd?: string; delegationDepth?: number };
  surface: { nodes: readonly number[]; contentGeneration: number; replaceGeneration: number };
  append(type: string, data: NativeMessage, options: object): NativeEvent;
}
interface NativeAgent { id: string; session: NativeSession; options: { subagentDepth?: number } }
interface Execution { agent?: NativeAgent; signal: AbortSignal }
interface Decision { kind: string; messages: NativeMessage[] }
export interface DshContext {
  get?: (name: string) => unknown;
  tools: { register(definition: { name: string; description: string; parameters: object; output: { schema: object; render(args: unknown, value: unknown): object[] }; execute(args: unknown, execution: Execution): Promise<unknown> }): () => void };
  sessions: { flush(session: NativeSession): Promise<boolean> };
  sessionQuery: { readSession(id: string): Promise<{ events: NativeEvent[] }> };
  on(event: 'agent/pre-step', listener: (payload: { agent: NativeAgent; signal: AbortSignal }, next: () => Promise<Decision>) => Promise<Decision>): () => void;
}

interface JournalRecord {
  version: 2; operationId: string; fingerprint: string; phase: 'intent' | 'applied' | 'cancelled' | 'failed' | 'blocked';
  owner: Identity; boundary: number; task: string;
  proof?: { source: Identity; successor: Identity; mechanism: 'new-session' | 'surface-replacement' | 'native-compaction'; nativeEvidence: string };
  /** Explicit proof mechanism; absent on records written before 0.0.5. */
  proofMechanism?: 'surface-replacement' | 'native-compaction';
  reason?: string;
  /** Exact request covered by the fingerprint; keeps later parsing independent of optional fields. */
  request?: { operation: 'handoff'; operationId: string; target: 'self'; task: string };
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
    surface: process.env.DSH_SURFACE === 'headless' ? 'headless' : 'web',
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
    if (event.type === 'user/message' && seq >= boundary && message.source?.kind !== SOURCE) retained.push(message);
  }
  if (open.size) throw new Error('Native tool calls remain unsettled');
  return { selected: nodes, retained };
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

  const disposeTool = ctx.tools.register({
    name: TOOL,
    description: TOOL_DESCRIPTION,
    parameters: REQUEST_SCHEMA,
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec): Promise<Result> {
      const validated = validateRequest(normalizeToolRequest(args));
      if (!validated.ok) throw new Error(JSON.stringify(validated.issues));
      const request = validated.value;
      const agent = exec.agent;
      if (!active) return result(request, 'failed', 'Integration was unloaded');
      if (!agent || !rootAgent(agent)) return result(request, 'authorization-required', 'Native root-agent identity is required');
      return serial(async () => {
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
          const store = await Ai4aiStore.open(process.env.DSH_HOME ?? process.cwd());
          return execute(request, { home: process.env.DSH_HOME ?? process.cwd(), identity: caller, adapter: new DshAdapter(), store, ...(process.env.AI4AI_EXECUTOR_ID ? { executorId: process.env.AI4AI_EXECUTOR_ID } : {}) });
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
          return {
            ...base,
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
        if (request.mode === 'compact') return result(request, 'unsupported', 'DSH handoff replaces the context with only the task material; a history summary (compact) is not implemented');
        if (stored) return receipt(request, stored.record, await durable(session));
        if (hasUnresolvedIntent(records)) return result(request, 'failed', 'Another handoff is unresolved; reconcile it before requesting a transition');
        // The fingerprint covers the canonical handoff request, and the exact
        // object is stored so the pre-step parser can reproduce it byte for
        // byte regardless of optional fields on the original request.
        const canonical = { operation: 'handoff' as const, operationId: request.operationId, target: 'self' as const, task: request.task! };
        const record: JournalRecord = { version: 2, operationId: request.operationId, fingerprint: fingerprint(canonical), phase: 'intent', owner: caller, boundary: session.seq, task: request.task!, request: canonical };
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
    },
  });

  const disposeHook = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next();
    if (!active || decision.kind === 'reject' || !rootAgent(agent)) return decision;
    return serial(async () => {
      const session = agent.session;
      const events = await snapshot(session);
      const pending = journal(events, session).filter(entry => entry.record.phase === 'intent' && latest(journal(events, session), entry.record.operationId)?.seq === entry.seq);
      if (!pending.length) return decision;
      if (pending.length !== 1) throw new Error('Ambiguous native handoff journal; no transition scheduled');
      const record = pending[0]!.record;
      if (!sameIdentity(record.owner, identity(agent))) return decision;
      if (!(await durable(session))) return decision;
      signal.throwIfAborted();
      const fresh = await snapshot(session);
      if (lastJournal(fresh, session, record.operationId) !== pending[0]!.seq) return decision;
      const span = replacementSpan(session, fresh, record.boundary);
      const before = identity(agent);
      // The surface replacement keeps the native session; only the generation
      // advances. A changed session here would be a false same-SID success.
      if (before.session !== record.owner.session) throw new Error('DSH handoff changed the native session id; no transition scheduled');
      const successor = { ...before, session: record.owner.session, generation: String(session.surface.contentGeneration + 1) };
      const proofMechanism = 'surface-replacement' as const;
      const proof = { source: record.owner, successor, mechanism: proofMechanism, nativeEvidence: `session:${session.id}:event:${session.seq}` };
      const applied: JournalRecord = { ...record, phase: 'applied', proof, proofMechanism, reason: 'Fresh context applied in the same session; successor binding recorded' };
      const continuation: NativeMessage = {
        id: randomUUID(), role: 'user',
        content: [{ type: 'text', text: `AI4AI handoff applied. Continue the caller-provided task in this fresh context. Native system instructions, permissions and policies still apply.\n\n${record.task}` }],
        source: { kind: SOURCE, ai4ai: applied },
      };
      for (const retained of span.retained) continuation.content.push({ type: 'text', text: 'Later user input (preserve and act on it):' }, ...retained.content);
      session.append('user/message', continuation, { surfaceOp: { op: 'replace', startSeq: span.selected[0], endSeq: span.selected.at(-1) }, sourceEventSeqs: span.selected });
      await durable(session);
      return decision;
    }).catch(() => decision);
  });

  function lastJournal(events: readonly NativeEvent[], session: NativeSession, operationId: string): number | undefined {
    return latest(journal(events, session), operationId)?.seq;
  }

  return () => { active = false; disposeHook(); disposeTool(); };
}
