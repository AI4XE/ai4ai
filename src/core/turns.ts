import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { TurnOutcome } from '../contract/states.js';

/**
 * Durable turn ledger.
 *
 * `status.json` stays a single-writer supervisor snapshot; the per-turn history
 * lives beside it in `turns.ndjson`, written only by the supervisor. Clients
 * read the ledger for receipts (`turnId`, outcome, timestamps) and never write
 * it.
 */
export interface TurnRecord {
  turnId: string;
  operationId?: string;
  startedAt: string;
  endedAt?: string;
  outcome?: TurnOutcome;
  sessionIdBefore?: string;
  sessionIdAfter?: string;
  exitCode?: number | null;
  signal?: string | null;
  reason?: string;
}

export const turnsFile = (home: string, executorId: string): string =>
  path.join(home, 'executors', executorId, 'turns.ndjson');

export async function readTurns(home: string, executorId: string, limit = 200): Promise<TurnRecord[]> {
  try {
    const text = await readFile(turnsFile(home, executorId), 'utf8');
    // The ledger is append-only: a turn's start row is followed by its end
    // row. Collapse each turn to its latest revision so one turn counts once.
    const byTurn = new Map<string, TurnRecord>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as TurnRecord;
        if (typeof value?.turnId !== 'string' || typeof value?.startedAt !== 'string') continue;
        byTurn.set(value.turnId, { ...(byTurn.get(value.turnId) ?? {}), ...value });
      } catch { /* ignore a torn trailing line */ }
    }
    const records = [...byTurn.values()];
    return records.slice(-Math.max(1, limit));
  } catch { return []; }
}

/** Pending inbox entries; claimed but unread entries do not count as queued. */
export async function queuedTurns(home: string, executorId: string): Promise<number> {
  try {
    const entries = await readdir(path.join(home, 'executors', executorId, 'inbox'), { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).length;
  } catch { return 0; }
}

/** 1-based position of a pending inbox file; 0 when it is not pending. */
export async function queuePositionOf(home: string, executorId: string, name: string): Promise<number> {
  try {
    const entries = await readdir(path.join(home, 'executors', executorId, 'inbox'), { withFileTypes: true });
    const names = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name).sort();
    const index = names.indexOf(name);
    return index < 0 ? 0 : index + 1;
  } catch { return 0; }
}

/** Latest turn record for one operation id (idempotent message receipts). */
export function turnForOperation(records: readonly TurnRecord[], operationId: string): TurnRecord | undefined {
  return records.findLast(record => record.operationId === operationId);
}
