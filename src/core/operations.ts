import { randomUUID } from 'node:crypto';
import { derivedPercent, result, validateRequest, validateResult } from '../contract/validate.js';
import type { CapabilityDeclaration, ExecutorSummary, Request, Result } from '../contract/types.js';
import type { Adapter, AdapterContext, NativeOutcome } from '../adapters/types.js';
import { fingerprint, sameIdentity } from './fingerprint.js';
import { lifecycleOfStatus, processStateOf, readStatus } from '../adapters/executors.js';
import { livenessOf } from '../adapters/external.js';
import { queuedTurns, readTurns } from './turns.js';
import { sessionPointer } from './session-probe.js';
import { checkPolicy, normalizePolicy, ROOT_POLICY } from './policy.js';
import { guardHandoffOutcome } from './handoff.js';
import { LockBusyError } from '../install/scope.js';
import type { Ai4aiStore, ExecutorRecord, OperationRecord } from './store.js';
import type { Identity } from '../contract/types.js';
import type { Policy } from '../contract/types.js';

export interface OperationsOptions {
  home: string;
  identity: Identity;
  adapter: Adapter;
  store: Ai4aiStore;
  os?: 'linux' | 'windows' | 'darwin';
  maxSpawn?: number;
  /** Trusted executor binding from the spawn carrier environment. */
  executorId?: string;
  signal?: AbortSignal;
}

const callerKey = (identity: Identity): string => `${identity.harness}\0${identity.workspace}\0${identity.surface}\0${identity.session}\0${identity.agent}`;

/** Ownership ignores generation so a session keeps its objects across its own handoff. */
function ownedBy(record: ExecutorRecord, caller: Identity): boolean {
  return record.parent.harness === caller.harness && record.parent.workspace === caller.workspace
    && record.parent.surface === caller.surface && record.parent.session === caller.session
    && record.parent.agent === caller.agent;
}

/** Native outcome fields copied to the result verbatim when present. */
const PASSTHROUGH = [
  'state', 'handoff', 'executorId', 'sessionId', 'surfaceChanged', 'model', 'reasoningEffort',
  'lastActivityAt', 'lastActivityAtSource', 'stateSource', 'exitCode', 'signal', 'session',
  'autoCompact', 'fieldStates', 'error', 'proof', 'processState', 'processStateReason', 'turns',
  'lastOperationId', 'lastTurnOutcome', 'queuedTurns', 'lastTurnAt', 'turnStartedAt', 'idleSince',
  'turnId', 'queuePosition', 'persistence', 'runtimeVersion', 'mcpFiltered', 'logTail',
] as const;

export function normalizeOutcome(request: Request, outcome: NativeOutcome): Result {
  // Only state-reporting outcomes carry a context block. A spawn/message/stop
  // result must not fabricate a null context (which would then mark every
  // context field unavailable); explicit `unavailable` entries still pass through.
  const context = outcome.context ?? null;
  if (context && context.percent == null && context.used != null && context.window != null && context.window > 0) {
    const percent = derivedPercent(context.used, context.window);
    if (percent !== null) {
      context.percent = percent;
      context.percentSource = 'derived';
      context.sources = { ...(context.sources ?? {}), percent: 'derived' };
    }
  }
  const options: Record<string, unknown> = {
    durable: outcome.durable ?? false,
    modelVerification: outcome.modelVerification ?? 'unknown',
    verification: outcome.verification ?? { model: 'unknown', context: 'reported' },
    ...(context ? { context } : {}),
    unavailable: outcome.unavailable ?? [],
    notices: outcome.notices ?? [],
  };
  for (const key of PASSTHROUGH) {
    if (outcome[key] !== undefined) options[key] = outcome[key];
  }
  return result(request, outcome.status, outcome.reason, options);
}

function policyOf(executors: readonly ExecutorRecord[], identity: Identity, executorId?: string): Required<Policy> {
  const record = executorId ? executors.find(e => e.executorId === executorId) : undefined;
  return record ? record.policy : { ...ROOT_POLICY };
}

/**
 * Execute one contract request:
 * validate -> idempotency -> ownership -> policy -> adapter -> durable record.
 *
 * Every path returns a schema-valid result; no path silently retries a native
 * mutation whose outcome is unknown.
 */
export async function execute(request: unknown, options: OperationsOptions): Promise<Result> {
  try {
    return await executeInner(request, options);
  } catch (error) {
    if (!(error instanceof LockBusyError)) throw error;
    // A concurrent ai4ai process (typically the executor supervisor's short
    // store write) holds the installation lock. This is transient contention,
    // not a failed operation: report a non-blocking pending result the caller
    // can retry, never the internal lock diagnostic.
    const base = (request && typeof request === 'object' ? request : {}) as Partial<Request>;
    return result(
      { operation: (base.operation as Request['operation']) ?? 'status', operationId: typeof base.operationId === 'string' ? base.operationId : `${base.operation ?? 'status'}-busy` },
      'pending',
      error.message,
      { notices: [{ code: 'busy', impact: 'none', action_required: false, message: 'Another ai4ai process is updating the installation; retry this operation.' }] },
    );
  }
}

async function executeInner(request: unknown, options: OperationsOptions): Promise<Result> {
  const validated = validateRequest(request);
  if (!validated.ok) {
    const base = (request && typeof request === 'object' ? request : {}) as Partial<Request>;
    return result(
      { operation: (base.operation as Request['operation']) ?? 'status', operationId: typeof base.operationId === 'string' ? base.operationId : 'invalid' },
      'unsupported',
      'Request failed contract validation',
      { error: { code: 'invalid-request', message: validated.issues.map(i => `${i.path}:${i.code}`).join(', ') } },
    );
  }
  const req = validated.value;
  const { identity, store, adapter, executorId } = options;
  const os = options.os ?? currentOs();
  const ctx: AdapterContext = { identity, store, home: options.home, ...(executorId ? { executorId } : {}), ...(options.signal ? { signal: options.signal } : {}) };
  const existing = (await store.records(identity)).find(r => r.request.operationId === req.operationId);

  if (req.operation === 'list') return listExecutors(req, options);

  if (existing) {
    if (existing.fingerprint !== fingerprint(req)) {
      return result(req, 'failed', 'Conflicting reuse of an operation identifier', {
        durable: true, error: { code: 'idempotency-conflict', message: 'The operation id was already used with different input' },
      });
    }
    // A pending handoff may have advanced in a native watcher or runner that
    // cannot write the shared store itself. Ask the adapter for the current
    // state instead of returning a stale pending result forever.
    if (req.operation === 'handoff' && ['accepted', 'pending', 'applied'].includes(existing.status) && adapter.reconcileHandoff) {
      try {
        const reconciled = await adapter.reconcileHandoff(existing.request, ctx);
        if (reconciled) {
          const normalized = normalizeOutcome(existing.request, reconciled);
          // The reconciled result is subject to the same contract check as a
          // first response, including the same-session proof rule.
          if (validateResult(normalized).ok) {
            if (normalized.status !== existing.status) {
              await store.completePending(existing.source, existing.request.operationId, normalized);
            }
            return normalized;
          }
        }
      } catch {
        // Keep the durable pending record; never invent progress.
      }
    }
    return existing.result;
  }

  if (req.operation === 'capabilities') {
    return result(req, 'completed', 'Capability declarations reflect implementation and verified evidence', {
      durable: false,
      capabilities: adapter.capabilities(os),
      modelVerification: 'unknown',
      verification: { model: 'unknown', context: 'reported' },
    });
  }

  const executors = await store.executors();
  const declarations = adapter.capabilities(os);
  const declared = declarations.find(c => c.interface === identity.surface) ?? declarations[0];
  if (req.operation === 'handoff' && declared?.handoff.availability === 'unsupported') {
    return result(req, 'unsupported', `Adapter declares handoff unsupported on ${identity.surface}`, { unavailable: ['handoff'] });
  }
  // Capability declarations decide mode availability, not just overall handoff
  // availability: an undeclared `compact` must be refused explicitly.
  if (req.operation === 'handoff' && req.mode !== undefined && declared && !declared.handoff.modes.includes(req.mode)) {
    return result(req, 'unsupported', `Adapter does not declare the ${req.mode} handoff mode on ${identity.surface}; omit mode for the zero-summary restart`, {
      unavailable: [`handoff.${req.mode}`],
    });
  }
  if (req.operation === 'spawn' && declared?.spawn.availability === 'unsupported') {
    return result(req, 'unsupported', `Adapter declares spawn unsupported on ${identity.surface}`, { unavailable: ['spawn'] });
  }

  const target = req.target ?? 'self';
  let targetRecord: ExecutorRecord | undefined;
  if (target !== 'self') {
    targetRecord = executors.find(e => e.executorId === target);
    const isSelfBinding = executorId !== undefined && targetRecord?.executorId === executorId;
    if (!targetRecord || (!isSelfBinding && !ownedBy(targetRecord, identity))) {
      // No information leak: an unknown target and a foreign target look the same.
      return result(req, 'unauthorized', 'Target is not owned by this caller', { error: { code: 'unauthorized', message: 'No owned target' } });
    }
  }

  const callerPolicy = policyOf(executors, identity, executorId);
  if (req.operation === 'handoff' && target === 'self') {
    const policy = checkPolicy(callerPolicy, 'handoff');
    if (!policy.ok) return result(req, 'forbidden', policy.reason, { error: { code: 'forbidden', message: policy.reason } });
  }
  if (req.operation === 'spawn') {
    const policy = checkPolicy(callerPolicy, 'spawn');
    if (!policy.ok) return result(req, 'forbidden', policy.reason, { error: { code: 'forbidden', message: policy.reason } });
    const limit = options.maxSpawn ?? spawnLimit(adapter, os);
    if ((req.count ?? 1) > limit) {
      return result(req, 'failed', `Requested ${req.count} executors exceeds the adapter limit of ${limit}`, { error: { code: 'concurrency-limit', message: 'No silent queueing' } });
    }
  }
  if ((req.operation === 'cancel' || req.operation === 'stop') && target === 'self') {
    const policy = checkPolicy(callerPolicy, 'cancel');
    if (!policy.ok) return result(req, 'forbidden', policy.reason, { error: { code: 'forbidden', message: policy.reason } });
  }
  if (req.operation === 'finish' && target === 'self') {
    return result(req, 'unsupported', 'finish completes a detached owned executor; an in-harness session has no supervisor to complete', { unavailable: ['finish.self'] });
  }

  let outcome: NativeOutcome;
  try {
    switch (req.operation) {
      case 'handoff': outcome = await adapter.handoff(req, ctx); break;
      case 'spawn': outcome = await adapter.spawn(req, ctx); break;
      case 'status': outcome = await adapter.status(req, ctx); break;
      case 'message': outcome = await adapter.message(req, ctx); break;
      case 'cancel':
      case 'stop': outcome = await adapter.cancel(req, ctx); break;
      case 'finish': outcome = await adapter.finish(req, ctx); break;
      default: outcome = { status: 'unsupported', reason: 'This adapter has no implementation for this operation' };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Adapter failed';
    outcome = { status: 'unknown', reason: `Native outcome is uncertain; reconcile before retrying: ${message}`, error: { code: 'native-unknown', message } };
  }

  // One finalization point for every adapter: a produced proof that changed
  // the native session becomes a structured failure, never a success.
  const normalized = normalizeOutcome(req, guardHandoffOutcome(outcome, {}));
  const checked = validateResult(normalized);
  if (!checked.ok) {
    return result(req, 'failed', 'Adapter produced a result that violates the contract; nothing was journaled', {
      error: { code: 'invalid-result', message: checked.issues.map(i => `${i.path}:${i.code}`).join(', ') },
    });
  }
  // Only terminal or safely replayable outcomes are journaled. A pending
  // mutation stays journaled too, so the same operation id is never repeated.
  const record: OperationRecord = {
    format: 2, kind: 'operation', request: req, fingerprint: fingerprint(req), source: identity,
    status: normalized.status, reason: normalized.reason, result: normalized, createdAt: new Date().toISOString(),
  };
  if (normalized.status !== 'unsupported') await store.append(record);
  return normalized;
}

async function listExecutors(req: Request, options: OperationsOptions): Promise<Result> {
  const { identity, store } = options;
  const records = (await store.executors()).filter(e => ownedBy(e, identity) || e.parent.session === identity.session);
  const executors: ExecutorSummary[] = [];
  for (const e of records) {
    const raw = await readStatus(options.home, e.executorId);
    const liveness = raw ? await livenessOf(options.home, e.executorId, raw) : {};
    // One lifecycle vocabulary for self and executors (starting/stopping and
    // liveness-only observations collapse into `running`; a quiescent
    // persistent executor is `idle`).
    const state = lifecycleOfStatus(raw, liveness);
    const processState = raw ? processStateOf(raw, liveness).state : 'unknown';
    const pointer = await sessionPointer(e.harness, options.identity.workspace, raw?.sessionId ?? e.sessionId).catch(() => null);
    const turns = await readTurns(options.home, e.executorId, 500);
    const lastTurn = turns.at(-1);
    if (['completed', 'failed', 'cancelled'].includes(state) && e.state !== state && typeof options.store.updateExecutor === 'function') {
      await options.store.updateExecutor(e.executorId, {
        state,
        ...(raw?.sessionId && e.sessionId !== raw.sessionId ? { sessionId: raw.sessionId } : {}),
      }).catch(() => undefined);
    }
    executors.push({
      executorId: e.executorId,
      state,
      surface: e.surface,
      processState,
      ...((raw?.sessionId ?? e.sessionId) ? { sessionId: (raw?.sessionId ?? e.sessionId)! } : {}),
      ...(pointer ? { session: pointer } : {}),
      turns: raw?.turns ?? turns.length,
      queuedTurns: raw?.queuedTurns ?? await queuedTurns(options.home, e.executorId),
      lastTurnAt: raw?.lastTurnAt ?? lastTurn?.endedAt ?? lastTurn?.startedAt ?? null,
      lastTurnOutcome: raw?.lastTurnOutcome ?? lastTurn?.outcome ?? null,
      lastOperationId: raw?.lastOperationId ?? e.lastOperationId ?? null,
      turnStartedAt: raw?.turnStartedAt ?? null,
      idleSince: state === 'idle' ? raw?.idleSince ?? null : null,
      ...((e.persistence ?? raw?.persistence) ? { persistence: (e.persistence ?? raw?.persistence)! } : {}),
    });
  }
  return result(req, 'completed', `${executors.length} owned executor(s)`, {
    durable: true,
    executors,
    state: 'running',
  });
}

function spawnLimit(adapter: Adapter, os: 'linux' | 'windows' | 'darwin'): number {
  const declaration = adapter.capabilities(os).find(c => c.spawn.availability !== 'unsupported');
  return declaration?.spawn.maxConcurrent ?? 1;
}

export function currentOs(): 'linux' | 'windows' | 'darwin' {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
}

/** Helper for adapters that need a fresh executor identifier. */
export const newExecutorId = (prefix = 'ex'): string => `${prefix}-${randomUUID()}`;

export { callerKey, ownedBy };
