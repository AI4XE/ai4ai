#!/usr/bin/env node
import { readFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { homedir } from 'node:os';
import { install, statusReport, detectHarnesses, currentOs } from './install/manager.js';
import { Ai4aiStore } from './core/store.js';
import { execute } from './core/operations.js';
import { HARNESSES, type HarnessId, type Surface } from './contract/states.js';
import { TOOL_DESCRIPTION, TOOL_NAME } from './contract/tool.js';
import type { Identity } from './contract/types.js';
import { claudeAdapter } from './adapters/claude/adapter.js';
import { codexAdapter } from './adapters/codex/adapter.js';
import { openCodeAdapter } from './adapters/opencode/adapter.js';
import { dshAdapter } from './adapters/dsh/adapter.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const adapters = { 'claude-code': claudeAdapter, codex: codexAdapter, opencode: openCodeAdapter, dsh: dshAdapter } as const;

interface Parsed {
  command: string;
  flags: Map<string, string[]>;
}

const VALUE_FLAGS = ['harness', 'scope', 'workspace', 'home', 'profile', 'package-root', 'contract', 'operation', 'task', 'target', 'mode', 'session', 'surface', 'operation-id', 'timeout', 'model', 'reasoning-effort', 'count'];
const BOOLEAN_FLAGS = ['yes', 'json', 'dry-run', 'help', 'version'];
const CLI_OPERATIONS = ['handoff', 'spawn', 'status', 'message', 'cancel', 'stop', 'list', 'capabilities'] as const;
const HARNESS_IDS = new Set<string>(HARNESSES);

function parse(argv: string[]): Parsed {
  const command = argv[0] && !argv[0].startsWith('-') ? argv.shift()! : 'help';
  const flags = new Map<string, string[]>();
  while (argv.length) {
    const token = argv.shift()!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.includes(name)) { flags.set(name, ['true']); continue; }
    if (!VALUE_FLAGS.includes(name)) throw new Error(`Unknown option: ${token}`);
    const value = argv.shift();
    if (!value || value.startsWith('--')) throw new Error(`Option ${token} requires a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { command, flags };
}

const flag = (parsed: Parsed, name: string): string | undefined => parsed.flags.get(name)?.[0];
const harnesses = (parsed: Parsed): HarnessId[] | undefined => {
  const values = parsed.flags.get('harness');
  if (!values) return undefined;
  const ids = values.flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean);
  for (const id of ids) if (!HARNESSES.includes(id as HarnessId)) throw new Error(`Unknown harness: ${id}`);
  return ids as HarnessId[];
};

const fileExists = async (file: string): Promise<boolean> => {
  try { await access(file); return true; } catch { return false; }
};

/**
 * Project-scope installs keep state in `<workspace>/.ai4ai`; otherwise use the
 * user home. The project install home is `<workspace>/.ai4ai`, so its ownership
 * record lives at `<workspace>/.ai4ai/.ai4ai/ownership.json`; a home whose
 * state sits directly at `<workspace>/.ai4ai` is also accepted.
 */
async function operationHome(parsed: Parsed, workspace: string): Promise<string> {
  const explicit = flag(parsed, 'home');
  if (explicit) return path.resolve(explicit);
  const project = path.join(workspace, '.ai4ai');
  if (await fileExists(path.join(project, '.ai4ai', 'ownership.json'))) return project;
  if (await fileExists(path.join(project, 'ownership.json'))) return workspace;
  return path.join(homedir(), '.ai4ai');
}

/** A stable session id keeps executor ownership across separate CLI invocations. */
async function cliSession(home: string): Promise<string> {
  const file = path.join(home, '.ai4ai', 'cli-session');
  if (await fileExists(file)) return (await readFile(file, 'utf8')).trim();
  const value = `cli-${randomUUID()}`;
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, value + '\n', { mode: 0o600 });
  return value;
}

/** Run one contract operation and print the schema-valid result. */
async function runOperation(parsed: Parsed): Promise<void> {
  const operation = flag(parsed, 'operation');
  if (!operation || !(CLI_OPERATIONS as readonly string[]).includes(operation)) {
    throw new Error(`--operation must be one of: ${CLI_OPERATIONS.join(', ')}`);
  }
  const harness = flag(parsed, 'harness') ?? process.env.AI4AI_HARNESS;
  if (!harness || !HARNESS_IDS.has(harness)) {
    throw new Error(`--harness is required for contract operations (${HARNESSES.join(', ')})`);
  }
  const workspace = path.resolve(flag(parsed, 'workspace') ?? process.cwd());
  const home = await operationHome(parsed, workspace);
  if (!(await fileExists(path.join(home, '.ai4ai', 'ownership.json')))) {
    throw new Error(`No ai4ai installation at ${home}; run "ai4ai init" first`);
  }
  // A carrier-launched CLI belongs to a detached executor: default its surface
  // to headless so the execution identity matches the surface it runs on.
  const executorId = process.env.AI4AI_EXECUTOR_ID;
  const surface = flag(parsed, 'surface') ?? (executorId ? 'headless' : 'tui');
  if (!['tui', 'headless', 'web'].includes(surface)) throw new Error(`Invalid surface: ${surface}`);
  const session = flag(parsed, 'session') ?? process.env.AI4AI_SESSION ?? await cliSession(home);
  const identity: Identity = {
    harness: harness as HarnessId, workspace, surface: surface as Identity['surface'], session,
    generation: process.env.AI4AI_GENERATION ?? 'cli', agent: 'main',
  };
  const request: Record<string, unknown> = {
    operation,
    operationId: flag(parsed, 'operation-id') ?? `${operation}-${randomUUID()}`,
  };
  const task = flag(parsed, 'task');
  if (task !== undefined) request.task = task;
  const target = flag(parsed, 'target');
  if (target !== undefined) request.target = target;
  else if (['handoff', 'message', 'cancel', 'stop'].includes(operation)) request.target = 'self';
  const mode = flag(parsed, 'mode');
  if (mode !== undefined) request.mode = mode;
  const model = flag(parsed, 'model');
  if (model !== undefined) request.model = model;
  const reasoningEffort = flag(parsed, 'reasoning-effort');
  if (reasoningEffort !== undefined) request.reasoningEffort = reasoningEffort;
  const count = flag(parsed, 'count');
  if (count !== undefined) request.count = Number(count);
  const timeout = flag(parsed, 'timeout');
  if (timeout !== undefined) request.timeoutMs = Number(timeout);
  const store = await Ai4aiStore.open(home);
  const result = await execute(request, { home, identity, adapter: adapters[harness as HarnessId], store, os: currentOs(), ...(executorId ? { executorId } : {}) });
  if (parsed.flags.has('json')) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`ai4ai ${result.operation} ${result.status}${result.state ? ` (${result.state})` : ''}`);
  console.log(`  ${result.reason}`);
  if (result.executorId) console.log(`  executor: ${result.executorId}`);
  if (result.sessionId) console.log(`  session: ${result.sessionId}`);
  if (result.context?.used != null) console.log(`  context: ${result.context.used} used${result.context.percent != null ? ` (${result.context.percent}% ${result.context.percentSource})` : ''}`);
  if (result.proof) console.log(`  proof: ${result.proof.mechanism} ${result.proof.nativeEvidence}`);
}

function printReport(report: unknown, json: boolean): void {
  if (json) { console.log(JSON.stringify(report, null, 2)); return; }
  const value = report as { version: string; home: string; actions?: { harness: string; action: string; state: string; reason: string; target?: string }[]; detections?: { harness: string; installed: boolean; version?: string; reason: string }[]; registered?: string[] };
  console.log(`ai4ai ${value.version} ${value.home}`);
  for (const detection of value.detections ?? []) console.log(`  ${detection.installed ? 'detected' : 'missing '} ${detection.harness}${detection.version ? ` ${detection.version}` : ''}`);
  if (value.registered) console.log(`  registered: ${value.registered.length ? value.registered.join(', ') : 'none'}`);
  for (const action of value.actions ?? []) console.log(`  ${action.action} ${action.harness}: ${action.state} - ${action.reason}${action.target ? ` (${action.target})` : ''}`);
}

async function main(): Promise<void> {
  const parsed = parse(process.argv.slice(2));
  if (flag(parsed, 'version') || parsed.command === 'version') {
    console.log(`ai4ai ${JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version}`);
    return;
  }
  if (parsed.command === 'help' || flag(parsed, 'help')) {
    console.log(`AI4AI - AI Harness Extension Kit

Usage: ai4ai <init|status|upgrade|uninstall|capabilities|detect|op|session> [options]

Contract operations: ai4ai session --operation <handoff|spawn|status|message|cancel|stop|list|capabilities> --harness <id> [--task <text>] [--target <self|id>]
(ai4ai op is an alias of ai4ai session.)

AI-facing tool (${TOOL_NAME}):
${TOOL_DESCRIPTION}

Options:
  --harness <id>        claude-code | codex | opencode | dsh (repeatable or comma separated)
  --scope <scope>       user (default) | project
  --workspace <path>    workspace for project scope and spawn carriers
  --home <path>         override the managed installation home
  --profile <name>      DSH profile (default: web)
  --yes                 accept detected harnesses without an interactive prompt
  --dry-run             report the plan without changing files
  --json                machine-readable output
  --version             print the package version

Headless is the must-pass baseline; TUI/web
support is declared per harness and never implied.`);
    return;
  }

  const selectedHarnesses = harnesses(parsed);
  const workspaceFlag = flag(parsed, 'workspace');
  const homeFlag = flag(parsed, 'home');
  const profileFlag = flag(parsed, 'profile');
  const packageRootFlag = flag(parsed, 'package-root');
  const common = {
    scope: (flag(parsed, 'scope') ?? 'user') as 'user' | 'project',
    ...(workspaceFlag ? { workspace: workspaceFlag } : {}),
    ...(homeFlag ? { home: homeFlag } : {}),
    ...(profileFlag ? { profile: profileFlag } : {}),
    ...(packageRootFlag ? { packageRoot: packageRootFlag } : {}),
    yes: parsed.flags.has('yes'),
    dryRun: parsed.flags.has('dry-run'),
    ...(selectedHarnesses ? { harnesses: selectedHarnesses } : {}),
  };

  if (parsed.command === 'init' || parsed.command === 'upgrade' || parsed.command === 'uninstall') {
    const report = await install({ ...common, action: parsed.command === 'uninstall' ? 'uninstall' : parsed.command === 'upgrade' ? 'upgrade' : 'install' });
    printReport(report, parsed.flags.has('json'));
    const failed = report.actions.some(action => ['failed', 'unknown'].includes(action.state));
    process.exitCode = failed ? 1 : 0;
    return;
  }
  if (parsed.command === 'status') {
    printReport(await statusReport({ action: 'install', ...common }), parsed.flags.has('json'));
    return;
  }
  if (parsed.command === 'capabilities') {
    const os = currentOs();
    const selected = harnesses(parsed) ?? [...HARNESSES];
    const declarations = selected.flatMap(harness => adapters[harness].capabilities(os));
    printReport({ version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, home: '-', declarations }, parsed.flags.has('json'));
    return;
  }
  if (parsed.command === 'detect') {
    const detections = await detectHarnesses({ action: 'install' });
    printReport({ version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, home: '-', detections }, parsed.flags.has('json'));
    return;
  }
  if (parsed.command === 'op' || parsed.command === 'session') {
    await runOperation(parsed);
    return;
  }
  throw new Error(`Unknown command: ${parsed.command}`);
}

main().catch(error => {
  console.error(JSON.stringify({ state: 'failed', reason: error instanceof Error ? error.message : 'CLI failed' }));
  process.exitCode = 1;
});
