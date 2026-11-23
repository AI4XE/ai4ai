import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { processAlive } from './process-identity.js';

/**
 * Per-executor mutual exclusion for state-changing operations (message
 * enqueue/revival, finish, force stop, sweep reconciliation).
 *
 * The lock is an atomically created directory; its owner record carries the
 * pid and timestamp so a crashed holder is reclaimed. A lock that cannot be
 * reclaimed is reported as `busy` rather than bypassed: two processes must
 * never relaunch or drain the same executor concurrently.
 */
export class ExecutorBusyError extends Error {
  readonly code = 'busy';
  constructor(message: string) { super(message); this.name = 'ExecutorBusyError'; }
}

const lockDir = (executorDirectory: string): string => path.join(executorDirectory, '.lock');

interface LockOwner { pid: number; at: string; operation?: string }

async function readOwner(directory: string): Promise<LockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8')) as LockOwner;
    return Number.isSafeInteger(value?.pid) ? value : undefined;
  } catch { return undefined; }
}

function stale(owner: LockOwner | undefined, ageMs: number): boolean {
  if (!owner) return ageMs > 1000;
  const held = Date.parse(owner.at);
  if (!Number.isFinite(held)) return true;
  // A live owner keeps the lock; a dead owner is reclaimed immediately.
  if (processAlive(owner.pid) === true) return ageMs > 120_000;
  return true;
}

export interface LockOptions {
  waitMs?: number;
  operation?: string;
}

export async function withExecutorLock<T>(executorDirectory: string, action: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const target = lockDir(executorDirectory);
  const waitMs = options.waitMs ?? 5000;
  const deadline = Date.now() + waitMs;
  await mkdir(executorDirectory, { recursive: true });
  for (;;) {
    try {
      await mkdir(target);
      await writeFile(path.join(target, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...(options.operation ? { operation: options.operation } : {}) }));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readOwner(target);
      let age = 0;
      if (owner) {
        const held = Date.parse(owner.at);
        age = Number.isFinite(held) ? Date.now() - held : Number.MAX_SAFE_INTEGER;
      }
      if (stale(owner, age)) {
        // Reclaim atomically enough: only remove the directory we observed.
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ExecutorBusyError(`Executor is locked by ${owner ? `pid ${owner.pid}` : 'another process'}; retry later`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try {
    return await action();
  } finally {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
  }
}
