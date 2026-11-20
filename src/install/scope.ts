import { constants } from 'node:fs';
import { mkdir, lstat, readFile, realpath, open, rename, link, unlink, readlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const digest = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
export async function bytes(file: string): Promise<Buffer | undefined> {
  try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || !equalPath(await realpath(file), path.resolve(file))) throw new Error('Expected an unlinked regular file'); return await readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
const equalPath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
/** Refuse both symbolic links and Windows junction/reparse escapes. */
export async function contained(root: string, target: string): Promise<void> {
  root = path.resolve(root);
  if (!path.isAbsolute(target) || path.normalize(target) !== target) throw new Error('Installation target must be an absolute normalized path');
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path escapes the selected scope');
  let current = root;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    current = part ? path.join(current, part) : current;
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !equalPath(await realpath(current), current)) throw new Error('Linked or reparse paths are not owned installation targets');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
}
/** Existing root selection is explicit; files below it must stay canonical. */
export async function selectedRoot(candidate: string): Promise<string> {
  if (!path.isAbsolute(candidate)) throw new Error('The selected scope root must be absolute');
  const resolved = path.resolve(candidate);
  await contained(path.parse(resolved).root, resolved);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const stat = await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The selected root must be a real directory');
  return realpath(resolved);
}

/** Cooperative compare-and-swap under the installer's exclusive scope lock. */
export async function atomicJson(root: string, file: string, value: unknown, expectedHash: string | undefined): Promise<string> {
  await contained(root, file);
  const before = await bytes(file);
  if ((before === undefined ? undefined : digest(before)) !== expectedHash) throw new Error('Concurrent file drift; no replacement performed');
  const body = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const temporary = path.join(path.dirname(file), `.ai4ai-write-${randomUUID()}`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
  try {
    await contained(root, file);
    const current = await bytes(file);
    if ((current === undefined ? undefined : digest(current)) !== expectedHash) throw new Error('Concurrent file drift before publication');
    if (expectedHash === undefined) { await link(temporary, file); await unlink(temporary); }
    else await rename(temporary, file);
    return digest(body);
  } catch (error) {
    const leftover = await bytes(temporary);
    if (leftover !== undefined && digest(leftover) === digest(body)) await unlink(temporary);
    throw error;
  }
}
interface Owner { product: 'ai4ai'; format: 1; token: string }
/** A live competing ai4ai process holds the installation lock. Transient. */
export class LockBusyError extends Error {
  readonly code = 'ai4ai-busy';
  constructor() { super('Installation is busy with another ai4ai process; retry'); this.name = 'LockBusyError'; }
}
const LOCK_WAIT_MS = 3000;
const LOCK_POLL_MS = 40;
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
export async function ownership(home: string): Promise<{ root: string; owner: Owner }> {
  const root = path.join(home, '.ai4ai');
  await contained(home, root);
  let created = false;
  try { await mkdir(root, { mode: 0o700 }); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const marker = path.join(root, 'ownership.json');
  if (created) await atomicJson(root, marker, { product: 'ai4ai', format: 1, token: randomUUID() }, undefined);
  const data = await bytes(marker);
  if (!data) throw new Error('Existing integration directory has no ownership baseline');
  const owner = JSON.parse(data.toString()) as Owner;
  if (owner.product !== 'ai4ai' || owner.format !== 1 || typeof owner.token !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.token)) throw new Error('Foreign installation ownership marker');
  return { root, owner };
}
/** Linux process start time (field 22) detects a reused pid; null elsewhere. */
async function processStart(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    return fields[19] ?? null;
  } catch { return null; }
}
async function namespace(): Promise<string> {
  if (process.platform === 'linux') { try { return await readlink('/proc/self/ns/pid'); } catch { return 'unknown'; } }
  return process.platform === 'win32' ? 'windows-local' : 'unknown';
}
/** Only a definitely absent, same-namespace installer can leave a removable stale lock. */
export async function withScopeLock<T>(root: string, owner: Owner, action: () => Promise<T>): Promise<T> {
  const file = path.join(root, 'installation.lock');
  await contained(root, file);
  const ns = await namespace();
  const start = await processStart(process.pid);
  const record = { product: 'ai4ai', format: 1, token: owner.token, pid: process.pid, namespace: ns, nonce: randomUUID(), ...(start ? { start } : {}) };
  const body = Buffer.from(JSON.stringify(record));
  let acquired = false;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { const h = await open(file, 'wx', 0o600); try { await h.writeFile(body); await h.sync(); } finally { await h.close(); } acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A live holder and an in-flight reclaimer are both transient: operations
      // such as status legitimately race the supervisor's short writes. Wait a
      // bounded time for the holder to finish instead of failing the operation.
      let progressed = false;
      // Reclaimers must serialize before reading the stale record. A second
      // hash check alone cannot prevent deleting a replacement live lock.
      const claim = path.join(root, 'installation.reclamation.lock');
      await contained(root, claim);
      const claimBody = Buffer.from(JSON.stringify({ ...record, purpose: 'reclamation' }));
      let claimHandle;
      try { claimHandle = await open(claim, 'wx', 0o600); }
      catch { /* another live reclaimer; wait for it below */ }
      if (claimHandle) {
        try {
          await claimHandle.writeFile(claimBody); await claimHandle.sync();
          const prior = await bytes(file);
          if (!prior) progressed = true;
          else {
            let lock;
            try { lock = JSON.parse(prior.toString()); } catch { throw new Error('Malformed lock; cleanup is not authorized'); }
            if (lock.product !== 'ai4ai' || lock.format !== 1 || lock.token !== owner.token || !Number.isSafeInteger(lock.pid) || lock.pid < 1) throw new Error('Unknown or foreign lock ownership/liveness');
            // Liveness can only be judged inside a known, matching PID namespace
            // (macOS has no /proc; containers may differ). Without that proof the
            // lock is never reclaimed: the caller waits the bounded window and
            // reports the operation as busy instead of failing hard.
            if (ns === 'unknown' || lock.namespace !== ns) { /* unprovable ownership: wait, never delete */ }
            else {
              let state: 'alive' | 'dead' | 'unknown' = 'unknown';
              try {
                process.kill(lock.pid, 0);
                // The pid may have been reused after a crash: compare the process
                // start time recorded with the lock to the live process.
                const liveStart = typeof lock.start === 'string' ? await processStart(lock.pid) : null;
                state = typeof lock.start === 'string' && liveStart !== null && liveStart !== lock.start ? 'dead' : 'alive';
              } catch (e) { state = (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
              if (state === 'dead') {
                const current = await bytes(file);
                if (!current || digest(current) !== digest(prior)) { /* replaced under us; retry */ }
                else { await unlink(file); progressed = true; }
              }
            }
          }
        } finally {
          await claimHandle.close();
          const current = await bytes(claim);
          if (current && digest(current) === digest(claimBody)) await unlink(claim);
          // A crashed reclaimer's claim is never automatically reclaimed.
        }
      }
      if (!progressed) {
        if (Date.now() >= deadline) throw new LockBusyError();
        await pause(LOCK_POLL_MS);
      }
    }
  }
  if (!acquired) throw new Error('Could not acquire the installation lock');
  try { return await action(); }
  finally {
    const current = await bytes(file);
    if (current && digest(current) === digest(body)) await unlink(file);
  }
}
