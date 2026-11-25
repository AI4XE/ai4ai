import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Adapter, AdapterContext, NativeOutcome } from './types.js';
export type { AdapterContext, NativeOutcome, Adapter } from './types.js';
import type {
  AutoCompact, CapabilityDeclaration, ContextInfo, LogTail, Request, Result,
} from '../contract/types.js';
import type { FieldStateValue, HarnessId, LifecycleState, Os, ProcessState, TurnOutcome } from '../contract/states.js';
import type { ExecutorRecord } from '../core/store.js';
import { normalizePolicy } from '../core/policy.js';
import { newExecutorId, ownedBy } from '../core/operations.js';
import {
  enqueueTurn, executorDir, launch, lifecycleOfStatus, processStateOf, readLog, readStatus, requestFinish, requestStop,
  turnPlacement, type ExecutorLiveness, type ExecutorStatus, type LogLine,
} from './executors.js';
import { sessionActivity, sessionPointer } from '../core/session-probe.js';
import { harnessCredentialReport, type CredentialReport } from '../core/credentials.js';
import { readEventTail } from '../core/events.js';
import { queuedTurns, queuePositionOf, readTurns } from '../core/turns.js';
import { withExecutorLock } from '../core/executor-lock.js';
import {
  controlEnvelope, readHandoffRequest, readHandoffStatus, writeHandoffRequest, type ExecutorHandoffRequest,
} from '../core/executor-request.js';

/** Best-effort registry reconciliation; test doubles may not implement it. */
const updateRecord = (store: AdapterContext['store'], executorId: string, patch: Parameters<AdapterContext['store']['updateExecutor']>[1]): Promise<unknown> =>
  typeof (store as { updateExecutor?: unknown }).updateExecutor === 'function' ? store.updateExecutor(executorId, patch).catch(() => undefined) : Promise.resolve();
import { forceKillTree, heartbeatAlive, processAlive, readHeartbeat, verifyIdentity } from '../core/process-identity.js';

export interface CarrierCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  envExclude?: string[];
  sessionRegex?: string;
  /** Windows only: the adapter already formed the complete cmd.exe payload. */
  windowsVerbatimArguments?: boolean;
}

export interface StatusDetails {
  model?: string | null;
  /** Provenance of the model value: native > session > env > config. */
  reasoningEffort?: string | null;
  context?: ContextInfo;
  autoCompact?: AutoCompact;
  modelVerification?: 'verified' | 'reported' | 'configured-only' | 'unknown';
  /** Explicit per-field states for fields with no value (defaults are derived). */
  fieldStates?: Record<string, FieldStateValue>;
  unavailable?: string[];
  runtimeVersion?: string | null;
  /** D37 provenance of the provider credentials (names/scopes only, never values). */
  credentials?: CredentialReport;
  notices?: { code: string; impact: 'none'; action_required: false; message: string }[];
}

/** Observed liveness and lifecycle for one executor. */
export interface Observation {
  state: LifecycleState;
  processState: ProcessState;
  processStateReason?: string;
  liveness: ExecutorLiveness;
  status: ExecutorStatus;
  log: LogLine[];
}

/**
 * Base for adapters whose spawn carrier is a detached OS process.
 *
 * `spawn`, `message`, `finish`, `cancel` and `status` are real file-backed
 * operations; `handoff` is deliberately unsupported externally because a
 * one-shot headless turn has no in-place context to replace. In-harness
 * plugins implement handoff with their native in-process API.
 */
export abstract class ExternalExecutorAdapter implements Adapter {
  abstract readonly harness: HarnessId;
  abstract capabilities(os: Os): CapabilityDeclaration[];
  /** Build the first-turn command for a new detached executor, or the resume command for an existing session. */
  protected abstract carrier(request: Request, ctx: AdapterContext, executorId: string, resumeSessionId?: string): Promise<CarrierCommand>;
  /** Adapter-specific context/model/reasoning-effort extraction from the carrier output. */
  protected statusDetails(_record: ExecutorRecord, _status: ExecutorStatus, _log: LogLine[], _ctx: AdapterContext): StatusDetails | Promise<StatusDetails> { return {}; }

  /**
   * Carrier model for a spawn: `resident` keeps one interactive child across
   * turns (Claude persistent); everything else starts one child per turn.
   */
  protected carrierMode(_request: Request): 'resident' | 'per-turn' { return 'per-turn'; }

  /**
   * Model a resumed turn must keep: the explicit request override, or the
   * effective value the carrier would use (environment/settings). Persisted at
   * spawn time so a follow-up turn started by a supervisor whose caller lacked
   * that environment still selects the same model.
   */
  protected persistedModel(request: Request, _ctx: AdapterContext): string | undefined | Promise<string | undefined> { return request.model; }

  /** Reasoning effort the resumed turn must keep (same rationale as persistedModel). */
  protected persistedReasoningEffort(request: Request, _ctx: AdapterContext): string | undefined | Promise<string | undefined> { return request.reasoningEffort; }

  protected async writeTask(ctx: AdapterContext, executorId: string, name: string, text: string): Promise<string> {
    const directory = executorDir(ctx.home, executorId);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, name);
    await writeFile(file, text);
    return file;
  }

  /**
   * Executor-target same-session handoff (restart/compact).
   *
   * The orchestrator cannot drive the executor's in-harness component directly.
   * It records a durable request and wakes a live executor with an invisible
   * control turn; the plugin/runner validates and applies it at a safe point,
   * then writes the status that `reconcileHandoff` returns.
   *
   * A terminal or session-less executor is `handoff-unreachable` with the
   * explicit rotation alternative; rotation itself is executed by the core,
   * never silently substituted here.
   */
  async handoff(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    const target = request.target;
    if (!target || target === 'self') {
      return {
        status: 'unsupported',
        reason: 'External process control cannot replace a live context in place; self-handoff is provided by the installed in-harness plugin',
        unavailable: ['handoff.external'],
      };
    }
    const mode = request.mode ?? 'restart';
    if (mode === 'rotation') {
      return { status: 'failed', reason: 'rotation is executed by the core rotation path', error: { code: 'invalid-request', message: 'rotation must be handled by the core' } };
    }
    const record = await this.executorFor(request, ctx);
    if (!record) return { status: 'unauthorized', reason: 'Target is not owned by this caller' };
    if (record.surface !== 'headless') {
      return { status: 'unsupported', reason: 'Executor-target handoff is headless-only', unavailable: ['handoff.executor.surface'] };
    }
    return withExecutorLock(executorDir(ctx.home, record.executorId), async () => {
      const observed = await this.observe(record, ctx);
      if (observed.processState === 'orphaned') {
        return { status: 'failed', reason: 'The executor is orphaned; sweep it before handing off', error: { code: 'executor-orphaned', message: 'Supervisor dead, child alive' } } as NativeOutcome;
      }
      if (!(observed.state === 'running' || observed.state === 'idle') || observed.liveness.supervisorAlive !== true) {
        return {
          status: 'failed', durable: true, state: observed.state,
          reason: 'The executor is not live; a same-session handoff needs a running or idle supervisor. Use an explicit rotation if the task must continue.',
          error: { code: 'handoff-unreachable', message: `Executor state ${observed.state}, supervisor alive=${String(observed.liveness.supervisorAlive)}` },
          alternatives: ['rotation'],
        } as NativeOutcome;
      }
      const sessionId = observed.status.sessionId ?? record.sessionId;
      // A repeated query for the same operationId must not enqueue another wake
      // turn: the executor adopts and clears the durable request once, and a
      // second wake would find nothing and fail the executor. Re-querying is
      // the contract's idempotent read path, not a second transition.
      const queued = await readHandoffRequest(executorDir(ctx.home, record.executorId));
      if (queued?.operationId === request.operationId) {
        return {
          status: 'pending', durable: true, state: 'running', ...(sessionId ? { sessionId } : {}),
          handoff: { phase: 'pending' },
          reason: 'The handoff request is already queued for the executor; re-query the same operationId to reconcile',
        } as NativeOutcome;
      }
      if (queued && queued.operationId !== request.operationId) {
        return {
          status: 'failed', durable: true, state: observed.state,
          reason: 'Another executor-target handoff is pending on this executor; wait for it or reconcile it first',
          error: { code: 'handoff-in-progress', message: `Pending operation ${queued.operationId}` },
          alternatives: ['rotation'],
        } as NativeOutcome;
      }
      const now = new Date();
      const handoffRequest: ExecutorHandoffRequest = {
        format: 2, kind: 'handoff-request', operationId: request.operationId, mode,
        ...(request.task !== undefined ? { task: request.task } : {}),
        ...(request.continuation !== undefined ? { continuation: request.continuation } : {}),
        marker: `ai4ai-context-${randomUUID()}`,
        caller: ctx.identity, requestedAt: now.toISOString(),
        deadlineAt: new Date(now.getTime() + Math.min(Math.max(request.timeoutMs ?? 120000, 5000), 600000)).toISOString(),
      };
      await writeHandoffRequest(executorDir(ctx.home, record.executorId), handoffRequest);
      // Wake the executor. The envelope is consumed by the in-harness component
      // before any model input; the carrier never sees it.
      const controlFile = await this.writeTask(ctx, record.executorId, `handoff-control-${request.operationId}.prompt`, controlEnvelope(request.operationId));
      const turnId = `turn-${randomUUID()}`;
      // The wake turn must resume the recorded native session; a queued turn
      // without a carrier command would fall back to the spawn args and create
      // a new session (observed with the OpenCode served carrier).
      const resume = this.resumeRequest(record, request);
      const wakeCarrier = await this.carrier(resume, ctx, record.executorId, sessionId);
      await enqueueTurn(ctx.home, record.executorId, {
        inputFile: path.basename(controlFile),
        turnId,
        operationId: `${request.operationId}:wake`,
        command: wakeCarrier.command,
        args: wakeCarrier.args,
        ...(wakeCarrier.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        ...(sessionId ? { expectedSessionId: sessionId } : {}),
      });
      await updateRecord(ctx.store, record.executorId, { state: 'running', lastOperationId: request.operationId });
      return {
        status: 'pending', durable: true, state: 'running', sessionId: sessionId ?? undefined,
        handoff: { phase: 'pending' },
        reason: `The ${mode} handoff request was delivered to the executor at its next safe point`,
        notices: [{
          code: 'executor-handoff-request', impact: 'none', action_required: false,
          message: `The in-harness ${this.harness} component will ${mode} the context; re-query the same operationId to reconcile.`,
        }],
      } as NativeOutcome;
    }, { operation: `handoff:${request.operationId}` });
  }

  /** Reconcile an executor-target handoff from the in-harness status file. */
  async reconcileHandoff(request: Request, ctx: AdapterContext): Promise<NativeOutcome | undefined> {
    if (!request.target || request.target === 'self') return undefined;
    const record = await this.executorFor(request, ctx);
    if (!record) return undefined;
    const status = await readHandoffStatus(executorDir(ctx.home, record.executorId));
    if (!status || status.operationId !== request.operationId) return undefined;
    const base = { durable: true, sessionId: status.session ?? record.sessionId } as Record<string, unknown>;
    // A successor turn that completed after the native transition is adoption:
    // some hosts do not emit a second hook the plugin can use to write
    // `completed`, so reconcile from the supervisor-owned turn ledger.
    if (status.phase === 'applied') {
      const turns = await readTurns(ctx.home, record.executorId, 200);
      const since = Number.isFinite(Date.parse(status.updatedAt)) ? Date.parse(status.updatedAt) : 0;
      const adopted = turns.some(turn => turn.outcome === 'completed' && turn.endedAt !== undefined && Date.parse(turn.endedAt) >= since);
      if (adopted) {
        const proof = status.source && status.successor
          ? { source: status.source, successor: status.successor, mechanism: status.mechanism ?? 'surface-replacement', nativeEvidence: `executor:${record.executorId}:turn-ledger` }
          : undefined;
        return { ...base, status: 'completed', state: 'completed', handoff: { phase: 'completed' }, reason: 'The successor turn completed after the native transition', ...(proof ? { proof } : {}), ...(status.mechanism ? { mechanism: status.mechanism } : {}) } as NativeOutcome;
      }
    }
    const proof = status.source && status.successor
      ? { source: status.source, successor: status.successor, mechanism: status.mechanism ?? 'surface-replacement', nativeEvidence: `executor:${record.executorId}:${status.phase}` }
      : undefined;
    switch (status.phase) {
      case 'completed':
        return { ...base, status: 'completed', state: 'completed', handoff: { phase: 'completed' }, reason: status.reason ?? 'The executor completed the handoff', ...(proof ? { proof } : {}), ...(status.mechanism ? { mechanism: status.mechanism } : {}), ...(status.continued !== undefined ? { continued: status.continued } : {}), ...(status.idleAfter !== undefined ? { idleAfter: status.idleAfter } : {}), ...(status.fallbackUsed !== undefined ? { fallbackUsed: status.fallbackUsed } : {}) } as NativeOutcome;
      case 'applied':
        return { ...base, status: 'applied', state: 'running', handoff: { phase: 'applied' }, reason: status.reason ?? 'The executor applied the handoff; delivery pending', ...(proof ? { proof } : {}), ...(status.mechanism ? { mechanism: status.mechanism } : {}) } as NativeOutcome;
      case 'failed':
        return { ...base, status: 'failed', state: 'failed', reason: status.reason ?? 'The executor failed the handoff', error: { code: status.errorCode ?? 'executor-handoff-failed', message: status.reason ?? 'handoff failed' } } as NativeOutcome;
      case 'cancelled':
        return { ...base, status: 'cancelled', state: 'cancelled', reason: status.reason ?? 'The executor cancelled the handoff' } as NativeOutcome;
      default:
        return { ...base, status: 'pending', state: 'running', handoff: { phase: 'pending' }, reason: status.reason ?? `The executor is applying the handoff (${status.phase})` } as NativeOutcome;
    }
  }

  /** Refuse carrier options the harness does not implement, loudly. */
  protected validateSpawnOptions(request: Request, os: Os): NativeOutcome | undefined {
    const spawn = request.spawn ?? {};
    const declarations = this.capabilities(os);
    const surfaces = new Set(declarations.flatMap(declaration => declaration.spawn.surfaces));
    const persistence = new Set(declarations.flatMap(declaration => declaration.spawn.persistenceModes));
    const permissions = new Set(declarations.flatMap(declaration => declaration.spawn.permissionModes));
    if (spawn.profile !== undefined && this.harness !== 'dsh') {
      return { status: 'unsupported', reason: 'spawn.profile is a DSH profile selector; this harness has no profile concept', unavailable: ['spawn.profile'] };
    }
    if (spawn.surface !== undefined && !surfaces.has(spawn.surface)) {
      return { status: 'unsupported', reason: `The ${this.harness} carrier does not implement the ${spawn.surface} spawn surface`, unavailable: [`spawn.surface.${spawn.surface}`] };
    }
    if (spawn.persistence !== undefined && !persistence.has(spawn.persistence)) {
      return { status: 'unsupported', reason: `The ${this.harness} carrier does not implement ${spawn.persistence} persistence`, unavailable: [`spawn.persistence.${spawn.persistence}`] };
    }
    if (spawn.permissionMode !== undefined && !permissions.has(spawn.permissionMode)) {
      return { status: 'unsupported', reason: `The ${this.harness} carrier does not implement permissionMode ${spawn.permissionMode}`, unavailable: ['spawn.permissionMode'] };
    }
    return undefined;
  }

  async spawn(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    if (request.isolation === 'isolated') {
      return {
        status: 'unsupported',
        reason: 'Executor isolation is recorded as a field but not implemented by any carrier; omit isolation or use the default inherit',
        unavailable: ['spawn.isolation.isolated'],
      };
    }
    const refused = this.validateSpawnOptions(request, process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux');
    if (refused) return refused;
    const count = request.count ?? 1;
    const ids = Array.from({ length: count }, () => newExecutorId(this.harness));
    const created: ExecutorRecord[] = [];
    try {
      for (const executorId of ids) {
        // The task file must exist before the carrier builds an MCP config in
        // the same executor directory.
        const taskFile = await this.writeTask(ctx, executorId, 'spawn.prompt', request.task ?? '');
        const carrier = await this.carrier(request, ctx, executorId);
        const model = await this.persistedModel(request, ctx);
        const reasoningEffort = await this.persistedReasoningEffort(request, ctx);
        const persistence = request.spawn?.persistence ?? 'one-shot';
        const mcpFiltered = await this.filteredMcpNames(ctx, executorId);
        const record: ExecutorRecord = {
          format: 2, kind: 'executor', executorId, parent: ctx.identity, harness: this.harness,
          surface: request.spawn?.surface ?? 'headless', policy: normalizePolicy(request.policy), isolation: request.isolation ?? 'inherit',
          state: 'running', createdAt: new Date().toISOString(),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(request.spawn ? { spawn: sanitizeSpawnOptions(request.spawn) } : {}),
          origin: request.spawn?.origin === 'rotation' ? 'rotation' : 'spawn',
          ...(request.spawn?.origin === 'rotation' ? { handoffSeed: true } : {}),
          persistence,
          epoch: 1,
          ...(mcpFiltered ? { mcpFiltered } : {}),
          carrier: { detached: true, command: [carrier.command, ...carrier.args] },
        };
        created.push(record);
        await ctx.store.addExecutors([record]);
        const initialTurnId = `turn-${randomUUID()}`;
        await launch({
          executorId, harness: this.harness, home: ctx.home, command: carrier.command, args: carrier.args,
          ...(carrier.env ? { env: carrier.env } : {}), ...(carrier.envExclude ? { envExclude: carrier.envExclude } : {}),
          ...(carrier.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
          supervisorProtocol: 3,
          persistence,
          epoch: 1,
          initialTurnId,
          initialOperationId: request.operationId,
          handoffSeed: request.spawn?.origin === 'rotation',
          resident: persistence === 'persistent' && this.carrierMode(request) === 'resident',
          cwd: ctx.identity.workspace, taskFile,
          ...(carrier.sessionRegex ? { sessionRegex: carrier.sessionRegex } : {}),
        });
      }
      return {
        status: 'accepted',
        reason: `${created.length} detached executor(s) started; status and cancellation are external`,
        durable: true,
        executorId: created[0]!.executorId,
        state: 'running',
        ...(created[0]!.persistence ? { persistence: created[0]!.persistence } : {}),
        ...(created[0]!.mcpFiltered ? { mcpFiltered: created[0]!.mcpFiltered } : {}),
        modelVerification: 'unknown',
        verification: { model: 'unknown', context: 'reported' },
      };
    } catch (error) {
      return {
        status: 'failed',
        reason: `Detached launch failed after ${created.length} executor(s) were recorded: ${error instanceof Error ? error.message : 'unknown error'}`,
        durable: created.length > 0,
        error: { code: 'spawn-failed', message: error instanceof Error ? error.message : 'unknown error' },
      };
    }
  }

  /** Names of the MCP servers copied by the adapter, read back from its file. */
  protected async filteredMcpNames(_ctx: AdapterContext, _executorId: string): Promise<{ names: string[]; count: number } | undefined> {
    return undefined;
  }

  protected async executorFor(request: Request, ctx: AdapterContext): Promise<ExecutorRecord | undefined> {
    const target = request.target;
    if (!target || target === 'self') return undefined;
    const records = await ctx.store.executors();
    const record = records.find(e => e.executorId === target);
    if (!record) return undefined;
    const selfBinding = ctx.executorId !== undefined && record.executorId === ctx.executorId;
    return selfBinding || ownedBy(record, ctx.identity) ? record : undefined;
  }

  async status(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    const record = await this.executorFor(request, ctx);
    if (!record) return { status: 'unauthorized', reason: 'Target is not owned by this caller' };
    const observed = await this.observe(record, ctx);
    const details = await this.statusDetails(record, observed.status, observed.log, ctx);
    const modelVerification = details.modelVerification ?? (details.model ? 'reported' : 'unknown');
    // Session pointer (content is never read) and per-field activity/state provenance.
    const sessionId = observed.status.sessionId ?? record.sessionId;
    const pointer = await sessionPointer(this.harness, ctx.identity.workspace, sessionId).catch(() => null);
    const nativeActivity = observed.status.lastActivityAt ?? null;
    const fallbackActivity = nativeActivity ? null : await sessionActivity(pointer?.path ?? null);
    const lastActivityAt = nativeActivity ?? fallbackActivity;
    const lastActivityAtSource = nativeActivity ? 'native' : fallbackActivity ? 'session' : 'unknown';
    const stateSource = observed.state === 'unknown' ? (pointer ? 'session' : 'unknown') : 'native';
    const terminal = ['completed', 'failed', 'cancelled'].includes(observed.state);
    const turns = await readTurns(ctx.home, record.executorId, 500);
    const lastTurn = turns.at(-1);
    const queued = await queuedTurns(ctx.home, record.executorId);
    // Registry reconciliation: the supervisor is the authority; the durable
    // registry is updated to match a terminal observation.
    // Dead-supervisor exception: a client may reconcile the registry only when
    // the supervisor is provably gone; while it is alive it is the single
    // writer of executor state.
    if (terminal && observed.liveness.supervisorAlive !== true && (record.state !== observed.state || (sessionId && record.sessionId !== sessionId))) {
      if (typeof ctx.store.updateExecutor === 'function') await ctx.store.updateExecutor(record.executorId, {
        state: observed.state,
        ...(sessionId ? { sessionId } : {}),
        ...(lastTurn?.outcome ? { lastTurnOutcome: lastTurn.outcome } : {}),
        ...(lastTurn?.endedAt ?? lastTurn?.startedAt ? { lastTurnAt: lastTurn.endedAt ?? lastTurn.startedAt! } : {}),
        ...(observed.status.lastOperationId ? { lastOperationId: observed.status.lastOperationId } : {}),
      }).catch(() => undefined);
    }
    const logTail = request.logTail ? await readEventTail(ctx.home, record.executorId, record.harness, request.logTail) : undefined;
    return {
      status: observed.state === 'running' || observed.state === 'idle' ? 'pending' : 'completed',
      reason: observed.state === 'running' ? 'Executor process is running'
        : observed.state === 'idle' ? 'Executor is idle and waiting for the next message'
        : `Executor process is ${observed.state}`,
      durable: true,
      state: observed.state,
      processState: observed.processState,
      ...(observed.processStateReason ? { processStateReason: observed.processStateReason } : {}),
      executorId: record.executorId,
      ...(sessionId ? { sessionId } : {}),
      ...(details.model !== undefined ? { model: details.model } : {}),
      ...(details.reasoningEffort !== undefined ? { reasoningEffort: details.reasoningEffort } : {}),
      ...(details.context ? { context: details.context } : {}),
      ...(details.autoCompact ? { autoCompact: details.autoCompact } : {}),
      ...(details.fieldStates ? { fieldStates: details.fieldStates } : {}),
      ...(details.unavailable ? { unavailable: details.unavailable } : {}),
      ...(details.notices ? { notices: details.notices } : {}),
      ...(details.runtimeVersion !== undefined ? { runtimeVersion: details.runtimeVersion } : {}),
      credentials: details.credentials ?? harnessCredentialReport(this.harness, ctx.identity.workspace),
      ...(record.persistence ? { persistence: record.persistence } : {}),
      ...(record.mcpFiltered ? { mcpFiltered: record.mcpFiltered } : {}),
      turns: observed.status.turns ?? turns.length,
      ...(observed.status.lastOperationId ?? record.lastOperationId ? { lastOperationId: observed.status.lastOperationId ?? record.lastOperationId } : {}),
      lastTurnOutcome: observed.status.lastTurnOutcome ?? lastTurn?.outcome ?? null,
      queuedTurns: observed.status.queuedTurns ?? queued,
      lastTurnAt: observed.status.lastTurnAt ?? lastTurn?.endedAt ?? lastTurn?.startedAt ?? null,
      turnStartedAt: observed.status.turnStartedAt ?? null,
      idleSince: observed.state === 'idle' ? observed.status.idleSince ?? null : null,
      lastActivityAt,
      lastActivityAtSource,
      stateSource,
      ...(terminal ? { exitCode: observed.status.exitCode ?? null, signal: observed.status.signal ?? null } : {}),
      ...(pointer ? { session: pointer } : {}),
      ...(logTail ? { logTail } : {}),
      modelVerification,
      verification: {
        model: modelVerification,
        context: details.context?.percentSource === 'native' ? 'native' : 'derived',
      },
    };
  }

  /**
   * Deliver a follow-up turn to an owned executor.
   *
   * Running/idle executors queue the turn for the live protocol-3 supervisor.
   * A terminal executor (completed/failed/cancelled) is revived in the same
   * executor id and native session by relaunching its supervisor with a resume
   * carrier; the old inbox is swapped out atomically so no backlog is replayed.
   * An orphan (dead supervisor, live child) is refused until it is swept, so a
   * revival can never double-run a session.
   */
  async message(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    const record = await this.executorFor(request, ctx);
    if (!record) return { status: 'unauthorized', reason: 'Target is not owned by this caller' };
    const directory = executorDir(ctx.home, record.executorId);
    return withExecutorLock(directory, async () => {
      const observed = await this.observe(record, ctx);
      if (observed.processState === 'orphaned') {
        return {
          status: 'failed',
          reason: 'The supervisor is dead but its harness child is still alive; revive is refused until the orphan is cleaned with ai4ai sweep or a force stop',
          durable: true,
          state: observed.state,
          processState: 'orphaned',
          error: { code: 'executor-orphaned', message: 'Supervisor dead, child alive' },
        };
      }
      const live = observed.state === 'running' || observed.state === 'idle';
      if (live && observed.liveness.supervisorAlive === true) {
        return this.enqueueForLive(record, observed, request, ctx);
      }
      if (live && observed.liveness.supervisorAlive !== true) {
        return {
          status: 'failed',
          reason: 'The recorded lifecycle is live but the supervisor cannot be verified; start a new executor or run ai4ai sweep',
          durable: true,
          state: observed.state,
          processState: observed.processState,
          error: { code: 'message-supervisor-unavailable', message: 'Supervisor liveness could not be verified' },
        };
      }
      return this.revive(record, observed, request, ctx);
    }, { operation: `message:${request.operationId}` });
  }

  private async enqueueForLive(record: ExecutorRecord, observed: Observation, request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    if ((observed.status.protocol ?? 1) < 3) {
      return {
        status: 'failed',
        reason: 'This executor was started by an older supervisor (protocol < 3) that cannot report idle/turn semantics; start a new executor',
        durable: true,
        state: observed.state,
        error: { code: 'message-executor-protocol-too-old', message: `Supervisor protocol ${observed.status.protocol ?? 1} < 3` },
      };
    }
    const sessionId = await this.awaitSessionId(ctx.home, record, observed.status.sessionId ?? record.sessionId);
    if (!sessionId) {
      return {
        status: 'failed',
        reason: 'The executor has not reported a native session id yet; the message was not queued (a session-less turn would lose context)',
        durable: true,
        state: observed.state,
        error: { code: 'message-session-unknown', message: 'No session id observed' },
      };
    }
    const file = await this.writeTask(ctx, record.executorId, `message-${request.operationId}.prompt`, request.task ?? '');
    const resume = this.resumeRequest(record, request);
    let carrier: CarrierCommand;
    try {
      carrier = await this.carrier(resume, ctx, record.executorId, sessionId);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      return {
        status: 'failed',
        reason: `Could not build a resume command for the existing session; the executor was left untouched: ${error instanceof Error ? error.message : 'unknown error'}`,
        durable: true,
        state: observed.state,
        error: { code: typeof code === 'string' ? code : 'message-resume-failed', message: error instanceof Error ? error.message : 'unknown error' },
      };
    }
    const turnId = `turn-${randomUUID()}`;
    const queued = await enqueueTurn(ctx.home, record.executorId, {
      inputFile: path.basename(file),
      turnId,
      operationId: request.operationId,
      expectedSessionId: sessionId,
      command: carrier.command,
      args: carrier.args,
      ...(carrier.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    const after = await readStatus(ctx.home, record.executorId);
    const placement = await turnPlacement(ctx.home, record.executorId, queued);
    if (after && (after.supervisorPid === undefined || processAlive(after.supervisorPid) !== true)) {
      return {
        status: 'failed',
        reason: `The supervisor exited after the message was queued (${placement === 'pending' ? 'message file remains queued' : 'message was already claimed or consumed'})`,
        durable: true,
        state: observed.state,
        error: { code: 'message-supervisor-exited', message: `Supervisor exited; queue placement: ${placement}` },
      };
    }
    const position = await queuePositionOf(ctx.home, record.executorId, queued);
    await updateRecord(ctx.store, record.executorId, { state: 'running', lastOperationId: request.operationId });
    return {
      status: 'accepted',
      reason: placement === 'pending'
        ? 'Message queued for the executor next turn in its existing native session'
        : 'Message was already claimed by the executor for its next turn in its existing native session',
      durable: true,
      state: observed.state,
      sessionId,
      turnId,
      queuePosition: position,
      ...(record.persistence ? { persistence: record.persistence } : {}),
    };
  }

  /**
   * Revive a terminal executor in the same executor id and native session.
   * A missing session id is `session-unavailable`; a new session is never
   * started silently.
   */
  private async revive(record: ExecutorRecord, observed: Observation, request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    const sessionId = observed.status.sessionId ?? record.sessionId;
    if (!sessionId) {
      return {
        status: 'failed',
        reason: 'The executor has no recorded native session to resume; message cannot revive it without losing context. Start a new executor instead.',
        durable: true,
        state: observed.state,
        error: { code: 'session-unavailable', message: 'No recorded session id for revival' },
      };
    }
    const directory = executorDir(ctx.home, record.executorId);
    const resume = this.resumeRequest(record, request);
    let carrier: CarrierCommand;
    try {
      carrier = await this.carrier(resume, ctx, record.executorId, sessionId);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      return {
        status: 'failed',
        reason: `The carrier cannot resume this session; revival was not attempted: ${error instanceof Error ? error.message : 'unknown error'}`,
        durable: true,
        state: observed.state,
        error: { code: typeof code === 'string' ? code : 'resume-unsupported', message: error instanceof Error ? error.message : 'unknown error' },
      };
    }
    const file = await this.writeTask(ctx, record.executorId, `revive-${request.operationId}.prompt`, request.task ?? '');
    // Inbox epoch swap: old pending messages belong to the previous life and
    // must never be replayed into the revived session.
    const nextEpoch = (record.epoch ?? 1) + 1;
    await swapInbox(ctx.home, record.executorId, nextEpoch);
    const turnId = `turn-${randomUUID()}`;
    try {
      await launch({
        executorId: record.executorId, harness: this.harness, home: ctx.home,
        command: carrier.command, args: carrier.args,
        ...(carrier.env ? { env: carrier.env } : {}), ...(carrier.envExclude ? { envExclude: carrier.envExclude } : {}),
        ...(carrier.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        supervisorProtocol: 3,
        persistence: record.persistence ?? 'one-shot',
        epoch: nextEpoch,
        initialTurnId: turnId,
        initialOperationId: request.operationId,
        initialTurns: observed.status.turns ?? (await readTurns(ctx.home, record.executorId, 1)).length,
        expectedSessionId: sessionId,
        resident: (record.persistence ?? 'one-shot') === 'persistent' && this.carrierMode(resume) === 'resident',
        cwd: ctx.identity.workspace, taskFile: file,
        ...(carrier.sessionRegex ? { sessionRegex: carrier.sessionRegex } : {}),
      });
    } catch (error) {
      return {
        status: 'failed',
        reason: `Revival launch failed; the executor remains ${observed.state}: ${error instanceof Error ? error.message : 'unknown error'}`,
        durable: true,
        state: observed.state,
        error: { code: 'revive-failed', message: error instanceof Error ? error.message : 'unknown error' },
      };
    }
    // Revival audit: from-state, operator and time are recorded independently
    // of the human-readable reason, so a later reviewer can reconcile who
    // revived which terminal executor and from which state.
    await appendFile(path.join(directory, 'revival.ndjson'), JSON.stringify({
      operationId: request.operationId,
      executorId: record.executorId,
      fromState: observed.state,
      operator: ctx.identity,
      sessionId,
      at: new Date().toISOString(),
      epoch: nextEpoch,
    }) + '\n').catch(() => undefined);
    await updateRecord(ctx.store, record.executorId, {
      state: 'running', sessionId, lastOperationId: request.operationId, epoch: nextEpoch,
    });
    return {
      status: 'accepted',
      reason: 'Executor revived in its recorded native session with the new turn; the previous inbox epoch was not replayed',
      durable: true,
      state: 'running',
      sessionId,
      turnId,
      queuePosition: 1,
      ...(record.persistence ? { persistence: record.persistence } : {}),
    };
  }

  /** Bounded wait for the carrier's session id; never guesses or starts a new session. */
  private async awaitSessionId(home: string, record: ExecutorRecord, initial: string | undefined, timeoutMs = 2000): Promise<string | undefined> {
    let sessionId = initial;
    const deadline = Date.now() + timeoutMs;
    while (!sessionId && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const raw = await readStatus(home, record.executorId);
      sessionId = raw?.sessionId ?? sessionId;
    }
    return sessionId;
  }

  private resumeRequest(record: ExecutorRecord, request: Request): Request {
    return {
      ...request,
      ...(record.model ? { model: record.model } : {}),
      ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
      ...(record.spawn ? { spawn: record.spawn } : {}),
    };
  }

  async cancel(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    const record = await this.executorFor(request, ctx);
    if (!record) return { status: 'unauthorized', reason: 'Target is not owned by this caller' };
    return withExecutorLock(executorDir(ctx.home, record.executorId), async () => {
      const observed = await this.observe(record, ctx);
      if (observed.state !== 'running' && observed.state !== 'idle') {
        return { status: 'completed', reason: `Executor is already ${observed.state}`, durable: true, state: observed.state, processState: observed.processState };
      }
      if (observed.processState === 'orphaned') {
        const forced = await this.forceOrphan(record, observed, ctx);
        if (forced) return { status: 'completed', reason: 'Orphaned harness child was identity-verified and force-stopped; the executor is recorded cancelled', durable: true, state: 'cancelled', processState: 'dead' };
        return {
          status: 'failed',
          reason: 'The supervisor is dead and the child identity cannot be verified; nothing was killed. Resolve it manually (ai4ai sweep reports the pid).',
          durable: true,
          state: observed.state,
          processState: 'unknown',
          error: { code: 'orphan-unverified', message: 'Child identity could not be verified' },
        };
      }
      await requestStop(ctx.home, record.executorId);
      const deadline = Date.now() + Math.min(30000, Math.max(1000, request.timeoutMs ?? 15000));
      for (;;) {
        const current = await this.observe(record, ctx);
        // Supervisor-exit race: the supervisor can die before it writes the
        // terminal `cancelled` status, so the durable record still says
        // running/idle while the process is verifiably gone. We already
        // requested the stop, so the confirmed outcome is `cancelled`, not a
        // spurious failure.
        if (stopOutcome(current.status.state, current.processState) === 'cancelled') {
          await updateRecord(ctx.store, record.executorId, { state: 'cancelled' });
          return { status: 'completed', reason: 'Executor stopped (cancelled)', durable: true, state: 'cancelled', processState: 'dead' };
        }
        if (current.state !== 'running' && current.state !== 'idle') {
          await updateRecord(ctx.store, record.executorId, { state: current.state });
          return { status: 'completed', reason: `Executor stopped (${current.state})`, durable: true, state: current.state, processState: current.processState };
        }
        if (Date.now() >= deadline) return { status: 'pending', reason: 'Stop requested; the supervisor has not confirmed exit yet (the EOF→SIGTERM→SIGKILL ladder continues)', durable: true, state: current.state };
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }, { operation: `stop:${request.operationId}` });
  }

  /**
   * Graceful completion (`finish`): the supervisor exits 0 after the current
   * turn and the executor becomes `completed`. `stop` remains `cancelled`.
   * In-harness self-finish is unsupported: there is no supervisor to end.
   */
  async finish(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    if (!request.target || request.target === 'self') {
      return { status: 'unsupported', reason: 'finish targets a detached owned executor only; an in-harness session has no supervisor to complete', unavailable: ['finish.self'] };
    }
    const record = await this.executorFor(request, ctx);
    if (!record) return { status: 'unauthorized', reason: 'Target is not owned by this caller' };
    return withExecutorLock(executorDir(ctx.home, record.executorId), async () => {
      const observed = await this.observe(record, ctx);
      if (observed.processState === 'orphaned') {
        return { status: 'failed', reason: 'The executor is orphaned (dead supervisor, live child); sweep it before finishing', durable: true, state: observed.state, processState: 'orphaned', error: { code: 'executor-orphaned', message: 'Supervisor dead, child alive' } };
      }
      if (observed.state === 'completed') return { status: 'completed', reason: 'Executor is already completed', durable: true, state: 'completed', processState: observed.processState };
      if (observed.state === 'failed' || observed.state === 'cancelled' || observed.state === 'unknown') {
        return { status: 'completed', reason: `Executor is already ${observed.state}; finish does not rewrite a terminal outcome`, durable: true, state: observed.state, processState: observed.processState };
      }
      if (observed.liveness.supervisorAlive !== true) {
        return { status: 'failed', reason: 'The supervisor cannot be verified; finish was not recorded', durable: true, state: observed.state, processState: observed.processState, error: { code: 'message-supervisor-unavailable', message: 'Supervisor liveness could not be verified' } };
      }
      await requestFinish(ctx.home, record.executorId);
      const deadline = Date.now() + Math.min(60000, Math.max(1000, request.timeoutMs ?? 20000));
      for (;;) {
        const current = await this.observe(record, ctx);
        const terminalRecord = current.status.state === 'exited' || current.status.state === 'stopped' || current.status.state === 'failed';
        if (terminalRecord) {
          const settled: LifecycleState = current.status.state === 'exited'
            ? (current.status.exitCode === 0 ? 'completed' : 'failed')
            : current.status.state === 'stopped' ? 'cancelled' : 'failed';
          await updateRecord(ctx.store, record.executorId, { state: settled });
          return {
            status: settled === 'completed' ? 'completed' : 'pending',
            reason: `Finish requested; executor settled as ${settled}`,
            durable: true, state: settled, processState: current.processState,
            exitCode: current.status.exitCode ?? null, signal: current.status.signal ?? null,
          };
        }
        if (Date.now() >= deadline) return { status: 'pending', reason: 'Finish requested; the supervisor is completing the current turn', durable: true, state: current.state, processState: current.processState };
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }, { operation: `finish:${request.operationId}` });
  }

  /** Identity-verified force stop of an orphaned child; false when unverifiable. */
  private async forceOrphan(record: ExecutorRecord, observed: Observation, ctx: AdapterContext): Promise<boolean> {
    const childPid = observed.status.pid ?? observed.status.child?.pid;
    if (!childPid) return false;
    const recorded = observed.status.child ?? (await readChildIdentity(ctx.home, record.executorId));
    if (!recorded) return false;
    const verdict = verifyIdentity({
      pid: childPid,
      ...(recorded.startToken ? { startToken: recorded.startToken } : {}),
      ...(recorded.commandHash ? { commandHash: recorded.commandHash } : {}),
    });
    if (verdict.verdict !== 'match') return false;
    if (process.platform === 'win32') forceKillTree(childPid);
    else {
      try { process.kill(-childPid, 'SIGKILL'); } catch { /* not a group leader */ }
      forceKillTree(childPid);
    }
    await updateRecord(ctx.store, record.executorId, { state: 'cancelled' });
    return true;
  }

  /**
   * Observe an executor from durable state, always cross-checking supervisor
   * and child liveness separately. Which pid defines liveness depends on the
   * carrier, so `idle` is never misread as `failed` because a per-turn child
   * exited between turns.
   */
  protected async observe(record: ExecutorRecord, ctx: AdapterContext): Promise<Observation> {
    const raw = await readStatus(ctx.home, record.executorId);
    if (!raw) return { state: 'unknown', processState: 'unknown', processStateReason: 'No supervisor status recorded', liveness: {}, status: { state: 'unknown' } as ExecutorStatus, log: await readLog(ctx.home, record.executorId, 400) };
    const liveness = await livenessOf(ctx.home, record.executorId, raw);
    const state = lifecycleOfStatus(raw, liveness);
    const processState = processStateOf(raw, liveness);
    return {
      state,
      processState: processState.state,
      ...(processState.reason ? { processStateReason: processState.reason } : {}),
      liveness,
      status: raw,
      log: await readLog(ctx.home, record.executorId, 400),
    };
  }
}

/**
 * Terminal lifecycle for a confirmed stop request. A non-terminal durable status
 * with a dead process is the supervisor-exit race, and the stop outcome is
 * `cancelled`; a terminal status keeps its own meaning.
 */
export function stopOutcome(durableState: unknown, processState: unknown): 'cancelled' | null {
  if (processState !== 'dead') return null;
  return durableState === 'running' || durableState === 'idle' || durableState === 'unknown' ? 'cancelled' : null;
}

/** Supervisor + child liveness, fail-closed to null when unverifiable. */
export async function livenessOf(home: string, executorId: string, raw: ExecutorStatus): Promise<ExecutorLiveness> {
  const heartbeat = await readHeartbeat(executorDir(home, executorId));
  let supervisorAlive: boolean | null;
  if (heartbeat) supervisorAlive = heartbeatAlive(heartbeat);
  else if (raw.supervisorPid !== undefined) supervisorAlive = processAlive(raw.supervisorPid);
  else supervisorAlive = null;
  // A terminal status with a recorded supervisor pid that is gone makes the
  // outcome authoritative. Without any supervisor record (legacy executors),
  // liveness stays unknown rather than being invented from the status text.
  if (['exited', 'stopped', 'failed'].includes(raw.state) && raw.supervisorPid !== undefined && processAlive(raw.supervisorPid) !== true) supervisorAlive = false;
  const childAlive = raw.pid === undefined ? false : processAlive(raw.pid);
  return { supervisorAlive, childAlive };
}

async function readChildIdentity(home: string, executorId: string): Promise<{ startToken?: string; commandHash?: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(executorDir(home, executorId), 'child.json'), 'utf8')) as { startToken?: string; commandHash?: string };
    return { ...(value.startToken ? { startToken: value.startToken } : {}), ...(value.commandHash ? { commandHash: value.commandHash } : {}) };
  } catch { return undefined; }
}

/** Move the current inbox aside and start an empty generation. */
async function swapInbox(home: string, executorId: string, epoch: number): Promise<void> {
  const directory = executorDir(home, executorId);
  const inbox = path.join(directory, 'inbox');
  try {
    await rename(inbox, path.join(directory, `inbox-epoch-${epoch - 1}`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(inbox, { recursive: true, mode: 0o700 });
}

/** Persisted spawn options: drop undefined values so the record stays stable. */
function sanitizeSpawnOptions(spawn: NonNullable<Request['spawn']>): NonNullable<Request['spawn']> {
  const result: NonNullable<Request['spawn']> = {};
  if (spawn.persistence) result.persistence = spawn.persistence;
  if (spawn.surface) result.surface = spawn.surface;
  if (spawn.profile) result.profile = spawn.profile;
  if (spawn.permissionMode) result.permissionMode = spawn.permissionMode;
  if (spawn.allowedTools?.length) result.allowedTools = [...spawn.allowedTools];
  if (spawn.disallowedTools?.length) result.disallowedTools = [...spawn.disallowedTools];
  if (spawn.envExclude?.length) result.envExclude = [...spawn.envExclude];
  if (spawn.mcp?.deny?.length) result.mcp = { deny: [...spawn.mcp.deny] };
  if (spawn.origin) result.origin = spawn.origin;
  return result;
}

/** Read the filtered MCP names/count from an adapter-written config. */
export async function readFilteredMcp(executorDirectory: string): Promise<{ names: string[]; count: number } | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(executorDirectory, 'mcp.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
    const names = Object.keys(value.mcpServers ?? {});
    return { names, count: names.length };
  } catch { return undefined; }
}

/** Extract the last JSON object line matching a predicate from carrier output. */
export function lastJson(log: readonly LogLine[], accept: (value: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  for (let index = log.length - 1; index >= 0; index--) {
    const line = log[index]!.line.trim();
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (accept(value)) return value;
    } catch { /* not JSON */ }
  }
  return undefined;
}

export function contextFromUsage(input: unknown, window: unknown): ContextInfo {
  // Token counts are integers. A platform value that is not a non-negative
  // integer is an unreliable conversion and becomes null, never a mixed unit.
  const used = typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? input : null;
  const win = typeof window === 'number' && Number.isSafeInteger(window) && window > 0 ? window : null;
  return {
    window: win,
    used,
    percent: used !== null && win !== null ? Math.min(100, Math.round((used / win) * 1000) / 10) : null,
    percentSource: used !== null && win !== null ? 'derived' : null,
  };
}

export type { Result, LogTail, TurnOutcome, ProcessState };
