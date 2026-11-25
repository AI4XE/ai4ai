import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bytes, ownership } from '../../install/scope.js';
import { resolveBindingFile } from '../../install/binding.js';
import { result, validateRequest } from '../../contract/validate.js';
import { handoffOutcome } from '../../contract/states.js';
import { REQUEST_SCHEMA } from '../../contract/schema.js';
import { TOOL_DESCRIPTION, TOOL_NAME, normalizeToolCall } from '../../contract/tool.js';
import { Ai4aiStore } from '../../core/store.js';
import { activeRecord } from '../../core/journal.js';
import { currentOs, execute } from '../../core/operations.js';
import { openCodeSessionUsage, sessionActivity, sessionPointer } from '../../core/session-probe.js';
import { envValue, probeOpenCodeConfig, openCodeAutoCompact } from '../../core/config-probe.js';
import { firstVerified, verifiedTokens } from '../../core/ladder.js';
import { RetainedInput, mergeRetained } from '../../core/retained-input.js';
import { taskDelivery } from '../../core/handoff-delivery.js';
import {
  clearHandoffRequest, controlEnvelopeOperationId, readHandoffRequest, writeHandoffStatus, type ExecutorHandoffStatus,
} from '../../core/executor-request.js';
import { contextFromUsage } from '../external.js';
import type { Identity, Request, Result } from '../../contract/types.js';
import { OpenCodeJournal, openCodeResult, type OpenCodeRecord } from './journal.js';
import { OpenCodeAdapter } from './adapter.js';

const terminal = (record: OpenCodeRecord): boolean => ['completed', 'cancelled', 'failed', 'unknown'].includes(record.phase);
const latestWindow = (messages: any[]): any => messages.filter(message => message.type === 'compaction' && message.status === 'completed').at(-1);
/** The handoff window: accepted but not yet completed. */
const handoffWindow = (record: OpenCodeRecord): boolean => ['pending', 'scheduled', 'applied'].includes(record.phase);
const retainedNotice = 'AI4AI is replacing this session\'s context; this input was retained and will be delivered in the fresh context.';

/**
 * Native token accounting for one assistant message.
 *
 * OpenCode stores the figures under `tokens` (the TUI export) or `usage` (an
 * earlier shape); both carry `input`, `output`, `reasoning` and
 * `cache.{read,write}`. `used` is prompt occupancy (input + cache reads/writes);
 * generated output is deliberately excluded so thresholds stay comparable.
 */
/**
 * Pick the assistant message that carries token figures. The newest row can be
 * the in-progress turn (the status call runs inside it) and reports no tokens;
 * the most recent completed message is the truthful usage source.
 */
export function selectAssistantUsage(messages: any[]): any | undefined {
  const assistants = [...messages].reverse().filter(message => message && message.type === 'assistant');
  return assistants.find(message => (message.tokens && typeof message.tokens === 'object')
    || (message.usage && typeof message.usage === 'object')) ?? assistants[0];
}

export function openCodeMessageUsage(last: any): { model: string | null; used: number | null } {
  const model = typeof last?.modelID === 'string' ? last.modelID
    : typeof last?.model?.id === 'string' ? last.model.id : null;
  const source = last?.tokens && typeof last.tokens === 'object' ? last.tokens
    : last?.usage && typeof last.usage === 'object' ? last.usage : null;
  const cache = source?.cache && typeof source.cache === 'object' ? source.cache as Record<string, unknown> : {};
  const input = typeof source?.input === 'number' ? source.input as number : null;
  const cached = (typeof cache.read === 'number' ? cache.read as number : 0) + (typeof cache.write === 'number' ? cache.write as number : 0);
  const used = input === null ? null : verifiedTokens(input + cached);
  return { model, used };
}

/**
 * Native OpenCode plugin: same-session handoff through the plugin's own
 * compaction and synthetic-message primitives. No UI routing, no history fork.
 *
 * The setup function is separated from the OpenCode entry point so the handoff
 * semantics can be exercised by a fake host in tests without the runtime
 * package that only the native harness provides.
 */
export async function setup(ctx: any): Promise<() => void> {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  // OpenCode can serve the same plugin package from a shared cache. Prefer
  // the workspace's own `.ai4ai/binding.json` so projects never adopt each
  // other's installation.
  if (typeof ctx.location?.directory !== 'string') throw new Error('AI4AI requires a native workspace');
  const directory = await realpath(ctx.location.directory);
  const resolved = await resolveBindingFile({
    workspace: directory,
    pluginRoot: root,
    read: async (file: string) => { const raw = await bytes(file); return raw?.toString(); },
  });
  if (!resolved) throw new Error('AI4AI requires its selected-project installed binding');
  const binding = resolved.binding;
  if ((await ownership(binding.home)).owner.token !== binding.ownerToken) throw new Error('AI4AI installation ownership changed');

  const journal = new OpenCodeJournal(binding.home);
  const store = await Ai4aiStore.open(binding.home);
  const instance = randomUUID();
  const sessions = new Map<string, OpenCodeRecord>();
  const delivered = new Set<string>();
  /** Input retained after the successor delivery was already injected is replayed once. */
  const replayed = new Set<string>();
  const replayIds = new Map<string, string>();
  const missing = new Set<string>();
  const retained = new RetainedInput();
  const stop = new AbortController();
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(action: () => Promise<T>): Promise<T> => { const next = tail.then(action); tail = next.catch(() => undefined); return next; };

  const identity = (sessionID: string, messages: any[]): Identity => {
    const window = latestWindow(messages);
    // A served headless executor sets AI4AI_OPENCODE_SURFACE; the interactive
    // TUI leaves it unset and keeps `tui`. Never claim a surface without the
    // native signal.
    const surface = process.env.AI4AI_OPENCODE_SURFACE === 'headless' ? 'headless' : 'tui';
    return {
      harness: 'opencode', workspace: binding.workspace, surface, session: sessionID,
      generation: window?.id ?? 'original', agent: sessionID,
    };
  };

  /** Mirror the executor-side outcome for the orchestrator's reconcile. */
  const publishStatus = async (record: OpenCodeRecord, extra: Partial<ExecutorHandoffStatus> = {}): Promise<void> => {
    const directory = process.env.AI4AI_EXECUTOR_DIR;
    if (!directory) return;
    const phase = record.phase === 'pending' ? 'intent' : record.phase;
    await writeHandoffStatus(directory, {
      format: 2, kind: 'handoff-status', operationId: record.operationId,
      phase: phase as ExecutorHandoffStatus['phase'],
      mechanism: record.proofMechanism === 'native-compaction' ? 'native-compaction' : 'surface-replacement',
      source: record.source,
      ...(record.successor ? { successor: record.successor, session: record.successor.session, generation: record.successor.generation } : {}),
      reason: record.reason,
      ...extra,
      updatedAt: new Date().toISOString(),
    }).catch(() => undefined);
  };

  /** Consume a durable executor-target handoff request before the model turn. */
  const intakeExternal = async (sessionID: string): Promise<boolean> => {
    const directory = process.env.AI4AI_EXECUTOR_DIR;
    if (!directory) return false;
    const request = await readHandoffRequest(directory);
    if (!request) return false;
    const messages = await ctx.session.context({ sessionID });
    const caller = identity(sessionID, messages);
    const out = await journal.request(caller, {
      operation: 'handoff', operationId: request.operationId, target: 'self', mode: request.mode,
      ...(request.task !== undefined ? { task: request.task } : {}),
    });
    if (out.record) {
      sessions.set(sessionID, out.record);
      await publishStatus(out.record);
      const scheduled = await journal.transition(caller, out.record.operationId, ['pending'], 'scheduled', 'External executor-target handoff accepted; the native transition is scheduled for the idle boundary');
      sessions.set(sessionID, scheduled);
      await publishStatus(scheduled);
    }
    await clearHandoffRequest(directory);
    return true;
  };

  /**
   * Recover the active record for a session after a plugin reload. The journal
   * key does not include the generation, so no native context call is needed.
   */
  const recordFor = async (sessionID: string): Promise<OpenCodeRecord | undefined> => {
    const known = sessions.get(sessionID);
    if (known) return known;
    if (missing.has(sessionID)) return undefined;
    const rows = await journal.rows(identity(sessionID, []));
    const active = activeRecord(rows, record => terminal(record));
    if (active) sessions.set(sessionID, active);
    else missing.add(sessionID);
    return active;
  };

  const external = async (request: Request, caller: Identity): Promise<Result> => execute(request, {
    home: binding.home, identity: caller, adapter: new OpenCodeAdapter(), store,
    ...(process.env.AI4AI_EXECUTOR_ID ? { executorId: process.env.AI4AI_EXECUTOR_ID } : {}),
  });

  const status = async (request: Request, caller: Identity): Promise<Result> => {
    // Layer 1: the live native session context.
    let nativeModel: string | null = null;
    let nativeUsed: number | null = null;
    try {
      const messages = await ctx.session.context({ sessionID: caller.session });
      // The tool call runs inside the current assistant turn, so the newest
      // assistant row is still in progress and carries no token figures. Use the
      // most recent assistant message that actually reports tokens (completed
      // turn); fall back to the newest one only for the model field.
      const last = selectAssistantUsage(messages);
      const usage = openCodeMessageUsage(last);
      nativeModel = usage.model;
      nativeUsed = usage.used;
    } catch { /* the persisted layers below still apply */ }
    // Layers 2/4: the persisted session store and the model catalog/config.
    const probe = await openCodeSessionUsage(caller.workspace, caller.session).catch(() => null);
    const config = await probeOpenCodeConfig(caller.workspace).catch(() => null);
    const modelField = firstVerified<string>([
      { value: nativeModel, source: 'native' },
      { value: probe?.model ?? null, source: 'session' },
      { value: envValue('AI4AI_OPENCODE_MODEL') ?? envValue('OPENCODE_MODEL'), source: 'env' },
      { value: config?.model?.value ?? null, source: config?.model?.source ?? 'config' },
    ]);
    const usedField = firstVerified<number>([
      { value: nativeUsed, source: 'native' },
      { value: probe?.used ?? null, source: 'session' },
    ]);
    const windowField = firstVerified<number>([
      { value: probe?.window ?? null, source: 'session' },
      { value: Number(envValue('AI4AI_OPENCODE_CONTEXT_WINDOW') ?? envValue('OPENCODE_CONTEXT_WINDOW')) || null, source: 'env' },
      { value: config?.window?.value ?? null, source: config?.window?.source ?? 'config' },
    ]);
    const reasoningEffortField = firstVerified<string>([
      { value: probe?.reasoningEffort ?? null, source: 'session' },
      { value: envValue('AI4AI_OPENCODE_REASONING_EFFORT') ?? envValue('OPENCODE_REASONING_EFFORT'), source: 'env' },
      { value: config?.reasoningEffort?.value ?? null, source: config?.reasoningEffort?.source ?? 'config' },
    ]);
    const used = usedField?.value ?? null;
    const window = windowField?.value ?? null;
    const context = contextFromUsage(used, window);
    context.sources = {
      window: windowField?.source ?? null,
      used: usedField?.source ?? null,
      percent: context.percent !== null ? 'derived' : null,
    };
    // OpenCode's ceiling: the window minus compaction.buffer (or the 15%/16k
    // default); compaction.auto=false is a disabled state, not a missing value.
    const derived = openCodeAutoCompact(config?.compaction ?? null, window);
    const autoCompact = derived.autoCompact;
    const autoCompactState = derived.fieldState;
    const records = await journal.rows(caller);
    const active = activeRecord(records, record => terminal(record));
    const unavailable = [
      ...(modelField ? [] : ['model']),
      ...(window === null ? ['context.window'] : []),
      ...(used === null ? ['context.used'] : []),
    ];
    const pointer = await sessionPointer('opencode', caller.workspace, caller.session).catch(() => null);
    const activity = await sessionActivity(pointer?.path ?? null);
    const handoff = active ? handoffOutcome(active.phase) : undefined;
    return result(request, 'completed', 'Native OpenCode session status', {
      // The session is alive while it serves this call; handoff progress is
      // separate and quiescence is inferred from lastActivityAt.
      durable: true, state: 'running',
      ...(handoff?.handoff ? { handoff: handoff.handoff } : {}),
      lastActivityAt: activity,
      lastActivityAtSource: activity ? 'session' : 'unknown',
      stateSource: 'native',
      ...(pointer ? { session: pointer } : {}),
      model: modelField?.value ?? null,
      reasoningEffort: reasoningEffortField?.value ?? null,
      modelVerification: !modelField ? 'unknown' : modelField.source === 'native' || modelField.source === 'session' ? 'reported' : 'configured-only',
      verification: { model: !modelField ? 'unknown' : modelField.source === 'native' || modelField.source === 'session' ? 'reported' : 'configured-only', context: 'derived' },
      context,
      ...(autoCompact ? { autoCompact } : {}),
      fieldStates: {
        ...(reasoningEffortField ? {} : { reasoningEffort: probe?.reasoningSupported === false ? ('unsupported' as const) : ('unknown' as const) }),
        ...(autoCompact ? {} : autoCompactState ? { 'context.autoCompact': autoCompactState } : {}),
      },
      unavailable,
    });
  };

  await ctx.tool.transform((editor: any) => {
    if (editor.get('ai4ai_session')) throw new Error('AI4AI native namespace collision');
    editor.namespace({ name: 'ai4ai', description: 'AI4AI session capabilities' });
    editor.add({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      input: REQUEST_SCHEMA,
      options: { namespace: 'ai4ai', codemode: false },
      async execute(input: unknown, native: any) {
        const norm = normalizeToolCall(input, { ...(process.env.AI4AI_EXECUTOR_ID ? { executorId: process.env.AI4AI_EXECUTOR_ID } : {}) });
        if (!norm.ok) {
          return { content: JSON.stringify({
            operation: 'handoff', operationId: norm.operationId, status: 'failed', reason: norm.failure.message,
            durable: false, modelVerification: 'unknown', verification: { model: 'unknown', context: 'reported' },
            notices: [], unavailable: [],
            error: { code: norm.failure.code, message: norm.failure.message, correctedCall: norm.failure.correctedCall },
          }) };
        }
        const parsed = validateRequest(norm.request);
        if (!parsed.ok) throw new Error('AI4AI request schema/version mismatch');
        const request = parsed.value;
        native.signal?.throwIfAborted?.();
        const messages = await ctx.session.context({ sessionID: native.sessionID });
        const caller = identity(native.sessionID, messages);
        const output = await serial(async () => {
          if (request.operation === 'status' && (request.target === undefined || request.target === 'self')) return { content: JSON.stringify(await status(request, caller)) };
          if (['spawn', 'message', 'list'].includes(request.operation) || (request.target !== undefined && request.target !== 'self')) {
            return { content: JSON.stringify(await external(request, caller)) };
          }
          if (request.operation === 'capabilities') return { content: JSON.stringify(result(request, 'completed', 'OpenCode plugin declares the ai4ai session capabilities', { durable: false, capabilities: new OpenCodeAdapter().capabilities(currentOs()) })) };
          if (request.operation === 'cancel' || request.operation === 'stop') {
            const records = await journal.rows(caller);
            // Revisions accumulate: a historical pending row of a completed
            // handoff is not an owned operation to cancel.
            const prior = activeRecord(records, record => terminal(record));
            if (!prior) return { content: JSON.stringify(result(request, 'unknown', 'No owned handoff to cancel')) };
            const next = await journal.transition(caller, prior.operationId, [prior.phase as any], 'cancelled', 'Cancelled before the replacement was applied');
            // The in-memory record is what the hooks consult; a stale pending
            // record would keep retaining user input after an explicit cancel.
            sessions.set(native.sessionID, next);
            retained.clear(native.sessionID);
            return { content: JSON.stringify(openCodeResult(next, request.operation)) };
          }
          const out = await journal.request(caller, request, { messageID: native.messageID, callID: native.id });
          if (out.record) sessions.set(native.sessionID, out.record);
          return { content: JSON.stringify(out.result) };
        });
        if (norm.notices.length === 0) return output;
        try {
          const value = JSON.parse(output.content) as Record<string, unknown>;
          return { ...output, content: JSON.stringify({ ...value, notices: [...((value.notices as unknown[]) ?? []), ...norm.notices] }) };
        } catch { return output; }
      },
    });
  });

  await ctx.session.hook('prompt', (event: any) => serial(async () => {
    // The invisible wake envelope is consumed before any model input.
    if (controlEnvelopeOperationId(event.prompt?.text)) {
      try { await intakeExternal(event.sessionID); }
      catch (error) {
        // The intake must never break the turn, but a silent failure leaves the
        // durable request pending forever. Record a bounded diagnostic beside
        // the executor so reconcile can explain it.
        const dir = process.env.AI4AI_EXECUTOR_DIR;
        if (dir) {
          try {
            await writeFile(path.join(dir, 'intake-error.json'), JSON.stringify({
              at: new Date().toISOString(),
              message: String((error as { message?: unknown })?.message ?? error).slice(0, 2000),
            }, null, 2) + '\n');
          } catch { /* diagnostics must never break the turn */ }
        }
      }
      event.prompt = { ...(event.prompt ?? {}), text: '' };
      return;
    }
    const record = await recordFor(event.sessionID);
    if (!record || terminal(record)) return;
    if (event.messageID === record.deliveryID) {
      if (record.phase !== 'applied') event.prompt.text = 'AI4AI cancelled this superseded delivery.';
      return;
    }
    if (handoffWindow(record) && retained.retain(event.sessionID, event.prompt?.text)) {
      // A handoff is atomic once accepted. Hold the user's prompt out of the
      // context that is about to be replaced and deliver it in the fresh one.
      event.prompt.text = retainedNotice;
    }
  }).then(() => undefined));

  await ctx.session.hook('compaction', (event: any) => serial(async () => {
    const previous = event.result;
    const messages = await ctx.session.context({ sessionID: event.sessionID });
    const running = messages.filter((message: any) => message.type === 'compaction' && message.status === 'running');
    const record = await recordFor(event.sessionID);
    if (!record || terminal(record) || record.phase !== 'scheduled' || running.length !== 1 || running[0].id !== record.compactID) {
      // Not our scheduled compaction: keep the native result untouched.
      if (!running.some((m: any) => typeof m.id === 'string' && m.id.startsWith('msg_ai4ai_compact_'))) event.result = previous;
      else event.result = { summary: 'AI4AI compaction admission unavailable; original window retained.', native: { messages: event.messages }, metadata: { ai4aiRejected: true } };
      return;
    }
    if (record.mechanism === 'compact') {
      // Keep the harness's own summary. The task (if any) is delivered as the
      // next input; without a task the native continuation carries the work.
      event.result = previous;
      const applied = await journal.transition(record.source, record.operationId, ['scheduled'], 'applied', 'Native summary produced; successor input pending');
      sessions.set(event.sessionID, applied);
      await publishStatus(applied, { continued: true, idleAfter: false, fallbackUsed: false });
      return;
    }
    event.result = { summary: 'AI4AI compaction admission unavailable; original window retained.', native: { messages: event.messages }, metadata: { ai4aiRejected: true } };
    const applied = await journal.transition(record.source, record.operationId, ['scheduled'], 'applied', 'Native fresh window supplied; task delivery pending');
    // The in-memory record is the authority for later hooks: without this
    // update the idle hook still sees `scheduled` and never delivers the task.
    sessions.set(event.sessionID, applied);
    await publishStatus(applied);
    event.result = { summary: 'Caller requested a fresh native execution context; task is delivered separately.', native: { messages: [] }, metadata: { ai4aiMarker: record.compactID } };
  }).then(() => undefined));

  /**
   * Replay retained input after the successor adopted the handoff task. It is
   * sent as a separate synthetic message, so the task runs first and the
   * queued input follows in arrival order; the id is stable across retries.
   */
  const replayRetainedInput = async (sessionID: string, record: OpenCodeRecord): Promise<void> => {
    if (replayed.has(record.operationId)) return;
    const entries = retained.peek(sessionID);
    if (entries.length === 0) return;
    const id = replayIds.get(record.operationId)
      ?? `msg_ai4ai_retained_${record.compactID.replace(/^msg_ai4ai_compact_/, '')}`;
    replayIds.set(record.operationId, id);
    const text = `AI4AI retained user input from during the handoff. Act on it now.\n${mergeRetained(entries)}`;
    try {
      const receipt = await ctx.session.synthetic({ sessionID: record.source.session, id, delivery: 'queue', text });
      if (receipt.id !== id) throw new Error('Native delivery receipt mismatch');
      retained.clear(sessionID);
      replayed.add(record.operationId);
    } catch {
      // Keep the queue; a later idle may retry the same message id.
    }
  };

  /**
   * Deliver the handoff task when the session is about to go idle. Input
   * admitted from this hook runs in the same execution instead of the session
   * going idle, which is the documented mechanism for a queued turn.
   */
  await ctx.session.hook('experimental.idle', (event: any) => serial(async () => {
    const record = await recordFor(event.sessionID);
    if (!record) return;
    if (record.phase === 'completed') {
      // Input retained during the window is delivered after the handoff task.
      await replayRetainedInput(event.sessionID, record);
      return;
    }
    if (record.phase === 'scheduled') {
      // A handoff scheduled from a prompt/control turn runs its native
      // transition at this idle boundary, which is the safe compaction point.
      try {
        const receipt = await ctx.session.compact({ sessionID: event.sessionID, id: record.compactID, delivery: 'queue' });
        if (receipt.id !== record.compactID) throw new Error('Native compact receipt mismatch');
      } catch (error) {
        const failed = await journal.transition(record.source, record.operationId, ['scheduled'], 'failed', `Native transition could not be scheduled: ${error instanceof Error ? error.message : String(error)}`);
        sessions.set(event.sessionID, failed);
        await publishStatus(failed, { errorCode: 'opencode-transition-failed' });
      }
      return;
    }
    if (record.phase !== 'applied' || delivered.has(record.operationId)) return;
    if (record.mechanism === 'compact' && !record.request.task) {
      // No task: the native summary continues the original work and nothing is
      // delivered. Completion is the summary itself, not an adoption turn.
      const completed = await journal.transition(record.source, record.operationId, ['applied'], 'completed', 'Native compaction completed in the same loop; the original task continues with no extra message');
      sessions.set(event.sessionID, completed);
      await publishStatus(completed, { continued: true, idleAfter: false, fallbackUsed: false });
      await replayRetainedInput(event.sessionID, completed);
      return;
    }
    delivered.add(record.operationId);
    // The task goes first; retained input is replayed as its own message after
    // adoption, so the successor does not have to choose between two
    // conflicting instructions in one prompt.
    const text = taskDelivery(record.request.task ?? '', record.compactID);
    try {
      const receipt = await ctx.session.synthetic({ sessionID: record.source.session, id: record.deliveryID, delivery: 'queue', text });
      if (receipt.id !== record.deliveryID) throw new Error('Native delivery receipt mismatch');
    } catch {
      // Leave the durable record applied; reconciliation must not replay blindly.
      delivered.delete(record.operationId);
    }
  }).then(() => undefined));

  await ctx.session.hook('context', (event: any) => serial(async () => {
    const record = await recordFor(event.sessionID);
    if (!record) return;
    if (record.phase === 'applied') {
      const messages = await ctx.session.context({ sessionID: event.sessionID });
      const wasDelivered = messages.some((message: any) => message.id === record.deliveryID);
      const window = latestWindow(messages);
      const summaryMatches = record.mechanism === 'compact' || window?.id === record.compactID;
      if (wasDelivered && summaryMatches) {
        const completed = await journal.transition(record.source, record.operationId, ['applied'], 'completed', 'Successor admitted the synthetic task in the replaced window');
        sessions.set(event.sessionID, completed);
        await publishStatus(completed);
        // The task is already in the fresh window; queued input follows as a
        // separate synthetic message once the handoff is complete.
        await replayRetainedInput(event.sessionID, completed);
      }
    }
  }).then(() => undefined));

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: stop.signal, types: ['session.tool.success', 'session.compaction.failed', 'session.execution.interrupted', 'session.execution.failed'] })) {
        await serial(async () => {
          const record = await recordFor(event.data.sessionID);
          if (!record || terminal(record)) return;
          if (['session.execution.interrupted', 'session.execution.failed', 'session.compaction.failed'].includes(event.type)) {
            if (record.phase === 'pending' || record.phase === 'scheduled') {
              // The native execution (or its replacement) stopped: this is a
              // mechanism-level termination, so retained input is discarded.
              retained.clear(event.data.sessionID);
              sessions.set(event.data.sessionID, await journal.transition(record.source, record.operationId, [record.phase], 'unknown', 'Native execution stopped or failed; no delivery replay'));
            }
            return;
          }
          if (event.type === 'session.tool.success' && record.phase === 'pending' && event.data.assistantMessageID === record.sourceMessage && event.data.id === record.sourceCall) {
            const scheduled = await journal.transition(record.source, record.operationId, ['pending'], 'scheduled', 'Native paired tool success committed; queued compact');
            sessions.set(event.data.sessionID, scheduled);
            const receipt = await ctx.session.compact({ sessionID: record.source.session, id: record.compactID, delivery: 'queue' });
            if (receipt.id !== record.compactID) throw new Error('Native compact receipt mismatch');
          }
        });
      }
    } catch { /* observer ended; durable state remains for reconciliation */ }
  })();

  return () => stop.abort();
}
