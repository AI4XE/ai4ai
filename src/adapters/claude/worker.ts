/**
 * Trusted Claude journal worker. Invoked only by the in-host plugin over a
 * short-lived stdin pipe; it has no model loop, no daemon and no network.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { bytes, ownership } from '../../install/scope.js';
import { containsWorkspace, parseBinding } from '../../install/binding.js';
import { result, validateRequest } from '../../contract/validate.js';
import { handoffMode, handoffOutcome } from '../../contract/states.js';
import { fingerprint } from '../../core/fingerprint.js';
import { activeRecord } from '../../core/journal.js';
import { Ai4aiStore } from '../../core/store.js';
import { currentOs, execute } from '../../core/operations.js';
import type { Identity, Request, Result } from '../../contract/types.js';
import { ClaudeJournal, response, type ClaudeCommand, type ClaudeRecord } from './journal.js';
import { ClaudeAdapter } from './adapter.js';
import { resolveClaudeStatus } from './status.js';
import { sessionActivity, sessionPointer } from '../../core/session-probe.js';

const root = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

let input = '';
for await (const chunk of process.stdin) { input += chunk; if (input.length > 262144) throw new Error('Oversize native worker input'); }
const command = JSON.parse(input) as ClaudeCommand & { workspace?: string; caller?: Identity; bindingPath?: string };

// The plugin selects the binding per workspace. A shared plugin cache must
// never make this worker silently read another project's binding.
const requested = typeof command.bindingPath === 'string' && command.bindingPath.length > 0 ? path.resolve(command.bindingPath) : undefined;
const bindingFile = requested ?? path.join(root, 'binding.json');
const raw = await bytes(bindingFile);
if (!raw) throw new Error('Native installation binding is missing');
const binding = parseBinding(raw.toString());
await ownership(binding.home).then(owned => {
  if (owned.owner.token !== binding.ownerToken) throw new Error('Installation ownership changed');
});

if (command.action === 'binding') {
  if (typeof command.workspace !== 'string' || !containsWorkspace(binding.workspace, command.workspace)) throw new Error('Native workspace differs from the selected installation');
  console.log(JSON.stringify({ instance: randomUUID(), workspace: binding.workspace }));
  process.exit(0);
}

const caller = command.caller;
if (!caller || caller.harness !== 'claude-code' || caller.workspace !== binding.workspace || caller.agent !== 'main' || !['tui', 'headless'].includes(caller.surface)) {
  throw new Error(`Native worker scope mismatch: ${JSON.stringify({ harness: caller?.harness, workspaceMatch: caller?.workspace === binding.workspace, agent: caller?.agent, surface: caller?.surface, session: caller?.session })}`);
}

const journal = new ClaudeJournal(binding.home!);
const store = await Ai4aiStore.open(binding.home!);

async function external(request: Request): Promise<Result> {
  return execute(request, {
    home: binding.home!,
    identity: caller!,
    adapter: new ClaudeAdapter(),
    store,
    ...(process.env.AI4AI_EXECUTOR_ID ? { executorId: process.env.AI4AI_EXECUTOR_ID } : {}),
  });
}

const records = await journal.rows(caller);
const active = activeRecord(records, record => ['completed', 'cancelled', 'failed', 'unknown'].includes(record.phase));

if (command.action === 'inspect') {
  const markers = command.marker ? [command.marker] : [];
  const known = new Set([...records].flatMap(record => [record.source.generation, record.successor?.generation]).filter((value): value is string => typeof value === 'string' && markers.includes(value)));
  if (known.size > 1) throw new Error('Ambiguous current native generation; no execution authority inferred');
  console.log(JSON.stringify({
    ...(active ? { record: active } : {}),
    generation: [...known][0] ?? 'original',
    consecutive: active?.phase === 'pending' || active?.phase === 'scheduled',
  }));
  process.exit(0);
}

if (command.action === 'recover') {
  if (!active) { console.log(JSON.stringify({})); process.exit(0); }
  const recovered: ClaudeRecord = { ...active, phase: 'unknown', reason: 'Native plugin restarted with an unfinished handoff; delivery is uncertain and never replayed automatically' };
  await journal.transaction(caller, async (_rows, commit) => commit(recovered));
  console.log(JSON.stringify({ record: recovered, result: response(recovered) }));
  process.exit(0);
}

if (command.action === 'transition') {
  const latest = journal.latest(records, command.operationId ?? '');
  if (!latest) throw new Error('No owned transition');
  if (latest.marker !== command.marker) throw new Error('Transition marker mismatch');
  const allowed: Record<string, readonly string[]> = {
    scheduled: ['pending'],
    applied: ['scheduled'],
    completed: ['applied'],
    cancelled: ['pending', 'scheduled'],
    failed: ['pending', 'scheduled'],
    unknown: ['pending', 'scheduled', 'applied'],
  };
  const to = command.phase ?? 'unknown';
  if (!allowed[to]?.includes(latest.phase)) throw new Error(`Unexpected transition ${latest.phase} -> ${to}; no replay`);
  const successor = command.successor ?? { ...latest.source, generation: latest.marker };
  // A handoff never changes the native session identity; the plugin asserts
  // this too, and the journal refuses a mismatched record rather than storing
  // a false success.
  if (successor.session !== latest.source.session) throw new Error('Handoff successor changed the native session id; no transition recorded');
  const next: ClaudeRecord = {
    ...latest, phase: to, reason: command.reason ?? to,
    ...(to === 'applied'
      ? {
          successor,
          mechanism: command.mechanism ?? latest.mechanism ?? 'restart',
          proofMechanism: command.proofMechanism ?? latest.proofMechanism ?? 'surface-replacement',
        }
      : {}),
  };
  await journal.transaction(caller, async (_rows, commit) => commit(next));
  console.log(JSON.stringify({ record: next, result: response(next) }));
  process.exit(0);
}

const parsed = validateRequest(command.request);
if (!parsed.ok) throw new Error('Invalid AI4AI request: ' + parsed.issues.map(issue => issue.code).join(', '));
const request = parsed.value;
const prior = journal.latest(records, request.operationId);

if (request.operation === 'status' && (request.target === undefined || request.target === 'self')) {
  const usage = command.usage ?? {};
  const handoff = active ? handoffOutcome(active.phase) : undefined;
  // Per-field ladder shared with the external adapter: native usage >
  // transcript > environment > settings.
  const details = await resolveClaudeStatus(caller.workspace, caller.session, {
    used: usage.used,
    window: usage.window,
    model: usage.model,
    reasoningEffort: usage.reasoningEffort,
    percent: usage.percent,
  });
  const pointer = await sessionPointer('claude-code', caller.workspace, caller.session).catch(() => null);
  const activity = await sessionActivity(pointer?.path ?? null);
  const compactionDisabled = !!process.env.DISABLE_COMPACT && process.env.DISABLE_COMPACT !== '0';
  console.log(JSON.stringify({
    result: result(request, 'completed', 'Native session status', {
      durable: true,
      // A session-level limit, reported honestly without blocking status.
      ...(compactionDisabled ? { notices: [{ code: 'claude-compaction-disabled', impact: 'none' as const, action_required: false as const, message: 'Compaction is switched off in this session (DISABLE_COMPACT); the in-place restart handoff is unsupported here.' }] } : {}),
      // The session is alive while it serves this call; handoff progress is
      // reported separately, and quiescence is inferred from lastActivityAt.
      state: 'running',
      ...(handoff?.handoff ? { handoff: handoff.handoff } : {}),
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
      ...(details.fieldStates ? { fieldStates: details.fieldStates } : {}),
      unavailable: details.unavailable,
    }),
  }));
  process.exit(0);
}

if (request.operation === 'capabilities') {
  console.log(JSON.stringify({ result: result(request, 'completed', 'Claude adapter capabilities are declared by the installed plugin', { durable: false, capabilities: new ClaudeAdapter().capabilities(currentOs()) }) }));
  process.exit(0);
}

if (request.operation === 'cancel' || request.operation === 'stop') {
  if (request.target !== 'self') {
    console.log(JSON.stringify({ result: await external(request) }));
    process.exit(0);
  }
  if (!prior) { console.log(JSON.stringify({ result: result(request, 'unknown', 'No owned handoff operation to cancel') })); process.exit(0); }
  const phase = ['completed', 'cancelled', 'failed', 'unknown'].includes(prior.phase) ? prior.phase : 'cancelled';
  const next: ClaudeRecord = { ...prior, phase: phase as ClaudeRecord['phase'], reason: phase === 'cancelled' ? 'Handoff cancelled before the native replacement was applied' : prior.reason };
  if (next.phase !== prior.phase) await journal.transaction(caller, async (_rows, commit) => commit(next));
  console.log(JSON.stringify({ result: response(next, request.operation) }));
  process.exit(0);
}

if (request.operation === 'handoff' && request.target === 'self') {
  if (prior) {
    console.log(JSON.stringify({ result: prior.fingerprint === fingerprint(request) ? response(prior) : result(request, 'failed', 'Conflicting operation identifier reuse') }));
    process.exit(0);
  }
  if (active) { console.log(JSON.stringify({ result: result(request, 'failed', 'Another handoff is unresolved; reconcile it before requesting a transition') })); process.exit(0); }
  // Compaction can be switched off per session; the restart path needs it, so
  // report the limitation up front instead of failing midway.
  if (process.env.DISABLE_COMPACT && process.env.DISABLE_COMPACT !== '0') {
    console.log(JSON.stringify({ result: result(request, 'unsupported', 'Compaction is switched off in this session (DISABLE_COMPACT); the in-place restart handoff needs it', { unavailable: ['handoff.restart'], error: { code: 'claude-compaction-disabled', message: 'DISABLE_COMPACT is set for this session' } }) }));
    process.exit(0);
  }
  // This version declares restart only. `compact` means a native summary,
  // which Claude does not implement here; refuse it instead of silently
  // running the zero-summary replacement under a compact label.
  if (request.mode === 'compact') {
    console.log(JSON.stringify({ result: result(request, 'unsupported', 'Claude Code handoff implements restart only in this version; native compaction plus task delivery is not available', { unavailable: ['handoff.compact'] }) }));
    process.exit(0);
  }
  const mechanism = handoffMode(request.mode);
  if (!request.task) {
    console.log(JSON.stringify({ result: result(request, 'unsupported', 'A restart handoff needs task material: the new context contains only that material', { unavailable: ['handoff.task'] }) }));
    process.exit(0);
  }
  const marker = `ai4ai-context-${randomUUID()}`;
  const record: ClaudeRecord = {
    format: 2, operationId: request.operationId, fingerprint: fingerprint(request), request, source: caller, marker, phase: 'pending',
    mechanism,
    proofMechanism: 'surface-replacement',
    reason: 'Finish this turn; the native compact hook replaces this context in place with the caller task material (no summary model is called)',
  };
  await journal.transaction(caller, async (_rows, commit) => commit(record));
  console.log(JSON.stringify({ result: response(record), record }));
  process.exit(0);
}

// Spawn/message/list/targeted handoff are owned by the external control plane.
console.log(JSON.stringify({ result: await external(request) }));
