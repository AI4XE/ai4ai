#!/usr/bin/env node
/**
 * Detached executor supervisor.
 *
 * Started as its own process with `detached: true` so it survives the parent
 * session and process. It runs a harness carrier turn, records durable state on
 * disk, drains queued messages as follow-up turns, and honours stop requests.
 * Reattachment is purely file-based, which is what makes the lifecycle detached.
 */
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const index = process.argv.indexOf('--dir');
const directory = index >= 0 ? process.argv[index + 1] : undefined;
if (!directory) {
  console.error('supervisor: --dir is required');
  process.exit(2);
}

const file = (name: string): string => path.join(directory!, name);
let atomicSequence = 0;
const atomic = async (name: string, value: unknown): Promise<void> => {
  // Unique temp name per write: concurrent writers in one process must never
  // share a temp file, or one rename removes the other's source.
  const temporary = file(`.${name}.${process.pid}.${atomicSequence++}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, file(name));
};
const stopRequested = (): boolean => {
  try { return JSON.parse(readFileSync(file('control.json'), 'utf8'))?.stop === true; }
  catch { return false; }
};

interface Spec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
  inputFile?: string;
  sessionRegex?: string;
}
interface Turn { inputFile?: string; extraArgs?: string[] }
interface Status {
  state: string; startedAt: string; turns: number; pid?: number;
  sessionId?: string; exitCode?: number | null; signal?: string | null; endedAt?: string;
  lastActivityAt?: string; lastActivitySource?: 'native';
}

/**
 * Activity is written by the supervisor (never by the executor itself) whenever
 * the child emits output. Updates are throttled so a chatty harness cannot turn
 * every chunk into a disk write, and are always flushed at turn end.
 */
let lastActivityWrite = 0;
let writes: Promise<void> = Promise.resolve();
/** Serialized status persistence: activity writes never overtake the terminal write. */
const persist = (): Promise<void> => {
  writes = writes.then(() => atomic('status.json', status));
  return writes;
};
const touchActivity = (force = false): void => {
  status = { ...status, lastActivityAt: new Date().toISOString(), lastActivitySource: 'native' };
  const now = Date.now();
  if (force || now - lastActivityWrite >= 1000) {
    lastActivityWrite = now;
    void persist();
  }
};

await mkdir(directory, { recursive: true });
let status: Status = { state: 'starting', startedAt: new Date().toISOString(), turns: 0 };
await atomic('status.json', status);

const spec = JSON.parse(await readFile(file('spec.json'), 'utf8')) as Spec;
const log = createWriteStream(file('log.ndjson'), { flags: 'a' });
const record = (stream: string, text: string): void => {
  for (const line of String(text).split(/\r?\n/)) {
    if (line) log.write(JSON.stringify({ ts: new Date().toISOString(), stream, line }) + '\n');
  }
};
const sessionRegex = spec.sessionRegex ? new RegExp(spec.sessionRegex) : undefined;
const observeSession = (line: string): void => {
  if (!sessionRegex) return;
  const match = sessionRegex.exec(line);
  if (match?.[1] && match[1] !== status.sessionId) {
    status = { ...status, sessionId: match[1] };
    void persist();
  }
};

function runTurn(command: string, args: string[], inputFile: string | undefined): Promise<{ code: number | null; signal: string | null; stopping: boolean }> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: spec.cwd, env: { ...process.env, ...(spec.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
    });
    status = { ...status, state: 'running', ...(child.pid ? { pid: child.pid } : {}), turns: (status.turns ?? 0) + 1 };
    void persist();
    let stopping = false;
    const timer = setInterval(() => {
      if (stopping || !stopRequested()) return;
      stopping = true;
      status = { ...status, state: 'stopping' };
      void persist();
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 10000).unref();
    }, 400);
    timer.unref?.();
    child.stdout.on('data', data => {
      const text = String(data);
      record('stdout', text);
      touchActivity();
      for (const line of text.split(/\r?\n/)) observeSession(line);
    });
    child.stderr.on('data', data => { record('stderr', String(data)); touchActivity(); });
    child.on('error', error => { record('error', error.message); touchActivity(true); });
    child.once('close', (code, signal) => {
      clearInterval(timer);
      // Activity is recorded in memory and flushed in order before the caller
      // writes the terminal status.
      status = { ...status, lastActivityAt: new Date().toISOString(), lastActivitySource: 'native' };
      void writes.then(() => resolve({ code, signal, stopping }));
    });
    // Non-interactive harnesses treat EOF as end of input.
    if (inputFile) readFile(file(inputFile), 'utf8').then(text => child.stdin.end(text)).catch(() => child.stdin.end());
    else child.stdin.end();
  });
}

async function nextQueuedTurn(): Promise<Turn | undefined> {
  try {
    const lines = (await readFile(file('inbox.jsonl'), 'utf8')).split('\n').filter(Boolean);
    if (!lines.length) return undefined;
    const next = JSON.parse(lines[0]!) as Turn;
    await writeFile(file('inbox.jsonl'), lines.slice(1).join('\n') + (lines.length > 1 ? '\n' : ''));
    return next;
  } catch { return undefined; }
}

let exitCode = 0;
let turn: Turn = { ...(spec.inputFile ? { inputFile: spec.inputFile } : {}), extraArgs: [] };
for (;;) {
  if (stopRequested()) {
    // A stop before the next turn starts: there is no child to reap, so the
    // exit code/signal stay null rather than being invented.
    status = { ...status, state: 'stopped', exitCode: null, signal: null, endedAt: new Date().toISOString() };
    break;
  }
  const result = await runTurn(spec.command, [...(spec.args ?? []), ...(turn.extraArgs ?? [])], turn.inputFile);
  if (result.stopping) {
    // The supervisor killed the child on request; record how it terminated so
    // status can report a real signal/exit code instead of a bare `stopped`.
    status = { ...status, state: 'stopped', exitCode: result.code, signal: result.signal, endedAt: new Date().toISOString() };
    break;
  }
  const queued = await nextQueuedTurn();
  if (!queued) {
    status = { ...status, state: result.code === 0 ? 'exited' : 'failed', exitCode: result.code, signal: result.signal, endedAt: new Date().toISOString() };
    exitCode = result.code ?? 0;
    break;
  }
  turn = queued;
}
await writes;
await atomic('status.json', status);
await new Promise<void>(resolve => log.end(() => resolve()));
process.exit(exitCode);
