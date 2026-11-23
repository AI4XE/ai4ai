#!/usr/bin/env node
/**
 * Detached watcher for a Codex TUI restart handoff.
 *
 * The handoff tool call runs inside the source turn, so the adapter cannot
 * wait for that turn to end. This watcher owns the shared app-server daemon
 * connection instead: it waits for the thread's idle safe point, archives the
 * current turns best-effort, `thread/revert`s the same thread to its start
 * (same thread id, no summarizer) and starts the material as the next turn in
 * that thread. The TUI process, thread and host channel are never replaced.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { CodexDaemon } from './control.js';
import { applyRevertHandoff, type RpcTransport } from './native-handoff.js';
import { Ai4aiStore } from '../../core/store.js';
import { result } from '../../contract/validate.js';
import { sameSessionProof } from '../../core/handoff.js';
import type { Identity, Request, Result } from '../../contract/types.js';

interface Payload {
  home: string;
  identity: Identity;
  request: Request;
  operationId: string;
  marker: string;
  threadId: string;
  socket: string;
  archiveDir: string;
  startedAt: string;
  timeoutMs: number;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error('payload path missing');
  const payload = JSON.parse(await readFile(file, 'utf8')) as Payload;
  const { identity, request, operationId, marker, threadId } = payload;
  const journalDir = path.join(payload.home, '.ai4ai', 'codex', 'tui-handoff');
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
  const transport: RpcTransport = {
    call: (method, params, timeoutMs) => daemon.call(method, params, timeoutMs),
    onMessage: listener => daemon.onMessage(listener),
  };
  try {
    await daemon.call('initialize', { clientInfo: { name: 'ai4ai', version: '0.0.7' } }, 10000);
    const delivery = `AI4AI handoff delivery ${marker}. Adopt the caller-supplied task in this fresh context:\n${request.task ?? ''}\nNative system/security instructions remain authoritative.`;
    const outcome = await applyRevertHandoff(transport, {
      threadId,
      deliveryText: delivery,
      archiveDir: payload.archiveDir,
      idleTimeoutMs: Math.min(payload.timeoutMs, 10 * 60 * 1000),
      turnTimeoutMs: Math.min(payload.timeoutMs, 10 * 60 * 1000),
    });

    const source: Identity = { ...identity, session: threadId, generation: 'codex-thread' };
    if (!outcome.ok) {
      const status = outcome.code === 'codex-legacy-thread' ? 'unsupported' as const : 'failed' as const;
      await writeJournal({
        format: 2, operationId, marker, phase: status, mechanism: 'restart', threadId,
        proofMechanism: 'surface-replacement', archive: outcome.archive ?? null,
        reason: outcome.reason, error: outcome.code ?? null,
      });
      await complete(result({ operation: 'handoff', operationId }, status, outcome.reason, {
        durable: true, ...(status === 'failed' ? { state: 'failed' as const } : {}),
        unavailable: [outcome.code === 'codex-legacy-thread' ? 'handoff.thread' : 'handoff.restart'],
        error: { code: outcome.code ?? 'codex-handoff-failed', message: outcome.reason },
        ...(outcome.archive?.path ? { notices: [{ code: 'handoff-archive', impact: 'none' as const, action_required: false as const, message: `Pre-handoff records: ${outcome.archive.path}` }] } : {}),
      }));
      return;
    }

    const generation = outcome.successorTurnId ?? 'codex-revert';
    const proof = sameSessionProof(source, generation, 'surface-replacement', `codex-app-server:thread/${threadId}/revert+turn/${generation}`);
    const phase = outcome.completed ? 'completed' as const : 'applied' as const;
    await writeJournal({
      format: 2, operationId, marker, phase, mechanism: 'restart', threadId,
      proofMechanism: 'surface-replacement', successor: proof.successor, proof,
      successorTurnId: generation, archive: outcome.archive ?? null, reason: outcome.reason,
    });
    await complete(result({ operation: 'handoff', operationId }, phase, outcome.reason, {
      durable: true,
      state: outcome.completed ? 'completed' : 'running',
      handoff: { phase },
      sessionId: threadId,
      proof,
      ...(outcome.archive?.path
        ? { notices: [{ code: 'handoff-archive', impact: 'none' as const, action_required: false as const, message: `Pre-handoff records: ${outcome.archive.path}` }] }
        : outcome.archive?.notice
          ? { notices: [{ code: 'handoff-archive-skipped', impact: 'none' as const, action_required: false as const, message: outcome.archive.notice }] }
          : {}),
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
      const journalDir = path.join(payload.home, '.ai4ai', 'codex', 'tui-handoff');
      await mkdir(journalDir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(journalDir, `${payload.operationId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`), JSON.stringify({
        format: 2, operationId: payload.operationId, phase: 'failed', mechanism: 'restart',
        proofMechanism: 'surface-replacement', threadId: payload.threadId,
        reason: String(error?.message ?? error),
      }, null, 2) + '\n');
      const store = await Ai4aiStore.open(payload.home).catch(() => undefined);
      await store?.completePending(payload.identity, payload.operationId, result({ operation: 'handoff', operationId: payload.operationId }, 'failed', 'Codex daemon handoff failed: ' + String(error?.message ?? error), {
        durable: true, state: 'failed', unavailable: ['handoff.restart'],
        error: { code: 'codex-handoff-failed', message: String(error?.message ?? error) },
      }));
    }
  } catch { /* best effort */ }
  process.exit(1);
});
