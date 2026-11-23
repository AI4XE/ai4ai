import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutorRecord } from '../core/store.js';
import type { HarnessId, LifecycleState } from '../contract/states.js';
import { spawnEnvironment } from '../core/env-policy.js';
import { SUPERVISOR_PROTOCOL } from '../core/protocol.js';

export interface LaunchSpec {
  executorId: string;
  harness: HarnessId;
  home: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Variables removed from the inherited environment before launch. */
  envExclude?: string[];
  cwd: string;
  taskFile: string;
  sessionRegex?: string;
  /** The adapter pre-built the complete cmd.exe command line. */
  windowsVerbatimArguments?: boolean;
  /** Protocol spoken by the supervisor launched here (3 = idle + turn ledger). */
  supervisorProtocol?: number;
  /** `one-shot` (default) or `persistent` (idle between turns). */
  persistence?: 'one-shot' | 'persistent';
  /** Inbox generation; a revival swaps the inbox and starts a new epoch. */
  epoch?: number;
  /** Receipt id for the first turn (spawn or a revival message). */
  initialTurnId?: string;
  /** Turn count carried across a revival (the ledger is cumulative). */
  initialTurns?: number;
  initialOperationId?: string;
  /** The carrier keeps one interactive child alive across turns. */
  resident?: boolean;
  /** The native session this turn must stay in (same-session guard). */
  expectedSessionId?: string;
}

export interface ExecutorStatus {
  state: string;
  startedAt?: string;
  endedAt?: string;
  turns?: number;
  pid?: number;
  sessionId?: string;
  exitCode?: number | null;
  signal?: string | null;
  /** Written by the supervisor on child output/events; never self-reported. */
  lastActivityAt?: string;
  lastActivitySource?: 'native';
  /** The supervisor's own pid; the child harness pid is `pid`. */
  supervisorPid?: number;
  /** Supervisor protocol version; v0.0.3 supervisors omit it. */
  protocol?: number;
  /** `running` while a turn executes, `idle` between turns (persistent only). */
  turnState?: 'running' | 'idle';
  persistence?: 'one-shot' | 'persistent';
  lastOperationId?: string;
  lastTurnAt?: string;
  lastTurnOutcome?: 'completed' | 'failed' | 'cancelled';
  queuedTurns?: number;
  turnStartedAt?: string;
  idleSince?: string;
  epoch?: number;
  resident?: boolean;
  /** Supervisor-reported child identity (pid + start token/command hash). */
  child?: { pid?: number; startToken?: string; commandHash?: string };
}

export interface LogLine { ts: string; stream: string; line: string }

/** Liveness of the two processes that make up a detached executor. */
export interface ExecutorLiveness {
  /** Supervisor process (owns status.json, the inbox and the turn ledger). */
  supervisorAlive?: boolean | null;
  /** Harness child process (per-turn) or resident child. */
  childAlive?: boolean | null;
}

/**
 * Collapse an internal supervisor status into the shared lifecycle vocabulary.
 *
 * Liveness wins over a stale status-file claim, but which pid matters depends
 * on the carrier: while `idle` the supervisor is alive and a per-turn child is
 * expected to be dead, so the child must never turn a healthy idle executor
 * into `failed`. A supervisor that is gone while the child still runs is an
 * orphan, never `running`.
 *
 * The boolean overload treats the flag as "the executor's observed process is
 * alive" and is kept for callers that only observe one pid.
 */
export function lifecycleOfStatus(raw: ExecutorStatus | undefined, alive: boolean | null | ExecutorLiveness): LifecycleState {
  if (!raw) return 'unknown';
  const liveness: ExecutorLiveness = typeof alive === 'object' && alive !== null ? alive : { childAlive: alive };
  const supervisor = liveness.supervisorAlive;
  const child = liveness.childAlive;
  const recorded = (): LifecycleState => raw.state === 'exited' ? (raw.exitCode === 0 ? 'completed' : 'failed')
    : raw.state === 'failed' ? 'failed'
    : raw.state === 'stopped' || raw.state === 'cancelled' ? 'cancelled'
    : raw.state === 'completed' ? 'completed'
    : raw.state === 'unknown' ? 'unknown'
    : raw.state === 'idle' ? 'idle'
    : 'running';
  // Supervisor death is authoritative: a recorded terminal outcome stands, a
  // non-terminal record is failed (or orphaned, which the caller reports).
  if (supervisor === false) return recorded() === 'running' || recorded() === 'idle' ? 'failed' : recorded();
  if (supervisor === true) {
    if (raw.state === 'idle') return 'idle';
    if (child === false) {
      // Between turns a persistent supervisor writes `idle`; a `running` record
      // whose child just exited is still the turn-boundary transient until
      // `idle`/`turnState: "idle"` lands. Reporting `idle` early would race
      // `message` against an unreported session id.
      if (raw.state === 'idle' || raw.turnState === 'idle') return 'idle';
      return recorded();
    }
    if (child === true) return 'running';
    return recorded();
  }
  // Supervisor liveness unknown: fall back to the child observation and never
  // invent `idle` or a failure from a stale file. Pre-protocol-3 executors have
  // no supervisorPid, so their child is the only liveness signal.
  if (child === true) return 'running';
  if (child === false && raw.supervisorPid === undefined) {
    const base = recorded();
    return base === 'running' || base === 'idle' ? 'failed' : base;
  }
  return recorded();
}

/** Process liveness relative to the two pids; `unknown` fails closed. */
export function processStateOf(raw: ExecutorStatus | undefined, liveness: ExecutorLiveness): { state: 'alive' | 'orphaned' | 'dead' | 'unknown'; reason?: string } {
  if (!raw) return { state: 'unknown', reason: 'No supervisor status recorded' };
  const { supervisorAlive, childAlive } = liveness;
  if (supervisorAlive === true) return { state: 'alive' };
  if (supervisorAlive === false) {
    if (childAlive === true) return { state: 'orphaned', reason: 'Supervisor is dead but the harness child is still alive; run ai4ai sweep or a force stop' };
    if (childAlive === false) return { state: 'dead' };
    return { state: 'unknown', reason: 'Supervisor is dead and child liveness cannot be determined' };
  }
  if (childAlive === true) return { state: 'unknown', reason: 'Supervisor liveness cannot be determined' };
  if (childAlive === false) return { state: 'unknown', reason: 'Supervisor liveness cannot be determined' };
  return { state: 'unknown', reason: 'Liveness cannot be determined' };
}

export const executorRoot = (home: string): string => path.join(home, 'executors');
export const executorDir = (home: string, executorId: string): string => path.join(executorRoot(home), executorId);

/**
 * The supervisor is a Node script, but in-harness plugins may themselves run on
 * a non-Node runtime (OpenCode 2.x ships a compiled binary as process.execPath).
 * Resolve a real Node executable so the supervisor is never reinterpreted as a
 * harness subcommand.
 */
export function resolveNodeRuntime(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AI4AI_NODE;
  if (explicit && existsSync(explicit)) return explicit;
  const executable = path.basename(process.execPath).toLowerCase();
  if (/^node(\.exe)?$/.test(executable)) return process.execPath;
  // Installers record the Node that registered the plugin; in-harness runtimes
  // (OpenCode 2.x) may expose a compiled binary as process.execPath and keep
  // node off PATH.
  try {
    const recorded = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'node-runtime.json');
    const value = JSON.parse(readFileSync(recorded, 'utf8')) as { node?: string };
    if (typeof value.node === 'string' && existsSync(value.node)) return value.node;
  } catch { /* no recorded runtime */ }
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

export async function writeAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, file);
}

/** True only when the OS confirms the pid exists (EPERM means it exists but is foreign). */
export function pidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export async function readStatus(home: string, executorId: string): Promise<ExecutorStatus | undefined> {
  try { return JSON.parse(await readFile(path.join(executorDir(home, executorId), 'status.json'), 'utf8')) as ExecutorStatus; }
  catch { return undefined; }
}

export async function readLog(home: string, executorId: string, lines = 200): Promise<LogLine[]> {
  try {
    const text = await readFile(path.join(executorDir(home, executorId), 'log.ndjson'), 'utf8');
    return text.split('\n').filter(Boolean).slice(-lines).map(line => {
      try { return JSON.parse(line) as LogLine; } catch { return { ts: '', stream: 'unknown', line }; }
    });
  } catch { return []; }
}

export interface QueuedTurn {
  inputFile?: string;
  /** The turn must run in this native session; a different id is a failure. */
  expectedSessionId?: string;
  /** Receipt id returned by `message` and written to the turn ledger. */
  turnId?: string;
  operationId?: string;
  command?: string;
  args?: string[];
  windowsVerbatimArguments?: boolean;
  extraArgs?: string[];
}

/**
 * Publish one message as its own inbox file using O_EXCL.
 *
 * One file per message means concurrent enqueues never read-modify-write the
 * same object, and the supervisor claims a message with an atomic rename. The
 * timestamp prefix preserves arrival order; the uuid suffix makes the name
 * unique under concurrent writers.
 */
export async function enqueueTurn(home: string, executorId: string, turn: QueuedTurn): Promise<string> {
  const directory = path.join(executorDir(home, executorId), 'inbox');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = `${String(Date.now()).padStart(13, '0')}-${randomUUID()}.json`;
  const handle = await open(path.join(directory, name), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(turn) + '\n'); }
  finally { await handle.close(); }
  return name;
}

/** Where a queued message currently sits: still pending, claimed, or consumed. */
export async function turnPlacement(home: string, executorId: string, name: string): Promise<'pending' | 'claimed' | 'consumed'> {
  const directory = executorDir(home, executorId);
  const exists = async (file: string): Promise<boolean> => {
    try { await open(file, 'r').then(handle => handle.close()); return true; } catch { return false; }
  };
  if (await exists(path.join(directory, 'inbox', name))) return 'pending';
  if (await exists(path.join(directory, 'inbox', 'claimed', name))) return 'claimed';
  return 'consumed';
}

export async function requestStop(home: string, executorId: string): Promise<void> {
  await writeAtomic(path.join(executorDir(home, executorId), 'control.json'), { stop: true, finish: false, requestedAt: new Date().toISOString() });
}

/** Ask the supervisor to complete gracefully after the current turn (finish). */
export async function requestFinish(home: string, executorId: string): Promise<void> {
  await writeAtomic(path.join(executorDir(home, executorId), 'control.json'), { stop: false, finish: true, requestedAt: new Date().toISOString() });
}

/** Read the control file; a malformed/missing file means "no request". */
export async function readControl(home: string, executorId: string): Promise<{ stop?: boolean; finish?: boolean }> {
  try { return JSON.parse(await readFile(path.join(executorDir(home, executorId), 'control.json'), 'utf8')) as { stop?: boolean; finish?: boolean }; }
  catch { return {}; }
}

// Provider credentials must reach the detached carrier through the supervisor's
// process environment, never through spec.json on disk. Keep non-secret carrier
// settings (DSH_HOME, PATH, HOME, ...) in the spec; filter API keys/tokens.
const SENSITIVE_ENV = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIALS?)(?:$|_)/i;
export function persistedEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !SENSITIVE_ENV.test(key)));
  return Object.keys(kept).length ? kept : undefined;
}

/**
 * Start a detached supervisor. The supervisor, not the caller, owns the harness
 * process, so closing the caller's session or killing the caller cannot end it.
 */
export async function launch(spec: LaunchSpec): Promise<{ directory: string; supervisorPid?: number }> {
  const directory = executorDir(spec.home, spec.executorId);
  await mkdir(directory, { recursive: true });
  const task = await readFile(spec.taskFile, 'utf8');
  await writeFile(path.join(directory, 'task.md'), task);
  const persisted = persistedEnv(spec.env);
  await writeAtomic(path.join(directory, 'spec.json'), {
    harness: spec.harness,
    command: spec.command,
    args: spec.args,
    ...(persisted ? { env: persisted } : {}),
    ...(spec.envExclude ? { envExclude: spec.envExclude } : {}),
    cwd: spec.cwd,
    inputFile: 'task.prompt',
    ...(spec.sessionRegex ? { sessionRegex: spec.sessionRegex } : {}),
    ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    supervisorProtocol: spec.supervisorProtocol ?? SUPERVISOR_PROTOCOL,
    persistence: spec.persistence ?? 'one-shot',
    ...(spec.epoch ? { epoch: spec.epoch } : {}),
    ...(spec.initialTurnId ? { initialTurnId: spec.initialTurnId } : {}),
    ...(spec.initialTurns ? { initialTurns: spec.initialTurns } : {}),
    ...(spec.initialOperationId ? { initialOperationId: spec.initialOperationId } : {}),
    ...(spec.resident ? { resident: true } : {}),
    ...(spec.expectedSessionId ? { expectedSessionId: spec.expectedSessionId } : {}),
  });
  // The task file the supervisor feeds on stdin is the plain prompt.
  await writeFile(path.join(directory, 'task.prompt'), task);
  await writeAtomic(path.join(directory, 'control.json'), { stop: false });
  const supervisor = fileURLToPath(new URL('./supervisor.js', import.meta.url));
  const runtime = resolveNodeRuntime();
  // The built-in environment policy (messaging transport, bot tokens, tmux,
  // host provider route) applies to every harness; the caller's envExclude is
  // additive and the adapter's explicit env is merged afterwards.
  const env = spawnEnvironment(process.env, { envExclude: spec.envExclude ?? [], explicit: spec.env ?? {} });
  // The carrier runs with `cwd: spec.cwd`, but an inherited PWD can still name
  // the caller's directory. Harnesses such as OpenCode resolve their project
  // config through PWD, so a detached executor started with --workspace from
  // another directory would load the wrong config and fail every provider call.
  const fullEnv = { ...env, PWD: spec.cwd, AI4AI_EXECUTOR_ID: spec.executorId, AI4AI_EXECUTOR_DIR: directory };
  await writeAtomic(path.join(directory, 'launch.json'), { runtime, supervisor, at: new Date().toISOString() });
  const child = spawn(runtime, [supervisor, '--dir', directory], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: fullEnv,
  });
  child.unref();
  child.on('error', error => {
    // stdio is ignored for detachment; persist the launch error instead.
    void writeAtomic(path.join(directory, 'launch.json'), { runtime, supervisor, at: new Date().toISOString(), error: error.message });
  });
  // A short bounded wait lets a genuinely broken launch surface as `failed`
  // instead of a fictitious running executor.
  await new Promise(resolve => setTimeout(resolve, 250));
  try { await open(path.join(directory, 'status.json'), 'r').then(handle => handle.close()); } catch { /* status is best-effort */ }
  return { directory, ...(child.pid ? { supervisorPid: child.pid } : {}) };
}

export function executorState(record: ExecutorRecord, status: ExecutorStatus | undefined): string {
  if (!status) return record.state;
  if (status.state === 'exited') return status.exitCode === 0 ? 'completed' : 'failed';
  if (status.state === 'failed') return 'failed';
  if (status.state === 'stopped') return 'cancelled';
  if (status.state === 'idle') return 'idle';
  return 'running';
}
