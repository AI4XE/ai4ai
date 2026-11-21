import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Adapter, AdapterContext, NativeOutcome } from './types.js';
export type { AdapterContext, NativeOutcome, Adapter } from './types.js';
import type {
  AutoCompact, CapabilityDeclaration, ContextInfo, Request, Result,
} from '../contract/types.js';
import type { HarnessId, LifecycleState, Os } from '../contract/states.js';
import type { ExecutorRecord } from '../core/store.js';
import { normalizePolicy } from '../core/policy.js';
import { newExecutorId, ownedBy } from '../core/operations.js';
import {
  enqueueTurn, executorDir, launch, lifecycleOfStatus, pidAlive, readLog, readStatus, requestStop, turnPlacement,
  type ExecutorStatus, type LogLine,
} from './executors.js';
import { sessionActivity, sessionPointer } from '../core/session-probe.js';

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
  fieldStates?: Record<string, 'unsupported' | 'unavailable' | 'unknown'>;
  unavailable?: string[];
}

/**
 * Base for adapters whose spawn carrier is a detached OS process.
 *
 * `spawn`, `message`, `cancel` and `status` are real file-backed operations;
 * `handoff` is deliberately unsupported externally because a one-shot headless
 * turn has no in-place context to replace. In-harness plugins implement handoff
 * with their native in-process API.
 */
export abstract class ExternalExecutorAdapter implements Adapter {
  abstract readonly harness: HarnessId;
  abstract capabilities(os: Os): CapabilityDeclaration[];
  /** Build the first-turn command for a new detached executor, or the resume command for an existing session. */
  protected abstract carrier(request: Request, ctx: AdapterContext, executorId: string, resumeSessionId?: string): Promise<CarrierCommand>;
  /** Adapter-specific context/model/reasoning-effort extraction from the carrier output. */
  protected statusDetails(_record: ExecutorRecord, _status: ExecutorStatus, _log: LogLine[], _ctx: AdapterContext): StatusDetails | Promise<StatusDetails> { return {}; }

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

  async handoff(request: Request, _ctx: AdapterContext): Promise<NativeOutcome> {
    return {
      status: 'unsupported',
      reason: 'External process control cannot replace a live context in place; self-handoff is provided by the installed in-harness plugin',
      unavailable: ['handoff.external'],
    };
  }

  async spawn(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    const count = request.count ?? 1;
    const ids = Array.from({ length: count }, () => newExecutorId(this.harness));
    const created: ExecutorRecord[] = [];
    try {
      for (const executorId of ids) {
        const carrier = await this.carrier(request, ctx, executorId);
        const taskFile = await this.writeTask(ctx, executorId, 'spawn.prompt', request.task ?? '');
        const model = await this.persistedModel(request, ctx);
        const reasoningEffort = await this.persistedReasoningEffort(request, ctx);
        const record: ExecutorRecord = {
          format: 2, kind: 'executor', executorId, parent: ctx.identity, harness: this.harness,
          surface: 'headless', policy: normalizePolicy(request.policy), isolation: request.isolation ?? 'inherit',
          state: 'running', createdAt: new Date().toISOString(),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          carrier: { detached: true, command: [carrier.command, ...carrier.args] },
        };
        created.push(record);
        await ctx.store.addExecutors([record]);
        await launch({
          executorId, harness: this.harness, home: ctx.home, command: carrier.command, args: carrier.args,
          ...(carrier.env ? { env: carrier.env } : {}), ...(carrier.envExclude ? { envExclude: carrier.envExclude } : {}),
          ...(carrier.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
          supervisorProtocol: 2,
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

  private async executorFor(request: Request, ctx: AdapterContext): Promise<ExecutorRecord | undefined> {
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
    return {
      status: observed.state === 'running' ? 'pending' : 'completed',
      reason: observed.state === 'running' ? 'Executor process is running' : `Executor process is ${observed.state}`,
      durable: true,
      state: observed.state,
      executorId: record.executorId,
      ...(sessionId ? { sessionId } : {}),
      ...(details.model !== undefined ? { model: details.model } : {}),
      ...(details.reasoningEffort !== undefined ? { reasoningEffort: details.reasoningEffort } : {}),
      ...(details.context ? { context: details.context } : {}),
      ...(details.autoCompact ? { autoCompact: details.autoCompact } : {}),
      ...(details.fieldStates ? { fieldStates: details.fieldStates } : {}),
      ...(details.unavailable ? { unavailable: details.unavailable } : {}),
      lastActivityAt,
      lastActivityAtSource,
      stateSource,
      ...(terminal ? { exitCode: observed.status.exitCode ?? null, signal: observed.status.signal ?? null } : {}),
      ...(pointer ? { session: pointer } : {}),
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
   * Only a running executor with a live protocol-2 supervisor is served: the
   * turn is queued for that supervisor and resumes the same native session.
   * Idle/exited executors fail structurally instead of silently starting a new
   * session (which would lose the previous context).
   */
  async message(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    const record = await this.executorFor(request, ctx);
    if (!record) return { status: 'unauthorized', reason: 'Target is not owned by this caller' };
    const observed = await this.observe(record, ctx);
    // Same lifecycle vocabulary as status/list (one raw status -> one state).
    if (observed.state !== 'running') {
      return {
        status: 'failed',
        reason: `Executor is ${observed.state}; a message is only queued for a running executor. Start a new executor instead.`,
        durable: true,
        state: observed.state,
        error: { code: 'message-executor-not-running', message: `Executor state is ${observed.state}` },
      };
    }
    if (!pidAlive(observed.status.supervisorPid)) {
      return {
        status: 'failed',
        reason: 'The detached supervisor is not alive; start a new executor instead of messaging a stale record',
        durable: true,
        state: 'running',
        error: { code: 'message-executor-not-running', message: 'Supervisor is not alive' },
      };
    }
    if ((observed.status.protocol ?? 1) < 2) {
      // v0.0.3 supervisors ignore per-turn command/args and would silently start
      // a new session. Refuse instead of losing context.
      return {
        status: 'failed',
        reason: 'This executor was started by an older supervisor that cannot resume its native session; start a new executor',
        durable: true,
        state: 'running',
        error: { code: 'message-executor-protocol-too-old', message: `Supervisor protocol ${observed.status.protocol ?? 1} < 2` },
      };
    }
    const sessionId = await this.awaitSessionId(ctx.home, record, observed.status);
    if (!sessionId) {
      return {
        status: 'failed',
        reason: 'The executor has not reported a native session id yet; the message was not queued (a session-less turn would lose context)',
        durable: true,
        state: 'running',
        error: { code: 'message-session-unknown', message: 'No session id observed within the bounded wait' },
      };
    }
    const file = await this.writeTask(ctx, record.executorId, `message-${request.operationId}.prompt`, request.task ?? '');
    // The message schema forbids model/effort; merge the values recorded at
    // spawn so the resumed turn keeps the original route.
    const resume: Request = {
      ...request,
      ...(record.model ? { model: record.model } : {}),
      ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
    };
    let carrier: CarrierCommand;
    try {
      carrier = await this.carrier(resume, ctx, record.executorId, sessionId);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      return {
        status: 'failed',
        reason: `Could not build a resume command for the existing session; the executor was left untouched: ${error instanceof Error ? error.message : 'unknown error'}`,
        durable: true,
        state: 'running',
        error: {
          code: typeof code === 'string' ? code : 'message-resume-failed',
          message: error instanceof Error ? error.message : 'unknown error',
        },
      };
    }
    const queued = await enqueueTurn(ctx.home, record.executorId, {
      inputFile: path.basename(file),
      command: carrier.command,
      args: carrier.args,
      ...(carrier.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    // Recheck after publication: the supervisor may have exited in between.
    // This is a best-effort narrowing of a file-based TOCTOU window, not a
    // claim that none exists.
    const after = await readStatus(ctx.home, record.executorId);
    const placement = await turnPlacement(ctx.home, record.executorId, queued);
    if (!pidAlive(after?.supervisorPid)) {
      return {
        status: 'failed',
        reason: `The supervisor exited after the message was queued (${placement === 'pending' ? 'message file remains queued' : 'message was already claimed or consumed'})`,
        durable: true,
        state: 'running',
        error: { code: 'message-supervisor-exited', message: `Supervisor exited; queue placement: ${placement}` },
      };
    }
    return {
      status: 'accepted',
      reason: placement === 'pending'
        ? 'Message queued for the executor next turn in its existing native session'
        : 'Message was already claimed by the executor for its next turn in its existing native session',
      durable: true,
      state: 'running',
      sessionId,
    };
  }

  /** Bounded wait for the carrier's session id; never guesses or reuses first-turn args. */
  private async awaitSessionId(home: string, record: ExecutorRecord, status: ExecutorStatus, timeoutMs = 2000): Promise<string | undefined> {
    let sessionId = status.sessionId ?? record.sessionId;
    const deadline = Date.now() + timeoutMs;
    while (!sessionId && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const raw = await readStatus(home, record.executorId);
      sessionId = raw?.sessionId ?? sessionId;
    }
    return sessionId;
  }

  async cancel(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    const record = await this.executorFor(request, ctx);
    if (!record) return { status: 'unauthorized', reason: 'Target is not owned by this caller' };
    const observed = await this.observe(record, ctx);
    if (observed.state !== 'running') return { status: 'completed', reason: `Executor is already ${observed.state}`, durable: true, state: observed.state };
    await requestStop(ctx.home, record.executorId);
    const deadline = Date.now() + Math.min(15000, Math.max(1000, request.timeoutMs ?? 10000));
    for (;;) {
      const current = await this.observe(record, ctx);
      if (current.state !== 'running') return { status: 'completed', reason: `Executor stopped (${current.state})`, durable: true, state: current.state };
      if (Date.now() >= deadline) return { status: 'pending', reason: 'Stop requested; the executor has not confirmed exit yet', durable: true, state: 'running' };
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  /**
   * Observe an executor from durable state, always cross-checking pid liveness:
   * a live pid is never reported completed/cancelled, and a dead pid with no
   * recorded clean exit is failed (exitCode/signal when known, null otherwise).
   */
  protected async observe(record: ExecutorRecord, ctx: AdapterContext): Promise<{ state: LifecycleState; status: ExecutorStatus; log: LogLine[] }> {
    const raw = await readStatus(ctx.home, record.executorId);
    if (!raw) return { state: 'unknown', status: { state: 'unknown' } as ExecutorStatus, log: await readLog(ctx.home, record.executorId, 400) };
    const alive = raw.pid === undefined ? null : pidAlive(raw.pid);
    // The recorded state is internal (starting/stopping/exited); the contract
    // exposes only the shared lifecycle vocabulary.
    return { state: lifecycleOfStatus(raw, alive), status: raw, log: await readLog(ctx.home, record.executorId, 400) };
  }
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

export type { Result };
