import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, lstat } from 'node:fs/promises';
import { atomicJson, bytes, contained, digest, ownership, selectedRoot, withScopeLock } from '../install/scope.js';
import { validateResult } from '../contract/validate.js';
import { finalizeHandoff } from './handoff.js';
import type { Identity, Policy, Request, Result } from '../contract/types.js';
import type { HarnessId, Isolation, State } from '../contract/states.js';

export class StoreError extends Error {}

export interface OperationRecord {
  format: 2;
  kind: 'operation';
  request: Request;
  fingerprint: string;
  source: Identity;
  status: State;
  reason: string;
  result: Result;
  createdAt: string;
}

export interface CarrierInfo {
  detached: true;
  command: string[];
  pid?: number;
  pidFile?: string;
}

export interface ExecutorRecord {
  format: 2;
  kind: 'executor';
  executorId: string;
  parent: Identity;
  harness: HarnessId;
  surface: 'tui' | 'headless' | 'web';
  policy: Required<Policy>;
  isolation: Isolation;
  sessionId?: string;
  /** Effective model at spawn time, restored on resumed turns. */
  model?: string;
  /** Effective reasoning effort at spawn time, restored on resumed turns. */
  reasoningEffort?: string;
  state: string;
  createdAt: string;
  carrier: CarrierInfo;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const identityKey = (identity: Identity): string => createHash('sha256').update(JSON.stringify({
  harness: identity.harness, workspace: identity.workspace, surface: identity.surface,
  session: identity.session, agent: identity.agent,
})).digest('hex');

function validOperation(value: unknown): value is OperationRecord {
  const r = value as OperationRecord | null;
  return !!r && r.format === 2 && r.kind === 'operation' && typeof r.fingerprint === 'string'
    && typeof r.status === 'string' && typeof r.reason === 'string'
    && !!r.request && typeof r.request.operationId === 'string'
    && !!r.source && typeof r.source.session === 'string' && !!r.result && typeof r.result.status === 'string'
    && typeof r.createdAt === 'string';
}

function validExecutor(value: unknown): value is ExecutorRecord {
  const r = value as ExecutorRecord | null;
  return !!r && r.format === 2 && r.kind === 'executor' && typeof r.executorId === 'string' && ID.test(r.executorId)
    && typeof r.parent?.session === 'string' && typeof r.harness === 'string' && typeof r.state === 'string'
    && (r.model === undefined || typeof r.model === 'string')
    && (r.reasoningEffort === undefined || typeof r.reasoningEffort === 'string')
    && typeof r.createdAt === 'string' && !!r.carrier && r.carrier.detached === true && Array.isArray(r.carrier.command);
}

interface OperationsEnvelope<T> {
  product: 'ai4ai'; format: 2; ownerToken: string; native: Omit<Identity, 'generation'>; records: T[];
}

/**
 * Durable, local-only operation and executor store.
 *
 * Contract: mutations are serialized by the installer scope lock, published
 * atomically with compare-and-swap, and reconciled by reading before writing.
 * A malformed or foreign store fails closed; nothing is reset or deleted.
 */
export class Ai4aiStore {
  private constructor(
    readonly home: string,
    private readonly root: string,
    private readonly ownerToken: string,
  ) {}

  static async open(candidateHome: string): Promise<Ai4aiStore> {
    const home = await selectedRoot(candidateHome);
    const owned = await ownership(home);
    return new Ai4aiStore(home, owned.root, owned.owner.token);
  }

  private async lock<T>(action: () => Promise<T>): Promise<T> {
    const owned = await ownership(this.home);
    if (owned.owner.token !== this.ownerToken) throw new StoreError('Installation ownership changed; no mutation authorized');
    return withScopeLock(owned.root, owned.owner, action);
  }

  private operationFile(identity: Identity): string {
    return path.join(this.root, 'operations', `${identityKey(identity)}.json`);
  }

  private async readOperations(identity: Identity): Promise<OperationsEnvelope<OperationRecord> | undefined> {
    const file = this.operationFile(identity);
    await contained(this.root, file);
    const raw = await bytes(file);
    if (!raw) return undefined;
    let value: OperationsEnvelope<OperationRecord>;
    try { value = JSON.parse(raw.toString()) as OperationsEnvelope<OperationRecord>; }
    catch { throw new StoreError('Operation store is malformed; no reset performed'); }
    const native = { harness: identity.harness, workspace: identity.workspace, surface: identity.surface, session: identity.session, agent: identity.agent };
    if (value.product !== 'ai4ai' || value.format !== 2 || value.ownerToken !== this.ownerToken
      || JSON.stringify(value.native) !== JSON.stringify(native) || !Array.isArray(value.records)
      || value.records.length > 10000 || !value.records.every(validOperation)) {
      throw new StoreError('Operation store is incompatible or belongs to another native scope');
    }
    return value;
  }

  /** Read-only view. Takes the cooperative lock so a concurrent append is not observed half-published. */
  async records(identity: Identity): Promise<readonly OperationRecord[]> {
    return this.lock(async () => (await this.readOperations(identity))?.records.slice() ?? []);
  }

  /** Idempotent append: an existing record keyed by operationId is never rewritten. */
  async append(record: OperationRecord): Promise<void> {    await this.lock(async () => {
      const file = this.operationFile(record.source);
      await contained(this.root, file);
      const directory = path.dirname(file);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if ((await lstat(directory)).isSymbolicLink()) throw new StoreError('Operation store directory is a link');
      const before = await this.readOperations(record.source);
      const existing = before?.records.find(r => r.request.operationId === record.request.operationId);
      if (existing) {
        if (existing.fingerprint !== record.fingerprint) throw new StoreError('Conflicting reuse of an operation identifier');
        return;
      }
      const native = { harness: record.source.harness, workspace: record.source.workspace, surface: record.source.surface, session: record.source.session, agent: record.source.agent };
      const next: OperationsEnvelope<OperationRecord> = before
        ? { ...before, records: [...before.records, record] }
        : { product: 'ai4ai', format: 2, ownerToken: this.ownerToken, native, records: [record] };
      const raw = await bytes(file);
      await atomicJson(this.root, file, next, raw === undefined ? undefined : digest(raw));
      const published = await bytes(file);
      if (!published || !published.toString().includes(record.request.operationId)) throw new StoreError('Operation store publication is uncertain');
    });
  }

  /**
   * Complete a pending operation in place. Durable operations are normally
   * append-only; a detached native watcher is the one case where the same
   * operation advances after its first result, so the pending record is
   * replaced with the terminal one. The replacement is contract-checked
   * (including the same-session proof rule) and terminal records are never
   * rewritten.
   */
  async completePending(identity: Identity, operationId: string, outcome: Result): Promise<boolean> {
    const checked = validateResult(outcome);
    if (!checked.ok) throw new StoreError(`Pending completion violates the contract: ${checked.issues.map(i => `${i.path}:${i.code}`).join(', ')}`);
    const finalized = finalizeHandoff({ ...(outcome.proof ? { proof: outcome.proof } : {}) });
    if (finalized.error) throw new StoreError(`Pending completion violates the handoff rule: ${finalized.error}`);
    return this.lock(async () => {
      const file = this.operationFile(identity);
      await contained(this.root, file);
      const before = await this.readOperations(identity);
      if (!before) return false;
      const index = before.records.findIndex(record => record.request.operationId === operationId);
      if (index < 0) return false;
      const existing = before.records[index]!;
      if (!['accepted', 'pending', 'applied'].includes(existing.status)) return false;
      if (outcome.operationId !== operationId || outcome.operation !== existing.request.operation) {
        throw new StoreError('Pending completion belongs to a different operation; record left pending');
      }
      const records = before.records.slice();
      records[index] = { ...existing, status: outcome.status, reason: outcome.reason, result: outcome };
      const raw = await bytes(file);
      await atomicJson(this.root, file, { ...before, records }, raw === undefined ? undefined : digest(raw));
      return true;
    });
  }

  private executorFile(): string { return path.join(this.root, 'executors.json'); }

  private async readExecutors(): Promise<ExecutorRecord[]> {
    const file = this.executorFile();
    await contained(this.root, file);
    const raw = await bytes(file);
    if (!raw) return [];
    let value: { product: string; format: number; ownerToken: string; records: ExecutorRecord[] };
    try { value = JSON.parse(raw.toString()); }
    catch { throw new StoreError('Executor registry is malformed; no reset performed'); }
    if (value.product !== 'ai4ai' || value.format !== 2 || value.ownerToken !== this.ownerToken
      || !Array.isArray(value.records) || value.records.length > 10000 || !value.records.every(validExecutor)) {
      throw new StoreError('Executor registry is incompatible or belongs to another installation');
    }
    return value.records;
  }

  async executors(): Promise<readonly ExecutorRecord[]> {
    return this.lock(async () => (await this.readExecutors()).slice());
  }

  async addExecutors(records: readonly ExecutorRecord[]): Promise<void> {
    if (!records.length) return;
    await this.lock(async () => {
      const file = this.executorFile();
      await contained(this.root, file);
      const existing = await this.readExecutors();
      const ids = new Set(existing.map(r => r.executorId));
      for (const record of records) {
        if (!validExecutor(record)) throw new StoreError('Invalid executor record');
        if (ids.has(record.executorId)) throw new StoreError('Executor identifier already exists');
      }
      const raw = await bytes(file);
      const directory = path.dirname(file);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if ((await lstat(directory)).isSymbolicLink()) throw new StoreError('Executor registry directory is a link');
      await atomicJson(this.root, file, { product: 'ai4ai', format: 2, ownerToken: this.ownerToken, records: [...existing, ...records] }, raw === undefined ? undefined : digest(raw));
    });
  }

  async updateExecutor(executorId: string, patch: Partial<Pick<ExecutorRecord, 'state' | 'sessionId'>>): Promise<ExecutorRecord> {
    return this.lock(async () => {
      const file = this.executorFile();
      const existing = await this.readExecutors();
      const index = existing.findIndex(r => r.executorId === executorId);
      if (index < 0) throw new StoreError('Unknown executor');
      const next = { ...existing[index]!, ...patch };
      const records = existing.slice();
      records[index] = next;
      const raw = await bytes(file);
      await atomicJson(this.root, file, { product: 'ai4ai', format: 2, ownerToken: this.ownerToken, records }, raw === undefined ? undefined : digest(raw));
      return next;
    });
  }
}

export { identityKey };
