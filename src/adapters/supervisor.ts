#!/usr/bin/env node
/**
 * Detached executor supervisor (protocol 3).
 *
 * Started as its own process with `detached: true` so it survives the parent
 * session and process. It owns the harness child, `status.json` (single
 * writer), the inbox and the turn ledger (`turns.ndjson`), drains queued
 * messages as follow-up turns in the same native session, reports `idle`
 * between turns for persistent executors, and honours stop/finish requests.
 *
 * Carrier models:
 * - per-turn: one child process per turn, resumed with the native session id.
 * - resident: one interactive child fed one stream-json user message per turn
 *   (Claude persistent mode), preserving in-process state and MCP connections.
 */
import { createWriteStream, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { spawnEnvironment } from '../core/env-policy.js';
import { processIdentity, writeHeartbeat } from '../core/process-identity.js';

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
const readJson = async <T>(name: string): Promise<T | undefined> => {
  try { return JSON.parse(await readFile(file(name), 'utf8')) as T; } catch { return undefined; }
};
const control = (): { stop: boolean; finish: boolean } => {
  try {
    const value = JSON.parse(readFileSync(file('control.json'), 'utf8')) as { stop?: boolean; finish?: boolean };
    return { stop: value?.stop === true, finish: value?.finish === true };
  } catch { return { stop: false, finish: false }; }
};

interface Spec {
  harness?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  envExclude?: string[];
  cwd: string;
  inputFile?: string;
  sessionRegex?: string;
  windowsVerbatimArguments?: boolean;
  supervisorProtocol?: number;
  persistence?: 'one-shot' | 'persistent';
  epoch?: number;
  initialTurnId?: string;
  initialOperationId?: string;
  initialTurns?: number;
  resident?: boolean;
  /** Same-session guard: every turn must report this native session id. */
  expectedSessionId?: string;
}
interface Turn {
  inputFile?: string;
  turnId?: string;
  operationId?: string;
  expectedSessionId?: string;
  command?: string;
  args?: string[];
  windowsVerbatimArguments?: boolean;
}
type Outcome = 'completed' | 'failed' | 'cancelled';
interface TurnRecord {
  turnId: string; operationId?: string; startedAt: string; endedAt?: string;
  outcome?: Outcome; sessionIdBefore?: string; sessionIdAfter?: string;
  exitCode?: number | null; signal?: string | null; reason?: string;
}
interface Status {
  state: string; startedAt: string; turns: number; pid?: number;
  sessionId?: string; exitCode?: number | null; signal?: string | null; endedAt?: string;
  lastActivityAt?: string; lastActivitySource?: 'native';
  /** The supervisor's own pid (the child harness pid is `pid`). */
  supervisorPid?: number;
  /** Protocol 3 adds idle, the turn ledger and finish. */
  protocol?: number;
  turnState?: 'running' | 'idle';
  persistence?: 'one-shot' | 'persistent';
  lastOperationId?: string;
  lastTurnAt?: string;
  lastTurnOutcome?: Outcome;
  queuedTurns?: number;
  turnStartedAt?: string;
  idleSince?: string;
  epoch?: number;
  resident?: boolean;
  child?: { pid?: number; startToken?: string; commandHash?: string };
  harness?: string;
}

const spec = JSON.parse(await readFile(file('spec.json'), 'utf8')) as Spec;
await mkdir(directory, { recursive: true });
const protocol = typeof spec.supervisorProtocol === 'number' && Number.isSafeInteger(spec.supervisorProtocol) ? spec.supervisorProtocol : 1;
const persistence = spec.persistence === 'persistent' ? 'persistent' : 'one-shot';
const resident = spec.resident === true;
const epoch = typeof spec.epoch === 'number' && Number.isSafeInteger(spec.epoch) ? spec.epoch : 1;
const ownIdentity = processIdentity(process.pid);
const heartbeatStartedAt = new Date().toISOString();
const heartbeatToken = randomUUID();

let status: Status = {
  state: 'starting', startedAt: new Date().toISOString(), turns: typeof spec.initialTurns === 'number' && Number.isSafeInteger(spec.initialTurns) && spec.initialTurns >= 0 ? spec.initialTurns : 0,
  supervisorPid: process.pid, protocol, persistence, epoch, resident,
  ...(spec.harness ? { harness: spec.harness } : {}),
};
await atomic('status.json', status);
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

const heartbeatTimer = setInterval(() => {
  void writeHeartbeat(directory!, {
    token: heartbeatToken, pid: process.pid, startedAt: heartbeatStartedAt, updatedAt: new Date().toISOString(),
    ...(ownIdentity.startToken ? { startToken: ownIdentity.startToken } : {}),
  });
}, 5000);
heartbeatTimer.unref?.();
void writeHeartbeat(directory, {
  token: heartbeatToken, pid: process.pid, startedAt: heartbeatStartedAt, updatedAt: new Date().toISOString(),
  ...(ownIdentity.startToken ? { startToken: ownIdentity.startToken } : {}),
}).catch(() => undefined);

async function ledger(entry: TurnRecord): Promise<void> {
  try { await appendFile(file('turns.ndjson'), JSON.stringify(entry) + '\n'); }
  catch (error) { record('driver', `turn ledger write failed: ${(error as Error).message}`); }
}

async function pendingTurns(): Promise<number> {
  try {
    const entries = await readdir(file('inbox'), { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).length;
  } catch { return 0; }
}

async function refreshQueue(): Promise<void> {
  status = { ...status, queuedTurns: await pendingTurns() };
  await persist();
}

/** Windows: end the whole tree so killing cmd.exe does not orphan node. */
function terminateTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => { try { child.kill(); } catch { /* already gone */ } });
    return;
  }
  // The child starts in its own process group; signal the group so wrapper
  // processes do not leave the harness orphaned.
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function recordChild(childPid: number | undefined, command: string, args: string[]): Promise<void> {
  if (!childPid) return;
  const identity = processIdentity(childPid);
  status = {
    ...status,
    child: {
      pid: childPid,
      ...(identity.startToken ? { startToken: identity.startToken } : {}),
      ...(identity.commandHash ? { commandHash: identity.commandHash } : {}),
    },
  };
  await persist();
  await atomic('child.json', { pid: childPid, ...(identity.startToken ? { startToken: identity.startToken } : {}), command: [command, ...args].join(' '), at: new Date().toISOString() });
}

/** Stop ladder: EOF → grace → SIGTERM → SIGKILL (Windows: taskkill /T /F). */
async function stopLadder(child: ReturnType<typeof spawn>, options: { eof?: () => void; graceMs?: number; termMs?: number } = {}): Promise<void> {
  const graceMs = options.graceMs ?? 20000;
  const termMs = options.termMs ?? 10000;
  try { options.eof?.(); } catch { /* stdin may already be closed */ }
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  const waitUntil = async (deadline: number): Promise<boolean> => {
    while (Date.now() < deadline) {
      if (exited()) return true;
      await delay(200);
    }
    return exited();
  };
  if (await waitUntil(Date.now() + graceMs)) return;
  terminateTree(child, 'SIGTERM');
  if (await waitUntil(Date.now() + termMs)) return;
  if (process.platform === 'win32') {
    if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await waitUntil(Date.now() + 5000);
    return;
  }
  try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* not a group */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  await waitUntil(Date.now() + 5000);
}

interface TurnResult { code: number | null; signal: string | null; stopping: boolean; resultError: boolean; sawResult: boolean }

function observeLine(line: string): void {
  observeSession(line);
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return;
  try {
    const value = JSON.parse(trimmed) as { type?: string; is_error?: boolean; subtype?: string };
    if (value?.type === 'result') {
      residentState.sawResult = true;
      if (value.is_error === true || (typeof value.subtype === 'string' && value.subtype !== 'success')) residentState.resultError = true;
      residentState.onResult?.(value);
    }
  } catch { /* not a JSON event */ }
}

interface ResidentState {
  sawResult: boolean;
  resultError: boolean;
  onResult: ((value: unknown) => void) | undefined;
}
const residentState: ResidentState = { sawResult: false, resultError: false, onResult: undefined };

function runTurnPerTurn(command: string, args: string[], inputFile: string | undefined, verbatim = false): Promise<TurnResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: spec.cwd,
      env: spawnEnvironment(process.env, { envExclude: spec.envExclude ?? [], explicit: spec.env ?? {} }),
      stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32',
      ...(verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    status = { ...status, state: 'running', turnState: 'running', ...(child.pid ? { pid: child.pid } : {}), turnStartedAt: new Date().toISOString() };
    void persist();
    void recordChild(child.pid, command, args);
    let stopping = false;
    let sawResult = false;
    let resultError = false;
    const timer = setInterval(() => {
      if (stopping) return;
      const state = control();
      if (!state.stop) return;
      stopping = true;
      status = { ...status, state: 'stopping' };
      void persist();
      void stopLadder(child, { eof: () => child.stdin.end() });
    }, 400);
    timer.unref?.();
    child.stdout.on('data', data => {
      const text = String(data);
      record('stdout', text);
      touchActivity();
      for (const line of text.split(/\r?\n/)) {
        observeSession(line);
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const value = JSON.parse(trimmed) as { type?: string; is_error?: boolean; subtype?: string };
          if (value?.type === 'result') {
            sawResult = true;
            if (value.is_error === true || (typeof value.subtype === 'string' && value.subtype !== 'success')) resultError = true;
          }
        } catch { /* not a JSON event */ }
      }
    });
    child.stderr.on('data', data => { record('stderr', String(data)); touchActivity(); });
    child.on('error', error => { record('error', error.message); touchActivity(true); });
    child.once('close', (code, signal) => {
      clearInterval(timer);
      status = { ...status, lastActivityAt: new Date().toISOString(), lastActivitySource: 'native' };
      void writes.then(() => resolve({ code, signal, stopping, resultError, sawResult }));
    });
    // Non-interactive harnesses treat EOF as end of input.
    if (inputFile) readFile(file(inputFile), 'utf8').then(text => child.stdin.end(text)).catch(() => child.stdin.end());
    else child.stdin.end();
  });
}

// ── Resident carrier (Claude persistent): one interactive child ───────────
interface Resident {
  child: ReturnType<typeof spawn>;
  waiter: ((value: { code: number | null; signal: string | null }) => void) | undefined;
  closing: boolean;
}
let residentCarrier: Resident | undefined;

function spawnResident(): Resident {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spawnEnvironment(process.env, { envExclude: spec.envExclude ?? [], explicit: spec.env ?? {} }),
    stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32',
    ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  void recordChild(child.pid, spec.command, spec.args);
  child.stdout.on('data', data => {
    const text = String(data);
    record('stdout', text);
    touchActivity();
    for (const line of text.split(/\r?\n/)) observeLine(line);
  });
  child.stderr.on('data', data => { record('stderr', String(data)); touchActivity(); });
  child.on('error', error => { record('error', error.message); touchActivity(true); });
  const state: Resident = { child, closing: false, waiter: undefined };
  child.once('close', (code, signal) => {
    status = { ...status, lastActivityAt: new Date().toISOString(), lastActivitySource: 'native' };
    state.waiter?.({ code, signal });
    state.waiter = undefined;
  });
  return state;
}

const frame = (text: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';

async function runTurnResident(inputFile: string | undefined): Promise<TurnResult> {
  if (!residentCarrier || residentCarrier.closing) residentCarrier = spawnResident();
  const carrier = residentCarrier;
  const text = inputFile ? await readFile(file(inputFile), 'utf8').catch(() => '') : '';
  residentState.sawResult = false;
  residentState.resultError = false;
  status = { ...status, state: 'running', turnState: 'running', turnStartedAt: new Date().toISOString(), ...(carrier.child.pid ? { pid: carrier.child.pid } : {}) };
  await persist();
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => { carrier.waiter = resolve; });
  const settled = new Promise<'result' | 'closed'>(resolve => {
    residentState.onResult = () => resolve('result');
    void closed.then(() => resolve('closed'));
  });
  // A stop during the turn goes through the full ladder; finish only takes
  // effect after this turn settles.
  let stopping = false;
  const timer = setInterval(() => {
    if (stopping) return;
    if (!control().stop) return;
    stopping = true;
    status = { ...status, state: 'stopping' };
    void persist();
    carrier.closing = true;
    void stopLadder(carrier.child, { eof: () => carrier.child.stdin?.end() });
  }, 400);
  timer.unref?.();
  try {
    carrier.child.stdin?.write(frame(text));
  } catch (error) {
    record('error', `resident stdin write failed: ${(error as Error).message}`);
    clearInterval(timer);
    residentState.onResult = undefined;
    return { code: null, signal: null, stopping, resultError: true, sawResult: false };
  }
  const how = await settled;
  clearInterval(timer);
  residentState.onResult = undefined;
  if (how === 'result') {
    // The turn is settled; keep the child alive for the next turn.
    return { code: 0, signal: null, stopping, resultError: residentState.resultError, sawResult: true };
  }
  const exit = await closed;
  return { code: exit.code, signal: exit.signal, stopping, resultError: true, sawResult: residentState.sawResult };
}

/**
 * Claim the oldest queued message with an atomic rename.
 *
 * Enqueue writes one O_EXCL file per message, so no read-modify-write is
 * shared. `rename` is the claim: exactly one consumer can move a given name,
 * and a claimed file is left in `inbox/claimed` until it has been read.
 */
async function nextQueuedTurn(): Promise<Turn | undefined> {
  const inbox = file('inbox');
  const claimed = path.join(inbox, 'claimed');
  let entries;
  try { entries = await readdir(inbox, { withFileTypes: true }); }
  catch { return undefined; }
  const names = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name).sort();
  for (const name of names) {
    const source = path.join(inbox, name);
    const target = path.join(claimed, name);
    try {
      await mkdir(claimed, { recursive: true });
      await rename(source, target);
    } catch { continue; }
    try {
      const value = JSON.parse(await readFile(target, 'utf8')) as Turn;
      await rm(target, { force: true });
      return value;
    } catch { return undefined; }
  }
  return undefined;
}

function outcomeOf(result: TurnResult, stopping: boolean): Outcome {
  if (stopping) return 'cancelled';
  if (result.resultError || result.code !== 0) return 'failed';
  return 'completed';
}

let exitCode = 0;
let finalState = 'exited';
const initial: Turn = {
  ...(spec.inputFile ? { inputFile: spec.inputFile } : {}),
  ...(spec.initialTurnId ? { turnId: spec.initialTurnId } : {}),
  ...(spec.initialOperationId ? { operationId: spec.initialOperationId } : {}),
  ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
};
let turn: Turn | undefined = initial;

// A resident carrier is started once and stays for the whole executor life.
if (resident) {
  residentCarrier = spawnResident();
  status = { ...status, state: 'idle', turnState: 'idle', idleSince: new Date().toISOString(), ...(residentCarrier.child.pid ? { pid: residentCarrier.child.pid } : {}) };
  await persist();
}

let finishing = false;
let lastResult: TurnResult | undefined;
let stopRequestedAtBoundary = false;
for (;;) {
  const state = control();
  if (state.stop) { stopRequestedAtBoundary = true; finalState = 'stopped'; break; }
  if (state.finish) finishing = true;
  if (!turn) {
    // `finish` completes after the current turn and does not drain the queue.
    if (finishing) { finalState = 'exited'; exitCode = 0; break; }
    // One-shot executors still drain queued follow-up turns (the queue, not
    // the process model, decides when the executor is done).
    const queued = await nextQueuedTurn();
    if (queued) { turn = queued; continue; }
    if (persistence === 'one-shot') {
      finalState = lastResult?.resultError || (lastResult && lastResult.code !== 0) ? 'failed' : 'exited';
      exitCode = lastResult?.code ?? 0;
      break;
    }
    // Persistent: report idle and wait for the next message with bounded
    // polling (no busy loop). The supervisor stays the status writer.
    if (status.state !== 'idle') {
      status = { ...status, state: 'idle', turnState: 'idle', idleSince: new Date().toISOString() };
      await refreshQueue();
    }
    if (resident) {
      // A resident child that died while idle is a failed executor, not idle.
      if (residentCarrier && (residentCarrier.child.exitCode !== null || residentCarrier.child.signalCode !== null)) {
        finalState = 'failed';
        exitCode = residentCarrier.child.exitCode ?? 1;
        break;
      }
    }
    await delay(500);
    continue;
  }
  const current = turn;
  turn = undefined;
  const command = current.command ?? spec.command;
  const args = current.args ?? spec.args ?? [];
  const verbatim = current.windowsVerbatimArguments ?? spec.windowsVerbatimArguments === true;
  const turnId = current.turnId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const sessionBefore = status.sessionId;
  status = {
    ...status, state: 'running', turnState: 'running', turns: (status.turns ?? 0) + 1,
    turnStartedAt: startedAt, lastTurnAt: startedAt,
    ...(current.operationId ? { lastOperationId: current.operationId } : {}),
  };
  delete (status as { idleSince?: unknown }).idleSince;
  await persist();
  await ledger({ turnId, ...(current.operationId ? { operationId: current.operationId } : {}), startedAt, ...(sessionBefore ? { sessionIdBefore: sessionBefore } : {}) });
  record('driver', `turn_start ${turnId}`);
  const result = resident
    ? await runTurnResident(current.inputFile)
    : await runTurnPerTurn(command, args, current.inputFile, verbatim);
  lastResult = result;
  // Same-session guard: a resumed/revived turn must run in the recorded native
  // session. A changed (or missing) session id is a failed turn, never a silent
  // success that loses the previous context.
  const expectedSession = current.expectedSessionId ?? spec.expectedSessionId;
  const sessionMismatch = !!expectedSession && status.sessionId !== expectedSession;
  const outcome = sessionMismatch ? 'failed' : outcomeOf(result, result.stopping);
  const endedAt = new Date().toISOString();
  status = { ...status, lastTurnAt: endedAt, lastTurnOutcome: outcome };
  if (sessionMismatch) record('driver', `session_guard turn=${turnId} expected=${expectedSession} observed=${status.sessionId ?? 'none'}`);
  await ledger({
    turnId, ...(current.operationId ? { operationId: current.operationId } : {}), startedAt, endedAt, outcome,
    ...(sessionBefore ? { sessionIdBefore: sessionBefore } : {}),
    ...(status.sessionId ? { sessionIdAfter: status.sessionId } : {}),
    exitCode: result.code, signal: result.signal,
    ...(sessionMismatch ? { reason: `same-session guard: expected ${expectedSession}, observed ${status.sessionId ?? 'none'}` } : {}),
  });
  record('driver', `turn_end ${turnId} ${outcome}`);
  if (sessionMismatch) { finalState = 'failed'; exitCode = 1; break; }
  if (result.stopping) { finalState = 'stopped'; exitCode = result.code ?? 0; break; }
  // Reset the transient child pid for a per-turn carrier: the next child gets
  // its own pid, and an idle executor is defined by the supervisor, not it.
  if (!resident) delete (status as { pid?: unknown }).pid;
  await refreshQueue();
}

// ── Finalize ────────────────────────────────────────────────────────────
const finalResident = residentCarrier;
if (finalResident) {
  finalResident.closing = true;
  if (finalResident.child.exitCode === null && finalResident.child.signalCode === null) {
    await stopLadder(finalResident.child, { eof: () => finalResident.child.stdin?.end() });
  }
}
const endedAt = new Date().toISOString();
status = {
  ...status,
  state: finalState,
  exitCode: finalState === 'exited' ? 0 : (lastResult?.code ?? null),
  signal: lastResult?.signal ?? null,
  endedAt,
  ...(finalState === 'stopped' ? { exitCode: lastResult?.code ?? null } : {}),
} as Status;
delete (status as { turnState?: unknown }).turnState;
delete (status as { idleSince?: unknown }).idleSince;
delete (status as { pid?: unknown }).pid;
await writes;
await atomic('status.json', status);
await writeHeartbeat(directory, {
  token: heartbeatToken, pid: process.pid, startedAt: heartbeatStartedAt, updatedAt: new Date().toISOString(), stoppedAt: endedAt,
  ...(ownIdentity.startToken ? { startToken: ownIdentity.startToken } : {}),
}).catch(() => undefined);
await new Promise<void>(resolve => log.end(() => resolve()));
process.exit(exitCode);
