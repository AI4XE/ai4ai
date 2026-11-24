/**
 * PARITY-038: caller-invoked adoption verification.
 *
 * Combines the durable executor handoff status, the turn ledger and (only when
 * explicitly requested) the bounded/redacted transcript reader from
 * `transcript.ts`. It never mutates state and never guesses adoption from an
 * unrelated session.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { executorDir } from '../adapters/executors.js';
import { readTurns } from './turns.js';
import { findMarker } from './transcript.js';
import type { Ai4aiStore } from './store.js';

const run = promisify(execFile);

export interface AdoptionReport {
  executorId: string;
  operationId: string;
  adopted: boolean;
  phase: string | null;
  mechanism?: string;
  session?: string | null;
  generation?: string | null;
  evidence: string[];
  transcript?: { store: string; entriesRead: number; markerFound: boolean; redacted: boolean; reason?: string };
  reason?: string;
}

async function readJson(file: string): Promise<any | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; }
}

export async function verifyAdoption(options: {
  home: string;
  workspace: string;
  store: Ai4aiStore;
  executorId: string;
  operationId: string;
  transcript?: boolean;
  limit?: number;
}): Promise<AdoptionReport> {
  const record = (await options.store.executors()).find(candidate => candidate.executorId === options.executorId);
  const directory = executorDir(options.home, options.executorId);
  const status = await readJson(path.join(directory, 'handoff-status.json'));
  const handoff = await readJson(path.join(directory, 'handoff.json'));
  const turns = await readTurns(options.home, options.executorId, 500);
  const evidence: string[] = [];
  let phase: string | null = null;
  let mechanism: string | undefined;
  let session: string | null = null;
  let generation: string | null = null;
  let marker: string | undefined;
  if (status && status.operationId === options.operationId) {
    phase = String(status.phase ?? '');
    mechanism = typeof status.mechanism === 'string' ? status.mechanism : undefined;
    session = typeof status.session === 'string' ? status.session : null;
    generation = typeof status.generation === 'string' ? status.generation : null;
    marker = typeof status.marker === 'string' ? status.marker : undefined;
    evidence.push(`handoff-status:${phase}`);
    if (status.source && status.successor) evidence.push(`proof:${status.source.session}->${status.successor.session}`);
  } else if (handoff && handoff.operationId === options.operationId) {
    phase = String(handoff.phase ?? '');
    mechanism = typeof handoff.proofMechanism === 'string' ? handoff.proofMechanism : undefined;
    session = typeof handoff.successorThreadId === 'string' ? handoff.successorThreadId : null;
    generation = typeof handoff.successorTurnId === 'string' ? handoff.successorTurnId : null;
    evidence.push(`handoff.json:${phase}`);
  }
  const completed = phase === 'completed' || phase === 'applied';
  if (completed) evidence.push('operation-terminal');
  const successorTurn = turns.findLast(turn => turn.operationId === options.operationId || (session !== null && turn.sessionIdAfter === session && turn.outcome === 'completed'));
  if (successorTurn) evidence.push(`turn:${successorTurn.turnId}:${successorTurn.outcome ?? 'unknown'}`);
  const adopted = completed && (successorTurn !== undefined || phase === 'completed' || status?.idleAfter === true || status?.continued === true);
  const report: AdoptionReport = {
    executorId: options.executorId,
    operationId: options.operationId,
    adopted,
    phase,
    ...(mechanism ? { mechanism } : {}),
    session,
    generation,
    evidence,
    ...(!record ? { reason: 'The executor is not owned by this installation' } : {}),
    ...(phase === null ? { reason: 'No durable handoff record for this operation id' } : {}),
  };
  if (options.transcript) {
    const pointer = await import('./session-probe.js').then(module => module.sessionPointer(
      (record?.harness ?? 'claude-code') as 'claude-code' | 'codex' | 'opencode' | 'dsh',
      options.workspace,
      session ?? record?.sessionId ?? undefined,
    )).catch(() => null);
    const found = marker
      ? await findMarker((record?.harness ?? 'claude-code') as 'claude-code' | 'codex' | 'opencode' | 'dsh', options.workspace, session ?? record?.sessionId ?? undefined, marker, { limit: options.limit ?? 200 }).catch(() => null)
      : null;
    report.transcript = {
      store: pointer?.store ?? 'unknown',
      entriesRead: found?.tail?.entries.length ?? 0,
      markerFound: found?.found ?? false,
      redacted: true,
      ...(found?.tail?.reason ? { reason: found.tail.reason } : pointer?.path === null ? { reason: 'Session store path unresolved' } : {}),
    };
    if (found?.found) evidence.push('transcript:marker');
    else if (marker) evidence.push('transcript:no-marker');
  }
  return report;
}

/** Small git summary used by the activity view (read-only). */
export async function gitActivity(workspace: string, limit = 5): Promise<{ commits: string[]; dirtyFiles: number; error?: string }> {
  try {
    const [log, status] = await Promise.all([
      run('git', ['-C', workspace, 'log', `-${Math.max(1, Math.min(limit, 20))}`, '--oneline']),
      run('git', ['-C', workspace, 'status', '--porcelain=v1']),
    ]);
    return { commits: log.stdout.split('\n').filter(Boolean), dirtyFiles: status.stdout.split('\n').filter(Boolean).length };
  } catch (error) {
    return { commits: [], dirtyFiles: 0, error: error instanceof Error ? error.message : 'git unavailable' };
  }
}
