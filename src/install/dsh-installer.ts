import { mkdir, readdir, lstat, readFile, copyFile, realpath, readlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { digest, bytes, contained, selectedRoot, ownership, withScopeLock, atomicJson } from './scope.js';

export interface NativeCommand { file: string; prefixArgs?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number }
export interface NativeMutationRequest {
  home: string; profile: string; args: string[]; expected?: Registration; token: string; timeoutMs: number;
}
export interface NativeBin { file: string; kind: 'file' | 'link'; sha256: string; target?: string }
export interface NativeMutationResult {
  nativeStarted: boolean; exitCode: number | null; refused?: string; diagnostics?: string; bins?: NativeBin[];
}
export interface InstallOptions {
  home: string;
  profile: string;
  command: NativeCommand;
  action: 'install' | 'uninstall';
  packageRoot?: string;
}
export interface InstallResult {
  state: 'installed' | 'already-installed' | 'uninstalled' | 'already-uninstalled' | 'unknown' | 'failed';
  reason: string;
  discoveryRequired: boolean;
  target?: string;
}
export interface DshProfileInspection {
  profile: string;
  state: 'installed' | 'partial' | 'absent';
  declared: boolean;
  bundled: boolean;
  module: boolean;
  owned: boolean;
  version?: string;
  reason?: string;
}
interface FileEntry { file: string; sha256: string }
interface Snapshot { id: string; version: string; files: FileEntry[]; directory: string }
export interface Registration extends Snapshot { spec: string; bins?: NativeBin[] }
interface Installation {
  product: 'ai4ai'; format: 1; token: string; harness: 'dsh'; profile: string;
  phase: 'absent' | 'installed' | 'mutating';
  active?: Registration;
  pending?: Registration;
  action?: 'install' | 'uninstall';
  nativeExit?: number | null;
  nativePid?: number;
  nativeDiagnostics?: string;
}
interface ProfilePackage {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
}
class NativeLaunchError extends Error {}
const OTHER_DEPENDENCIES = ['devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const response = (state: InstallResult['state'], reason: string, discoveryRequired = false, target?: string): InstallResult => ({ state, reason, discoveryRequired, ...(target ? { target } : {}) });
function profileName(value: string): void {
  if (value === 'node_modules' || !/^[\p{L}\p{N}][\p{L}\p{N}_. -]{0,63}$/u.test(value) || /[. ]$/.test(value) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)) throw new Error('Invalid native profile name');
}
async function files(directory: string, prefix = ''): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    await contained(directory, path.join(directory, relative));
    if (entry.isDirectory()) output.push(...await files(directory, relative));
    else if (entry.isFile()) output.push(relative.split(path.sep).join('/'));
    else throw new Error('Non-regular object in packaged runtime');
  }
  return output.sort();
}
async function sourceSnapshot(source: string): Promise<Omit<Snapshot, 'directory'>> {
  const data = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  if (data.name !== 'ai4ai' || typeof data.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(data.version) || data.license !== 'MIT' || data.dependencies && Object.keys(data.dependencies).length) throw new Error('Expected a self-contained MIT AI4AI package');
  if (Object.keys(data.scripts ?? {}).some(k => /^(preinstall|install|postinstall|prepare|prepack|postpack)$/.test(k))) throw new Error('Native snapshots may not execute package lifecycle scripts');
  const list = ['package.json', 'LICENSE', 'README.md', 'cordis.patch.yml'];
  for (const directory of ['dist', 'docs']) {
    await contained(source, path.join(source, directory));
    list.push(...(await files(source, directory)));
  }
  const entries: FileEntry[] = [];
  for (const file of [...new Set(list)].sort()) {
    await contained(source, path.join(source, file));
    const value = await bytes(path.join(source, file));
    if (!value) throw new Error('Packaged runtime is incomplete');
    entries.push({ file, sha256: digest(value) });
  }
  return { id: digest(JSON.stringify(entries)), version: data.version, files: entries };
}
async function verify(directory: string, entries: FileEntry[], extra: string[] = []): Promise<boolean> {
  const expected = [...entries.map(e => e.file), ...extra].sort();
  try {
    const actual = await files(directory);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) return false;
    for (const entry of entries) { const data = await bytes(path.join(directory, entry.file)); if (!data || digest(data) !== entry.sha256) return false; }
    return true;
  } catch { return false; }
}
async function snapshot(root: string, source: string, token: string): Promise<Snapshot> {
  const item = await sourceSnapshot(source);
  const parent = path.join(root, 'objects');
  await contained(root, parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = path.join(parent, item.id);
  const marker = path.join(directory, '.ai4ai-snapshot.json');
  try {
    await mkdir(directory, { mode: 0o700 });
    // Persist the exact allowlist before copying. An interruption can be inspected,
    // but it is never repaired by deleting unknown or partially copied objects.
    await atomicJson(root, marker, { product: 'ai4ai', format: 1, token, ...item }, undefined);
    for (const entry of item.files) {
      const target = path.join(directory, entry.file);
      await contained(root, target);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(path.join(source, entry.file), target, 1);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stamp = await bytes(marker);
  if (!stamp) throw new Error('Snapshot ownership baseline missing');
  const owner = JSON.parse(stamp.toString());
  if (owner.product !== 'ai4ai' || owner.format !== 1 || owner.token !== token || owner.id !== item.id || !(await verify(directory, item.files, ['.ai4ai-snapshot.json']))) throw new Error('Snapshot drift or incomplete interrupted copy; no overwrite authorized');
  return { ...item, directory };
}
export async function guardProfileDestinations(home: string, profile: string): Promise<void> {
  profileName(profile);
  const directory = path.join(home, 'profiles', profile);
  for (const target of ['package.json', 'package.json.lock', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', '.npmrc', '.plugin-manager', 'node_modules', 'node_modules/.bin', 'node_modules/.pnpm', 'node_modules/.modules.yaml']) {
    await contained(home, path.join(directory, ...target.split('/')));
  }
  const metadata = path.join(directory, '.plugin-manager');
  let count = 0;
  const check = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (++count > 2048 || depth > 4) throw new Error('Native metadata write destinations exceed bounded preflight');
      const target = path.join(dir, entry.name); await contained(home, target);
      if (entry.isDirectory()) await check(target, depth + 1);
      else if (!entry.isFile()) throw new Error('Unowned native metadata write destination');
    }
  };
  await check(metadata, 0);
}
export async function profilePackage(home: string, profile: string): Promise<ProfilePackage> {
  const file = path.join(home, 'profiles', profile, 'package.json');
  await contained(home, file);
  const value = await bytes(file);
  return value ? JSON.parse(value.toString()) : {};
}
export async function captureNativeBins(home: string, profile: string, payload?: Registration): Promise<NativeBin[]> {
  const directory = path.join(home, 'profiles', profile);
  const binDirectory = path.join(directory, 'node_modules', '.bin');
  await contained(home, binDirectory);
  const result: NativeBin[] = [];
  for (const name of ['ai4ai', 'ai4ai.cmd', 'ai4ai.ps1']) {
    const file = path.join(binDirectory, name);
    let stat;
    try { stat = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const relative = `node_modules/.bin/${name}`;
    if (stat.isSymbolicLink()) {
      if (!payload) throw new Error('Foreign or unresolved AI4AI command entry');
      const target = await realpath(file);
      await contained(home, target);
      const module = await realpath(path.join(directory, 'node_modules', 'ai4ai'));
      await contained(home, module);
      const data = await bytes(path.join(module, 'package.json'));
      if (!data) throw new Error('Native command payload is missing');
      const metadata = JSON.parse(data.toString());
      const entry = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.ai4ai;
      if (typeof entry !== 'string' || path.relative(module, path.resolve(module, entry)).startsWith('..') || path.relative(await realpath(path.resolve(module, entry)), target) !== '') throw new Error('Native command link does not target the owned entrypoint');
      const owned = payload.files.find(item => item.file === entry.replace(/^\.\//, '').split(path.sep).join('/'));
      const content = await bytes(target);
      if (!owned || !content || digest(content) !== owned.sha256) throw new Error('Native command target has drifted');
      result.push({ file: relative, kind: 'link', sha256: digest(await readlink(file)), target });
    } else {
      await contained(home, file);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unowned native command file');
      const content = await bytes(file); if (!content) throw new Error('Native command file is missing');
      result.push({ file: relative, kind: 'file', sha256: digest(content) });
    }
  }
  return result;
}
export async function installed(home: string, profile: string, expected: Registration): Promise<boolean> {
  const p = await profilePackage(home, profile);
  if (p.dependencies?.ai4ai !== expected.spec || OTHER_DEPENDENCIES.some(field => p[field]?.ai4ai !== undefined) || !Array.isArray(p.dsh?.profile?.bundles) || p.dsh.profile.bundles.filter(name => name === 'ai4ai').length !== 1) return false;
  const modules = path.join(home, 'profiles', profile, 'node_modules');
  await contained(home, modules);
  try {
    // The native package manager owns the final package symlink. Resolve it once,
    // then verify both scope containment and every installed payload byte.
    const actual = await realpath(path.join(modules, 'ai4ai'));
    await contained(home, actual);
    if (!(await verify(actual, expected.files))) return false;
    return JSON.stringify(await captureNativeBins(home, profile, expected)) === JSON.stringify(expected.bins ?? []);
  } catch { return false; }
}
export async function assertPendingSnapshot(home: string, profile: string, pending: Registration, token: string): Promise<void> {
  if (!pending || !/^[a-f0-9]{64}$/.test(pending.id) || !Array.isArray(pending.files) || pending.files.length > 2048 || digest(JSON.stringify(pending.files)) !== pending.id) throw new Error('Invalid pending snapshot baseline');
  const directory = path.join(home, '.ai4ai', 'dsh', profile, 'objects', pending.id);
  if (path.relative(directory, path.resolve(pending.directory)) !== '' || pending.spec !== `file:${directory.split(path.sep).join('/')}`) throw new Error('Pending snapshot escapes its owned location');
  await contained(home, directory);
  const raw = await bytes(path.join(directory, '.ai4ai-snapshot.json'));
  if (!raw) throw new Error('Pending snapshot ownership is missing');
  const marker = JSON.parse(raw.toString());
  if (marker.product !== 'ai4ai' || marker.format !== 1 || marker.token !== token || marker.id !== pending.id || !(await verify(directory, pending.files, ['.ai4ai-snapshot.json']))) throw new Error('Pending snapshot ownership or payload drift');
}
export async function assertNativeBaseline(home: string, profile: string, expected?: Registration): Promise<void> {
  await guardProfileDestinations(home, profile);
  if (expected) {
    if (!(await installed(home, profile, expected))) throw new Error('Native ownership or payload drift; mutation refused');
    return;
  }
  const current = await profilePackage(home, profile);
  if ((await captureNativeBins(home, profile)).length) throw new Error('Foreign AI4AI command entry; mutation refused');
  if (current.dependencies?.ai4ai !== undefined || OTHER_DEPENDENCIES.some(field => current[field]?.ai4ai !== undefined) || current.dsh?.profile?.bundles?.includes('ai4ai')) throw new Error('Foreign AI4AI registration; mutation refused');
  try { await lstat(path.join(home, 'profiles', profile, 'node_modules', 'ai4ai')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error('Foreign unregistered AI4AI payload; mutation refused');
}
async function native(command: NativeCommand, request: NativeMutationRequest, beforeInput: (pid: number) => Promise<void>): Promise<NativeMutationResult> {
  let rawEntry = command.prefixArgs?.length === 1 ? command.prefixArgs[0]! : command.file;
  // A bare command name must be resolved against the carrier PATH first; a
  // package manager (Homebrew, npm global) then exposes it as a symlink.
  // Resolve both so the safety gate inspects and node executes the real JS
  // entry instead of refusing a link whose name has no extension.
  if (!path.isAbsolute(rawEntry)) {
    for (const directory of (command.env?.PATH ?? process.env.PATH ?? '').split(path.delimiter)) {
      if (!directory) continue;
      const candidate = path.join(directory, rawEntry);
      if (existsSync(candidate)) { rawEntry = candidate; break; }
    }
  }
  const entry = await realpath(rawEntry).catch(() => rawEntry);
  const runtime = command.prefixArgs?.length === 1 ? command.file : process.execPath;
  if (!/\.[cm]?js$/i.test(entry)) throw new NativeLaunchError('Conditional native SDK integration is unavailable; no unchecked CLI mutation is permitted');
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 300000) throw new NativeLaunchError('Invalid native operation deadline');
  return new Promise((resolve, reject) => {
    const child = spawn(runtime, [fileURLToPath(new URL('./dsh-worker.js', import.meta.url)), entry], {
      shell: false, env: { ...(command.env ?? process.env), DSH_HOME: request.home }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', errors = '', done = false, timedOut = false;
    let processIntent: Promise<void> | undefined;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const timers: ReturnType<typeof setTimeout>[] = [];
    const cleanup = (): void => { for (const timer of timers) clearTimeout(timer); };
    const finishUnknown = (): void => {
      if (done) return; done = true; cleanup();
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); reject(new Error('Native worker deadline or process control failed; outcome unknown'));
    };
    child.stdout.on('data', data => { output = (output + String(data)).slice(-65536); });
    child.stderr.on('data', data => { errors = (errors + String(data)).slice(-8192); });
    child.stdin.on('error', () => { /* Exit/close determines whether the outcome is known. */ });
    const grace = Math.min(5000, Math.max(100, Math.floor(request.timeoutMs / 10)));
    const arm = (): void => {
      timers.push(setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, request.timeoutMs + grace));
      timers.push(setTimeout(() => { if (!done) child.kill('SIGKILL'); }, request.timeoutMs + 2 * grace));
      timers.push(setTimeout(finishUnknown, request.timeoutMs + 3 * grace));
    };
    child.once('spawn', () => {
      processIntent = Promise.resolve().then(() => beforeInput(child.pid!));
      void processIntent.then(() => { if (!done) { arm(); child.stdin.end(JSON.stringify(request)); } else child.stdin.destroy(); }).catch(error => {
        if (done) return; done = true; cleanup(); child.stdin.destroy(); child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); child.unref(); reject(new NativeLaunchError(`Could not persist native process intent: ${String(error)}`));
      });
    });
    child.once('error', error => {
      if (done) return;
      if (child.pid !== undefined) { finishUnknown(); return; }
      done = true; cleanup(); reject(new NativeLaunchError(error.message));
    });
    child.once('close', async () => {
      if (processIntent) await processIntent.catch(() => undefined);
      if (done) return; done = true; cleanup();
      if (timedOut) { reject(new Error('Native worker deadline exceeded; outcome unknown')); return; }
      let value: NativeMutationResult;
      try { value = JSON.parse(output) as NativeMutationResult; }
      catch { reject(new Error(`Native worker outcome is unknown: ${errors.slice(-1000)}`)); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { reject(new Error('Invalid native worker receipt')); return; }
      if (value.nativeStarted === false && typeof value.refused === 'string') { reject(new NativeLaunchError(value.refused)); return; }
      if (value.nativeStarted !== true || !(value.exitCode === null || (Number.isSafeInteger(value.exitCode) && value.exitCode >= 0)) || (value.exitCode === 0 && !Array.isArray(value.bins)) || (value.diagnostics !== undefined && typeof value.diagnostics !== 'string')) { reject(new Error('Invalid native worker receipt')); return; }
      resolve(value);
    });
  });
}

/** Install only in the explicitly selected DSH profile through its native package manager. */
export async function installDsh(options: InstallOptions): Promise<InstallResult> {
  profileName(options.profile);
  const home = await selectedRoot(options.home);
  await guardProfileDestinations(home, options.profile);
  const owned = await ownership(home);
  // The scope lock is taken per DSH profile: `install()` may already hold the
  // installation-home lock (for example when the managed home IS DSH_HOME), and
  // two profiles are independent destinations that do not need to serialize.
  const parent = path.join(owned.root, 'dsh');
  await contained(owned.root, parent); await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = path.join(parent, options.profile);
  await contained(owned.root, root);
  const target = path.join(home, 'profiles', options.profile);
  const preexisting = existsSync(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return withScopeLock(root, owned.owner, async () => {
    const manifest = path.join(root, 'installation.json');
    let raw = await bytes(manifest);
    if (!raw) {
      // An existing profile directory without an ownership baseline is foreign
      // state, not ours to initialize.
      if (preexisting) throw new Error('Missing profile ownership baseline');
      await atomicJson(owned.root, manifest, { product: 'ai4ai', format: 1, token: owned.owner.token, harness: 'dsh', profile: options.profile, phase: 'absent' }, undefined);
      raw = await bytes(manifest);
    }
    if (!raw) throw new Error('Missing profile ownership baseline');
    let state = JSON.parse(raw.toString()) as Installation;
    if (state.product !== 'ai4ai' || state.format !== 1 || state.token !== owned.owner.token || state.harness !== 'dsh' || state.profile !== options.profile || !['absent', 'installed', 'mutating'].includes(state.phase)) throw new Error('Foreign or incompatible installation manifest');
    const save = async (next: Installation): Promise<void> => {
      await atomicJson(owned.root, manifest, next, digest(raw!)); raw = await bytes(manifest); state = next;
    };
    if (state.phase === 'mutating') {
      // Unknown child delivery is reconciled, not automatically repeated.
      if (state.nativeExit === 0 && state.action === 'install' && state.pending && await installed(home, options.profile, state.pending)) {
        await save({ product: 'ai4ai', format: 1, token: owned.owner.token, harness: 'dsh', profile: options.profile, phase: 'installed', active: state.pending });
        return response('installed', 'Reconciled a completed native installation', true, target);
      } else if (state.nativeExit === 0 && state.action === 'uninstall') {
        const after = await profilePackage(home, options.profile);
        if (after.dependencies?.ai4ai !== undefined || after.dsh?.profile?.bundles?.includes('ai4ai')) return response('unknown', 'Native removal is not reconciled; no retry performed');
        await save({ product: 'ai4ai', format: 1, token: owned.owner.token, harness: 'dsh', profile: options.profile, phase: 'absent' });
      } else if (typeof state.nativeExit === 'number' && state.nativeExit !== 0 && !state.active && await (async () => {
        // A confirmed failed first install whose profile baseline is untouched
        // leaves nothing to preserve; allow the caller to retry after fixing
        // the environment (for example, a missing package manager).
        try { await assertNativeBaseline(home, options.profile); return true; } catch { return false; }
      })()) {
        await save({ product: 'ai4ai', format: 1, token: owned.owner.token, harness: 'dsh', profile: options.profile, phase: 'absent' });
      } else return response('unknown', 'Previous native mutation has no confirmed exit/outcome; no retry or rollback performed');
    }
    if (state.phase === 'installed' && !state.active) throw new Error('Owned registration baseline is missing');
    await assertNativeBaseline(home, options.profile, state.phase === 'installed' ? state.active : undefined);
    if (options.action === 'uninstall') {
      if (state.phase === 'absent') return response('already-uninstalled', 'No owned native registration exists');
      const prior = state;
      await save({ ...state, phase: 'mutating', action: 'uninstall' });
      let outcome: NativeMutationResult;
      try { outcome = await native(options.command, { home, profile: options.profile, args: ['remove', 'ai4ai'], token: owned.owner.token, timeoutMs: options.command.timeoutMs ?? 180000, ...(prior.active ? { expected: prior.active } : {}) }, async pid => { await save({ ...state, nativePid: pid }); }); } catch (error) {
        if (error instanceof NativeLaunchError) { await save(prior); return response('failed', `Native mutation did not start: ${error.message}`); }
        return response('unknown', 'Native uninstallation launch/delivery is unknown; inspect the existing operation');
      }
      const exit = outcome.exitCode;
      await save({ ...state, nativeExit: exit, ...(outcome.diagnostics ? { nativeDiagnostics: outcome.diagnostics } : {}) });
      const after = await profilePackage(home, options.profile);
      if (exit === 0 && after.dependencies?.ai4ai === undefined && !after.dsh?.profile?.bundles?.includes('ai4ai')) {
        await save({ product: 'ai4ai', format: 1, token: owned.owner.token, harness: 'dsh', profile: options.profile, phase: 'absent' });
        return response('uninstalled', 'Native registration removed; owned recovery manifests and immutable snapshots retained');
      }
      if (exit !== null && prior.active && await installed(home, options.profile, prior.active)) { await save(prior); return response('failed', 'Native uninstall failed; previous owned registration is verified intact'); }
      return response('unknown', 'Native uninstall outcome is unresolved; no foreign state restored or deleted');
    }
    const source = path.resolve(options.packageRoot ?? fileURLToPath(new URL('../../', import.meta.url)));
    const item = await snapshot(root, source, owned.owner.token);
    const next: Registration = { ...item, spec: `file:${item.directory.split(path.sep).join('/')}` };
    if (state.active?.id === next.id && state.phase === 'installed') return response('already-installed', 'Owned native registration and installed bytes already match', true, target);
    const previous = state;
    await save({ ...state, phase: 'mutating', action: 'install', pending: next });
    let outcome: NativeMutationResult;
    try { outcome = await native(options.command, { home, profile: options.profile, args: ['add', next.spec], token: owned.owner.token, timeoutMs: options.command.timeoutMs ?? 180000, ...(previous.active ? { expected: previous.active } : {}) }, async pid => { await save({ ...state, nativePid: pid }); }); } catch (error) {
      if (error instanceof NativeLaunchError) { await save(previous); return response('failed', `Native mutation did not start: ${error.message}`); }
      return response('unknown', 'Native installation launch/delivery is unknown; inspect the existing operation');
    }
    const exit = outcome.exitCode;
    const applied: Registration = { ...next, ...(outcome.bins ? { bins: outcome.bins } : {}) };
    await save({ ...state, pending: applied, nativeExit: exit, ...(outcome.diagnostics ? { nativeDiagnostics: outcome.diagnostics } : {}) });
    if (exit === 0 && await installed(home, options.profile, applied)) {
      await save({ product: 'ai4ai', format: 1, token: owned.owner.token, harness: 'dsh', profile: options.profile, phase: 'installed', active: applied });
      return response('installed', 'Native package and bundle registered; restart normally and verify model-visible discovery', true, target);
    }
    if (exit !== null && previous.active && await installed(home, options.profile, previous.active)) { await save(previous); return response('failed', 'Native update failed; previous owned payload is verified intact'); }
    if (exit !== null && exit !== 0 && !previous.active) {
      // A confirmed non-zero exit is not an unknown outcome. When the profile
      // baseline is untouched, the failed mutation applied nothing and a retry
      // (for example after installing the missing package manager) is safe.
      try {
        await assertNativeBaseline(home, options.profile);
        await save({ product: 'ai4ai', format: 1, token: owned.owner.token, harness: 'dsh', profile: options.profile, phase: 'absent' });
        return response('failed', `Native install failed with a confirmed exit (exit=${exit}); the profile baseline is unchanged, so a retry is allowed`);
      } catch { /* Fall through to the unresolved outcome below. */ }
    }
    return response('unknown', `Native install outcome is unresolved (exit=${exit}); no repeat, cleanup or rollback performed`);
  });
}

/** Read a JSON object without throwing on missing/damaged files or package-manager links. */
async function jsonObject(file: string): Promise<Record<string, any> | undefined> {
  try {
    // Inspection is read-only: following the profile's package-manager links is
    // required here (pnpm links node_modules/ai4ai), unlike mutation guards.
    const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as Record<string, any>;
  } catch { return undefined; }
}

/**
 * Read-only coverage of ai4ai in DSH profiles. `installed` means the profile
 * declares the plugin, bundles it, carries the native module and matches an
 * owned installation record; anything in between is `partial` and must be
 * reported so a half-installed DSH is never mistaken for a complete one.
 */
export async function inspectDshProfiles(home: string, profiles: readonly string[]): Promise<DshProfileInspection[]> {
  const root = path.resolve(home);
  const output: DshProfileInspection[] = [];
  for (const profile of profiles) {
    const directory = path.join(root, 'profiles', profile);
    const pkg = await jsonObject(path.join(directory, 'package.json'));
    if (!pkg) {
      output.push({ profile, state: 'absent', declared: false, bundled: false, module: false, owned: false, reason: 'profile is not initialized' });
      continue;
    }
    const declared = ['dependencies', ...OTHER_DEPENDENCIES].some(field => (pkg[field] as Record<string, unknown> | undefined)?.ai4ai !== undefined);
    const bundled = Array.isArray(pkg.dsh?.profile?.bundles) && (pkg.dsh.profile.bundles as unknown[]).includes('ai4ai');
    const modulePkg = await jsonObject(path.join(directory, 'node_modules', 'ai4ai', 'package.json'));
    const version = typeof modulePkg?.version === 'string' ? modulePkg.version : undefined;
    const manifest = await jsonObject(path.join(root, '.ai4ai', 'dsh', profile, 'installation.json'));
    const owned = manifest?.product === 'ai4ai' && manifest?.phase === 'installed'
      && typeof manifest?.active?.version === 'string' && manifest.active.version === version;
    if (declared && bundled && modulePkg && owned) {
      output.push({ profile, state: 'installed', declared, bundled, module: true, owned, ...(version ? { version } : {}) });
      continue;
    }
    if (!declared && !bundled && !modulePkg) {
      output.push({ profile, state: 'absent', declared, bundled, module: false, owned: false, reason: 'profile has no ai4ai registration' });
      continue;
    }
    const reasons: string[] = [];
    if (!declared) reasons.push('not listed in the profile dependencies');
    if (!bundled) reasons.push('not listed in dsh.profile.bundles');
    if (!modulePkg) reasons.push('the native module is missing');
    if (!owned) reasons.push('the owned installation record is missing or stale');
    output.push({ profile, state: 'partial', declared, bundled, module: Boolean(modulePkg), owned, ...(version ? { version } : {}), reason: reasons.join('; ') });
  }
  return output;
}
