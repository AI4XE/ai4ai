import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { atomicJson, bytes, digest, ownership, selectedRoot, withScopeLock } from './scope.js';
import { installDsh } from './dsh-installer.js';
import type { HarnessId, Os } from '../contract/states.js';
import { currentOs } from '../core/operations.js';

export type InstallAction = 'install' | 'upgrade' | 'uninstall';
export interface InstallActionReport {
  harness: HarnessId;
  action: InstallAction;
  state: 'installed' | 'already-installed' | 'uninstalled' | 'already-uninstalled' | 'unsupported' | 'skipped' | 'failed' | 'unknown';
  reason: string;
  target?: string;
}
export interface InstallReport {
  product: 'ai4ai';
  version: string;
  home: string;
  scope: 'user' | 'project';
  dryRun: boolean;
  actions: InstallActionReport[];
}

export interface InstallOptions {
  action: InstallAction;
  harnesses?: HarnessId[];
  scope?: 'user' | 'project';
  workspace?: string;
  home?: string;
  profile?: string;
  yes?: boolean;
  dryRun?: boolean;
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
}

interface Detection { harness: HarnessId; installed: boolean; binary?: string; version?: string; reason: string }

const HARNESSES: readonly HarnessId[] = ['claude-code', 'codex', 'opencode', 'dsh'];

const packageRoot = (options: InstallOptions): string =>
  options.packageRoot ?? process.env.AI4AI_PACKAGE_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));

const version = async (root: string): Promise<string> =>
  JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version as string;

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (error) {
      // Node refuses to spawn `.cmd`/`.bat` without a shell on Windows; treat it
      // as "not found" rather than aborting the whole detection pass.
      resolve({ code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, options.timeoutMs ?? 120000);
    child.stdout.on('data', data => { stdout = (stdout + String(data)).slice(-65536); });
    child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-16384); });
    child.once('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function probeBinary(binary: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; version?: string; reason: string }> {
  const candidates = process.platform === 'win32' ? [binary, `${binary}.cmd`, `${binary}.exe`] : [binary];
  for (const candidate of candidates) {
    const result = await run(candidate, ['--version'], { env, timeoutMs: 20000 });
    if (result.code === 0) {
      const first = result.stdout.trim().split('\n')[0]?.slice(0, 200);
      return { ok: true, ...(first ? { version: first } : {}), reason: 'Binary responded to --version' };
    }
  }
  return { ok: false, reason: 'Binary not found or did not answer --version' };
}

/** Detect installed harnesses. Only the binary probe mutates nothing. */
export async function detectHarnesses(options: InstallOptions = { action: 'install' }): Promise<Detection[]> {
  const env = { ...process.env, ...(options.env ?? {}) };
  const overrides: Record<HarnessId, string | undefined> = {
    'claude-code': env.AI4AI_CLAUDE_BIN,
    codex: env.AI4AI_CODEX_BIN,
    opencode: env.AI4AI_OPENCODE_BIN,
    dsh: env.AI4AI_DSH_ENTRY ? (env.AI4AI_DSH_NODE || process.execPath) : env.AI4AI_DSH_BIN,
  };
  const binaries: Record<HarnessId, string> = { 'claude-code': 'claude', codex: 'codex', opencode: 'opencode', dsh: 'dsh' };
  const output: Detection[] = [];
  for (const harness of HARNESSES) {
    if (harness === 'dsh' && env.AI4AI_DSH_ENTRY && existsSync(env.AI4AI_DSH_ENTRY)) {
      output.push({ harness, installed: true, binary: env.AI4AI_DSH_ENTRY, reason: 'AI4AI_DSH_ENTRY points at the DSH entry point' });
      continue;
    }
    const binary = overrides[harness] ?? binaries[harness];
    const probed = await probeBinary(binary, env);
    output.push({ harness, installed: probed.ok, ...(probed.ok ? { binary } : {}), ...(probed.version ? { version: probed.version } : {}), reason: probed.reason });
  }
  return output;
}

interface JournalRecord {
  harness: HarnessId; action: InstallAction; state: string; target?: string; version: string; at: string;
}
interface Journal { product: 'ai4ai'; format: 2; ownerToken: string; records: JournalRecord[] }

async function readJournal(home: string, token: string): Promise<Journal> {
  const file = path.join(home, '.ai4ai', 'install-journal.json');
  const raw = await bytes(file);
  if (!raw) return { product: 'ai4ai', format: 2, ownerToken: token, records: [] };
  const value = JSON.parse(raw.toString()) as Journal;
  if (value.product !== 'ai4ai' || value.format !== 2 || value.ownerToken !== token || !Array.isArray(value.records)) throw new Error('Install journal is foreign or malformed; no mutation performed');
  return value;
}

async function appendJournal(home: string, token: string, record: JournalRecord): Promise<void> {
  const root = path.join(home, '.ai4ai');
  const file = path.join(root, 'install-journal.json');
  const current = await readJournal(home, token);
  await atomicJson(root, file, { ...current, records: [...current.records, record] }, await (async () => {
    const raw = await bytes(file);
    return raw === undefined ? undefined : digest(raw);
  })());
}

async function snapshotRuntime(root: string, home: string, versionString: string, workspace: string, token: string, scope: 'user' | 'project'): Promise<string> {
  const target = path.join(home, 'runtime', versionString);
  await mkdir(target, { recursive: true });
  const entries = ['dist', 'LICENSE', 'README.md', 'README.zh-CN.md', 'docs/contract.md', 'package.json',
    'claude-plugin', 'opencode-plugin', 'cordis.patch.yml'];
  for (const entry of entries) {
    const source = path.join(root, entry);
    if (!existsSync(source)) continue;
    await cp(source, path.join(target, entry), { recursive: true, force: true });
  }
  const binding = { product: 'ai4ai', format: 2, home, workspace, ownerToken: token, version: versionString, node: process.execPath, scope };
  // The workspace-local copy is the authoritative lookup for native plugins:
  // a plugin cache can be shared by several projects, so the binding must live
  // with the workspace, not only inside the plugin package.
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'binding.json'), JSON.stringify(binding, null, 2) + '\n');
  for (const plugin of ['claude-plugin', 'opencode-plugin']) {
    const directory = path.join(target, plugin);
    if (existsSync(directory)) await writeFile(path.join(directory, 'binding.json'), JSON.stringify(binding, null, 2) + '\n');
  }
  return target;
}

function homeFor(options: InstallOptions): string {
  if (options.home) return path.resolve(options.home);
  const workspace = path.resolve(options.workspace ?? process.cwd());
  return options.scope === 'project' ? path.join(workspace, '.ai4ai') : path.join(homedir(), '.ai4ai');
}

/**
 * A marketplace name is global to the Claude configuration. Deriving it from
 * the installation home keeps projects independent: two projects with their own
 * local marketplaces must not shadow each other's cached copy under one name.
 */
export function claudeMarketplaceName(home: string): string {
  return `ai4ai-local-${createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 8)}`;
}

async function registerClaude(runtime: string, home: string, scope: 'user' | 'project', dryRun: boolean, env: NodeJS.ProcessEnv, workspace: string): Promise<InstallActionReport> {
  const marketplace = path.join(home, 'marketplace');
  const name = claudeMarketplaceName(home);
  const plugin = path.join(marketplace, 'plugins', 'ai4ai');
  if (dryRun) return { harness: 'claude-code', action: 'install', state: 'installed', reason: 'dry-run: would add a local marketplace and install ai4ai', target: plugin };
  await mkdir(path.join(marketplace, '.claude-plugin'), { recursive: true });
  await cp(path.join(runtime, 'claude-plugin'), plugin, { recursive: true, force: true });
  const versionString = (JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8')) as { version: string }).version;
  await writeFile(path.join(marketplace, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    schemaVersion: '1.0', name, owner: { name: 'AI4AI' },
    plugins: [{ name: 'ai4ai', version: versionString, description: 'AI4AI self-handoff and detached executors', source: './plugins/ai4ai' }],
  }, null, 2) + '\n');
  // Project scope is resolved by the CLI against its working directory; run it in
  // the target workspace so an install invoked elsewhere cannot register another project.
  // User scope is global and keeps the caller's working directory.
  const cliOptions: { env: NodeJS.ProcessEnv; cwd?: string } = { env };
  if (scope === 'project') {
    await mkdir(workspace, { recursive: true });
    cliOptions.cwd = workspace;
  }
  const add = await run(env.AI4AI_CLAUDE_BIN || 'claude', ['plugin', 'marketplace', 'add', marketplace], cliOptions);
  if (add.code !== 0 && !/already/i.test(add.stdout + add.stderr)) return { harness: 'claude-code', action: 'install', state: 'failed', reason: `marketplace add failed: ${(add.stderr || add.stdout).slice(-500)}` };
  const install = await run(env.AI4AI_CLAUDE_BIN || 'claude', ['plugin', 'install', `ai4ai@${name}`, '--scope', scope], cliOptions);
  if (install.code !== 0) return { harness: 'claude-code', action: 'install', state: 'failed', reason: `plugin install failed: ${(install.stderr || install.stdout).slice(-500)}` };
  return { harness: 'claude-code', action: 'install', state: 'installed', reason: 'Native Claude plugin registered from a local marketplace', target: plugin };
}

/**
 * Content revision of the shipped plugin package. OpenCode caches a Git plugin
 * by spec URL, so an unchanged `git+file://…/opencode-plugin-repo` keeps the
 * previously installed package after an ai4ai upgrade. A content-derived
 * repository name gives the new bytes a new spec (and therefore a new cache
 * entry) while leaving unrelated plugins untouched.
 */
async function pluginRevision(directory: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (relative = ''): Promise<void> => {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) {
        hash.update(next);
        hash.update(await readFile(path.join(directory, next)));
      }
    }
  };
  await walk();
  return hash.digest('hex').slice(0, 12);
}

/** Drop only ai4ai's own local OpenCode specs from a config file. */
async function removePriorOpenCodeSpecs(file: string): Promise<void> {
  const raw = await bytes(file);
  if (!raw) return;
  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw.toString()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    config = parsed as Record<string, unknown>;
  } catch { return; }
  if (!Array.isArray(config.plugins)) return;
  const plugins = (config.plugins as unknown[]).filter((value): value is string => typeof value === 'string');
  const remaining = plugins.filter(value => !/\/opencode-plugin-repo(?:-[0-9a-f]+)?$/.test(value));
  if (remaining.length === plugins.length) return;
  await writeFile(file, JSON.stringify({ ...config, plugins: remaining }, null, 2) + '\n');
}

async function registerOpenCode(runtime: string, home: string, dryRun: boolean, env: NodeJS.ProcessEnv, workspace: string, scope: 'user' | 'project'): Promise<InstallActionReport> {
  const plugin = path.join(runtime, 'opencode-plugin');
  if (dryRun) return { harness: 'opencode', action: 'install', state: 'installed', reason: 'dry-run: would add the local OpenCode plugin', target: plugin };
  const revision = await pluginRevision(plugin);
  const binary = env.AI4AI_OPENCODE_BIN || 'opencode';
  const resolvedBinary = (() => {
    if (path.isAbsolute(binary)) return existsSync(binary) ? binary : undefined;
    for (const directory of (env.PATH ?? '').split(path.delimiter)) {
      if (!directory) continue;
      const candidate = path.join(directory, binary);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  })();
  // `opencode plugin add` accepts npm or Git specs only. Publish the managed
  // plugin as a tiny local Git repository so registration is native, offline
  // and reversible before ai4ai is on npm.
  const repo = path.join(home, `opencode-plugin-repo-${revision}`);
  await mkdir(repo, { recursive: true });
  await cp(plugin, repo, { recursive: true, force: true });
  // OpenCode 2.x may run plugins on a compiled binary, not Node. Record the
  // Node that performed this install so detached supervisors can be launched
  // with a real Node runtime instead of `opencode <script>`.
  await writeFile(path.join(repo, 'node-runtime.json'), JSON.stringify({ node: process.execPath }) + '\n');
  // Record the harness binary too: the in-harness plugin process may resolve a
  // different `opencode` (for example a legacy 1.x) than the install shell.
  // Never record an unresolvable bare name: an absolute path is the only value
  // the detached carrier can trust, and `null` lets the plugin fall back to the
  // binary that is actually running it.
  await writeFile(path.join(repo, 'opencode-runtime.json'), JSON.stringify({ opencode: resolvedBinary ?? null }) + '\n');
  const git = async (...args: string[]) => run('git', args, { env, cwd: repo });
  if (!(await bytes(path.join(repo, '.git', 'HEAD')))) await git('init', '-q');
  await git('add', '-A');
  await git('-c', 'user.name=AI4AI', '-c', 'user.email=ai4ai@localhost', 'commit', '-q', '-m', 'ai4ai opencode plugin', '--allow-empty');
  const normalized = repo.split(path.sep).join('/');
  const spec = `git+file://${process.platform === 'win32' ? '/' : ''}${normalized}`;
  if (scope === 'project') {
    // `opencode plugin add` mutates the user's global config even for a
    // project-scope install. Write the native project config instead so the
    // plugin is scoped to the caller workspace and other projects stay clean.
    const file = path.join(workspace, 'opencode.json');
    let config: Record<string, unknown> = {};
    const raw = await bytes(file);
    if (raw) {
      try {
        const parsed = JSON.parse(raw.toString()) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        config = parsed as Record<string, unknown>;
      } catch {
        return { harness: 'opencode', action: 'install', state: 'failed', reason: 'Existing opencode.json is not a JSON object; no overwrite performed', target: file };
      }
    }
    const plugins = Array.isArray(config.plugins)
      ? (config.plugins as unknown[]).filter((value): value is string => typeof value === 'string' && !/\/opencode-plugin-repo(?:-[0-9a-f]+)?$/.test(value))
      : [];
    if (!plugins.includes(spec)) plugins.push(spec);
    await writeFile(file, JSON.stringify({ ...config, plugins }, null, 2) + '\n');
    return { harness: 'opencode', action: 'install', state: 'installed', reason: 'Project-scoped OpenCode plugin registered in the workspace config', target: spec };
  }
  // User scope: remove a previous ai4ai spec first, or OpenCode would load two
  // copies of the same plugin id.
  const userConfig = path.join(env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'opencode', 'opencode.json');
  await removePriorOpenCodeSpecs(userConfig);
  const result = await run(binary, ['plugin', 'add', spec], { env });
  if (result.code === 0) return { harness: 'opencode', action: 'install', state: 'installed', reason: 'Native OpenCode plugin registered from a local Git spec', target: spec };
  return { harness: 'opencode', action: 'install', state: 'failed', reason: `opencode plugin add failed: ${(result.stderr || result.stdout).slice(-500)}` };
}

/** Remove the ai4ai spec from a project-scope OpenCode config only. */
async function unregisterOpenCodeProject(workspace: string, spec: string | undefined): Promise<InstallActionReport> {
  const file = path.join(workspace, 'opencode.json');
  const raw = await bytes(file);
  if (!raw) return { harness: 'opencode', action: 'uninstall', state: 'already-uninstalled', reason: 'No project opencode.json exists' };
  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw.toString()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    config = parsed as Record<string, unknown>;
  } catch {
    return { harness: 'opencode', action: 'uninstall', state: 'unknown', reason: 'Existing opencode.json is not a JSON object; no rewrite performed', target: file };
  }
  const plugins = Array.isArray(config.plugins) ? (config.plugins as unknown[]).filter((value): value is string => typeof value === 'string') : [];
  const remaining = spec ? plugins.filter(value => value !== spec) : plugins.filter(value => !value.startsWith('git+file://'));
  await writeFile(file, JSON.stringify({ ...config, plugins: remaining }, null, 2) + '\n');
  return { harness: 'opencode', action: 'uninstall', state: 'uninstalled', reason: 'Project-scoped OpenCode plugin registration removed', target: file };
}

async function registerDsh(runtime: string, options: InstallOptions, env: NodeJS.ProcessEnv): Promise<InstallActionReport> {
  const dshHome = env.DSH_HOME || path.join(homedir(), '.dsh');
  const profile = options.profile ?? env.AI4AI_DSH_PROFILE ?? 'web';
  const entry = env.AI4AI_DSH_ENTRY;
  const command = entry
    ? { file: env.AI4AI_DSH_NODE || process.execPath, prefixArgs: [entry], env }
    : { file: 'dsh', prefixArgs: [], env };
  if (options.dryRun) return { harness: 'dsh', action: 'install', state: 'installed', reason: `dry-run: would install into DSH profile ${profile}`, target: dshHome };
  const result = await installDsh({ home: dshHome, profile, command, action: options.action === 'uninstall' ? 'uninstall' : 'install', packageRoot: runtime });
  return { harness: 'dsh', action: options.action, state: result.state as InstallActionReport['state'], reason: result.reason };
}

/**
 * One install experience: detect, select, register natively, journal every
 * change. Idempotent; a failed native call is reported, never papered over.
 */
export async function install(options: InstallOptions): Promise<InstallReport> {
  const env = { ...process.env, ...(options.env ?? {}) };
  const root = packageRoot(options);
  const versionString = await version(root);
  const scope = options.scope ?? 'user';
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const home = homeFor({ ...options, scope, workspace });
  const detections = await detectHarnesses(options);
  const requested = options.harnesses?.length
    ? options.harnesses
    : options.yes ? detections.filter(d => d.installed).map(d => d.harness) : detections.filter(d => d.installed).map(d => d.harness);
  const actions: InstallActionReport[] = [];
  if (!requested.length) {
    return { product: 'ai4ai', version: versionString, home, scope, dryRun: options.dryRun === true, actions: [{ harness: 'claude-code', action: options.action, state: 'skipped', reason: 'No supported harness detected' }] };
  }
  if (options.dryRun) {
    for (const harness of requested) actions.push({ harness, action: options.action, state: 'installed', reason: 'dry-run: no files changed' });
    return { product: 'ai4ai', version: versionString, home, scope, dryRun: true, actions };
  }
  const selected = await selectedRoot(home);
  const owned = await ownership(selected);
  return withScopeLock(owned.root, owned.owner, async () => {
    const runtime = await snapshotRuntime(root, selected, versionString, workspace, owned.owner.token, scope);
    const journal = await readJournal(selected, owned.owner.token);
    for (const harness of requested) {
      const detection = detections.find(d => d.harness === harness);
      const last = journal.records.filter(record => record.harness === harness).at(-1);
      const prior = [...journal.records].reverse().find(record => record.harness === harness && record.action !== 'uninstall');
      let report: InstallActionReport;
      if (options.action === 'install' && prior?.version === versionString && prior.target && existsSync(prior.target)) {
        report = { harness, action: 'install', state: 'already-installed', reason: 'Owned registration for this version already exists', target: prior.target };
      } else if (options.action === 'uninstall') {
        if (!last || last.action === 'uninstall') { report = { harness, action: 'uninstall', state: 'already-uninstalled', reason: 'No owned registration recorded' }; }
        else if (harness === 'claude-code') {
          const result = await run(env.AI4AI_CLAUDE_BIN || 'claude', ['plugin', 'uninstall', `ai4ai@${claudeMarketplaceName(selected)}`, '--scope', scope, '-y'], { env });
          report = { harness, action: 'uninstall', state: result.code === 0 ? 'uninstalled' : 'unknown', reason: result.code === 0 ? 'Native plugin removed' : `uninstall outcome: ${(result.stderr || result.stdout).slice(-400)}` };
        } else if (harness === 'opencode') {
          report = scope === 'project'
            ? await unregisterOpenCodeProject(workspace, prior?.target)
            : await (async () => {
              const result = await run(env.AI4AI_OPENCODE_BIN || 'opencode', ['plugin', 'remove', prior?.target ?? ''], { env });
              return { harness: 'opencode', action: 'uninstall', state: result.code === 0 ? 'uninstalled' : 'unknown', reason: result.code === 0 ? 'Native plugin removed' : `uninstall outcome: ${(result.stderr || result.stdout).slice(-400)}` } as InstallActionReport;
            })();
        } else if (harness === 'dsh') {
          report = await registerDsh(runtime, { ...options, action: 'uninstall' }, env);
        } else {
          report = { harness, action: 'uninstall', state: 'unsupported', reason: 'No native registration is owned for this harness' };
        }
      } else if (harness === 'claude-code') {
        report = await registerClaude(runtime, selected, scope, false, env, workspace);
      } else if (harness === 'opencode') {
        report = await registerOpenCode(runtime, selected, false, env, workspace, scope);
      } else if (harness === 'dsh') {
        report = await registerDsh(runtime, options, env);
      } else {
        report = {
          harness, action: options.action, state: 'installed',
          reason: 'Codex integration uses the ai4ai CLI and the local app-server daemon control channel; no in-session manifest is required',
          target: path.join(runtime, 'dist', 'cli.js'),
        };
      }
      actions.push(report);
      await appendJournal(selected, owned.owner.token, { harness, action: options.action, state: report.state, ...(report.target ? { target: report.target } : {}), version: versionString, at: new Date().toISOString() });
      void detection;
    }
    return { product: 'ai4ai', version: versionString, home: selected, scope, dryRun: false, actions };
  });
}

export async function statusReport(options: InstallOptions = { action: 'install' }): Promise<InstallReport & { detections: Detection[]; registered: HarnessId[] }> {
  const detections = await detectHarnesses(options);
  const home = homeFor(options);
  const root = packageRoot(options);
  let registered: HarnessId[] = [];
  try {
    const owned = await ownership(home);
    const journal = await readJournal(home, owned.owner.token);
    const lastAction = new Map<HarnessId, string>();
    for (const record of journal.records) lastAction.set(record.harness, record.action);
    registered = [...lastAction.entries()].filter(([, action]) => action !== 'uninstall').map(([harness]) => harness);
  } catch { /* uninstalled home is simply empty */ }
  return {
    product: 'ai4ai', version: await version(root), home,
    scope: options.scope ?? 'user', dryRun: false, actions: [], detections, registered,
  };
}

export { detectHarnesses as detect, currentOs };
export type { Detection, Os };
