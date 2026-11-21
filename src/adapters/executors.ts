import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutorRecord } from '../core/store.js';
import type { HarnessId, LifecycleState } from '../contract/states.js';

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
  /** Protocol spoken by the supervisor launched here (2 = per-turn resume). */
  supervisorProtocol?: number;
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
}

export interface LogLine { ts: string; stream: string; line: string }

/**
 * Collapse an internal supervisor status into the shared lifecycle vocabulary.
 * Liveness wins over a stale status-file claim: a live pid is running, and a
 * dead pid without a recorded clean exit is failed. A pid that cannot be
 * checked keeps the recorded terminal outcome or falls back to running.
 */
export function lifecycleOfStatus(raw: ExecutorStatus | undefined, alive: boolean | null): LifecycleState {
  if (!raw) return 'unknown';
  if (alive === true) return 'running';
  if (alive === false) {
    return raw.state === 'stopped' ? 'cancelled'
      : raw.state === 'exited' ? (raw.exitCode === 0 ? 'completed' : 'failed')
      : 'failed';
  }
  return raw.state === 'exited' ? (raw.exitCode === 0 ? 'completed' : 'failed')
    : raw.state === 'failed' ? 'failed'
    : raw.state === 'stopped' || raw.state === 'cancelled' ? 'cancelled'
    : raw.state === 'completed' ? 'completed'
    : raw.state === 'unknown' ? 'unknown'
    : 'running';
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
  await writeAtomic(path.join(executorDir(home, executorId), 'control.json'), { stop: true, requestedAt: new Date().toISOString() });
}

export async function markStoppedIfDead(home: string, executorId: string, status: ExecutorStatus): Promise<ExecutorStatus> {
  if (!status.pid || status.state !== 'running') return status;
  try { process.kill(status.pid, 0); return status; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return status;
    const next = { ...status, state: 'exited', endedAt: status.endedAt ?? new Date().toISOString() };
    await writeAtomic(path.join(executorDir(home, executorId), 'status.json'), next);
    return next;
  }
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
  await writeAtomic(path.join(directory, 'spec.json'), {
    command: spec.command,
    args: spec.args,
    ...(spec.env ? { env: spec.env } : {}),
    cwd: spec.cwd,
    inputFile: 'task.prompt',
    ...(spec.sessionRegex ? { sessionRegex: spec.sessionRegex } : {}),
    ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    supervisorProtocol: spec.supervisorProtocol ?? 2,
  });
  // The task file the supervisor feeds on stdin is the plain prompt.
  await writeFile(path.join(directory, 'task.prompt'), task);
  await writeAtomic(path.join(directory, 'control.json'), { stop: false });
  const supervisor = fileURLToPath(new URL('./supervisor.js', import.meta.url));
  const runtime = resolveNodeRuntime();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !spec.envExclude?.includes(key)) env[key] = value;
  const fullEnv = { ...env, ...(spec.env ?? {}), AI4AI_EXECUTOR_ID: spec.executorId, AI4AI_EXECUTOR_DIR: directory };
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
  return 'running';
}
