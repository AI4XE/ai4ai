import { randomUUID } from 'node:crypto';
import { derivedPercent, result, validateRequest, validateResult } from '../contract/validate.js';
import type { CapabilityDeclaration, ExecutorSummary, Request, Result } from '../contract/types.js';
import type { Adapter, AdapterContext, NativeOutcome } from '../adapters/types.js';
import { fingerprint, sameIdentity } from './fingerprint.js';
import { lifecycleOfStatus, pidAlive, readStatus } from '../adapters/executors.js';
import { sessionPointer } from './session-probe.js';
import { checkPolicy, normalizePolicy, ROOT_POLICY } from './policy.js';
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

function normalizeOutcome(request: Request, outcome: NativeOutcome): Result {
  const context = outcome.context ?? { window: null, used: null, percent: null, percentSource: null };
  if (context.percent == null && context.used != null && context.window != null && context.window > 0) {
    const percent = derivedPercent(context.used, context.window);
    if (percent !== null) {
      context.percent = percent;
      context.percentSource = 'derived';
      context.sources = { ...(context.sources ?? {}), percent: 'derived' };
    }
  }
  return result(request, outcome.status, outcome.reason, {
    durable: outcome.durable ?? false,
    ...(outcome.state !== undefined ? { state: outcome.state } : {}),
    ...(outcome.handoff !== undefined ? { handoff: outcome.handoff } : {}),
    ...(outcome.executorId !== undefined ? { executorId: outcome.executorId } : {}),
    ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
    ...(outcome.surfaceChanged !== undefined ? { surfaceChanged: outcome.surfaceChanged } : {}),
    ...(outcome.model !== undefined ? { model: outcome.model } : {}),
    ...(outcome.reasoningEffort !== undefined ? { reasoningEffort: outcome.reasoningEffort } : {}),
    ...(outcome.lastActivityAt !== undefined ? { lastActivityAt: outcome.lastActivityAt } : {}),
    ...(outcome.lastActivityAtSource !== undefined ? { lastActivityAtSource: outcome.lastActivityAtSource } : {}),
    ...(outcome.stateSource !== undefined ? { stateSource: outcome.stateSource } : {}),
    ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
    ...(outcome.signal !== undefined ? { signal: outcome.signal } : {}),
    ...(outcome.session !== undefined ? { session: outcome.session } : {}),
    modelVerification: outcome.modelVerification ?? 'unknown',
    verification: outcome.verification ?? { model: 'unknown', context: 'reported' },
    context,
    ...(outcome.autoCompact ? { autoCompact: outcome.autoCompact } : {}),
    ...(outcome.fieldStates ? { fieldStates: outcome.fieldStates } : {}),
    unavailable: outcome.unavailable ?? [],
    notices: outcome.notices ?? [],
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.proof ? { proof: outcome.proof } : {}),
  });
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

  let outcome: NativeOutcome;
  try {
    switch (req.operation) {
      case 'handoff': outcome = await adapter.handoff(req, ctx); break;
      case 'spawn': outcome = await adapter.spawn(req, ctx); break;
      case 'status': outcome = await adapter.status(req, ctx); break;
      case 'message': outcome = await adapter.message(req, ctx); break;
      case 'cancel':
      case 'stop': outcome = await adapter.cancel(req, ctx); break;
      default: outcome = { status: 'unsupported', reason: 'This adapter has no implementation for this operation' };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Adapter failed';
    outcome = { status: 'unknown', reason: `Native outcome is uncertain; reconcile before retrying: ${message}`, error: { code: 'native-unknown', message } };
  }

  const normalized = normalizeOutcome(req, outcome);
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
    const alive = raw?.pid === undefined ? null : pidAlive(raw.pid);
    // One lifecycle vocabulary for self and executors (starting/stopping and
    // liveness-only observations collapse into `running`).
    const state = lifecycleOfStatus(raw, alive);
    const pointer = await sessionPointer(e.harness, options.identity.workspace, e.sessionId).catch(() => null);
    executors.push({
      executorId: e.executorId,
      state,
      surface: e.surface,
      ...(e.sessionId ? { sessionId: e.sessionId } : {}),
      ...(pointer ? { session: pointer } : {}),
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
