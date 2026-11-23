import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Portable process identity.
 *
 * `kill(pid, 0)` only proves that *some* process currently owns a pid; it
 * cannot distinguish the original child from a reused pid, a zombie, or an
 * unrelated process. Every liveness decision that can lead to a kill therefore
 * uses a recorded identity (start token / creation time + command line) and
 * fails closed to `unknown` when it cannot be verified.
 */
export interface ProcessIdentity {
  pid: number;
  /** true/false when determined; null when the platform check failed. */
  alive: boolean | null;
  startToken?: string;
  command?: string;
  commandHash?: string;
  /** cwd when cheaply available (POSIX /proc only). */
  cwd?: string;
  zombie?: boolean;
  source: 'proc' | 'ps' | 'cim' | 'kill' | 'unknown';
  reason?: string;
}

export interface RecordedIdentity {
  pid: number;
  startToken?: string;
  commandHash?: string;
  createdAt?: string;
}

export function commandHash(command: string | undefined): string | undefined {
  if (!command) return undefined;
  return createHash('sha256').update(command.trim()).digest('hex');
}

const run = (command: string, args: string[], timeout = 3000): { ok: boolean; status: number | null; error?: string; stdout: string; stderr: string } => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return {
    ok: result.status === 0,
    status: result.status,
    ...(result.error ? { error: (result.error as Error).message } : {}),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

function posixProcIdentity(pid: number): ProcessIdentity | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return undefined;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const state = fields[0];
    const startToken = fields[19];
    let command: string | undefined;
    try {
      command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    } catch { /* command line may be unreadable for a foreign process */ }
    let cwd: string | undefined;
    try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* optional */ }
    const zombie = state === 'Z' || state === 'X';
    const hash = commandHash(command);
    return {
      pid,
      alive: zombie ? false : true,
      ...(startToken ? { startToken } : {}),
      ...(command ? { command } : {}),
      ...(hash ? { commandHash: hash } : {}),
      ...(cwd ? { cwd } : {}),
      zombie,
      source: 'proc',
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { pid, alive: false, source: 'proc', reason: 'process not found' };
    return undefined;
  }
}

export interface PsResult { status: number | null; error?: string; stdout: string; stderr: string }

/** Interpret one `ps -p` invocation; exported so the fail-closed rules stay testable. */
export function psIdentityFromResult(pid: number, result: PsResult): ProcessIdentity {
  if (result.error) {
    // The probe itself could not run (missing binary, sandbox denial): that is
    // not evidence that the process is gone, so liveness stays unknown.
    return { pid, alive: null, source: 'ps', reason: result.error.slice(0, 300) };
  }
  if (result.status !== 0 || result.stdout.trim() === '') {
    // `ps -p` exits 1 with no output when no process matches. Any other
    // diagnostic (e.g. "Operation not permitted") means the probe was denied,
    // which must fail closed to unknown rather than report a false death.
    const stderr = result.stderr.trim();
    if (result.status === 1 && result.stdout.trim() === '' && stderr === '') {
      return { pid, alive: false, source: 'ps', reason: 'process not found' };
    }
    return { pid, alive: null, source: 'ps', reason: (stderr || `ps exited with status ${result.status ?? 'null'}`).slice(0, 300) };
  }
  const line = result.stdout.trim();
  const match = /^(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
  const state = match?.[1] ?? line.split(/\s+/)[0] ?? '';
  const startToken = match?.[2];
  const command = match?.[3];
  const zombie = state.startsWith('Z');
  const hash = commandHash(command);
  return {
    pid,
    alive: zombie ? false : true,
    ...(startToken ? { startToken } : {}),
    ...(command ? { command } : {}),
    ...(hash ? { commandHash: hash } : {}),
    zombie,
    source: 'ps',
  };
}

function posixPsIdentity(pid: number): ProcessIdentity {
  return psIdentityFromResult(pid, run('ps', ['-o', 'stat=', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)]));
}

interface CimRow { ProcessId?: number; CreationDate?: string; CommandLine?: string | null }

function windowsIdentity(pid: number): ProcessIdentity {
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,CreationDate,CommandLine; if ($p) { $p | ConvertTo-Json -Compress }`;
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 5000);
  if (!result.ok) return { pid, alive: null, source: 'cim', reason: (result.stderr || 'CIM query failed').trim().slice(0, 300) };
  const text = result.stdout.trim();
  if (!text) return { pid, alive: false, source: 'cim', reason: 'process not found' };
  try {
    const row = JSON.parse(text) as CimRow;
    const command = typeof row.CommandLine === 'string' && row.CommandLine.length > 0 ? row.CommandLine : undefined;
    const startToken = typeof row.CreationDate === 'string' ? row.CreationDate : row.CreationDate !== undefined ? String(row.CreationDate) : undefined;
    const hash = commandHash(command);
    return {
      pid,
      alive: true,
      ...(startToken ? { startToken } : {}),
      ...(command ? { command } : {}),
      ...(hash ? { commandHash: hash } : {}),
      source: 'cim',
    };
  } catch (error) {
    return { pid, alive: null, source: 'cim', reason: `CIM output unparsable: ${(error as Error).message}`.slice(0, 300) };
  }
}

/** Full identity observation; never throws. */
export function processIdentity(pid: number): ProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { pid, alive: false, source: 'unknown', reason: 'invalid pid' };
  if (process.platform === 'win32') return windowsIdentity(pid);
  const proc = posixProcIdentity(pid);
  if (proc) return proc;
  return posixPsIdentity(pid);
}

/** Quick liveness that still treats zombies as dead. */
export function processAlive(pid: number | undefined): boolean | null {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  let exists: boolean;
  try { process.kill(pid, 0); exists = true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') exists = true;
    else return null;
  }
  if (!exists) return false;
  const identity = process.platform === 'linux' ? posixProcIdentity(pid) : process.platform === 'win32' ? undefined : posixPsIdentity(pid);
  // `kill(0)` already proved the pid exists; an unavailable identity probe only
  // removes zombie detection, it does not make the process dead.
  if (identity && identity.alive !== null) return identity.alive;
  return true;
}

export type IdentityVerdict = 'match' | 'mismatch' | 'unknown';

/**
 * Verify that the live process still is the recorded child. A recorded
 * identity with neither a start token nor a command hash cannot be verified,
 * which is reported as `unknown` rather than assumed.
 */
export function verifyIdentity(recorded: RecordedIdentity): { verdict: IdentityVerdict; live: ProcessIdentity; reason?: string } {
  const live = processIdentity(recorded.pid);
  if (live.alive === false) return { verdict: 'mismatch', live, reason: live.reason ?? 'process is not alive' };
  if (live.alive === null) return { verdict: 'unknown', live, reason: live.reason ?? 'liveness unknown' };
  if (recorded.startToken && live.startToken) {
    return recorded.startToken === live.startToken
      ? { verdict: 'match', live }
      : { verdict: 'mismatch', live, reason: 'start token differs (pid reused)' };
  }
  if (recorded.commandHash && live.commandHash) {
    return recorded.commandHash === live.commandHash
      ? { verdict: 'match', live }
      : { verdict: 'mismatch', live, reason: 'command line differs (pid reused)' };
  }
  return { verdict: 'unknown', live, reason: 'no verifiable identity component' };
}

/** SIGTERM a process (POSIX) or terminate its tree (Windows). Best effort. */
export function terminate(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

/** Kill a whole process tree. POSIX uses the detached process group. */
export function forceKillTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

// ── Supervisor heartbeat ────────────────────────────────────────────────
export interface Heartbeat {
  token: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  startToken?: string;
  /** Set by the supervisor when it exits; the heartbeat then reads as dead. */
  stoppedAt?: string;
}

export const heartbeatFile = (directory: string): string => path.join(directory, 'heartbeat.json');

export async function writeHeartbeat(directory: string, heartbeat: Heartbeat): Promise<void> {
  await mkdir(directory, { recursive: true });
  const target = heartbeatFile(directory);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(heartbeat) + '\n');
  await rename(temporary, target);
}

export async function readHeartbeat(directory: string): Promise<Heartbeat | undefined> {
  try {
    const value = JSON.parse(await readFile(heartbeatFile(directory), 'utf8')) as Heartbeat;
    return typeof value?.token === 'string' && Number.isSafeInteger(value?.pid) ? value : undefined;
  } catch { return undefined; }
}

/**
 * Supervisor liveness: a fresh heartbeat plus a matching pid identity. A
 * missing heartbeat is `null` (unknown), never "dead": old executors written
 * before heartbeats existed must not be killed on that basis.
 */
export function heartbeatAlive(heartbeat: Heartbeat | undefined, options: { maxAgeMs?: number; now?: number } = {}): boolean | null {
  if (!heartbeat) return null;
  if (heartbeat.stoppedAt) return false;
  const now = options.now ?? Date.now();
  const updated = Date.parse(heartbeat.updatedAt);
  if (!Number.isFinite(updated)) return null;
  const fresh = now - updated <= (options.maxAgeMs ?? 30_000);
  const live = processIdentity(heartbeat.pid);
  if (live.alive === false) return false;
  if (live.alive === null) {
    // Sandboxes may deny `ps`. Existence via kill(0) still separates a gone
    // supervisor from an unverifiable one; only a fresh heartbeat is trusted
    // when the recorded identity cannot be re-checked.
    const exists = processAlive(heartbeat.pid);
    if (exists === false) return false;
    return exists === true && fresh ? true : null;
  }
  // A stale heartbeat with a matching start token still names the same live
  // process (the writer may be wedged); only an unverifiable process is dead.
  if (!fresh) {
    if (heartbeat.startToken && live.startToken) return heartbeat.startToken === live.startToken;
    return false;
  }
  if (heartbeat.startToken && live.startToken) return heartbeat.startToken === live.startToken;
  return true;
}
