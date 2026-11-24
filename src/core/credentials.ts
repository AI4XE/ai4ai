/**
 * Provider-credential inheritance (v0.0.8 D37 / AI4AI-CONFIG-050).
 *
 * A real user may configure their provider only at the user level
 * (`~/.claude/settings.json` or `$CLAUDE_CONFIG_DIR/settings.json`). The Claude
 * carrier deliberately runs with `--setting-sources project,local` so user
 * behaviour (hooks, plugins, permissions, MCP, model policy) never leaks into an
 * executor. That also hid the user's *provider route*, so such a user could not
 * spawn anything without editing their project.
 *
 * This module separates the two concerns:
 * - credentials/identity (an explicit allowlist of provider environment keys)
 *   are resolved read-only and injected at launch through the carrier env map;
 * - behaviour/policy stays isolated exactly as before.
 *
 * Resolution order (highest first): an explicit request override (adapter-owned
 * carrier env such as a pinned config dir), project settings, the user settings
 * file, then the process environment. Nothing here ever writes a user file, and
 * no secret value is returned for display: provenance reports key names only.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Where an injected credential came from. */
export type CredentialSource = 'request' | 'config:project' | 'config:user' | 'env' | 'pinned-home' | 'user-home' | 'none';

export type CredentialIsolation = 'inherit' | 'isolated';

/** Read-only provenance summary surfaced by `status` and the install report. */
export interface CredentialReport {
  isolation: CredentialIsolation;
  /** Highest-precedence scope that contributed a credential. */
  source: CredentialSource;
  /** Allowlisted key names that resolved (never their values). */
  keys: string[];
  /** Per-key provenance, key names only. */
  fields?: { key: string; source: CredentialSource }[];
  /** Always true: the report never carries a value. */
  masked: true;
  notes?: string[];
}

export interface ResolvedCredentials {
  report: CredentialReport;
  /** Values to inject into the carrier environment; empty in isolated mode. */
  env: Record<string, string>;
}

const MAX_SETTINGS_BYTES = 1024 * 1024;

/**
 * Explicit isolation switch for tests and multi-tenant hosts. `isolated`
 * restores the pre-D37 semantics (`project,local` only, no user-settings read).
 */
export function credentialIsolation(env: NodeJS.ProcessEnv = process.env): CredentialIsolation {
  const raw = (env.AI4AI_CREDENTIAL_INHERITANCE ?? '').trim().toLowerCase();
  return raw === 'isolated' || raw === 'off' || raw === 'none' || raw === '0' ? 'isolated' : 'inherit';
}

/**
 * Credential allowlist. Only provider connection/identity variables are
 * eligible; behaviour or policy structures are never read at all (we only look
 * at the settings `env` block, never hooks/plugins/permissions/mcpServers/model).
 * Model-name mappings live in the provider env (`ANTHROPIC_MODEL`, the
 * `ANTHROPIC_DEFAULT_*_MODEL` aliases) and are part of the provider route: a
 * gateway that only serves specific model ids cannot be reached without them.
 */
export const CLAUDE_CREDENTIAL_PREFIXES: readonly string[] = ['ANTHROPIC_', 'CLAUDE_CODE_USE_'];

/** Keys that describe a provider connection or identity (allowlisted). */
export function isClaudeCredentialKey(key: string): boolean {
  return CLAUDE_CREDENTIAL_PREFIXES.some(prefix => key.startsWith(prefix));
}

function normalize(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(file, 'utf8');
    if (text.length > MAX_SETTINGS_BYTES) return null;
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

/** Claude settings files, highest precedence first (local project > project > user). */
export function credentialSettingsPaths(workspace: string, configDir?: string, env: NodeJS.ProcessEnv = process.env): { file: string; source: CredentialSource }[] {
  const root = configDir || env.CLAUDE_CONFIG_DIR || env.AI4AI_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return [
    { file: path.join(workspace, '.claude', 'settings.local.json'), source: 'config:project' },
    { file: path.join(workspace, '.claude', 'settings.json'), source: 'config:project' },
    { file: path.join(root, 'settings.json'), source: 'config:user' },
  ];
}

const SOURCE_RANK: Record<CredentialSource, number> = {
  request: 0, 'config:project': 1, 'config:user': 2, env: 3, 'pinned-home': 3, 'user-home': 3, none: 9,
};

/**
 * Resolve the Claude provider env for one executor.
 *
 * `explicit` is the adapter-owned override map (already-trusted carrier knobs);
 * it wins over everything else for the keys it carries. In isolated mode no
 * settings are read and nothing is injected (the carrier keeps today's
 * project,local-only behaviour).
 */
export async function resolveClaudeCredentials(options: {
  workspace: string;
  explicit?: Record<string, string>;
  processEnv?: NodeJS.ProcessEnv;
  isolation?: CredentialIsolation;
}): Promise<ResolvedCredentials> {
  const proc = options.processEnv ?? process.env;
  const isolation = options.isolation ?? credentialIsolation(proc);
  if (isolation === 'isolated') {
    return {
      env: {},
      report: { isolation, source: 'none', keys: [], masked: true, notes: ['credential inheritance is disabled (isolated mode)'] },
    };
  }
  const resolved = new Map<string, { value: string; source: CredentialSource }>();
  for (const [key, value] of Object.entries(options.explicit ?? {})) {
    if (isClaudeCredentialKey(key) && normalize(value)) resolved.set(key, { value: value.trim(), source: 'request' });
  }
  for (const { file, source } of credentialSettingsPaths(options.workspace, undefined, proc)) {
    if (!existsSync(file)) continue;
    const parsed = await readJson(file);
    const env = parsed?.env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) continue;
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (resolved.has(key) || !isClaudeCredentialKey(key)) continue;
      const text = normalize(value);
      if (text) resolved.set(key, { value: text, source });
    }
  }
  for (const key of Object.keys(proc)) {
    if (resolved.has(key) || !isClaudeCredentialKey(key)) continue;
    const text = normalize(proc[key]);
    if (text) resolved.set(key, { value: text, source: 'env' });
  }
  const fields = [...resolved.entries()].map(([key, entry]) => ({ key, source: entry.source }));
  const source = fields.reduce<CredentialSource>((best, field) => (SOURCE_RANK[field.source] < SOURCE_RANK[best] ? field.source : best), 'none');
  return {
    env: Object.fromEntries([...resolved.entries()].map(([key, entry]) => [key, entry.value])),
    report: { isolation, source, keys: fields.map(field => field.key), masked: true, ...(fields.length ? { fields } : {}) },
  };
}

/**
 * Provenance for harnesses whose credentials live in the harness's own home.
 * Codex/OpenCode/DSH read their user home by default; when ai4ai (or the
 * caller) pins an isolated home, the user's credentials are deliberately not
 * consulted. Key names are reported when they can be read from the pinned
 * config without exposing values.
 */
export function harnessCredentialReport(
  harness: 'claude-code' | 'codex' | 'opencode' | 'dsh',
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
): CredentialReport {
  const isolation = credentialIsolation(env);
  if (isolation === 'isolated') {
    return { isolation, source: 'none', keys: [], masked: true, notes: ['credential inheritance is disabled (isolated mode)'] };
  }
  if (harness === 'claude-code') {
    // Synchronous best-effort view for the install doctor; the carrier path uses
    // resolveClaudeCredentials above.
    const keys: { key: string; source: CredentialSource }[] = [];
    return { isolation, source: keys.length ? keys[0]!.source : 'none', keys: keys.map(k => k.key), masked: true, notes: ['run a spawn to resolve the full carrier env'] };
  }
  if (harness === 'codex') {
    const pinned = normalize(env.CODEX_HOME);
    return { isolation, source: pinned ? 'pinned-home' : 'user-home', keys: [], masked: true,
      ...(pinned ? { notes: ['CODEX_HOME is pinned; the user home is not consulted'] } : {}) };
  }
  if (harness === 'opencode') {
    const pinned = normalize(env.OPENCODE_CONFIG);
    return { isolation, source: pinned ? 'pinned-home' : 'user-home', keys: [], masked: true,
      ...(pinned ? { notes: ['OPENCODE_CONFIG is pinned; the user config is not consulted'] } : {}) };
  }
  const pinned = normalize(env.DSH_HOME);
  return { isolation, source: pinned ? 'pinned-home' : 'user-home', keys: [], masked: true,
    ...(pinned ? { notes: ['DSH_HOME is pinned; the user home is not consulted'] } : {}) };
}

/** Mask a credential value for logs: never the full value, at most a short tail. */
export function maskCredential(value: string | undefined): string {
  if (!value) return '<unset>';
  if (value.length <= 4) return '***';
  return '***' + value.slice(-4);
}

/**
 * Persist the provenance report beside the executor. It carries key names and
 * scopes only — never a value — so the file is safe to keep and to quote in
 * evidence.
 */
export async function writeCredentialReport(directory: string, report: CredentialReport): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'credentials.json'), JSON.stringify(report, null, 2) + '\n');
}

/** Read a persisted provenance report; malformed or absent means "unknown". */
export async function readCredentialReport(directory: string): Promise<CredentialReport | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(directory, 'credentials.json'), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.source !== 'string' || !Array.isArray(record.keys)) return null;
    return { ...(record as unknown as CredentialReport), masked: true };
  } catch { return null; }
}
