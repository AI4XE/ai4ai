#!/usr/bin/env node
/**
 * Detached watcher for a Codex TUI restart when the TUI has no tmux pane.
 *
 * A bare terminal TUI still speaks to its local app-server daemon. ai4ai asks
 * the model to call the core `new_context` tool (an in-thread context reset
 * with no summary); this watcher observes that tool call, waits for the source
 * turn to end, and then starts the successor turn with only the caller
 * material. The TUI process, thread and host channel are never replaced and
 * no tmux is required.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { CodexDaemon, daemonSocket } from './control.js';
import { Ai4aiStore } from '../../core/store.js';
import { result } from '../../contract/validate.js';
import type { Identity, Request, Result } from '../../contract/types.js';

interface Payload {
  home: string;
  identity: Identity;
  request: Request;
  operationId: string;
  marker: string;
  threadId: string;
  socket: string;
  startedAt: string;
  timeoutMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error('payload path missing');
  const payload = JSON.parse(await readFile(file, 'utf8')) as Payload;
  const { identity, request, operationId, marker, threadId } = payload;
  const journalDir = path.join(payload.home, '.ai4ai', 'codex', 'tui-restart');
  const journal = path.join(journalDir, `${operationId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  const writeJournal = async (value: Record<string, unknown>): Promise<void> => {
    await mkdir(journalDir, { recursive: true, mode: 0o700 });
    const temporary = `${journal}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
    await rename(temporary, journal);
  };
  const complete = async (outcome: Result): Promise<void> => {
    try {
      const store = await Ai4aiStore.open(payload.home);
      await store.completePending(identity, operationId, outcome);
    } catch { /* the journal file remains the durable evidence */ }
  };

  const daemon = await CodexDaemon.connect(payload.socket);
  let newContextSeen = false;
  let turnDone = false;
  const deadline = Date.now() + payload.timeoutMs;

  daemon.onMessage(message => {
    try {
      const text = JSON.stringify(message);
      if (text.includes('new_context')) newContextSeen = true;
      if (message?.method === 'turn/completed' && message.params?.threadId === threadId) turnDone = true;
    } catch { /* tolerate unknown shapes */ }
  });

  try {
    await daemon.call('initialize', { clientInfo: { name: 'ai4ai', version: '0.0.3' } }, 10000);
    await daemon.call('thread/resume', { threadId }, 10000);

    // Wait for the model to call the native `new_context` tool and for the
    // source turn to finish. The successor turn must not start before the
    // reset is requested, or the material would land in the old context.
    while (Date.now() < deadline && !(newContextSeen && turnDone)) await sleep(500);

    if (!newContextSeen) {
      await writeJournal({ format: 1, operationId, marker, phase: 'failed', mechanism: 'restart', reason: 'The model did not call the native new_context tool; the material was not delivered', successor: null });
      await complete(result({ operation: 'handoff', operationId }, 'failed', 'Codex restart needs the native new_context tool call; it was not observed, so the material was not delivered', {
        durable: true, state: 'failed', unavailable: ['handoff.restart'],
        error: { code: 'new-context-missing', message: 'new_context tool call not observed' },
      }));
      return;
    }

    const text = `AI4AI handoff delivery ${marker}. Adopt the caller-supplied task in this fresh context:\n${request.task ?? ''}\nNative system/security instructions remain authoritative.`;
    const turn = await daemon.call('turn/start', { threadId, input: [{ type: 'text', text }] }, Math.min(payload.timeoutMs, 120000)) as { turn?: { id?: string } };
    const successorTurnId = turn?.turn?.id;
    const successor: Identity = { ...identity, session: threadId, generation: marker, agent: 'main' };
    await writeJournal({
      format: 1, operationId, marker, phase: 'completed', mechanism: 'restart',
      nativeEvidence: 'codex-new-context+app-server-turn', successor,
      successorTurnId,
      reason: 'Native new_context reset the context in the same thread; the material was started as the next turn',
    });
    await complete(result({ operation: 'handoff', operationId }, 'completed', 'Codex new_context reset the context in the same thread; the task material was delivered as the next turn', {
      durable: true, state: 'completed', handoff: { phase: 'completed' }, sessionId: threadId,
      proof: { source: identity, successor, mechanism: 'new-session', nativeEvidence: 'codex-new-context+app-server-turn' },
    }));
  } finally {
    daemon.close();
  }
}

main().catch(async error => {
  try {
    const file = process.argv[2];
    if (file) {
      const payload = JSON.parse(await readFile(file, 'utf8')) as Payload;
      const journalDir = path.join(payload.home, '.ai4ai', 'codex', 'tui-restart');
      await mkdir(journalDir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(journalDir, `${payload.operationId}.json`), JSON.stringify({
        format: 1, operationId: payload.operationId, phase: 'failed', mechanism: 'restart', reason: String(error?.message ?? error),
      }, null, 2) + '\n');
      const store = await Ai4aiStore.open(payload.home).catch(() => undefined);
      await store?.completePending(payload.identity, payload.operationId, result({ operation: 'handoff', operationId: payload.operationId }, 'failed', 'Codex daemon restart failed: ' + String(error?.message ?? error), {
        durable: true, state: 'failed', unavailable: ['handoff.restart'],
      }));
    }
  } catch { /* best effort */ }
  process.exit(1);
});
