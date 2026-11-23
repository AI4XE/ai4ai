#!/usr/bin/env node
/**
 * Detached Codex executor runner.
 *
 * One runner owns one Codex app-server process and one thread, which is the
 * "per-executor app-server thread (own process)" carrier required by the plan.
 * It reads the turn text from stdin, emits the thread id as a machine-readable
 * line, records token usage, and exits when the turn settles.
 *
 * Headless self-handoff: an executor that wants a fresh context records a
 * durable intent (see the adapter). This runner owns the app-server channel, so
 * at the turn boundary it compacts its own thread and starts the successor turn
 * in the same thread with the caller-supplied task.
 *
 * Experimental: the app-server protocol is upstream-experimental.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexAppServer } from './app-server.js';
import { applyRevertHandoff, type RpcTransport } from './native-handoff.js';

const args = process.argv.slice(2);
const threadIndex = args.indexOf('--thread');
const resumeThreadId = threadIndex >= 0 ? args[threadIndex + 1] : undefined;
const cwd = process.env.AI4AI_CODEX_CWD ?? process.cwd();
const executorDir = process.env.AI4AI_EXECUTOR_DIR;
const timeoutMs = Number(process.env.AI4AI_CODEX_TIMEOUT_MS ?? 30 * 60 * 1000);
const handoffTimeoutMs = Number(process.env.AI4AI_CODEX_HANDOFF_TIMEOUT_MS ?? 5 * 60 * 1000);

const task = await new Promise<string>((resolve, reject) => {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { text += chunk; });
  process.stdin.on('end', () => resolve(text));
  process.stdin.on('error', reject);
});

const server = CodexAppServer.start({
  command: process.env.AI4AI_CODEX_BIN || 'codex',
  cwd,
});
let threadId: string | undefined;
let threadModel: string | undefined;
let exitCode = 0;
let answer = '';
let failure: string | undefined;
let handoff: Record<string, unknown> | undefined;

const writeUsage = async (value: unknown): Promise<void> => {
  if (!executorDir) return;
  try { await writeFile(path.join(executorDir, 'usage.json'), JSON.stringify(value, null, 2) + '\n'); }
  catch { /* usage evidence is best-effort */ }
};
const writeOutput = async (): Promise<void> => {
  if (!executorDir) return;
  try {
    await writeFile(path.join(executorDir, 'output.json'), JSON.stringify({
      threadId, text: answer, ...(failure ? { error: failure } : {}), ...(handoff ? { handoff } : {}),
    }, null, 2) + '\n');
  } catch { /* output evidence is best-effort */ }
};

/** Notifications plus a resettable waiter so each turn/compaction step is distinct. */
let events: any[] = [];
const waiters: { predicate: (message: any) => boolean; resolve: (message: any) => void }[] = [];
const waitFor = (predicate: (message: any) => boolean, timeoutMsValue: number): Promise<any | undefined> => {
  const hit = events.find(predicate);
  if (hit) return Promise.resolve(hit);
  return new Promise(resolve => {
    const entry = {
      predicate,
      resolve: (message: any) => { clearTimeout(timer); remove(); resolve(message); },
    };
    const remove = (): void => { const index = waiters.indexOf(entry); if (index >= 0) waiters.splice(index, 1); };
    const timer = setTimeout(() => { remove(); resolve(undefined); }, timeoutMsValue);
    timer.unref?.();
    waiters.push(entry);
  });
};
const matchesTurn = (message: any, turnId: string | undefined): boolean =>
  message.method === 'turn/completed' && message.params?.threadId === threadId
  && (turnId === undefined || message.params?.turn?.id === turnId);

/**
 * Tee key app-server notifications to stdout so the supervisor records them in
 * `log.ndjson` (the supervisor remains the log's single writer). Deltas are
 * omitted: the final item/turn events are enough to normalize the stream and
 * a chatty stream must not turn into a log flood. Unsigned raw diagnostics stay
 * bounded.
 */
const tee = (method: string, params: any): void => {
  if (method.includes('delta')) return;
  const bounded = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || !value) return undefined;
    return value.length <= 2000 ? value : value.slice(0, 2000) + '…';
  };
  let payload: Record<string, unknown> = {};
  if (method.startsWith('item/')) {
    const item = params?.item ?? {};
    payload = { item: { id: item.id, type: item.type, name: item.name, text: bounded(item.text) } };
  } else if (method === 'turn/completed' || method === 'turn/failed') {
    payload = { turn: { id: params?.turn?.id, status: params?.turn?.status, error: { message: bounded(params?.turn?.error?.message) } } };
  } else if (method === 'error') {
    payload = { error: { message: bounded(params?.error?.message) } };
  } else if (method === 'thread/tokenUsage/updated') {
    payload = { usage: { modelContextWindow: params?.modelContextWindow } };
  }
  try { process.stdout.write(JSON.stringify({ ai4ai: 'codex-event', method, params: payload }) + '\n'); }
  catch { /* logging must never break the turn */ }
};

server.onNotification((method, params) => {
  const message = { method, params };
  events.push(message);
  tee(method, params);
  if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') answer += params.delta;
  if (method === 'thread/tokenUsage/updated') void writeUsage(params);
  for (const waiter of [...waiters]) if (waiter.predicate(message)) waiter.resolve(message);
});

const settle = async (turnId: string | undefined, waitMs: number): Promise<{ ok: boolean; detail?: string }> => {
  const message = await waitFor(candidate =>
    matchesTurn(candidate, turnId) || candidate.method === 'turn/failed' || candidate.method === 'error',
  waitMs);
  if (!message) return { ok: false, detail: 'codex turn did not settle within the timeout' };
  if (message.method === 'error') {
    return { ok: false, detail: (message.params?.error as { message?: string } | undefined)?.message ?? 'codex app-server error' };
  }
  if (message.method === 'turn/failed') return { ok: false, detail: 'codex turn failed' };
  const status = message.params?.turn?.status;
  if (status === 'failed') return { ok: false, detail: (message.params?.turn?.error as { message?: string } | undefined)?.message ?? 'codex turn failed' };
  return { ok: true };
};

const handoffFile = executorDir ? path.join(executorDir, 'handoff.json') : undefined;
const readHandoff = async (): Promise<any | undefined> => {
  if (!handoffFile) return undefined;
  try { return JSON.parse(await readFile(handoffFile, 'utf8')); } catch { return undefined; }
};
const writeHandoff = async (record: any): Promise<void> => {
  if (!handoffFile) return;
  const temporary = `${handoffFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2) + '\n');
  await rename(temporary, handoffFile);
};

/**
 * Apply a pending self-handoff intent at the turn boundary: compact this
 * executor's own thread, then start the successor turn with the task.
 */
const applyHandoff = async (): Promise<boolean> => {
  const intent = await readHandoff();
  if (!intent || intent.phase !== 'intent' || !threadId) return false;
  const operationId = String(intent.operationId ?? 'unknown');
  const mode = intent.mode === 'compact' ? 'compact' : 'restart';
  const record: Record<string, unknown> = { ...intent, phase: 'applying', applyingAt: new Date().toISOString() };
  await writeHandoff(record);
  try {
    events = [];
    const delivery = `AI4AI handoff delivery ${operationId}. Adopt the caller-supplied task in this fresh context:\n${String(intent.request?.task ?? '')}\nNative system/security instructions remain authoritative.`;
    let successorThreadId = threadId;
    let successorTurnId: string | undefined;
    if (mode === 'restart') {
      // Same-thread restart: revert the thread to its start (durable and live
      // context), then run the material as the next turn in that thread. The
      // thread id is unchanged and no summarizer runs.
      const transport: RpcTransport = {
        call: (method, params, timeoutMs) => server.request(method, params, timeoutMs),
        onMessage: listener => {
          server.onNotification((method, params) => listener({ method, params }));
          return () => undefined;
        },
      };
      const archiveDir = path.join(
        executorDir ?? path.join(cwd, '.ai4ai'),
        'handoff-archive', threadId, new Date().toISOString().replace(/[:.]/g, '-'),
      );
      answer = '';
      const outcome = await applyRevertHandoff(transport, {
        threadId, deliveryText: delivery, archiveDir,
        idleTimeoutMs: handoffTimeoutMs, turnTimeoutMs: handoffTimeoutMs,
      });
      successorThreadId = threadId;
      successorTurnId = outcome.successorTurnId;
      const phase = outcome.ok ? (outcome.completed ? 'completed' : 'applied') : 'failed';
      const finalRecord = {
        ...record,
        phase,
        mechanism: 'restart',
        proofMechanism: 'surface-replacement',
        successorThreadId,
        successorSessionId: successorThreadId,
        successorTurnId,
        archive: outcome.archive ?? null,
        reason: outcome.reason,
        ...(outcome.code ? { errorCode: outcome.code } : {}),
        ...(outcome.ok ? {} : { error: outcome.reason }),
        appliedAt: new Date().toISOString(),
      };
      await writeHandoff(finalRecord);
      handoff = {
        operationId, phase, mechanism: 'restart', proofMechanism: 'surface-replacement',
        successorThreadId, successorTurnId,
        archive: outcome.archive ?? null,
        ...(outcome.ok ? {} : { error: outcome.reason }),
      };
      if (!outcome.ok) {
        failure = `codex headless restart handoff failed: ${outcome.reason}`;
        exitCode = 1;
        return false;
      }
      // The successor identity is the same thread; report it so a supervisor
      // can reconcile without inventing a new session.
      process.stdout.write(JSON.stringify({ session_id: threadId }) + '\n');
      return true;
    }

    // `thread/compact/start` starts a compaction turn. The thread is only
    // steerable again after that turn completes; accepting the earlier
    // `item/completed (contextCompaction)` races with the active turn.
    await server.request('thread/compact/start', { threadId }, handoffTimeoutMs);
    const compacted = await waitFor(candidate => matchesTurn(candidate, undefined), handoffTimeoutMs);
    if (!compacted) throw new Error('compaction did not reach a final state within the timeout');

    events = [];
    answer = '';
    const started = await server.request('turn/start', { threadId, input: [{ type: 'text', text: delivery }] }, handoffTimeoutMs) as { turn?: { id?: string } };
    successorTurnId = started?.turn?.id;
    const settled = await settle(successorTurnId, handoffTimeoutMs);
    const finalRecord = {
      ...record,
      phase: settled.ok ? 'completed' : 'failed',
      compacted: true,
      mechanism: 'compact',
      proofMechanism: 'native-compaction',
      successorThreadId: threadId,
      successorTurnId,
      ...(settled.ok ? {} : { error: settled.detail }),
      appliedAt: new Date().toISOString(),
    };
    await writeHandoff(finalRecord);
    handoff = {
      operationId, phase: finalRecord.phase, compacted: true, mechanism: 'compact', proofMechanism: 'native-compaction', successorThreadId: threadId, successorTurnId,
      ...(settled.ok ? {} : { error: settled.detail }),
    };
    if (!settled.ok) {
      failure = `codex headless handoff failed: ${settled.detail}`;
      exitCode = 1;
      return false;
    }
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await writeHandoff({ ...record, phase: 'failed', error: detail, appliedAt: new Date().toISOString() });
    handoff = { operationId, phase: 'failed', error: detail };
    failure = `codex headless handoff failed: ${detail}`;
    exitCode = 1;
    return false;
  }
};

const deadline = setTimeout(() => { exitCode = 2; failure = failure ?? 'codex runner timed out'; }, timeoutMs);
deadline.unref?.();

try {
  await server.initialize();
  if (resumeThreadId) {
    const resumed = await server.request('thread/resume', { threadId: resumeThreadId, cwd }) as { thread?: { id?: string; model?: string } };
    threadId = resumed.thread?.id ?? resumeThreadId;
    threadModel = resumed.thread?.model;
  } else {
    const started = await server.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'workspace-write' }) as { thread?: { id?: string; model?: string } };
    threadId = started.thread?.id;
    threadModel = started.thread?.model;
  }
  if (!threadId) throw new Error('codex app-server returned no thread id');
  process.stdout.write(JSON.stringify({ session_id: threadId }) + '\n');
  // Native status evidence: thread/start already names the model; token usage
  // notifications carry the model context window.
  if (executorDir && threadModel) {
    try { await writeFile(path.join(executorDir, 'model.json'), JSON.stringify({ model: threadModel }) + '\n'); } catch { /* best-effort */ }
  }
  if (executorDir && !threadModel) {
    try {
      const listing = await server.request('thread/list', { limit: 50 }) as { data?: { id?: string; model?: string }[] };
      const row = (listing?.data ?? []).find(entry => entry.id === threadId);
      if (row?.model) await writeFile(path.join(executorDir, 'model.json'), JSON.stringify({ model: row.model }) + '\n');
    } catch { /* model metadata is best-effort */ }
  }
  events = [];
  const started = await server.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: task }],
  }) as { turn?: { id?: string } };
  const settled = await settle(started?.turn?.id, timeoutMs);
  if (!settled.ok) {
    failure = settled.detail ?? 'codex turn failed';
    exitCode = 1;
  } else {
    await applyHandoff();
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codex runner failed: ${failure}\n`);
  exitCode = 1;
} finally {
  if (failure) process.stderr.write(`codex turn error: ${failure}\n`);
  await writeOutput();
  server.close();
}
process.exit(exitCode);
