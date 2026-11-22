import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { bytes, ownership } from '../../install/scope.js';
import { resolveBindingFile } from '../../install/binding.js';
import { result, validateRequest } from '../../contract/validate.js';
import { handoffOutcome } from '../../contract/states.js';
import { REQUEST_SCHEMA } from '../../contract/schema.js';
import { TOOL_DESCRIPTION, TOOL_NAME, normalizeToolRequest } from '../../contract/tool.js';
import { Ai4aiStore } from '../../core/store.js';
import { activeRecord } from '../../core/journal.js';
import { currentOs, execute } from '../../core/operations.js';
import { openCodeSessionUsage, sessionActivity, sessionPointer } from '../../core/session-probe.js';
import { probeOpenCodeConfig } from '../../core/config-probe.js';
import { firstVerified } from '../../core/ladder.js';
import { RetainedInput, mergeRetained } from '../../core/retained-input.js';
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
    return {
      harness: 'opencode', workspace: binding.workspace, surface: 'tui', session: sessionID,
      generation: window?.id ?? 'original', agent: sessionID,
    };
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
      const last = [...messages].reverse().find(message => message.type === 'assistant');
      nativeModel = last?.modelID ?? last?.model?.id ?? null;
      if (last?.usage) {
        // Prompt occupancy only: input plus cache reads/writes.
        const cache = last.usage.cache;
        const cached = cache && typeof cache === 'object'
          ? (typeof cache.read === 'number' ? cache.read : 0) + (typeof cache.write === 'number' ? cache.write : 0)
          : 0;
        const input = typeof last.usage.input === 'number' ? last.usage.input : null;
        nativeUsed = input === null ? null : input + cached;
      }
    } catch { /* report unavailable */ }
    // Layers 2/4: the persisted session store and the model catalog/config.
    const probe = await openCodeSessionUsage(caller.workspace, caller.session).catch(() => null);
    const config = await probeOpenCodeConfig(caller.workspace).catch(() => null);
    const modelField = firstVerified<string>([
      { value: nativeModel, source: 'native' },
      { value: probe?.model ?? null, source: 'session' },
      { value: config?.model?.value ?? null, source: config?.model?.source ?? 'config' },
    ]);
    const usedField = firstVerified<number>([
      { value: nativeUsed, source: 'native' },
      { value: probe?.used ?? null, source: 'session' },
    ]);
    const windowField = firstVerified<number>([
      { value: probe?.window ?? null, source: 'session' },
      { value: config?.window?.value ?? null, source: config?.window?.source ?? 'config' },
    ]);
    const reasoningEffortField = firstVerified<string>([
      { value: probe?.reasoningEffort ?? null, source: 'session' },
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
    const autoCompact = config?.autoCompact
      ? { tokens: config.autoCompact.value.tokens, ratio: config.autoCompact.value.ratio, source: config.autoCompact.source }
      : undefined;
    const records = await journal.rows(caller);
    const active = activeRecord(records, record => terminal(record));
    const unavailable = [...(modelField ? [] : ['model']), ...(window === null ? ['context.window'] : []), ...(used === null ? ['context.used'] : [])];
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
      ...(reasoningEffortField ? {} : { fieldStates: { reasoningEffort: 'unavailable' as const } }),
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
        const parsed = validateRequest(normalizeToolRequest(input));
        if (!parsed.ok) throw new Error('AI4AI request schema/version mismatch');
        const request = parsed.value;
        native.signal?.throwIfAborted?.();
        const messages = await ctx.session.context({ sessionID: native.sessionID });
        const caller = identity(native.sessionID, messages);
        return serial(async () => {
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
      },
    });
  });

  await ctx.session.hook('prompt', (event: any) => serial(async () => {
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
    event.result = { summary: 'AI4AI compaction admission unavailable; original window retained.', native: { messages: event.messages }, metadata: { ai4aiRejected: true } };
    const messages = await ctx.session.context({ sessionID: event.sessionID });
    const running = messages.filter((message: any) => message.type === 'compaction' && message.status === 'running');
    const record = await recordFor(event.sessionID);
    if (!record || terminal(record) || record.phase !== 'scheduled' || running.length !== 1 || running[0].id !== record.compactID) {
      if (!running.some((m: any) => typeof m.id === 'string' && m.id.startsWith('msg_ai4ai_compact_'))) event.result = previous;
      return;
    }
    const applied = await journal.transition(record.source, record.operationId, ['scheduled'], 'applied', 'Native fresh window supplied; task delivery pending');
    // The in-memory record is the authority for later hooks: without this
    // update the idle hook still sees `scheduled` and never delivers the task.
    sessions.set(event.sessionID, applied);
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
    if (record.phase !== 'applied' || delivered.has(record.operationId)) return;
    delivered.add(record.operationId);
    // The task goes first; retained input is replayed as its own message after
    // adoption, so the successor does not have to choose between two
    // conflicting instructions in one prompt.
    const text = `AI4AI handoff delivery ${record.compactID}. Adopt the caller-supplied task in this fresh context:\n${record.request.task ?? ''}\nNative system/security instructions remain authoritative.`;
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
      if (wasDelivered && window?.id === record.compactID) {
        const completed = await journal.transition(record.source, record.operationId, ['applied'], 'completed', 'Successor admitted the synthetic task in the replaced window');
        sessions.set(event.sessionID, completed);
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
