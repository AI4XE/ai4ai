import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Native same-thread Codex handoff.
 *
 * `restart` is a `thread/revert` to the thread's first turn followed by a
 * `turn/start` with the caller material. The app-server closes and reloads the
 * same thread, so the native thread id never changes and no summarizer runs.
 * Old rollouts stay on disk (the store switches its pointer), so archiving is
 * best-effort: it is for the user's records, not a data-loss guard.
 *
 * Both transports (the per-executor stdio app-server and the TUI's shared
 * WebSocket daemon) expose the same JSON-RPC methods; this module only needs
 * `call` and `onMessage`.
 */

export interface RpcTransport {
  call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  onMessage(listener: (message: any) => void): () => void;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Read every page of a paginated list method. */
export async function listAllPages(
  transport: RpcTransport,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<any[]> {
  const rows: any[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < 200; page++) {
    const request = { ...params, ...(cursor ? { cursor } : {}) };
    const listing = await transport.call(method, request, timeoutMs);
    rows.push(...(Array.isArray(listing?.data) ? listing.data : []));
    cursor = listing?.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return rows;
}

export interface ArchiveOutcome {
  ok: boolean;
  path?: string;
  notice?: string;
}

/**
 * Export turns and items before the revert. Failure never blocks the handoff:
 * the upstream implementation keeps the old rollout files intact.
 */
export async function archiveThread(
  transport: RpcTransport,
  threadId: string,
  directory: string,
  timeoutMs = 30000,
): Promise<ArchiveOutcome> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const turns = await listAllPages(transport, 'thread/turns/list', { threadId, itemsView: 'full', limit: 100 }, timeoutMs);
    const items = await listAllPages(transport, 'thread/items/list', { threadId, limit: 100 }, timeoutMs);
    await writeFile(path.join(directory, 'turns.json'), JSON.stringify(turns, null, 2) + '\n');
    await writeFile(path.join(directory, 'items.json'), JSON.stringify(items, null, 2) + '\n');
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
      threadId, archivedAt: new Date().toISOString(), turnCount: turns.length, itemCount: items.length,
      note: 'Pre-handoff records. The upstream app-server keeps the original rollout file; this export is for convenience.',
    }, null, 2) + '\n');
    return { ok: true, path: directory };
  } catch (error) {
    return { ok: false, notice: `Archive export failed (${error instanceof Error ? error.message : String(error)}); the original rollout is still on disk` };
  }
}

/** The thread's first turn; reverting before it clears the whole history. */
export async function firstTurnId(transport: RpcTransport, threadId: string, timeoutMs = 30000): Promise<string | undefined> {
  const listing = await transport.call('thread/turns/list', { threadId, itemsView: 'summary', limit: 100, sortDirection: 'asc' }, timeoutMs);
  const first = Array.isArray(listing?.data) ? listing.data[0] : undefined;
  return typeof first?.id === 'string' ? first.id : undefined;
}

export async function threadIsIdle(transport: RpcTransport, threadId: string): Promise<boolean> {
  try {
    const read = await transport.call('thread/read', { threadId, includeTurns: false }, 15000);
    return read?.thread?.status?.type === 'idle';
  } catch {
    return false;
  }
}

/**
 * Wait for the thread to be idle. Reverting an active turn would interrupt it
 * and any message sent between the archive and the revert would miss the
 * export, so the safe point is mandatory.
 */
export async function waitThreadIdle(transport: RpcTransport, threadId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await threadIsIdle(transport, threadId)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

export interface RevertHandoffOptions {
  threadId: string;
  deliveryText: string;
  archiveDir: string;
  idleTimeoutMs?: number;
  turnTimeoutMs?: number;
}

export interface RevertHandoffOutcome {
  ok: boolean;
  /** True when the successor turn completed; `applied` when it only started. */
  completed?: boolean;
  archive?: ArchiveOutcome;
  firstTurnId?: string;
  successorTurnId?: string;
  reason: string;
  code?: string;
}

/**
 * Apply a restart handoff in the same thread: wait for the safe point, archive
 * best-effort, revert before the first turn, then start the material turn.
 */
export async function applyRevertHandoff(
  transport: RpcTransport,
  options: RevertHandoffOptions,
): Promise<RevertHandoffOutcome> {
  const { threadId, deliveryText } = options;
  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60 * 1000;
  const turnTimeoutMs = options.turnTimeoutMs ?? 5 * 60 * 1000;
  const events: any[] = [];
  const off = transport.onMessage(message => events.push(message));
  try {
    if (!(await waitThreadIdle(transport, threadId, idleTimeoutMs))) {
      return { ok: false, code: 'codex-thread-busy', reason: 'The Codex thread did not reach an idle safe point; the handoff was not applied and no turn was interrupted' };
    }
    if (!(await threadIsIdle(transport, threadId))) {
      return { ok: false, code: 'codex-thread-busy', reason: 'A new turn started at the safe point; the handoff was not applied' };
    }

    const archive = await archiveThread(transport, threadId, options.archiveDir);
    const first = await firstTurnId(transport, threadId);
    if (!first) {
      return { ok: false, code: 'codex-no-turns', reason: 'The thread has no persisted turn to revert before; nothing was changed', archive };
    }

    try {
      await transport.call('thread/revert', { threadId, beforeTurnId: first }, turnTimeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const legacy = /paginated/i.test(message);
      return {
        ok: false,
        code: legacy ? 'codex-legacy-thread' : 'codex-revert-failed',
        reason: legacy
          ? `thread/revert only supports paginated threads; this legacy thread must be migrated before a same-session handoff (${message})`
          : `thread/revert failed; the task was not delivered (${message})`,
        archive,
      };
    }

    const remaining = await listAllPages(transport, 'thread/turns/list', { threadId, itemsView: 'summary', limit: 100 }, turnTimeoutMs);
    if (remaining.length !== 0) {
      return { ok: false, code: 'codex-revert-incomplete', reason: `thread/revert left ${remaining.length} turn(s); the material was not delivered`, archive };
    }

    events.length = 0;
    const started = await transport.call('turn/start', { threadId, input: [{ type: 'text', text: deliveryText }] }, turnTimeoutMs);
    const successorTurnId = typeof started?.turn?.id === 'string' ? started.turn.id : undefined;
    const deadline = Date.now() + turnTimeoutMs;
    while (Date.now() < deadline) {
      const done = events.find(message =>
        message?.method === 'turn/completed' && message?.params?.threadId === threadId
        && (successorTurnId === undefined || message?.params?.turn?.id === successorTurnId));
      if (done) {
        const status = done.params?.turn?.status;
        if (status === 'failed') {
          return { ok: false, code: 'codex-successor-failed', reason: 'The successor turn failed after the revert', archive, firstTurnId: first, ...(successorTurnId ? { successorTurnId } : {}) };
        }
        return { ok: true, completed: true, archive, firstTurnId: first, ...(successorTurnId ? { successorTurnId } : {}), reason: 'The thread was reverted to an empty history and the material turn completed in the same thread' };
      }
      const failed = events.find(message => message?.method === 'error' || message?.method === 'turn/failed');
      if (failed) {
        return { ok: false, code: 'codex-successor-failed', reason: `The successor turn failed after the revert: ${JSON.stringify(failed.params?.error ?? failed.params).slice(0, 300)}`, archive, firstTurnId: first, ...(successorTurnId ? { successorTurnId } : {}) };
      }
      await sleep(200);
    }
    return {
      ok: true, completed: false, archive, firstTurnId: first, ...(successorTurnId ? { successorTurnId } : {}),
      reason: 'The thread was reverted to an empty history and the material turn started; completion was not confirmed within the timeout',
    };
  } finally {
    off();
  }
}
