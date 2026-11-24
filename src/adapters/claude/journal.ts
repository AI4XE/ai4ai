import { randomUUID } from 'node:crypto';
import { mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, bytes, contained, digest, ownership, withScopeLock } from '../../install/scope.js';
import { result, validateRequest } from '../../contract/validate.js';
import { handoffOutcome } from '../../contract/states.js';
import { fingerprint } from '../../core/fingerprint.js';
import type { Identity, Request, Result } from '../../contract/types.js';
import type { StoredProofMechanism } from '../../contract/states.js';
import { legacyProofMechanism } from '../../core/handoff.js';

export type ClaudePhase = 'pending' | 'scheduled' | 'applied' | 'completed' | 'cancelled' | 'failed' | 'unknown';

export interface ClaudeRecord {
  format: 2;
  operationId: string;
  fingerprint: string;
  request: Request;
  source: Identity;
  marker: string;
  phase: ClaudePhase;
  reason: string;
  /** Native context replacement strategy recorded for this handoff. */
  mechanism?: 'restart' | 'compact';
  /**
   * Explicit proof mechanism. New records always set it. Records written
   * before 0.0.5 lack it; their proof is derived from `mechanism` under the
   * historical rules and is exempt from the same-session gate.
   */
  proofMechanism?: StoredProofMechanism;
  successor?: Identity;
}

export interface ClaudeCommand {
  action: 'binding' | 'inspect' | 'request' | 'transition' | 'recover' | 'bind' | 'intake' | 'debug';
  caller?: Identity;
  instance?: string;
  request?: unknown;
  operationId?: string;
  phase?: ClaudePhase;
  marker?: string;
  reason?: string;
  /** Native successor identity after a restart (new session id) or compact generation. */
  successor?: Identity;
  mechanism?: 'restart' | 'compact';
  proofMechanism?: StoredProofMechanism;
  /** Temporary probe payload (debug). */
  debug?: unknown;
  /** Durable binding write (bind): session + generation token. */
  session?: string;
  generation?: string;
  usage?: { window?: number | null; used?: number | null; percent?: number | null; model?: string | null; reasoningEffort?: string | null };
}

interface Ledger { product: 'ai4ai'; format: 2; ownerToken: string; session: string; records: ClaudeRecord[] }

const PHASES: readonly ClaudePhase[] = ['pending', 'scheduled', 'applied', 'completed', 'cancelled', 'failed', 'unknown'];
const sessionKey = (identity: Identity): string => `${identity.workspace}\0${identity.surface}\0${identity.session}`;

function response(record: ClaudeRecord, operation: Request['operation'] = 'handoff'): Result {
  const status = record.phase === 'scheduled' ? 'pending' : record.phase;
  const lifecycle = handoffOutcome(record.phase);
  return result({ operation, operationId: record.operationId }, status, record.reason, {
    durable: true,
    state: lifecycle.state,
    ...(lifecycle.handoff ? { handoff: lifecycle.handoff } : {}),
    ...(record.phase === 'completed' && record.successor
      ? {
          proof: {
            source: record.source, successor: record.successor,
            // New records carry the explicit field; old records keep the
            // mechanism they historically implied and stay legacy-exempt.
            mechanism: record.proofMechanism ?? legacyProofMechanism(record.mechanism),
            nativeEvidence: record.marker,
          },
        }
      : {}),
  });
}

/** Durable per-session journal; revisions append and the latest row wins. */
export class ClaudeJournal {
  constructor(private readonly home: string) {}

  private async lock<T>(action: () => Promise<T>): Promise<T> {
    const owned = await ownership(this.home);
    return withScopeLock(owned.root, owned.owner, action);
  }

  private file(identity: Identity): string {
    const key = digest(sessionKey(identity));
    return path.join(this.home, '.ai4ai', 'claude', `${key}.json`);
  }

  private async read(identity: Identity, token: string): Promise<Ledger> {
    const file = this.file(identity);
    const raw = await bytes(file);
    if (!raw) return { product: 'ai4ai', format: 2, ownerToken: token, session: identity.session, records: [] };
    const value = JSON.parse(raw.toString()) as Ledger;
    if (value.product !== 'ai4ai' || value.format !== 2 || value.ownerToken !== token || value.session !== identity.session || !Array.isArray(value.records)) {
      throw new Error('Claude journal is foreign or malformed; no transition authorized');
    }
    return value;
  }

  private async write(identity: Identity, token: string, ledger: Ledger): Promise<void> {
    const file = this.file(identity);
    await contained(this.home, file);
    const directory = path.dirname(file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('Claude journal directory is a link');
    const raw = await bytes(file);
    await atomicJson(path.join(this.home, '.ai4ai'), file, ledger, raw === undefined ? undefined : digest(raw));
  }

  latest(records: readonly ClaudeRecord[], operationId: string): ClaudeRecord | undefined {
    return records.findLast(record => record.operationId === operationId);
  }

  async transaction(identity: Identity, action: (records: ClaudeRecord[], commit: (record: ClaudeRecord) => Promise<void>) => Promise<unknown>): Promise<unknown> {
    return this.lock(async () => {
      const owned = await ownership(this.home);
      const ledger = await this.read(identity, owned.owner.token);
      const records = ledger.records.slice();
      const commit = async (record: ClaudeRecord): Promise<void> => {
        records.push(record);
        await this.write(identity, owned.owner.token, { ...ledger, records });
      };
      return action(records, commit);
    });
  }

  async rows(identity: Identity): Promise<readonly ClaudeRecord[]> {
    const owned = await ownership(this.home);
    return (await this.read(identity, owned.owner.token)).records;
  }
}

export { response, PHASES, sessionKey };
