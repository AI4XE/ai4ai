import { mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, bytes, contained, digest, ownership, withScopeLock } from '../../install/scope.js';
import { result } from '../../contract/validate.js';
import { handoffOutcome } from '../../contract/states.js';
import { fingerprint } from '../../core/fingerprint.js';
import type { Identity, Request, Result } from '../../contract/types.js';

export type OpenCodePhase = 'pending' | 'scheduled' | 'applied' | 'completed' | 'cancelled' | 'failed' | 'unknown';

export interface OpenCodeRecord {
  format: 2;
  operationId: string;
  fingerprint: string;
  request: Request;
  source: Identity;
  compactID: string;
  deliveryID: string;
  sourceMessage: string;
  sourceCall: string;
  phase: OpenCodePhase;
  reason: string;
  /** The native handoff replaces the window without a summary model call. */
  mechanism?: 'restart';
  successor?: Identity;
}

interface Ledger { product: 'ai4ai'; format: 2; ownerToken: string; session: string; records: OpenCodeRecord[] }

const key = (identity: Identity): string => `${identity.workspace}\0${identity.surface}\0${identity.session}`;

export function openCodeResult(record: OpenCodeRecord, operation: Request['operation'] = 'handoff'): Result {
  const status = record.phase === 'scheduled' ? 'pending' : record.phase;
  const lifecycle = handoffOutcome(record.phase);
  return result({ operation, operationId: record.operationId }, status, record.reason, {
    durable: true,
    state: lifecycle.state,
    ...(lifecycle.handoff ? { handoff: lifecycle.handoff } : {}),
    ...(record.phase === 'completed' && record.successor
      ? { proof: { source: record.source, successor: record.successor, mechanism: 'new-session' as const, nativeEvidence: record.compactID } }
      : {}),
  });
}

export class OpenCodeJournal {
  constructor(private readonly home: string) {}

  private file(identity: Identity): string {
    return path.join(this.home, '.ai4ai', 'opencode', `${digest(key(identity))}.json`);
  }

  private async read(identity: Identity, token: string): Promise<Ledger> {
    const file = this.file(identity);
    const raw = await bytes(file);
    if (!raw) return { product: 'ai4ai', format: 2, ownerToken: token, session: identity.session, records: [] };
    const value = JSON.parse(raw.toString()) as Ledger;
    if (value.product !== 'ai4ai' || value.format !== 2 || value.ownerToken !== token || value.session !== identity.session || !Array.isArray(value.records)) {
      throw new Error('OpenCode journal is foreign or malformed; no transition authorized');
    }
    return value;
  }

  latest(records: readonly OpenCodeRecord[], operationId: string): OpenCodeRecord | undefined {
    return records.findLast(record => record.operationId === operationId);
  }

  async rows(identity: Identity): Promise<readonly OpenCodeRecord[]> {
    const owned = await ownership(this.home);
    return (await this.read(identity, owned.owner.token)).records;
  }

  async transaction<T>(identity: Identity, action: (records: OpenCodeRecord[], commit: (record: OpenCodeRecord) => Promise<void>) => Promise<T>): Promise<T> {
    const owned = await ownership(this.home);
    return withScopeLock(owned.root, owned.owner, async () => {
      const ledger = await this.read(identity, owned.owner.token);
      const records = ledger.records.slice();
      const commit = async (record: OpenCodeRecord): Promise<void> => {
        records.push(record);
        const file = this.file(identity);
        await contained(this.home, file);
        const directory = path.dirname(file);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if ((await lstat(directory)).isSymbolicLink()) throw new Error('OpenCode journal directory is a link');
        const raw = await bytes(file);
        await atomicJson(path.join(this.home, '.ai4ai'), file, { ...ledger, records }, raw === undefined ? undefined : digest(raw));
      };
      return action(records, commit);
    });
  }

  async request(identity: Identity, request: Request, native?: { messageID: string; callID: string }): Promise<{ result: Result; record?: OpenCodeRecord }> {
    return this.transaction(identity, async (records, commit) => {
      const prior = this.latest(records, request.operationId);
      if (prior) {
        return { result: prior.fingerprint === fingerprint(request) ? openCodeResult(prior) : result(request, 'failed', 'Conflicting operation identifier reuse') };
      }
      if (request.operation !== 'handoff') return { result: result(request, 'unsupported', 'This OpenCode plugin implements in-session handoff only; use the external CLI for executors') };
      if (request.target !== 'self') return { result: result(request, 'unsupported', 'Only self-handoff is implemented in the in-session plugin') };
      if (request.mode === 'compact') return { result: result(request, 'unsupported', 'OpenCode handoff replaces the window with only the task material; a history summary (compact) is not implemented') };
      const active = records.find(record => !['completed', 'cancelled', 'failed', 'unknown'].includes(record.phase));
      if (active) return { result: result(request, 'failed', 'Another handoff is unresolved; reconcile it first') };
      const token = crypto.randomUUID().replaceAll('-', '');
      const record: OpenCodeRecord = {
        format: 2, operationId: request.operationId, fingerprint: fingerprint(request), request, source: identity,
        compactID: `msg_ai4ai_compact_${token}`, deliveryID: `msg_ai4ai_task_${token}`,
        sourceMessage: native?.messageID ?? '', sourceCall: native?.callID ?? '', phase: 'pending',
        mechanism: 'restart',
        reason: 'Finish the source turn; the native replacement supplies a fresh window containing only the task material',
      };
      await commit(record);
      return { result: openCodeResult(record), record };
    });
  }

  async transition(identity: Identity, operationId: string, from: readonly OpenCodePhase[], to: OpenCodePhase, reason: string): Promise<OpenCodeRecord> {
    return this.transaction(identity, async (records, commit) => {
      const prior = this.latest(records, operationId);
      if (!prior || !from.includes(prior.phase)) throw new Error('Native operation changed; no replay or competing transition');
      const next: OpenCodeRecord = {
        ...prior, phase: to, reason,
        ...(to === 'applied' || to === 'completed' ? { successor: { ...prior.source, generation: prior.compactID } } : {}),
      };
      await commit(next);
      return next;
    });
  }
}
