#!/usr/bin/env node
import { readFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { homedir } from 'node:os';
import { install, statusReport, detectReport, currentOs } from './install/manager.js';
import { Ai4aiStore } from './core/store.js';
import { execute } from './core/operations.js';
import { HARNESSES, EVENT_KINDS, type EventKind, type HarnessId, type Surface } from './contract/states.js';
import { TOOL_DESCRIPTION, TOOL_NAME } from './contract/tool.js';
import type { Identity } from './contract/types.js';
import { claudeAdapter } from './adapters/claude/adapter.js';
import { codexAdapter } from './adapters/codex/adapter.js';
import { openCodeAdapter } from './adapters/opencode/adapter.js';
import { dshAdapter } from './adapters/dsh/adapter.js';
import { readStatus, executorDir, type ExecutorStatus } from './adapters/executors.js';
import { livenessOf } from './adapters/external.js';
import { lifecycleOfStatus, processStateOf } from './adapters/executors.js';
import { readEventTail } from './core/events.js';
import { readTranscriptTail } from './core/transcript.js';
import { verifyAdoption } from './core/adoption.js';
import { activitySummary } from './core/activity.js';
import { forceKillTree, verifyIdentity } from './core/process-identity.js';
import { withExecutorLock } from './core/executor-lock.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const adapters = { 'claude-code': claudeAdapter, codex: codexAdapter, opencode: openCodeAdapter, dsh: dshAdapter } as const;

interface Parsed {
  command: string;
  flags: Map<string, string[]>;
}

const VALUE_FLAGS = [
  'harness', 'scope', 'workspace', 'home', 'profile', 'package-root', 'contract', 'operation', 'task', 'target', 'mode', 'session', 'surface', 'operation-id', 'timeout', 'model', 'reasoning-effort', 'count',
  'executor', 'until', 'condition', 'cursor', 'tail', 'format', 'kind', 'continuation', 'interval', 'spawn', 'persistence', 'permission-mode', 'allowed-tools', 'disallowed-tools', 'env-exclude', 'mcp-deny', 'spawn-surface', 'spawn-profile', 'log-tail', 'log-cursor', 'log-format', 'isolation', 'policy', 'limit', 'session',
];
const BOOLEAN_FLAGS = ['yes', 'json', 'dry-run', 'help', 'version', 'any', 'transcript', 'follow'];
const CLI_OPERATIONS = ['handoff', 'spawn', 'status', 'message', 'cancel', 'stop', 'finish', 'list', 'capabilities'] as const;

/** Usage/configuration error: exit code 2, distinct from runtime failures (1). */
class UsageError extends Error {}
const HARNESS_IDS = new Set<string>(HARNESSES);

function parse(argv: string[]): Parsed {
  const command = argv[0] && !argv[0].startsWith('-') ? argv.shift()! : 'help';
  const flags = new Map<string, string[]>();
  while (argv.length) {
    const token = argv.shift()!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.includes(name)) { flags.set(name, ['true']); continue; }
    if (!VALUE_FLAGS.includes(name)) throw new Error(`Unknown option: ${token}`);
    const value = argv.shift();
    if (!value || value.startsWith('--')) throw new Error(`Option ${token} requires a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { command, flags };
}

const flag = (parsed: Parsed, name: string): string | undefined => parsed.flags.get(name)?.[0];
const harnesses = (parsed: Parsed): HarnessId[] | undefined => {
  const values = parsed.flags.get('harness');
  if (!values) return undefined;
  const ids = values.flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean);
  for (const id of ids) if (!HARNESSES.includes(id as HarnessId)) throw new Error(`Unknown harness: ${id}`);
  return ids as HarnessId[];
};

const fileExists = async (file: string): Promise<boolean> => {
  try { await access(file); return true; } catch { return false; }
};

/** PARITY-041: `events --kind` filter (repeatable or comma separated). */
const eventKinds = (parsed: Parsed): EventKind[] | undefined => {
  const values = parsed.flags.get('kind');
  if (!values) return undefined;
  const kinds = values.flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean);
  if (kinds.length === 0) return undefined;
  for (const kind of kinds) if (!EVENT_KINDS.includes(kind as EventKind)) throw new UsageError(`Unknown event kind: ${kind} (expected ${EVENT_KINDS.join('|')})`);
  return kinds as EventKind[];
};

/**
 * Project-scope installs keep state in `<workspace>/.ai4ai`; otherwise use the
 * user home. The project install home is `<workspace>/.ai4ai`, so its ownership
 * record lives at `<workspace>/.ai4ai/.ai4ai/ownership.json`; a home whose
 * state sits directly at `<workspace>/.ai4ai` is also accepted.
 */
async function operationHome(parsed: Parsed, workspace: string): Promise<string> {
  const explicit = flag(parsed, 'home');
  if (explicit) return path.resolve(explicit);
  const project = path.join(workspace, '.ai4ai');
  if (await fileExists(path.join(project, '.ai4ai', 'ownership.json'))) return project;
  if (await fileExists(path.join(project, 'ownership.json'))) return workspace;
  return path.join(homedir(), '.ai4ai');
}

/** A stable session id keeps executor ownership across separate CLI invocations. */
async function cliSession(home: string): Promise<string> {
  const file = path.join(home, '.ai4ai', 'cli-session');
  if (await fileExists(file)) return (await readFile(file, 'utf8')).trim();
  const value = `cli-${randomUUID()}`;
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, value + '\n', { mode: 0o600 });
  return value;
}

/** Run one contract operation and print the schema-valid result. */
async function runOperation(parsed: Parsed): Promise<void> {
  const operation = flag(parsed, 'operation');
  if (!operation || !(CLI_OPERATIONS as readonly string[]).includes(operation)) {
    throw new Error(`--operation must be one of: ${CLI_OPERATIONS.join(', ')}`);
  }
  const harness = flag(parsed, 'harness') ?? process.env.AI4AI_HARNESS;
  if (!harness || !HARNESS_IDS.has(harness)) {
    throw new Error(`--harness is required for contract operations (${HARNESSES.join(', ')})`);
  }
  const workspace = path.resolve(flag(parsed, 'workspace') ?? process.cwd());
  const home = await operationHome(parsed, workspace);
  if (!(await fileExists(path.join(home, '.ai4ai', 'ownership.json')))) {
    throw new Error(`No ai4ai installation at ${home}; run "ai4ai init" first`);
  }
  // A carrier-launched CLI belongs to a detached executor: default its surface
  // to headless so the execution identity matches the surface it runs on.
  const executorId = process.env.AI4AI_EXECUTOR_ID;
  const surface = flag(parsed, 'surface') ?? (executorId ? 'headless' : 'tui');
  if (!['tui', 'headless', 'web'].includes(surface)) throw new Error(`Invalid surface: ${surface}`);
  const session = flag(parsed, 'session') ?? process.env.AI4AI_SESSION ?? await cliSession(home);
  const identity: Identity = {
    harness: harness as HarnessId, workspace, surface: surface as Identity['surface'], session,
    generation: process.env.AI4AI_GENERATION ?? 'cli', agent: 'main',
  };
  const request: Record<string, unknown> = {
    operation,
    operationId: flag(parsed, 'operation-id') ?? `${operation}-${randomUUID()}`,
  };
  const task = flag(parsed, 'task');
  if (task !== undefined) request.task = task;
  const target = flag(parsed, 'target');
  if (target !== undefined) request.target = target;
  else if (['handoff', 'message', 'cancel', 'stop', 'finish'].includes(operation)) request.target = 'self';
  const isolation = flag(parsed, 'isolation');
  if (isolation !== undefined) request.isolation = isolation;
  const policyJson = flag(parsed, 'policy');
  if (policyJson !== undefined) {
    let policy: unknown;
    try { policy = JSON.parse(policyJson); } catch { throw new UsageError('--policy must be a JSON object'); }
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new UsageError('--policy must be a JSON object');
    request.policy = policy;
  }
  // Spawn carrier options (nested under `spawn`).
  const spawn: Record<string, unknown> = {};
  const persistence = flag(parsed, 'persistence');
  if (persistence !== undefined) spawn.persistence = persistence;
  const spawnSurface = flag(parsed, 'spawn-surface');
  if (spawnSurface !== undefined) spawn.surface = spawnSurface;
  const spawnProfile = flag(parsed, 'spawn-profile');
  if (spawnProfile !== undefined) spawn.profile = spawnProfile;
  const permissionMode = flag(parsed, 'permission-mode');
  if (permissionMode !== undefined) spawn.permissionMode = permissionMode;
  const listFlag = (name: string): string[] | undefined => {
    const values = parsed.flags.get(name);
    if (!values) return undefined;
    return values.flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean);
  };
  const allowedTools = listFlag('allowed-tools');
  if (allowedTools) spawn.allowedTools = allowedTools;
  const disallowedTools = listFlag('disallowed-tools');
  if (disallowedTools) spawn.disallowedTools = disallowedTools;
  const envExclude = listFlag('env-exclude');
  if (envExclude) spawn.envExclude = envExclude;
  const mcpDeny = listFlag('mcp-deny');
  if (mcpDeny) spawn.mcp = { deny: mcpDeny };
  const spawnJson = flag(parsed, 'spawn');
  if (spawnJson !== undefined) {
    const parsedSpawn = JSON.parse(spawnJson) as Record<string, unknown>;
    Object.assign(spawn, parsedSpawn);
  }
  if (Object.keys(spawn).length) request.spawn = spawn;
  const logTail = flag(parsed, 'log-tail');
  const logCursor = flag(parsed, 'log-cursor');
  const logFormat = flag(parsed, 'log-format');
  if (logTail !== undefined || logCursor !== undefined || logFormat !== undefined) {
    request.logTail = {
      ...(logTail !== undefined ? { tail: Number(logTail) } : {}),
      ...(logCursor !== undefined ? { cursor: Number(logCursor) } : {}),
      ...(logFormat !== undefined ? { format: logFormat } : {}),
    };
  }
  const mode = flag(parsed, 'mode');
  if (mode !== undefined) request.mode = mode;
  const continuation = flag(parsed, 'continuation');
  if (continuation !== undefined) request.continuation = continuation;
  const model = flag(parsed, 'model');
  if (model !== undefined) request.model = model;
  const reasoningEffort = flag(parsed, 'reasoning-effort');
  if (reasoningEffort !== undefined) request.reasoningEffort = reasoningEffort;
  const count = flag(parsed, 'count');
  if (count !== undefined) request.count = Number(count);
  const timeout = flag(parsed, 'timeout');
  if (timeout !== undefined) request.timeoutMs = Number(timeout);
  const store = await Ai4aiStore.open(home);
  const result = await execute(request, { home, identity, adapter: adapters[harness as HarnessId], store, os: currentOs(), ...(executorId ? { executorId } : {}) });
  if (parsed.flags.has('json')) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`ai4ai ${result.operation} ${result.status}${result.state ? ` (${result.state})` : ''}`);
  console.log(`  ${result.reason}`);
  if (result.executorId) console.log(`  executor: ${result.executorId}`);
  if (result.sessionId) console.log(`  session: ${result.sessionId}`);
  if (result.context?.used != null) console.log(`  context: ${result.context.used} used${result.context.percent != null ? ` (${result.context.percent}% ${result.context.percentSource})` : ''}`);
  if (result.turns !== undefined) console.log(`  turns: ${result.turns}${result.queuedTurns !== undefined ? ` queued: ${result.queuedTurns}` : ''}${result.lastTurnOutcome ? ` last: ${result.lastTurnOutcome}` : ''}`);
  if (result.turnId) console.log(`  turn: ${result.turnId}${result.queuePosition !== undefined ? ` position: ${result.queuePosition}` : ''}`);
  if (result.processState) console.log(`  process: ${result.processState}${result.processStateReason ? ` (${result.processStateReason})` : ''}`);
  if (result.proof) console.log(`  proof: ${result.proof.mechanism} ${result.proof.nativeEvidence}`);
}

const adapterFor = (harness: HarnessId) => adapters[harness];

async function managedContext(parsed: Parsed): Promise<{ home: string; workspace: string }> {
  const workspace = path.resolve(flag(parsed, 'workspace') ?? process.cwd());
  const home = await operationHome(parsed, workspace);
  if (!(await fileExists(path.join(home, '.ai4ai', 'ownership.json')))) {
    throw new Error(`No ai4ai installation at ${home}; run "ai4ai init" first`);
  }
  return { home, workspace };
}

/** Observe one executor without journaling a contract operation. */
async function observeExecutor(home: string, workspace: string, store: Ai4aiStore, executorId: string) {
  const record = (await store.executors()).find(candidate => candidate.executorId === executorId);
  if (!record) return undefined;
  const raw = await readStatus(home, executorId);
  const liveness = raw ? await livenessOf(home, executorId, raw) : {};
  const state = lifecycleOfStatus(raw, liveness);
  const processState = raw ? processStateOf(raw, liveness).state : 'unknown';
  const identity: Identity = { ...record.parent };
  const outcome = await adapterFor(record.harness).status(
    { operation: 'status', operationId: `watch-${executorId}`, target: executorId },
    { identity, store, home },
  );
  return { record, raw, state, processState, outcome };
}

interface WatchCondition { evaluate(snapshot: { state: string; processState: string; raw: ExecutorStatus | undefined; outcome: any; eventMatch: boolean }): boolean; label: string }

function parseCondition(text: string): WatchCondition {
  const normalized = text.trim();
  let match: RegExpExecArray | null;
  if ((match = /^state\s+in\s*\[([^\]]*)\]$/.exec(normalized))) {
    const values = match[1]!.split(',').map(value => value.trim()).filter(Boolean);
    return { label: normalized, evaluate: snapshot => values.includes(snapshot.state) };
  }
  if ((match = /^state\s*(?:=|==)\s*([A-Za-z-]+)$/.exec(normalized))) {
    const value = match[1]!;
    return { label: normalized, evaluate: snapshot => snapshot.state === value };
  }
  if ((match = /^(?:idle-for|idleFor)\s*(?:>=)?\s*(\d+)$/i.exec(normalized))) {
    const seconds = Number(match[1]);
    return {
      label: normalized,
      evaluate: snapshot => {
        if (snapshot.state !== 'idle' || !snapshot.raw?.idleSince) return false;
        return Date.now() - Date.parse(snapshot.raw.idleSince) >= seconds * 1000;
      },
    };
  }
  if ((match = /^(?:last-activity-age|no-event-for|turn-age)\s*(?:>=)?\s*(\d+)$/i.exec(normalized))) {
    const kind = match[0].toLowerCase().startsWith('turn-age') ? 'turn' : 'activity';
    const seconds = Number(match[1]);
    return {
      label: normalized,
      evaluate: snapshot => {
        const raw = snapshot.raw;
        if (!raw) return false;
        const candidates = kind === 'turn'
          ? [raw.turnStartedAt, raw.lastTurnAt]
          : [raw.lastActivityAt, raw.lastTurnAt, raw.turnStartedAt];
        const stamps = candidates.filter((value): value is string => typeof value === 'string').map(value => Date.parse(value)).filter(value => Number.isFinite(value));
        if (!stamps.length) return false;
        return Date.now() - Math.max(...stamps) >= seconds * 1000;
      },
    };
  }
  if ((match = /^(turns|queued-turns)\s*(?:>=)?\s*(\d+)$/i.exec(normalized))) {
    const key = match[1]!.toLowerCase() === 'queued-turns' ? 'queuedTurns' : 'turns';
    const threshold = Number(match[2]);
    return {
      label: normalized,
      evaluate: snapshot => {
        const value = key === 'queuedTurns' ? snapshot.outcome?.queuedTurns : snapshot.outcome?.turns ?? snapshot.raw?.turns;
        return typeof value === 'number' && value >= threshold;
      },
    };
  }
  if ((match = /^context\.percent\s*(?:>=)?\s*(\d+(?:\.\d+)?)$/.exec(normalized))) {
    const threshold = Number(match[1]);
    return {
      label: normalized,
      evaluate: snapshot => {
        const value = snapshot.outcome?.context?.percent;
        return typeof value === 'number' && value >= threshold;
      },
    };
  }
  if ((match = /^processState\s*(?:=|==)\s*([A-Za-z-]+)$/.exec(normalized))) {
    const value = match[1]!;
    return { label: normalized, evaluate: snapshot => snapshot.processState === value };
  }
  if ((match = /^event\s*~\s*(.+)$/.exec(normalized))) {
    try { new RegExp(match[1]!); } catch { throw new UsageError(`Invalid event regular expression: ${match[1]}`); }
    return { label: normalized, evaluate: snapshot => snapshot.eventMatch };
  }
  throw new UsageError(`Unknown watch condition: ${normalized}`);
}

/**
 * Declarative, read-only watcher (qgo watcher parity). Conditions are a
 * bounded heuristic, not a definitive hang detector: a legitimately long
 * silent reasoning turn can satisfy last-activity-age/turn-age, so the caller
 * decides whether to intervene.
 */
async function runWatch(parsed: Parsed): Promise<void> {
  const { home, workspace } = await managedContext(parsed);
  const executorId = flag(parsed, 'executor');
  if (!executorId) throw new UsageError('watch requires --executor <id>');
  const conditionText = [...(parsed.flags.get('until') ?? []), ...(parsed.flags.get('condition') ?? [])];
  const conditions = conditionText.map(parseCondition);
  if (!conditions.length) throw new UsageError('watch requires at least one --until/--condition condition');
  const timeoutSeconds = Number(flag(parsed, 'timeout') ?? 300);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new UsageError('--timeout must be a positive number of seconds');
  const intervalMs = Math.max(200, Number(flag(parsed, 'interval') ?? 1000));
  const any = parsed.flags.has('any');
  const format = (flag(parsed, 'format') ?? 'events') === 'lines' ? 'lines' : 'events';
  let cursor = Number(flag(parsed, 'cursor') ?? 0);
  const eventConditions = conditionText.filter(value => /^event\s*~/.test(value.trim()));
  const regexes = eventConditions.map(value => new RegExp(/^event\s*~\s*(.+)$/.exec(value.trim())![1]!));
  let eventMatch = false;
  const store = await Ai4aiStore.open(home);
  const deadline = Date.now() + timeoutSeconds * 1000;
  const started = Date.now();
  for (;;) {
    const observed = await observeExecutor(home, workspace, store, executorId);
    if (!observed) throw new UsageError(`Unknown executor: ${executorId}`);
    if (regexes.length) {
      const tail = await readEventTail(home, executorId, observed.record.harness, { cursor, tail: 1000 });
      cursor = tail.nextCursor;
      if (tail.events?.some(event => regexes.some(regex => regex.test(`${event.kind} ${event.text ?? ''} ${event.detail ?? ''}`)))) eventMatch = true;
    }
    const snapshot = { state: observed.state, processState: observed.processState, raw: observed.raw, outcome: observed.outcome, eventMatch };
    const results = conditions.map(condition => ({ condition, met: condition.evaluate(snapshot) }));
    const met = any ? results.some(result => result.met) : results.every(result => result.met);
    if (met) {
      const report = {
        executorId, met: true, exitCode: 0, elapsedSeconds: (Date.now() - started) / 1000,
        state: observed.state, processState: observed.processState,
        conditions: results.map(result => ({ condition: result.condition.label, met: result.met })),
        status: observed.outcome, nextCursor: cursor,
      };
      if (parsed.flags.has('json')) console.log(JSON.stringify(report, null, 2));
      else console.log(`ai4ai watch ${executorId} met (${observed.state})`);
      return;
    }
    if (Date.now() >= deadline) {
      const report = {
        executorId, met: false, exitCode: 3, elapsedSeconds: (Date.now() - started) / 1000,
        state: observed.state, processState: observed.processState,
        conditions: results.map(result => ({ condition: result.condition.label, met: result.met })),
        nextCursor: cursor,
        reason: 'timeout without condition',
      };
      if (parsed.flags.has('json')) console.log(JSON.stringify(report, null, 2));
      else console.log(`ai4ai watch ${executorId} timeout (${observed.state})`);
      process.exitCode = 3;
      return;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/** List, identity-check and clean owned executors (orphans and stale records). */
async function runSweep(parsed: Parsed): Promise<void> {
  const { home, workspace } = await managedContext(parsed);
  const store = await Ai4aiStore.open(home);
  const records = await store.executors();
  const results: unknown[] = [];
  let orphansKilled = 0; let reconciled = 0; let unverified = 0; let alive = 0;
  for (const record of records) {
    const raw = await readStatus(home, record.executorId);
    const liveness = raw ? await livenessOf(home, record.executorId, raw) : {};
    const state = lifecycleOfStatus(raw, liveness);
    const processState = raw ? processStateOf(raw, liveness).state : 'unknown';
    let action = 'none';
    if (processState === 'orphaned') {
      const childPid = raw?.pid ?? raw?.child?.pid;
      const recorded = raw?.child;
      const verdict = childPid && recorded
        ? verifyIdentity({ pid: childPid, ...(recorded.startToken ? { startToken: recorded.startToken } : {}), ...(recorded.commandHash ? { commandHash: recorded.commandHash } : {}) }).verdict
        : 'unknown';
      if (verdict === 'match' && childPid) {
        if (process.platform === 'win32') forceKillTree(childPid);
        else {
          try { process.kill(-childPid, 'SIGKILL'); } catch { /* not a group */ }
          forceKillTree(childPid);
        }
        await withExecutorLock(executorDir(home, record.executorId), async () => {
          await store.updateExecutor(record.executorId, { state: 'failed' });
        }, { operation: 'sweep' }).catch(() => undefined);
        action = 'orphan-killed'; orphansKilled++;
      } else {
        action = 'orphan-unverified'; unverified++;
      }
    } else if (processState === 'dead' && ['running', 'idle'].includes(state)) {
      await withExecutorLock(executorDir(home, record.executorId), async () => {
        await store.updateExecutor(record.executorId, { state });
      }, { operation: 'sweep' }).catch(() => undefined);
      action = 'reconciled'; reconciled++;
    } else if (processState === 'unknown') {
      action = 'unknown'; unverified++;
    } else if (processState === 'alive') {
      alive++;
    }
    results.push({ executorId: record.executorId, state, processState, action, pid: raw?.pid ?? null, supervisorPid: raw?.supervisorPid ?? null });
  }
  const report = { swept: records.length, orphansKilled, reconciled, unverified, alive, executors: results };
  if (parsed.flags.has('json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`ai4ai sweep ${records.length} executor(s): ${orphansKilled} orphan(s) killed, ${reconciled} reconciled, ${unverified} unverified, ${alive} alive`);
    for (const entry of results as { executorId: string; state: string; processState: string; action: string }[]) {
      console.log(`  ${entry.executorId} ${entry.state}/${entry.processState} ${entry.action}`);
    }
  }
  if (unverified) process.exitCode = 1;
}

/** Read a bounded normalized event tail from an executor log. */
async function runEvents(parsed: Parsed): Promise<void> {
  const { home } = await managedContext(parsed);
  const executorId = flag(parsed, 'executor');
  if (!executorId) throw new UsageError('events requires --executor <id>');
  const store = await Ai4aiStore.open(home);
  const record = (await store.executors()).find(candidate => candidate.executorId === executorId);
  if (!record) throw new UsageError(`Unknown executor: ${executorId}`);
  const kinds = eventKinds(parsed);
  const tail = await readEventTail(home, executorId, record.harness, {
    ...(flag(parsed, 'cursor') !== undefined ? { cursor: Number(flag(parsed, 'cursor')) } : {}),
    ...(flag(parsed, 'tail') !== undefined ? { tail: Number(flag(parsed, 'tail')) } : {}),
    ...(flag(parsed, 'format') !== undefined ? { format: flag(parsed, 'format') as 'events' | 'lines' } : {}),
    ...(kinds ? { kind: kinds } : {}),
  });
  console.log(JSON.stringify(tail, null, 2));
}

/** PARITY-037: opt-in bounded/redacted transcript tail. */
async function runTranscript(parsed: Parsed): Promise<void> {
  const { home, workspace } = await managedContext(parsed);
  const executorId = flag(parsed, 'executor');
  const harness = flag(parsed, 'harness') as 'claude-code' | 'codex' | 'opencode' | 'dsh' | undefined;
  let session = flag(parsed, 'session');
  let harnessId = harness;
  if (executorId) {
    const store = await Ai4aiStore.open(home);
    const record = (await store.executors()).find(candidate => candidate.executorId === executorId);
    if (!record) throw new UsageError(`Unknown executor: ${executorId}`);
    session = session ?? record.sessionId;
    harnessId = harnessId ?? record.harness;
  }
  if (!harnessId) throw new UsageError('transcript requires --harness or --executor');
  if (!session) throw new UsageError('transcript requires --session or an executor with a recorded session');
  const tail = await readTranscriptTail(harnessId, workspace, session, {
    ...(flag(parsed, 'limit') !== undefined ? { limit: Number(flag(parsed, 'limit')) } : {}),
    ...(flag(parsed, 'cursor') !== undefined ? { cursor: Number(flag(parsed, 'cursor')) } : {}),
  });
  if (!tail) throw new UsageError('The session store could not be resolved');
  console.log(JSON.stringify(tail, null, 2));
}

/** PARITY-038: caller-invoked adoption verification. */
async function runAdoption(parsed: Parsed): Promise<void> {
  const { home, workspace } = await managedContext(parsed);
  const executorId = flag(parsed, 'executor');
  const operationId = flag(parsed, 'operation-id');
  if (!executorId) throw new UsageError('adoption requires --executor <id>');
  if (!operationId) throw new UsageError('adoption requires --operation-id <id>');
  const store = await Ai4aiStore.open(home);
  const report = await verifyAdoption({
    home, workspace, store, executorId, operationId,
    ...(parsed.flags.has('transcript') ? { transcript: true } : {}),
    ...(flag(parsed, 'limit') !== undefined ? { limit: Number(flag(parsed, 'limit')) } : {}),
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.adopted) process.exitCode = 1;
}

/** PARITY-042: read-only activity summary. */
async function runActivity(parsed: Parsed): Promise<void> {
  const { home, workspace } = await managedContext(parsed);
  const executorId = flag(parsed, 'executor');
  if (!executorId) throw new UsageError('activity requires --executor <id>');
  const store = await Ai4aiStore.open(home);
  const record = (await store.executors()).find(candidate => candidate.executorId === executorId);
  if (!record) throw new UsageError(`Unknown executor: ${executorId}`);
  const summary = await activitySummary({
    home, workspace, executorId, harness: record.harness,
    ...(flag(parsed, 'limit') !== undefined ? { events: { tail: Number(flag(parsed, 'limit')) } } : {}),
  });
  console.log(JSON.stringify(summary, null, 2));
}

/** PARITY-043: read-only follow loop over the normalized event tail. */
async function runEventsFollow(parsed: Parsed): Promise<void> {
  const { home } = await managedContext(parsed);
  const executorId = flag(parsed, 'executor');
  if (!executorId) throw new UsageError('events requires --executor <id>');
  const store = await Ai4aiStore.open(home);
  const record = (await store.executors()).find(candidate => candidate.executorId === executorId);
  if (!record) throw new UsageError(`Unknown executor: ${executorId}`);
  const timeoutSeconds = Number(flag(parsed, 'timeout') ?? 300);
  const intervalMs = Math.max(200, Number(flag(parsed, 'interval') ?? 1000));
  const kinds = eventKinds(parsed);
  let cursor = Number(flag(parsed, 'cursor') ?? 0);
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  for (;;) {
    const tail = await readEventTail(home, executorId, record.harness, { cursor, tail: 1000, ...(kinds ? { kind: kinds } : {}) });
    cursor = tail.nextCursor;
    if ((tail.events?.length ?? 0) > 0) console.log(JSON.stringify(tail));
    if (Date.now() >= deadline) { process.exitCode = 3; return; }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

function printReport(report: unknown, json: boolean): void {
  if (json) { console.log(JSON.stringify(report, null, 2)); return; }
  const value = report as {
    version: string; home: string;
    actions?: { harness: string; profile?: string; action: string; state: string; reason: string; target?: string }[];
    detections?: { harness: string; installed: boolean; version?: string; reason: string }[];
    registered?: string[];
    dsh?: { home: string; profiles: { profile: string; state: string; version?: string; reason?: string }[]; notices: string[] };
  };
  console.log(`ai4ai ${value.version} ${value.home}`);
  for (const detection of value.detections ?? []) console.log(`  ${detection.installed ? 'detected' : 'missing '} ${detection.harness}${detection.version ? ` ${detection.version}` : ''}`);
  if (value.registered) console.log(`  registered: ${value.registered.length ? value.registered.join(', ') : 'none'}`);
  for (const action of value.actions ?? []) console.log(`  ${action.action} ${action.harness}${action.profile ? `[${action.profile}]` : ''}: ${action.state} - ${action.reason}${action.target ? ` (${action.target})` : ''}`);
  if (value.dsh) {
    console.log(`  dsh home: ${value.dsh.home}`);
    for (const profile of value.dsh.profiles) console.log(`  dsh profile ${profile.profile}: ${profile.state}${profile.version ? ` ${profile.version}` : ''}${profile.reason ? ` - ${profile.reason}` : ''}`);
    for (const notice of value.dsh.notices) console.log(`  notice: ${notice}`);
  }
}

async function main(): Promise<void> {
  const parsed = parse(process.argv.slice(2));
  if (flag(parsed, 'version') || parsed.command === 'version') {
    console.log(`ai4ai ${JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version}`);
    return;
  }
  if (parsed.command === 'help' || flag(parsed, 'help')) {
    console.log(`AI4AI - AI Harness Extension Kit

Usage: ai4ai <init|status|upgrade|uninstall|capabilities|detect|op|session|watch|events|transcript|adoption|activity|sweep> [options]

Contract operations: ai4ai session --operation <handoff|spawn|status|message|cancel|stop|finish|list|capabilities> --harness <id> [--task <text>] [--target <self|id>]
(ai4ai op is an alias of ai4ai session.)

Watcher (read-only, declarative):
  ai4ai watch --executor <id> --until "state in [completed,failed,cancelled]" [--until ...] [--timeout <seconds>] [--any] [--json]
  Conditions: state in [..]/state=<x>, idle-for N, last-activity-age >= N, no-event-for N,
              turn-age >= N, context.percent >= N,
              event ~ REGEX, processState=orphaned.
  Exit codes: 0 condition met, 3 timeout, 2 usage/config, 1 runtime.
  ai4ai events --executor <id> [--tail N] [--cursor N] [--kind message,tool,...] [--format events|lines]
  ai4ai sweep [--json]

Spawn options: --persistence one-shot|persistent --permission-mode bypassPermissions|dontAsk
  --allowed-tools a,b --disallowed-tools Skill(gclear) --env-exclude A,B --mcp-deny name
  --spawn-surface headless|web --spawn-profile <dsh profile> --isolation inherit|isolated
  --policy '{"allowSelfHandoff":false,"allowSelfStop":false,"allowSpawnChildren":false}'

AI-facing tool (${TOOL_NAME}):
${TOOL_DESCRIPTION}

Options:
  --harness <id>        claude-code | codex | opencode | dsh (repeatable or comma separated)
  --scope <scope>       user (default) | project
  --workspace <path>    workspace for project scope and spawn carriers
  --home <path>         override the managed installation home
  --profile <name>      DSH profile (default: install both web and headless)
  --yes                 accept detected harnesses without an interactive prompt
  --dry-run             report the plan without changing files
  --json                machine-readable output
  --version             print the package version

Headless is the must-pass baseline; TUI/web
support is declared per harness and never implied.`);
    return;
  }

  const selectedHarnesses = harnesses(parsed);
  const workspaceFlag = flag(parsed, 'workspace');
  const homeFlag = flag(parsed, 'home');
  const profileFlag = flag(parsed, 'profile');
  const packageRootFlag = flag(parsed, 'package-root');
  const common = {
    scope: (flag(parsed, 'scope') ?? 'user') as 'user' | 'project',
    ...(workspaceFlag ? { workspace: workspaceFlag } : {}),
    ...(homeFlag ? { home: homeFlag } : {}),
    ...(profileFlag ? { profile: profileFlag } : {}),
    ...(packageRootFlag ? { packageRoot: packageRootFlag } : {}),
    yes: parsed.flags.has('yes'),
    dryRun: parsed.flags.has('dry-run'),
    ...(selectedHarnesses ? { harnesses: selectedHarnesses } : {}),
  };

  if (parsed.command === 'init' || parsed.command === 'upgrade' || parsed.command === 'uninstall') {
    const report = await install({ ...common, action: parsed.command === 'uninstall' ? 'uninstall' : parsed.command === 'upgrade' ? 'upgrade' : 'install' });
    printReport(report, parsed.flags.has('json'));
    const failed = report.actions.some(action => ['failed', 'unknown'].includes(action.state));
    process.exitCode = failed ? 1 : 0;
    return;
  }
  if (parsed.command === 'status') {
    printReport(await statusReport({ action: 'install', ...common }), parsed.flags.has('json'));
    return;
  }
  if (parsed.command === 'capabilities') {
    const os = currentOs();
    const selected = harnesses(parsed) ?? [...HARNESSES];
    const declarations = selected.flatMap(harness => adapters[harness].capabilities(os));
    printReport({ version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, home: '-', declarations }, parsed.flags.has('json'));
    return;
  }
  if (parsed.command === 'detect') {
    printReport(await detectReport({ action: 'install', ...common }), parsed.flags.has('json'));
    return;
  }
  if (parsed.command === 'op' || parsed.command === 'session') {
    await runOperation(parsed);
    return;
  }
  if (parsed.command === 'watch') { await runWatch(parsed); return; }
  if (parsed.command === 'sweep') { await runSweep(parsed); return; }
  if (parsed.command === 'events') {
    if (parsed.flags.has('follow')) { await runEventsFollow(parsed); return; }
    await runEvents(parsed); return;
  }
  if (parsed.command === 'transcript') { await runTranscript(parsed); return; }
  if (parsed.command === 'adoption') { await runAdoption(parsed); return; }
  if (parsed.command === 'activity') { await runActivity(parsed); return; }
  throw new Error(`Unknown command: ${parsed.command}`);
}

main().catch(error => {
  console.error(JSON.stringify({ state: 'failed', reason: error instanceof Error ? error.message : 'CLI failed' }));
  // 2 = usage/config error; 1 = runtime error. Conditions/timeout never set 2.
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
