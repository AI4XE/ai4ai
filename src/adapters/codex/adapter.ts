import { existsSync, readFileSync } from 'node:fs';
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { AdapterContext, CarrierCommand, StatusDetails, NativeOutcome } from '../external.js';
import { ExternalExecutorAdapter, contextFromUsage } from '../external.js';
import type { CapabilityDeclaration } from '../../contract/types.js';
import type { Request } from '../../contract/types.js';
import { handoffMode, handoffOutcome } from '../../contract/states.js';
import type { HarnessId, Os } from '../../contract/states.js';
import type { ExecutorRecord } from '../../core/store.js';
import { executorDir, type LogLine, type ExecutorStatus } from '../executors.js';
import { declaration } from '../declarations.js';
import { paneForProcess, paneForWorkspace, tmuxAvailable } from '../../tmux/backend.js';
import { CodexDaemon, daemonSocket, listThreads, type CodexThread } from './control.js';
import { codexSessionUsage } from '../../core/session-probe.js';
import { envValue, probeCodexConfig } from '../../core/config-probe.js';
import { firstVerified, verifiedText, verifiedTokens, verifiedWindow } from '../../core/ladder.js';

/**
 * Codex adapter.
 *
 * Carriers are per-executor `codex app-server` processes driven by
 * `runner.js`; the protocol is upstream-experimental. Same-window handoff uses
 * the local app-server daemon that the interactive TUI already runs: compact the
 * live thread, then start the successor turn in the same thread. tmux remains an
 * experimental fallback for sessions without a reachable daemon.
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
    const reason = linux
      ? 'Linux headless spawn/status and restart handoff (new app-server thread + material) were verified with a real app-server process; TUI restart uses the pane\'s native /new command in tmux or the native new_context tool on a bare TUI; compact remains available. The app-server protocol is upstream-experimental.'
      : mac
        ? 'macOS headless spawn/status and restart handoff (new app-server thread + material) run in the same app-server process; TUI restart uses /new in tmux or the native new_context tool on a bare TUI, with compact available explicitly. The app-server protocol is upstream-experimental.'
        : 'Codex is supported via WSL on Windows; native Windows harness integration is out of scope and was not exercised.';
    const level = linux || mac ? 'supported' as const : 'not-tested' as const;
    const common = {
      handoff: { availability: level, modes: ['restart', 'compact'] as ('compact' | 'restart')[], tmuxFallback: 'experimental' as const },
      spawn: { availability: level, maxConcurrent: 4 },
      status: { availability: level, model: 'not-tested' as const, reasoningEffort: 'unsupported' as const, context: level, percentSource: 'derived' as const },
      ...(linux || mac ? { evidence: `matrix:codex/${os}/2026-11-18` } : {}),
    };
    return [
      declaration({ harness: 'codex', os, interface: 'headless', reason, experimental: ['app-server', 'tmux-fallback'], ...common }),
      declaration({ harness: 'codex', os, interface: 'tui', reason, experimental: ['app-server', 'tmux-fallback'], ...common }),
    ];
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
   * The daemon owns the TUI's live thread. Compacting it and starting the
   * successor turn through the daemon changes what the user sees in the same
   * window: a compaction marker followed by the handoff task as the next turn.
   * When no daemon or live thread is reachable, the experimental tmux fallback
   * is attempted once.
   */
  async handoff(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    if (request.target !== 'self') {
      return { status: 'unsupported', reason: 'Codex handoff targets the caller self only; detached executors cannot replace their context in place', unavailable: ['handoff.executor'] };
    }
    if (request.surface !== undefined && request.surface !== 'preserve') {
      return { status: 'unsupported', reason: 'Codex handoff preserves the TUI surface; cross-surface handoff is not implemented', unavailable: ['handoff.crossSurface'] };
    }
    const mode = handoffMode(request.mode);
    // A detached Codex executor is itself an app-server thread. It owns its
    // thread id and its app-server connection (held by the runner), so the
    // restart or compact successor is applied by that runner at the turn boundary.
    if (ctx.identity.surface === 'headless' || ctx.executorId !== undefined) {
      return headlessSelfHandoff(request, ctx, mode);
    }
    if (mode === 'restart') return this.tuiRestart(request, ctx);
    const socket = await daemonSocket(process.env.AI4AI_CODEX_BIN || 'codex');
    if (socket) {
      let daemon: CodexDaemon | undefined;
      try { daemon = await CodexDaemon.connect(socket); } catch { daemon = undefined; }
      if (daemon) {
        let mutated = false;
        try {
          return await nativeHandoff(daemon, request, ctx, () => { mutated = true; });
        } catch (error) {
          if (error instanceof NoLiveThread) {
            // Nothing native was changed; there is no safe fallback for compact.
          } else {
            return {
              status: mutated ? 'unknown' : 'failed',
              reason: `Codex native handoff ${mutated ? 'started but could not be confirmed' : 'failed'}: ${error instanceof Error ? error.message : 'unknown error'}`,
              durable: mutated,
              state: mutated ? 'unknown' : 'failed',
              unavailable: ['handoff.native'],
              error: { code: 'codex-native-handoff', message: error instanceof Error ? error.message : 'unknown error' },
            };
          }
        } finally { daemon.close(); }
      }
    }
    return {
      status: 'unsupported',
      reason: 'No live Codex app-server daemon or TUI thread was found for a compact handoff; restart is the default and uses the native /new path',
      unavailable: ['handoff.native'],
    };
  }

  /**
   * Native TUI restart. The visible terminal is the only surface the user
   * sees, so ai4ai drives that terminal's own `/new` command (a documented
   * harness action) and then delivers the material as the next turn. The
   * source turn is still running when this call is made, so a detached watcher
   * applies the reset at the turn boundary. The process, pane and host channel
   * are never replaced.
   */
  private async tuiRestart(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    if (!request.task) {
      return { status: 'unsupported', reason: 'A restart handoff needs task material; the new context contains only that material', unavailable: ['handoff.task'] };
    }
    const attributed = !(await tmuxAvailable()) ? undefined
      : (process.env.AI4AI_TMUX_PANE || process.env.TMUX_PANE)
        ? { paneId: process.env.AI4AI_TMUX_PANE || process.env.TMUX_PANE }
        : await paneForProcess(process.pid).then(pane => pane ? { paneId: pane.paneId } : undefined)
          ?? await paneForWorkspace('codex', ctx.identity.workspace).then(pane => pane ? { paneId: pane.paneId } : undefined);
    if (!attributed?.paneId) return this.daemonRestart(request, ctx);
    const marker = `ai4ai-context-${randomUUID()}`;
    const directory = path.join(ctx.home, '.ai4ai', 'codex', 'tui-restart');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const payloadFile = path.join(directory, `${request.operationId.replace(/[^A-Za-z0-9._-]/g, '_')}.payload.json`);
    const payload = {
      home: ctx.home, identity: ctx.identity, request, operationId: request.operationId, marker,
      paneId: attributed.paneId, startedAt: new Date().toISOString(),
      timeoutMs: Math.min(Math.max(request.timeoutMs ?? 10 * 60 * 1000, 1000), 30 * 60 * 1000),
    };
    await writeFile(payloadFile, JSON.stringify(payload, null, 2) + '\n');
    const watcher = fileURLToPath(new URL('./tui-restart-watch.js', import.meta.url));
    const child = spawn(process.execPath, [watcher, payloadFile], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    return {
      status: 'pending',
      reason: 'The native TUI /new restart and material delivery are scheduled at the turn boundary; the successor thread is recorded in the journal',
      durable: true, state: 'running', handoff: { phase: 'pending' },
      notices: [{
        code: 'codex-tui-restart', impact: 'none', action_required: false,
        message: 'Finish the current turn; the watcher sends /new and the material in the same pane.',
      }],
      verification: { model: 'unknown', context: 'reported' },
    };
  }

  /**
   * tmux-independent TUI restart. A bare terminal TUI still speaks to its
   * local app-server daemon. ai4ai asks the model to call the core
   * `new_context` tool (an in-thread reset without a summary) and a detached
   * watcher starts the material turn once the reset is observed. Same thread,
   * same process, no tmux and no process replacement.
   */
  private async daemonRestart(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    const socket = await daemonSocket(process.env.AI4AI_CODEX_BIN || 'codex');
    if (!socket) {
      return {
        status: 'unknown',
        reason: 'The Codex TUI exposes no reachable app-server daemon (embedded server) and no tmux pane; ai4ai has no native input channel to reset it in place',
        unavailable: ['handoff.restart'],
        error: { code: 'codex-no-daemon', message: 'No reachable app-server daemon' },
      };
    }
    const threads = await listThreads().catch(() => [] as CodexThread[]);
    const workspace = path.resolve(ctx.identity.workspace);
    const candidates = threads
      .filter(thread => typeof thread.cwd === 'string' && path.resolve(thread.cwd) === workspace && typeof thread.id === 'string')
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const threadId = candidates[0]?.id;
    if (!threadId) {
      return {
        status: 'unknown',
        reason: 'No live app-server thread matches this Codex TUI workspace; restart needs the thread the TUI is showing',
        unavailable: ['handoff.thread'],
        error: { code: 'codex-tui-no-thread', message: 'No matching live thread' },
      };
    }
    const marker = `ai4ai-context-${randomUUID()}`;
    const directory = path.join(ctx.home, '.ai4ai', 'codex', 'tui-restart');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const payloadFile = path.join(directory, `${request.operationId.replace(/[^A-Za-z0-9._-]/g, '_')}.daemon.json`);
    const payload = {
      home: ctx.home, identity: ctx.identity, request, operationId: request.operationId, marker, threadId, socket,
      startedAt: new Date().toISOString(),
      timeoutMs: Math.min(Math.max(request.timeoutMs ?? 10 * 60 * 1000, 1000), 30 * 60 * 1000),
    };
    await writeFile(payloadFile, JSON.stringify(payload, null, 2) + '\n');
    const watcher = fileURLToPath(new URL('./tui-daemon-watch.js', import.meta.url));
    const child = spawn(process.execPath, [watcher, payloadFile], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    return {
      status: 'pending',
      reason: 'The native new_context reset is requested; the successor material runs in the same thread after the source turn',
      durable: true, state: 'running', handoff: { phase: 'pending' },
      notices: [{
        code: 'codex-new-context', impact: 'none', action_required: false,
        message: 'Call the new_context tool now, then end this turn; the material is delivered in the fresh context.',
      }],
      verification: { model: 'unknown', context: 'reported' },
    };
  }

  protected async statusDetails(record: ExecutorRecord, status: ExecutorStatus, _log: LogLine[], ctx: AdapterContext): Promise<StatusDetails> {
    return codexUsage(executorDir(ctx.home, record.executorId), {
      workspace: ctx.identity.workspace,
      ...(status.sessionId ? { sessionId: status.sessionId } : {}),
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
 * connection; a separate CLI process cannot drive that stdio channel.
 * The executor therefore records a durable intent and finishes its turn, and
 * the runner applies it at the turn boundary: compact the executor's own
 * thread, then start the successor turn in the same thread with the task.
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
    const phase = String(existing.phase ?? 'intent');
    const lifecycle = handoffOutcome(phase, { appliedIsTerminal: true });
    if (phase === 'completed' || phase === 'applied') {
      return {
        status: 'completed', reason: 'The detached runner already applied this handoff', durable: true,
        state: lifecycle.state, ...(lifecycle.handoff ? { handoff: lifecycle.handoff } : {}), sessionId: threadId,
      };
    }
    return {
      status: 'pending', reason: `The detached runner is applying this handoff (${phase})`, durable: true,
      state: lifecycle.state, ...(lifecycle.handoff ? { handoff: lifecycle.handoff } : {}), sessionId: threadId,
    };
  }
  if (existing && !['completed', 'applied', 'failed', 'cancelled'].includes(String(existing.phase))) {
    return {
      status: 'failed', reason: 'Another handoff is still pending on this executor; only one context replacement can be applied per turn boundary',
      error: { code: 'handoff-busy', message: `Pending operation ${String(existing.operationId)}` },
    };
  }
  const record = {
    format: 2, kind: 'handoff', operationId: request.operationId, request, source: ctx.identity,
    executorId: ctx.executorId ?? process.env.AI4AI_EXECUTOR_ID, threadId, mode, mechanism: mode,
    phase: 'intent', createdAt: new Date().toISOString(),
  };
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2) + '\n');
  await rename(temporary, file);
  return {
    status: 'pending',
    reason: mode === 'restart'
      ? 'The detached runner owns this app-server process; it starts a new thread and delivers the material when the current turn completes'
      : 'The detached runner owns this app-server thread; it compacts the thread and starts the successor turn when the current turn completes',
    durable: true, state: 'running', handoff: { phase: 'pending' }, sessionId: threadId,
    notices: [{
      code: 'codex-headless-handoff', impact: 'none', action_required: false,
      message: 'Finish the current turn; the runner applies the handoff at the turn boundary.',
    }],
    verification: { model: 'unknown', context: 'reported' },
  };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Compact the live TUI thread and run the handoff task as its next turn.
 * `markMutated` is called before the first native mutation so the caller can
 * report an unknown state instead of retrying through another channel.
 */
async function nativeHandoff(
  daemon: CodexDaemon,
  request: Request,
  ctx: AdapterContext,
  markMutated: () => void,
): Promise<NativeOutcome> {
  await daemon.call('initialize', { clientInfo: { name: 'ai4ai', version: '0.0.4' } });
  let threadId = process.env.AI4AI_CODEX_THREAD;
  let model: string | null = null;
  if (!threadId) {
    const listing = await daemon.call('thread/list', { limit: 50 });
    const rows = (listing?.data ?? []) as (CodexThread & { model?: string })[];
    const workspace = path.resolve(ctx.identity.workspace);
    const candidates = rows
      .filter(thread => typeof thread.cwd === 'string' && path.resolve(thread.cwd) === workspace)
      .filter(thread => thread.status?.type !== 'notLoaded')
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    threadId = candidates[0]?.id;
    model = candidates[0]?.model ?? null;
    if (!threadId) {
      throw new NoLiveThread('No live Codex TUI thread is attached to the local app-server daemon for this workspace');
    }
  }
  const thread = threadId!;
  await daemon.call('thread/resume', { threadId: thread, excludeTurns: true });
  if (!model) {
    const listing = await daemon.call('thread/list', { limit: 50 });
    const row = (listing?.data ?? []).find((entry: CodexThread) => entry.id === thread) as { model?: string } | undefined;
    model = row?.model ?? null;
  }

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
        const listing = await daemon.call('thread/list', { limit: 50 });
        const row = (listing?.data ?? []).find((entry: CodexThread) => entry.id === thread);
        if (row && row.status?.type === 'idle') return true;
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
    const text = `AI4AI handoff delivery ${request.operationId}. Adopt the caller-supplied task in this fresh context:\n${request.task ?? ''}\nNative system/security instructions remain authoritative.`;
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
    const successor = { ...ctx.identity, generation: turnId ?? 'codex-compacted' };
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
      proof: { source: ctx.identity, successor, mechanism: 'surface-replacement', nativeEvidence: `codex-app-server:thread/${thread}/compact+turn/${turnId ?? 'unknown'}` },
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
    { value: config?.model?.value ?? null, source: config?.model?.source ?? 'unknown' },
  ]);
  const reasoningEffortField = firstVerified<string>([
    { value: session?.reasoningEffort ?? null, source: 'session' },
    { value: config?.reasoningEffort?.value ?? null, source: config?.reasoningEffort?.source ?? 'unknown' },
  ]);
  const usedField = firstVerified<number>([
    { value: nativeUsed, source: 'native' },
    { value: session?.used ?? null, source: 'session' },
  ]);
  const windowField = firstVerified<number>([
    { value: nativeWindow, source: 'native' },
    { value: session?.window ?? null, source: 'session' },
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
  const autoCompact = config?.autoCompact
    ? { tokens: config.autoCompact.value, ratio: window ? Math.round((config.autoCompact.value / window) * 1000) / 1000 : null, source: config.autoCompact.source }
    : undefined;

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
    ...(reasoningEffortField ? {} : { fieldStates: { reasoningEffort: 'unavailable' as const } }),
    context,
    ...(autoCompact ? { autoCompact } : {}),
    ...(modelField ? { modelVerification: modelField.source === 'native' || modelField.source === 'session' ? 'reported' as const : 'configured-only' as const } : {}),
    unavailable,
  };
}
