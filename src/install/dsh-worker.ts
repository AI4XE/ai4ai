// One-shot native SDK bridge. The parent records this process before supplying
// input. No native mutation is permitted without revalidation under the actual
// DSH profile lock; invoking an unconditional CLI beneath that lock would deadlock.
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { assertNativeBaseline, assertPendingSnapshot, captureNativeBins, guardProfileDestinations, type NativeMutationRequest, type NativeMutationResult } from './dsh-installer.js';
import { bytes, contained } from './scope.js';

async function input(): Promise<NativeMutationRequest> {
  let body = '';
  process.stdin.setEncoding('utf8');
  for await (const data of process.stdin) { body += String(data); if (body.length > 1048576) throw new Error('Native request is too large'); }
  return JSON.parse(body) as NativeMutationRequest;
}
async function execute(): Promise<NativeMutationResult> {
  let nativeStarted = false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  process.once('SIGTERM', () => controller.abort(new Error('Native operation cancelled')));
  try {
    const request = await input();
    if (!path.isAbsolute(request.home) || !Array.isArray(request.args) || !['add', 'remove'].includes(request.args[0] ?? '') || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 300000) throw new Error('Invalid native request');
    const home = path.resolve(request.home);
    await contained(home, home);
    const stateFile = path.join(home, '.ai4ai', 'dsh', request.profile, 'installation.json');
    await contained(home, stateFile);
    const raw = await bytes(stateFile);
    await contained(home, path.join(home, '.ai4ai', 'ownership.json'));
    const marker = await bytes(path.join(home, '.ai4ai', 'ownership.json'));
    if (!raw || !marker) throw new Error('Native mutation ownership baseline is missing');
    const state = JSON.parse(raw.toString()), owner = JSON.parse(marker.toString());
    if (owner.product !== 'ai4ai' || owner.format !== 1 || owner.token !== request.token || state.product !== 'ai4ai' || state.format !== 1 || state.harness !== 'dsh' || state.token !== request.token || state.phase !== 'mutating' || state.nativePid !== process.pid || state.profile !== request.profile || state.active?.id !== request.expected?.id || state.action !== (request.args[0] === 'add' ? 'install' : 'uninstall')) throw new Error('Native mutation authority or process binding differs');
    if (request.args.length !== 2 || (request.args[0] === 'remove' ? request.args[1] !== 'ai4ai' : request.args[1] !== state.pending?.spec)) throw new Error('Native mutation arguments differ from the owned intent');
    if (request.args[0] === 'add') await assertPendingSnapshot(home, request.profile, state.pending, request.token);
    const entry = path.resolve(process.argv[2] ?? '');
    const anchor = path.resolve(path.dirname(entry), '..', 'package.json');
    const metadata = JSON.parse(await readFile(anchor, 'utf8'));
    if (metadata.name !== '@deepseek-ai/dsh' || metadata.version !== '0.2.2-rc.1') throw new Error('Conditional native interface is not verified for this runtime generation');
    const minimum = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(metadata.engines?.node ?? '');
    if (!minimum) throw new Error('Native runtime requirement is unrecognized');
    const current = process.versions.node.split('.').map(Number);
    const required = minimum.slice(1).map(Number);
    let compatible = true;
    for (let i = 0; i < 3; i++) { if (current[i]! > required[i]!) break; if (current[i]! < required[i]!) { compatible = false; break; } }
    if (!compatible) throw new Error('The installed native SDK requires a newer existing Node runtime; no global upgrade attempted');
    const require = createRequire(anchor);
    const load = async (specifier: string): Promise<any> => import(pathToFileURL(require.resolve(specifier)).href);
    const atomic = await load('@deepseek-ai/dsh-atomic-write');
    const operations = await load('@deepseek-ai/dsh-plugin-manager/operations');
    const boot = await load('@deepseek-ai/dsh-app-boot');
    const bundles = await load('@deepseek-ai/dsh-official-bundles');
    if (typeof atomic.withFileLock !== 'function' || typeof operations.runProfilePnpm !== 'function' || typeof boot.initProfile !== 'function' || !Array.isArray(bundles.DEFAULT_PROFILE_BUNDLES)) throw new Error('Conditional native package-management API is unavailable');
    timer = setTimeout(() => controller.abort(new Error('Native operation deadline exceeded')), request.timeoutMs);
    await guardProfileDestinations(home, request.profile);
    const directory = path.join(home, 'profiles', request.profile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return await atomic.withFileLock(path.join(directory, 'package.json'), async () => {
      controller.signal.throwIfAborted();
      await assertNativeBaseline(home, request.profile, request.expected);
      if (!(await bytes(path.join(directory, 'package.json')))) {
        if (request.profile === 'desktop') throw new Error('Desktop must initialize its native profile before installation');
        nativeStarted = true;
        boot.initProfile(directory, bundles.PROFILE_TEMPLATES?.[request.profile]?.bundles ?? bundles.DEFAULT_PROFILE_BUNDLES);
      }
      await guardProfileDestinations(home, request.profile);
      controller.signal.throwIfAborted();
      nativeStarted = true;
      const result = await operations.runProfilePnpm({ profile: request.profile, dir: directory, home, installAnchor: anchor, cwd: process.cwd() }, request.args, {
        execution: 'service', outputBytes: 16384, signal: controller.signal,
        idleTimeoutMs: Math.min(request.timeoutMs, 120000), lookupTimeoutMs: Math.min(request.timeoutMs, 30000),
      });
      const bins = result.exitCode === 0 && !result.timedOut ? await captureNativeBins(home, request.profile, request.args[0] === 'add' ? state.pending : undefined) : undefined;
      if (request.args[0] === 'remove' && bins?.length) throw new Error('Native removal left unresolved AI4AI command entries');
      return { nativeStarted: true, exitCode: result.timedOut ? null : result.exitCode, diagnostics: String(result.output ?? '').slice(-16384), ...(bins ? { bins } : {}) };
    }, { waitMs: Math.min(request.timeoutMs, 120000), signal: controller.signal });
  } catch (error) {
    return { nativeStarted, exitCode: null, ...(nativeStarted ? { diagnostics: error instanceof Error ? error.message : 'Native mutation failed' } : { refused: error instanceof Error ? error.message : 'Native mutation refused before write' }) };
  } finally { if (timer) clearTimeout(timer); }
}
void execute().then(receipt => { process.stdout.write(JSON.stringify(receipt)); });
