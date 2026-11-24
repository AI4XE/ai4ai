import { existsSync, readFileSync } from 'node:fs';
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { AdapterContext, CarrierCommand, StatusDetails, NativeOutcome } from '../external.js';
import { ExternalExecutorAdapter, contextFromUsage } from '../external.js';
import type { AdoptionProof, CapabilityDeclaration, Identity, Request } from '../../contract/types.js';
import { handoffMode, handoffOutcome } from '../../contract/states.js';
import type { HarnessId, Os, StoredProofMechanism } from '../../contract/states.js';
import type { ExecutorRecord } from '../../core/store.js';
import { executorDir, pidAlive, type LogLine, type ExecutorStatus } from '../executors.js';
import { declaration } from '../declarations.js';
import { CodexDaemon, daemonSocket, resolveTuiThread, type CodexThread } from './control.js';
import { legacyProofMechanism, sameSessionProof } from '../../core/handoff.js';
import { taskDelivery } from '../../core/handoff-delivery.js';
import { codexSessionUsage } from '../../core/session-probe.js';
import { envValue, probeCodexConfig, probeCodexModelInfo, codexAutoCompact } from '../../core/config-probe.js';
import { firstVerified, verifiedText, verifiedTokens, verifiedWindow } from '../../core/ladder.js';
import { PRODUCT_VERSION } from '../../contract/version.js';

/**
 * Codex adapter.
 *
 * Carriers are per-executor `codex app-server` processes driven by
 * `runner.js`; the protocol is upstream-experimental. Same-window handoff uses
 * the local app-server daemon that the interactive TUI already runs: revert the
 * live thread to its start, then start the material turn in the same thread.
 * There is no tmux/new-thread fallback: a session without a reachable daemon
 * returns a structured `codex-no-daemon` boundary.
 */

/** Resolve a harness binary against the caller's PATH so detached carriers do not depend on the supervisor PATH. */
function resolveBinary(name: string): string | undefined {
  if (path.isAbsolute(name)) return name;
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * A TUI-hosted shell may expose a filtered environment. Resolve a complete
 * PATH explicitly so the detached `codex app-server` can start, and carry the
 * provider environment keys declared by the Codex config (`env_key`) through to
 * the executor when they are present in the caller's environment.
 */
function carrierPath(codexBinary: string | undefined): string {
  const entries = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    path.dirname(process.execPath),
    ...(codexBinary ? [path.dirname(codexBinary)] : []),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ].filter((entry): entry is string => Boolean(entry));
  return [...new Set(entries)].join(path.delimiter);
}

function providerEnv(codexHome: string | undefined): Record<string, string> {
  try {
    const file = path.join(codexHome ?? path.join(homedir(), '.codex'), 'config.toml');
    const text = readFileSync(file, 'utf8');
    const names = [...text.matchAll(/env_key\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)"/g)].map(match => match[1]!);
    const selected: Record<string, string> = {};
    for (const name of new Set(names)) {
      const value = process.env[name];
      if (value !== undefined) selected[name] = value;
    }
    return selected;
  } catch { return {}; }
}

export class CodexAdapter extends ExternalExecutorAdapter {
  readonly harness: HarnessId = 'codex';

  capabilities(os: Os): CapabilityDeclaration[] {
    const linux = os === 'linux';
    const mac = os === 'darwin';
    // macOS authentication is the opencode-go provider via OPENCODE_API_KEY,
    // not `codex login`. Codex 0.170.0 was exercised on macOS: go/no-go
    // (thread/revert, old secret UNKNOWN, no compact), a headless restart
    // handoff and a TUI restart handoff all completed in the same thread. The
    // native compact opt-in was not exercised on macOS, so it is not claimed
    // there.
    const reason = linux
      ? 'Linux headless spawn/status and the same-thread restart handoff were verified with a real app-server: thread/revert to the thread start, then the material turn in the same thread id with no summary call. TUI restart uses the shared daemon and the same revert; compact is the explicit native-summary opt-in. A Codex-hosted shell reports self status from the identity-bound native rollout (CODEX_THREAD_ID plus workspace). The app-server protocol is upstream-experimental.'
      : mac
        ? 'macOS was exercised with Codex 0.170.0 using the opencode-go provider from the environment (not `codex login`): thread/revert preserved the thread, the headless handoff and the TUI handoff both completed in the same thread, and the old codeword was not in the replaced live context. Native compact was not exercised on macOS, so only restart is claimed. The app-server protocol is upstream-experimental.'
        : 'Codex is supported via WSL on Windows; native Windows harness integration is out of scope and was not exercised.';
    const level = linux || mac ? 'supported' as const : 'not-tested' as const;
    const modes = (linux ? ['restart', 'compact'] : ['restart']) as ('compact' | 'restart')[];
    const common = {
      handoff: { availability: level, modes, self: { modes }, executor: { modes: ['restart', 'compact', 'rotation'] as ('compact' | 'restart' | 'rotation')[] } },
      spawn: {
        availability: level, maxConcurrent: 4,
        persistenceModes: ['one-shot', 'persistent'] as ('one-shot' | 'persistent')[],
        surfaces: ['headless'] as ('headless' | 'web')[],
        permissionModes: [] as ('bypassPermissions' | 'dontAsk')[],
        mcpFilter: 'not-tested' as const,
      },
      events: 'normalized' as const,
      status: { availability: level, model: level, reasoningEffort: level, context: level, percentSource: 'derived' as const, autoCompact: 'supported' as const },
      ...(linux || mac ? { evidence: `matrix:codex/${os}/2026-11-22` } : {}),
    };
    return [
      declaration({ harness: 'codex', os, interface: 'headless', reason, experimental: ['app-server'], ...common }),
      declaration({ harness: 'codex', os, interface: 'tui', reason, experimental: ['app-server'], ...common }),
    ];
  }

  /**
   * Codex self status.
   *
   * A Codex-hosted shell carries `CODEX_THREAD_ID` (verified 0.171.0), so the
   * caller can observe its own live thread without an executor record. The
   * rollout must declare both that thread id and this workspace; anything else
   * is a structured refusal, never a guess from the newest file. Detached
   * executors keep the supervisor-owned status path.
   */
  async status(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    if (request.target !== 'self' || ctx.executorId || !process.env.CODEX_THREAD_ID) return super.status(request, ctx);
    const thread = process.env.CODEX_THREAD_ID;
    const usage = await codexSessionUsage(ctx.identity.workspace, thread, process.env.CODEX_HOME).catch(() => null);
    if (!usage) {
      return {
        status: 'unknown',
        reason: 'The live Codex thread is not present in the native session store for this workspace; no status is fabricated',
        durable: false,
        unavailable: ['status.session'],
        error: { code: 'codex-self-unread', message: `No rollout for thread ${thread} in this workspace` },
      };
    }
    const details = await codexUsage(path.join(ctx.home, '.self'), {
      workspace: ctx.identity.workspace,
      sessionId: thread,
      ...(process.env.CODEX_HOME ? { codexHome: process.env.CODEX_HOME } : {}),
    }).catch((): StatusDetails => ({}));
    const state = usage.lastEvent === 'task_complete' ? 'idle' as const : 'running' as const;
    return {
      status: 'completed',
      reason: 'Codex session status read from the native rollout store',
      durable: true,
      state,
      processState: 'alive',
      sessionId: thread,
      turns: usage.turns ?? 0,
      ...(state === 'idle' ? { lastTurnOutcome: 'completed' as const, idleSince: null } : {}),
      ...(details.model !== undefined ? { model: details.model } : {}),
      ...(details.reasoningEffort !== undefined ? { reasoningEffort: details.reasoningEffort } : {}),
      ...(details.context ? { context: details.context } : {}),
      ...(details.fieldStates ? { fieldStates: details.fieldStates } : {}),
      ...(details.unavailable ? { unavailable: details.unavailable } : {}),
      ...(details.modelVerification ? { modelVerification: details.modelVerification } : {}),
    };
  }

  /**
   * A detached Codex executor inherits the profile model and reasoning effort:
   * the runner starts a thread without per-request overrides. Refuse them
   * loudly instead of accepting values that would never reach the harness.
   */
  async spawn(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    const unavailable: string[] = [];
    if (request.model !== undefined) unavailable.push('spawn.model');
    if (request.reasoningEffort !== undefined) unavailable.push('spawn.reasoningEffort');
    if (unavailable.length) {
      return {
        status: 'unsupported',
        reason: `codex detached executors inherit the profile model and reasoning effort; overrides are not applied (${unavailable.join(', ')}); configure the Codex profile instead and omit them`,
        unavailable,
      };
    }
    return super.spawn(request, ctx);
  }

  protected async carrier(request: Parameters<ExternalExecutorAdapter['spawn']>[0], ctx: AdapterContext, _executorId: string, resumeSessionId?: string): Promise<CarrierCommand> {
    if (process.platform === 'darwin' && process.env.CODEX_SANDBOX && process.env.CODEX_SANDBOX !== 'none') {
      throw new Error(
        'The caller runs inside the Codex seatbelt sandbox, which confines every descendant process; a detached executor cannot write its app-server runtime outside the workspace. '
        + 'Run the harness outside the seatbelt sandbox for team/spawn cells (for example: codex --sandbox danger-full-access).',
      );
    }
    const runner = existsSync(path.join(ctx.home, 'dist', 'adapters', 'codex', 'runner.js'))
      ? path.join(ctx.home, 'dist', 'adapters', 'codex', 'runner.js')
      : new URL('./runner.js', import.meta.url).pathname;
    const codexBinary = resolveBinary(process.env.AI4AI_CODEX_BIN || 'codex');
    return {
      command: process.execPath,
      args: [runner, ...(resumeSessionId ? ['--thread', resumeSessionId] : [])],
      env: {
        PATH: carrierPath(codexBinary),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.USER ? { USER: process.env.USER } : {}),
        ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
        ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
        ...providerEnv(process.env.CODEX_HOME),
        AI4AI_CODEX_CWD: ctx.identity.workspace,
        AI4AI_CODEX_BIN: codexBinary ?? (process.env.AI4AI_CODEX_BIN || 'codex'),
        ...(request.model ? { AI4AI_CODEX_MODEL: request.model } : {}),
      },
      sessionRegex: '"session_id"\\s*:\\s*"([^"]+)"',
    };
  }

  /**
   * Same-window handoff through the local app-server daemon.
   *
   * The daemon owns the TUI's live thread. Reverting it and starting the
   * material turn through the daemon changes what the user sees in the same
   * window: a reset history followed by the handoff task as the next turn.
   * When no daemon or live thread is reachable, the call fails as the
   * structured `codex-no-daemon` host boundary; no new thread is created.
   */
  async handoff(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    if (request.target !== 'self') {
      // Executor-target restart/compact uses the durable request + control turn
      // consumed by the executor's runner; rotation is executed by the core.
      return super.handoff(request, ctx);
    }
    if (request.surface !== undefined && request.surface !== 'preserve') {
      return { status: 'unsupported', reason: 'Codex handoff preserves the surface; cross-surface handoff is not implemented', unavailable: ['handoff.crossSurface'] };
    }
    const mode = handoffMode(request.mode);
    if (mode === 'rotation') {
      return { status: 'unsupported', reason: 'Rotation stops and respawns an owned executor; a session cannot rotate itself', unavailable: ['handoff.self.rotation'] };
    }
    // A detached Codex executor is itself an app-server thread. It owns its
    // thread id and its app-server connection (held by the runner), so the
    // restart or compact successor is applied by that runner at the turn boundary.
    if (ctx.identity.surface === 'headless' || ctx.executorId !== undefined) {
      return headlessSelfHandoff(request, ctx, mode);
    }
    return mode === 'compact' ? this.tuiCompact(request, ctx) : this.tuiRestart(request, ctx);
  }

  /**
   * Re-query a pending handoff written by the headless runner or the detached
   * TUI watcher. Without this, the same operationId would return the original
   * pending result forever even after the native side completed.
   *
   * An external caller re-querying an executor-target handoff has no
   * `AI4AI_EXECUTOR_DIR`/`AI4AI_EXECUTOR_ID`, so the TUI/self file lookup
   * alone cannot see the executor's handoff-status. Try the shared
   * executor-target reconcile first; fall back to the Codex-local files.
   */
  async reconcileHandoff(request: Request, ctx: AdapterContext): Promise<NativeOutcome | undefined> {
    const executor = await super.reconcileHandoff(request, ctx);
    if (executor) return executor;
    return reconcileCodexHandoff(request, ctx);
  }

  /**
   * Native TUI restart. The TUI's shared app-server daemon owns the live
   * thread; a detached watcher waits for the safe point, archives best-effort,
   * reverts the thread to its start and starts the material turn in the same
   * thread. No tmux, no `/new`, no new thread.
   */
  private async tuiRestart(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    if (!request.task) {
      return { status: 'unsupported', reason: 'A restart handoff needs task material; the new context contains only that material', unavailable: ['handoff.task'] };
    }
    const socket = await daemonSocket(process.env.AI4AI_CODEX_BIN || 'codex');
    if (!socket) {
      return {
        status: 'unsupported',
        reason: 'The Codex TUI exposes no reachable app-server daemon (embedded server or --no-daemon); ai4ai has no native control channel to replace its context in place',
        unavailable: ['handoff.restart'],
        error: { code: 'codex-no-daemon', message: 'No reachable app-server daemon' },
      };
    }
    let daemon: CodexDaemon | undefined;
    try { daemon = await CodexDaemon.connect(socket); } catch { daemon = undefined; }
    if (!daemon) {
      return {
        status: 'unsupported',
        reason: 'The Codex app-server daemon did not accept a control connection; the handoff cannot be driven without changing the session',
        unavailable: ['handoff.restart'],
        error: { code: 'codex-no-daemon', message: 'Daemon connection failed' },
      };
    }
    try {
      await daemon.call('initialize', { clientInfo: { name: 'ai4ai', version: PRODUCT_VERSION } });
      const resolution = await resolveTuiThread(daemon, ctx.identity.workspace, process.env.AI4AI_CODEX_THREAD);
      if (!resolution.ok) {
        return {
          status: 'unsupported',
          reason: resolution.reason,
          unavailable: ['handoff.thread'],
          error: { code: resolution.code, message: resolution.reason },
        };
      }
      const threadId = resolution.thread.id;
      const marker = `ai4ai-context-${randomUUID()}`;
      const directory = path.join(ctx.home, '.ai4ai', 'codex', 'tui-handoff');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const payloadFile = path.join(directory, `${request.operationId.replace(/[^A-Za-z0-9._-]/g, '_')}.payload.json`);
      const payload = {
        home: ctx.home, identity: ctx.identity, request, operationId: request.operationId, marker, threadId, socket,
        archiveDir: path.join(ctx.home, '.ai4ai', 'handoff-archive', threadId, new Date().toISOString().replace(/[:.]/g, '-')),
        startedAt: new Date().toISOString(),
        timeoutMs: Math.min(Math.max(request.timeoutMs ?? 10 * 60 * 1000, 1000), 30 * 60 * 1000),
      };
      await writeFile(payloadFile, JSON.stringify(payload, null, 2) + '\n');
      const watcher = fileURLToPath(new URL('./tui-daemon-watch.js', import.meta.url));
      const child = spawn(process.execPath, [watcher, payloadFile], { detached: true, stdio: 'ignore', env: process.env });
      child.unref();
      return {
        status: 'pending',
        reason: `The same-thread restart is scheduled at the turn boundary on thread ${threadId}: thread/revert to the thread start, then the material turn`,
        durable: true, state: 'running', handoff: { phase: 'pending' }, sessionId: threadId,
        notices: [{
          code: 'codex-tui-handoff', impact: 'none', action_required: false,
          message: 'Finish the current turn; the watcher reverts the same thread and delivers the material there.',
        }],
        verification: { model: 'unknown', context: 'reported' },
      };
    } finally { daemon.close(); }
  }

  /**
   * Explicit compact opt-in for the TUI: the harness's native compaction runs
   * (and may spend summary tokens), then the material is the next turn in the
   * same thread. Proof uses the native thread id for both source and successor.
   */
  private async tuiCompact(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    if (!request.task) {
      return { status: 'unsupported', reason: 'A compact handoff needs task material to deliver after the native summary', unavailable: ['handoff.task'] };
    }
    const socket = await daemonSocket(process.env.AI4AI_CODEX_BIN || 'codex');
    if (!socket) {
      return {
        status: 'unsupported',
        reason: 'No reachable Codex app-server daemon for the native compact handoff',
        unavailable: ['handoff.compact'],
        error: { code: 'codex-no-daemon', message: 'No reachable app-server daemon' },
      };
    }
    let daemon: CodexDaemon | undefined;
    try { daemon = await CodexDaemon.connect(socket); } catch { daemon = undefined; }
    if (!daemon) {
      return { status: 'unsupported', reason: 'The Codex app-server daemon did not accept a control connection', unavailable: ['handoff.compact'], error: { code: 'codex-no-daemon', message: 'Daemon connection failed' } };
    }
    let mutated = false;
    try {
      return await nativeCompactHandoff(daemon, request, ctx, () => { mutated = true; });
    } catch (error) {
      if (error instanceof NoLiveThread) {
        return { status: 'unsupported', reason: error.message, unavailable: ['handoff.thread'], error: { code: 'codex-thread-unresolved', message: error.message } };
      }
      return {
        status: mutated ? 'unknown' : 'failed',
        reason: `Codex compact handoff ${mutated ? 'started but could not be confirmed' : 'failed'}: ${error instanceof Error ? error.message : 'unknown error'}`,
        durable: mutated,
        state: mutated ? 'unknown' : 'failed',
        unavailable: ['handoff.native'],
        error: { code: 'codex-native-handoff', message: error instanceof Error ? error.message : 'unknown error' },
      };
    } finally { daemon.close(); }
  }

  protected async statusDetails(record: ExecutorRecord, status: ExecutorStatus, _log: LogLine[], ctx: AdapterContext): Promise<StatusDetails> {
    return codexUsage(executorDir(ctx.home, record.executorId), {
      workspace: ctx.identity.workspace,
      ...((status.sessionId ?? record.sessionId) ? { sessionId: status.sessionId ?? record.sessionId } : {}),
    });
  }
}

export const codexAdapter = new CodexAdapter();

class NoLiveThread extends Error {}

/** Handoff intent file written by the executor CLI and applied by its runner. */
const HANDOFF_FILE = 'handoff.json';

async function readJson(file: string): Promise<any | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; }
}

function executorDirectory(ctx: AdapterContext): string | undefined {
  if (process.env.AI4AI_EXECUTOR_DIR) return process.env.AI4AI_EXECUTOR_DIR;
  const id = ctx.executorId ?? process.env.AI4AI_EXECUTOR_ID;
  return id ? executorDir(ctx.home, id) : undefined;
}

/**
 * Headless self-handoff intent.
 *
 * The detached runner owns the executor's app-server process and thread
 * connection; a separate CLI process cannot drive that stdio channel. The
 * executor records a durable intent and finishes its turn, and the runner
 * applies it at the turn boundary: `thread/revert` to the thread start (same
 * thread id, no summary) and then the material turn in that thread.
 */
async function headlessSelfHandoff(request: Request, ctx: AdapterContext, mode: 'restart' | 'compact'): Promise<NativeOutcome> {
  const directory = executorDirectory(ctx);
  if (!directory) {
    return { status: 'unsupported', reason: 'No detached executor binding was found; only the owning executor can replace its own thread context', unavailable: ['handoff.executor'] };
  }
  const status = await readJson(path.join(directory, 'status.json'));
  const threadId = (typeof status?.sessionId === 'string' ? status.sessionId as string : undefined) ?? process.env.AI4AI_CODEX_THREAD;
  if (!threadId) {
    return {
      status: 'unknown', reason: 'The executor thread id has not been recorded yet; the runner cannot target its own thread',
      unavailable: ['handoff.thread'], error: { code: 'codex-thread-unknown', message: 'No executor thread id is available' },
    };
  }
  const file = path.join(directory, HANDOFF_FILE);
  const existing = await readJson(file);
  if (existing && existing.operationId === request.operationId) {
    return handoffRecordOutcome(existing, threadId, mode);
  }
  if (existing && !['completed', 'applied', 'failed', 'cancelled'].includes(String(existing.phase))) {
    return {
      status: 'failed', reason: 'Another handoff is still pending on this executor; only one context replacement can be applied per turn boundary',
      error: { code: 'handoff-busy', message: `Pending operation ${String(existing.operationId)}` },
    };
  }
  const proofMechanism = mode === 'restart' ? 'surface-replacement' : 'native-compaction';
  const record = {
    format: 2, kind: 'handoff', operationId: request.operationId, request, source: ctx.identity,
    executorId: ctx.executorId ?? process.env.AI4AI_EXECUTOR_ID, threadId, mode, mechanism: mode, proofMechanism,
    phase: 'intent', createdAt: new Date().toISOString(),
  };
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2) + '\n');
  await rename(temporary, file);
  return {
    status: 'pending',
    reason: mode === 'restart'
      ? 'The detached runner owns this thread; at the turn boundary it reverts the same thread to its start (no summary) and delivers the material'
      : 'The detached runner owns this app-server thread; it compacts the thread and starts the successor turn when the current turn completes',
    durable: true, state: 'running', handoff: { phase: 'pending' }, sessionId: threadId,
    notices: [{
      code: 'codex-headless-handoff', impact: 'none', action_required: false,
      message: 'Finish the current turn; the runner applies the handoff at the turn boundary.',
    }],
    verification: { model: 'unknown', context: 'reported' },
  };
}

/** Native thread identity for proof: the thread id, never the CLI carrier. */
function nativeCodexSource(record: any, threadId: string): Identity {
  const source = record?.source ?? { harness: 'codex', workspace: '', surface: 'headless', session: threadId, generation: 'codex-thread', agent: 'main' };
  // The CLI carrier's session is `cli-<uuid>`; proof must name the native
  // thread, not that carrier.
  return { ...source, session: threadId, generation: 'codex-thread' } as Identity;
}

/** Proof for a durable codex handoff record, including pre-0.0.5 records. */
function handoffRecordProof(record: any, threadId: string, fallbackMode: 'restart' | 'compact'): AdoptionProof {
  const source = nativeCodexSource(record, threadId);
  const stored = record.proofMechanism as StoredProofMechanism | undefined;
  const mode = record.mode === 'compact' ? 'compact' : fallbackMode;
  const mechanism: StoredProofMechanism = stored ?? legacyProofMechanism(mode);
  const successorThread = String(record.successorThreadId ?? record.successorSessionId ?? threadId);
  const generation = String(record.successorTurnId ?? record.appliedAt ?? successorThread);
  const evidence = `codex-app-server:thread/${threadId}/revert+turn/${generation}`;
  if (mechanism === 'new-session') {
    // A legacy restart really did change the thread; keep the historical
    // evidence instead of relabelling it as a same-session replacement.
    return { source, successor: { ...source, session: successorThread, generation }, mechanism, nativeEvidence: evidence };
  }
  return sameSessionProof(source, generation, mechanism, evidence);
}

/** Map a durable headless record onto a contract outcome, proof included. */
function handoffRecordOutcome(record: any, threadId: string, fallbackMode: 'restart' | 'compact' = 'restart'): NativeOutcome {
  const phase = String(record.phase ?? 'intent');
  const lifecycle = handoffOutcome(phase, { appliedIsTerminal: true });
  const base = {
    durable: true, sessionId: threadId,
    state: lifecycle.state,
    ...(lifecycle.handoff ? { handoff: lifecycle.handoff } : {}),
  };
  if (phase === 'completed' || phase === 'applied') {
    return {
      ...base,
      status: phase === 'completed' ? 'completed' : 'applied',
      reason: String(record.reason ?? (phase === 'completed' ? 'The detached runner applied this handoff' : 'The detached runner applied this handoff; the successor turn is still running')),
      proof: handoffRecordProof(record, threadId, fallbackMode),
    };
  }
  if (phase === 'failed') {
    return { ...base, status: 'failed', reason: String(record.reason ?? record.error ?? 'The detached runner failed to apply this handoff'), durable: false, error: { code: 'codex-handoff-failed', message: String(record.error ?? 'headless handoff failed') } };
  }
  if (phase === 'cancelled') return { ...base, status: 'cancelled', reason: 'The handoff was cancelled' };
  return { ...base, status: 'pending', reason: `The detached runner is applying this handoff (${phase})` };
}

/**
 * Reconcile a pending handoff from the runner's `handoff.json` or the TUI
 * watcher journal. An `intent` whose executor is gone becomes failed instead
 * of pending forever.
 */
async function reconcileCodexHandoff(request: Request, ctx: AdapterContext): Promise<NativeOutcome | undefined> {
  const directory = executorDirectory(ctx);
  if (directory) {
    const record = await readJson(path.join(directory, HANDOFF_FILE));
    if (record && record.operationId === request.operationId) {
      const phase = String(record.phase ?? 'intent');
      if (['intent', 'applying', 'applied'].includes(phase)) {
        const status = await readJson(path.join(directory, 'status.json'));
        const pid = status?.pid;
        if (typeof pid === 'number' && !pidAlive(pid)) {
          return {
            status: 'failed', durable: false, state: 'failed',
            reason: 'The detached executor no longer exists before applying the handoff; start a new handoff if the task still matters',
            error: { code: 'handoff-executor-gone', message: `Executor pid ${pid} is gone with the handoff still ${phase}` },
          };
        }
      }
      const threadId = String(record.threadId ?? '');
      if (threadId) return handoffRecordOutcome(record, threadId, record.mode === 'compact' ? 'compact' : 'restart');
    }
  }
  const journalFile = path.join(ctx.home, '.ai4ai', 'codex', 'tui-handoff', `${request.operationId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  const journal = await readJson(journalFile);
  if (journal && journal.operationId === request.operationId) {
    const phase = String(journal.phase ?? 'pending');
    const threadId = String(journal.threadId ?? journal.successor?.session ?? ctx.identity.session);
    if (phase === 'completed' || phase === 'applied') {
      const successor = journal.successor ?? { ...ctx.identity, session: threadId };
      const mechanism: StoredProofMechanism = journal.proofMechanism ?? legacyProofMechanism('restart');
      return {
        status: phase === 'completed' ? 'completed' : 'applied', durable: true, sessionId: threadId,
        state: phase === 'completed' ? 'completed' : 'running',
        handoff: { phase: phase === 'completed' ? 'completed' : 'applied' },
        reason: String(journal.reason ?? 'The TUI watcher applied the handoff'),
        proof: mechanism === 'new-session'
          ? { source: ctx.identity, successor, mechanism, nativeEvidence: String(journal.nativeEvidence ?? 'codex-tui:legacy') }
          : sameSessionProof(nativeCodexSource({ source: ctx.identity }, threadId), String(journal.successorTurnId ?? 'codex-revert'), mechanism, String(journal.nativeEvidence ?? 'codex-tui:revert')),
      };
    }
    if (phase === 'failed') {
      return { status: 'failed', durable: false, state: 'failed', reason: String(journal.reason ?? 'The TUI watcher failed to apply the handoff'), error: { code: 'codex-handoff-failed', message: String(journal.reason ?? 'TUI handoff failed') } };
    }
    return { status: 'pending', durable: true, state: 'running', handoff: { phase: 'pending' }, sessionId: threadId, reason: `The TUI watcher is applying this handoff (${phase})` };
  }
  return undefined;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Explicit compact opt-in for the live TUI thread: the native compaction runs,
 * then the material is the next turn in the same thread. `markMutated` is
 * called before the first native mutation so the caller can report an unknown
 * state instead of retrying through another channel.
 */
async function nativeCompactHandoff(
  daemon: CodexDaemon,
  request: Request,
  ctx: AdapterContext,
  markMutated: () => void,
): Promise<NativeOutcome> {
  await daemon.call('initialize', { clientInfo: { name: 'ai4ai', version: PRODUCT_VERSION } });
  const resolution = await resolveTuiThread(daemon, ctx.identity.workspace, process.env.AI4AI_CODEX_THREAD);
  if (!resolution.ok) throw new NoLiveThread(resolution.reason);
  const thread = resolution.thread.id;
  const model = resolution.thread.model ?? null;
  await daemon.call('thread/resume', { threadId: thread, excludeTurns: true });
  const source = nativeCodexSource({ source: ctx.identity }, thread);

  const compactTimeout = Math.min(120000, request.timeoutMs ?? 120000);
  const taskTimeout = Math.min(300000, request.timeoutMs ?? 180000);
  let events: any[] = [];
  const off = daemon.onMessage(message => events.push(message));
  const waitFor = async (predicate: (message: any) => boolean, timeoutMs: number): Promise<any | undefined> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = events.find(predicate);
      if (hit) return hit;
      await sleep(100);
    }
    return undefined;
  };

  try {
    markMutated();
    await daemon.call('thread/compact/start', { threadId: thread }, compactTimeout);
    // A compaction marker or a generic turn completion can arrive while the
    // compaction turn is still active; submitting a successor turn then fails
    // with ActiveTurnNotSteerable. Gate on the thread actually returning to
    // idle before starting the successor.
    const waitIdle = async (timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const read = await daemon.call('thread/read', { threadId: thread, includeTurns: false }, 15000).catch(() => undefined);
        if (read?.thread?.status?.type === 'idle') return true;
        if (Date.now() >= deadline) return false;
        await sleep(250);
      }
    };
    await waitFor(message =>
      (message.method === 'thread/compacted' && message.params?.threadId === thread)
      || (message.method === 'item/completed' && message.params?.threadId === thread && message.params?.item?.type === 'contextCompaction')
      || (message.method === 'turn/completed' && message.params?.threadId === thread), compactTimeout);
    if (!(await waitIdle(compactTimeout))) throw new Error('The compaction did not reach a final state');
    await sleep(500);

    events = [];
    const text = taskDelivery(request.task ?? '', request.operationId);
    let started: any;
    for (let attempt = 0; ; attempt++) {
      try {
        started = await daemon.call('turn/start', { threadId: thread, input: [{ type: 'text', text }] }, taskTimeout);
        break;
      } catch (error) {
        // The thread status can read idle while the compaction turn still owns
        // the input queue. Retry with bounded backoff instead of failing.
        if (attempt >= 8 || !/ActiveTurnNotSteerable/.test(String(error))) throw error;
        await sleep(Math.min(1000 * 2 ** attempt, 10000));
      }
    }
    const turnId = started?.turn?.id as string | undefined;
    const completed = await waitFor(message =>
      message.method === 'turn/completed' && message.params?.threadId === thread
      && (turnId === undefined || message.params?.turn?.id === turnId), taskTimeout);
    const usage = [...events].reverse().find(message =>
      message.method === 'thread/tokenUsage/updated' && message.params?.threadId === thread
      && (turnId === undefined || message.params?.turnId === turnId))?.params?.tokenUsage;
    const answer = [...events].reverse().find(message =>
      message.method === 'item/completed' && message.params?.threadId === thread
      && message.params?.item?.type === 'agentMessage')?.params?.item?.text as string | undefined;
    const context = contextFromUsage(usage?.last?.inputTokens ?? null, usage?.modelContextWindow ?? null);
    return {
      status: completed ? 'completed' : 'applied',
      reason: completed
        ? `Codex compacted the live thread and completed the successor turn${answer ? `: ${String(answer).slice(0, 240)}` : ''}`
        : 'Codex compacted the live thread and started the successor turn; completion was not confirmed within the timeout',
      durable: true,
      // A confirmed successor turn is complete; an unconfirmed one is still running.
      state: completed ? 'completed' : 'running',
      handoff: { phase: completed ? 'completed' : 'applied' },
      sessionId: thread,
      ...(model ? { model } : {}),
      modelVerification: model ? 'reported' : 'unknown',
      verification: { model: model ? 'reported' : 'unknown', context: context.percentSource === 'derived' ? 'derived' : 'reported' },
      context,
      unavailable: model ? ['context.window'] : ['model'],
      // The native thread id is the source and successor session; only the
      // generation (turn) advances.
      proof: sameSessionProof(source, turnId ?? 'codex-compacted', 'native-compaction', `codex-app-server:thread/${thread}/compact+turn/${turnId ?? 'unknown'}`),
      notices: [{
        code: 'codex-tui-handoff', impact: 'none', action_required: false,
        message: 'The compaction marker and the handoff task appear in the same TUI; the daemon protocol is upstream-experimental.',
      }],
    };
  } finally {
    off();
  }
}

/**
 * Per-field status resolution for a Codex executor.
 *
 * Each field walks its own ladder: native (runner-written usage.json/model.json
 * from app-server events) > session (~/.codex/sessions rollout) > env > config
 * ($CODEX_HOME/config.toml, plus the trusted project's .codex/config.toml).
 * A source that yields nothing for a field is skipped for exactly that field.
 */
export async function codexUsage(
  executorDir: string,
  options: { workspace?: string; sessionId?: string; codexHome?: string } = {},
): Promise<StatusDetails> {
  // Layer 1: native runner artifacts, parsed independently so a partial file
  // still contributes the fields it does carry.
  let nativeUsed: number | null = null;
  let nativeWindow: number | null = null;
  let nativeModel: string | null = null;
  let sawUsage = false;
  try {
    const value = JSON.parse(await readFile(path.join(executorDir, 'usage.json'), 'utf8')) as {
      tokenUsage?: { last?: { inputTokens?: number; cachedInputTokens?: number }; modelContextWindow?: number | null };
    };
    sawUsage = true;
    const last = value.tokenUsage?.last;
    // Codex reports inputTokens as total input and cachedInputTokens as a
    // subset of it. Adding them double-counts the cached portion.
    nativeUsed = verifiedTokens(last?.inputTokens);
    nativeWindow = verifiedWindow(value.tokenUsage?.modelContextWindow);
  } catch { /* native usage absent, torn or unreadable: the ladder continues */ }
  try {
    const metadata = JSON.parse(await readFile(path.join(executorDir, 'model.json'), 'utf8')) as { model?: unknown };
    nativeModel = verifiedText(metadata.model);
  } catch { /* the model list is best-effort */ }

  const needsSession = nativeUsed === null || nativeWindow === null || nativeModel === null;
  const session = needsSession && options.workspace && options.sessionId
    ? await codexSessionUsage(options.workspace, options.sessionId, options.codexHome).catch(() => null)
    : null;
  // autoCompact is never native, so the config layer is always consulted for it.
  const config = options.workspace
    ? await probeCodexConfig(options.workspace, options.codexHome).catch(() => null)
    : null;

  // Codex exposes no documented model/effort environment variable (verified in
  // the installed CLI), so the env layer is genuinely N/A for this harness.
  const modelField = firstVerified<string>([
    { value: nativeModel, source: 'native' },
    { value: session?.model ?? null, source: 'session' },
    // Codex documents no model-selection variable; these are the only plausible
    // overrides and an absent one skips the layer without affecting other fields.
    { value: envValue('CODEX_MODEL') ?? envValue('AI4AI_CODEX_MODEL'), source: 'env' },
    { value: config?.model?.value ?? null, source: config?.model?.source ?? 'unknown' },
  ]);
  const reasoningEffortField = firstVerified<string>([
    { value: session?.reasoningEffort ?? null, source: 'session' },
    { value: envValue('CODEX_REASONING_EFFORT') ?? envValue('AI4AI_CODEX_REASONING_EFFORT'), source: 'env' },
    { value: config?.reasoningEffort?.value ?? null, source: config?.reasoningEffort?.source ?? 'unknown' },
  ]);
  const usedField = firstVerified<number>([
    { value: nativeUsed, source: 'native' },
    { value: session?.used ?? null, source: 'session' },
  ]);
  const windowField = firstVerified<number>([
    { value: nativeWindow, source: 'native' },
    { value: session?.window ?? null, source: 'session' },
    { value: verifiedWindow(Number(envValue('CODEX_CONTEXT_WINDOW') ?? envValue('AI4AI_CODEX_CONTEXT_WINDOW'))), source: 'env' },
    { value: config?.window?.value ?? null, source: config?.window?.source ?? 'unknown' },
  ]);

  const used = usedField?.value ?? null;
  const window = windowField?.value ?? null;
  const context = contextFromUsage(used, window);
  context.sources = {
    window: windowField?.source ?? null,
    used: usedField?.source ?? null,
    percent: context.percent !== null ? 'derived' : null,
  };
  // Codex derives its default threshold from the model catalog (90% of the
  // resolved window); an explicit config/catalog limit is clamped to that.
  const catalog = modelField
    ? await probeCodexModelInfo(modelField.value, options.codexHome).catch(() => null)
    : null;
  const autoCompact = codexAutoCompact(config?.autoCompact ?? null, catalog, window, windowField?.source) ?? undefined;

  const unavailable: string[] = [];
  if (!modelField) unavailable.push('model');
  if (window === null) unavailable.push('context.window');
  if (used === null) unavailable.push('context.used');
  // No source at all (no native artifacts, no session row, no config): keep the
  // coarse historical marker for host consumers that only look for it.
  if (!sawUsage && !session && !config && !modelField) return { unavailable: ['model', 'context'] };
  return {
    model: modelField?.value ?? null,
    reasoningEffort: reasoningEffortField?.value ?? null,
    fieldStates: {
      ...(reasoningEffortField ? {} : { reasoningEffort: 'unavailable' as const }),
      ...(autoCompact ? {} : { 'context.autoCompact': 'unavailable' as const }),
    },
    context,
    ...(autoCompact ? { autoCompact } : {}),
    ...(modelField ? { modelVerification: modelField.source === 'native' || modelField.source === 'session' ? 'reported' as const : 'configured-only' as const } : {}),
    unavailable,
  };
}
