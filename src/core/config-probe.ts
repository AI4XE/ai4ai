import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Read-only configuration probes for the per-field source ladder.
 *
 * Rules (config resolution safety):
 * - mirror the harness's documented precedence; never invent one;
 * - report the effective scope (`config:project` / `config:user`);
 * - read an explicit allowlist of keys only, never log or return other values;
 * - schema-tolerant and read-only; an unreadable or unexpected file degrades to
 *   "no value" instead of a guess.
 */
export type ConfigSource = 'config' | 'config:project' | 'config:user';

export interface ConfigField<T> {
  value: T;
  source: ConfigSource;
}

export interface CodexConfig {
  model: ConfigField<string> | null;
  reasoningEffort: ConfigField<string> | null;
  window: ConfigField<number> | null;
  autoCompact: ConfigField<number> | null;
}

const MAX_CONFIG_BYTES = 1024 * 1024;

/** Bounded UTF-8 read; larger or unreadable files are treated as absent. */
async function readConfig(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return null;
    return await readFile(file, 'utf8');
  } catch { return null; }
}

function normalizePath(value: string): string {
  return value.replace(/[\\/]+$/, '');
}

/** Remove a trailing `#` comment that is outside quoted strings. */
function stripComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const ch = line[index]!;
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, index);
  }
  return line;
}

/** Parse a simple TOML scalar (basic/literal string or integer); anything else is ignored. */
function parseScalar(raw: string): string | number | null {
  const value = raw.trim();
  if (value.startsWith('"')) {
    let out = '';
    let escaped = false;
    for (let index = 1; index < value.length; index++) {
      const ch = value[index]!;
      if (escaped) {
        out += ch === 'n' ? '\n' : ch === 't' ? '\t' : ch;
        escaped = false;
      } else if (ch === '\\') escaped = true;
      else if (ch === '"') return out;
      else out += ch;
    }
    return null;
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end > 0 ? value.slice(1, end) : null;
  }
  if (/^[+-]?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

interface TomlLite {
  top: Map<string, string | number>;
  /** Table name → key/value pairs. Only what the parser saw. */
  tables: Map<string, Map<string, string | number>>;
}

/** Minimal, schema-tolerant TOML reader: top-level scalars plus named tables. */
function parseTomlLite(text: string): TomlLite {
  const top = new Map<string, string | number>();
  const tables = new Map<string, Map<string, string | number>>();
  let current: Map<string, string | number> = top;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith('[[')) { current = new Map(); continue; } // array tables are not used by the allowlist
    if (line.startsWith('[')) {
      const end = line.indexOf(']');
      if (end < 0) { current = new Map(); continue; }
      const name = line.slice(1, end).trim();
      current = tables.get(name) ?? new Map();
      tables.set(name, current);
      continue;
    }
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue;
    const value = parseScalar(line.slice(equals + 1));
    if (value !== null) current.set(key, value);
  }
  return { top, tables };
}

/** `[projects."<path>"]` / `[projects.'<path>']` → normalized path → trust_level. */
function trustedProjects(toml: TomlLite): Set<string> {
  const trusted = new Set<string>();
  for (const [name, table] of toml.tables) {
    const match = /^projects\s*\.\s*"((?:[^"\\]|\\.)*)"$/.exec(name) ?? /^projects\s*\.\s*'([^']*)'$/.exec(name);
    if (!match) continue;
    const project = normalizePath(match[1]!.replace(/\\(.)/g, '$1'));
    if (table.get('trust_level') === 'trusted') trusted.add(project);
  }
  return trusted;
}

function asText(value: string | number | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asPositive(value: string | number | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Codex configuration: `$CODEX_HOME/config.toml` (user) and the trusted
 * project's `.codex/config.toml`.
 *
 * Verified precedence: the harness itself reports "Overridden by project
 * config", and project config applies to trusted repositories only (the trust
 * entry lives in the user config's `[projects."<path>"]` table). Project values
 * are therefore used only when that trust record is present; otherwise the user
 * config is the effective scope.
 */
export async function probeCodexConfig(workspace: string, codexHome?: string): Promise<CodexConfig> {
  const empty: CodexConfig = { model: null, reasoningEffort: null, window: null, autoCompact: null };
  const home = codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const userText = await readConfig(path.join(home, 'config.toml'));
  if (userText === null) return empty;
  let user: TomlLite;
  try { user = parseTomlLite(userText); } catch { return empty; }
  let project: TomlLite | null = null;
  if (trustedProjects(user).has(normalizePath(workspace))) {
    const projectText = await readConfig(path.join(workspace, '.codex', 'config.toml'));
    if (projectText !== null) { try { project = parseTomlLite(projectText); } catch { project = null; } }
  }
  const pick = <T>(key: string, read: (value: string | number | undefined) => T | null): ConfigField<T> | null => {
    const fromProject = project ? read(project.top.get(key)) : null;
    if (fromProject !== null) return { value: fromProject, source: 'config:project' };
    const fromUser = read(user.top.get(key));
    return fromUser !== null ? { value: fromUser, source: 'config:user' } : null;
  };
  return {
    model: pick('model', asText),
    reasoningEffort: pick('model_reasoning_effort', asText),
    window: pick('model_context_window', asPositive),
    autoCompact: pick('model_auto_compact_token_limit', asPositive),
  };
}

/** Files the Claude settings probe reads, highest precedence first. */
export function claudeSettingsPaths(workspace: string, configDir?: string): { file: string; source: ConfigSource }[] {
  const root = configDir || process.env.CLAUDE_CONFIG_DIR || process.env.AI4AI_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return [
    { file: path.join(workspace, '.claude', 'settings.local.json'), source: 'config:project' },
    { file: path.join(workspace, '.claude', 'settings.json'), source: 'config:project' },
    { file: path.join(root, 'settings.json'), source: 'config:user' },
  ];
}

export interface ClaudeSettingsValues {
  /** Values from the settings `env` blocks, highest precedence first. */
  env: { value: string; source: ConfigSource }[];
  /** Top-level `effortLevel` (low|medium|high|xhigh), highest precedence first. */
  effortLevel: { value: string; source: ConfigSource } | null;
  /** Top-level `autoCompactWindow` in tokens, highest precedence first. */
  autoCompactWindow: { value: number; source: ConfigSource } | null;
}

/**
 * Claude Code settings. Verified precedence: managed > flag > local project >
 * project > user; here we read local project > project > user (managed policy is
 * not consulted). The settings `env` block is applied over the inherited
 * process environment by the harness, so for the same key the settings value is
 * the effective one. Only the allowlisted keys are extracted; nothing else is
 * read or returned.
 */
export async function probeClaudeSettings(workspace: string, configDir?: string, keys: readonly string[] = []): Promise<ClaudeSettingsValues> {
  const found: { value: string; source: ConfigSource }[] = [];
  let effortLevel: { value: string; source: ConfigSource } | null = null;
  let autoCompactWindow: { value: number; source: ConfigSource } | null = null;
  for (const { file, source } of claudeSettingsPaths(workspace, configDir)) {
    if (!existsSync(file)) continue;
    const text = await readConfig(file);
    if (text === null) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    const record = parsed as Record<string, unknown>;
    const env = record.env;
    if (keys.length && env && typeof env === 'object') {
      for (const key of keys) {
        const value = (env as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.trim().length > 0) found.push({ value: value.trim(), source });
      }
    }
    const level = record.effortLevel;
    if (!effortLevel && typeof level === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(level)) effortLevel = { value: level, source };
    const window = record.autoCompactWindow;
    if (!autoCompactWindow && typeof window === 'number' && Number.isSafeInteger(window) && window > 0) autoCompactWindow = { value: window, source };
  }
  return { env: found, effortLevel, autoCompactWindow };
}

/** Read one allowlisted string value from the harness process environment. */
export function envValue(name: string): string | null {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// OpenCode configuration (opencode.json / .jsonc).
// Verified precedence (lowest → highest): global filesystem config, explicit
// OPENCODE_CONFIG, discovered direct project files (farthest ancestor → cwd),
// discovered `.opencode` files, then inline OPENCODE_CONFIG_CONTENT. Later
// documents win for scalars. Only the allowlisted keys are read.
// ---------------------------------------------------------------------------
function stripJsonc(text: string): string {
  let out = '';
  let quote = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index]!;
    if (quote) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') { quote = true; out += ch; continue; }
    if (ch === '/' && text[index + 1] === '/') { while (index < text.length && text[index] !== '\n') index++; out += '\n'; continue; }
    if (ch === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
      index++;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function parseJsonc(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(stripJsonc(text)) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export interface OpenCodeConfig {
  model: ConfigField<string> | null;
  reasoningEffort: ConfigField<string> | null;
  window: ConfigField<number> | null;
  autoCompact: ConfigField<{ tokens: number | null; ratio: number | null }> | null;
}

/** Discovered config files, lowest precedence first. */
export function openCodeConfigPaths(workspace: string): { file: string; source: 'config:user' | 'config:project' | 'config' }[] {
  const paths: { file: string; source: 'config:user' | 'config:project' | 'config' }[] = [];
  const globalDir = process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode');
  for (const name of ['opencode.json', 'opencode.jsonc']) paths.push({ file: path.join(globalDir, name), source: 'config:user' });
  const explicit = process.env.OPENCODE_CONFIG;
  if (explicit) paths.push({ file: explicit, source: 'config' });
  const ancestors: string[] = [];
  let current = normalizePath(workspace);
  for (;;) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const ordered = ancestors.reverse(); // farthest ancestor first
  for (const directory of ordered) for (const name of ['opencode.json', 'opencode.jsonc']) paths.push({ file: path.join(directory, name), source: 'config:project' });
  for (const directory of ordered) for (const name of ['opencode.json', 'opencode.jsonc']) paths.push({ file: path.join(directory, '.opencode', name), source: 'config:project' });
  return paths;
}

function mergeOpenCode(documents: { value: Record<string, unknown>; source: 'config:user' | 'config:project' | 'config' }[]): OpenCodeConfig {
  let model: { value: string; source: 'config:user' | 'config:project' | 'config' } | null = null;
  let reasoningEffort: { value: string; source: 'config:user' | 'config:project' | 'config' } | null = null;
  let buffer: { value: string | number; source: 'config:user' | 'config:project' | 'config' } | null = null;
  const limits = new Map<string, { value: number; source: 'config:user' | 'config:project' | 'config' }>();
  for (const { value, source } of documents) {
    const selection = value.model;
    if (typeof selection === 'string' && selection.trim()) {
      // "provider/model#variant"
      const [target, variant] = selection.trim().split('#');
      model = { value: target!, source };
      reasoningEffort = variant && variant !== 'default' ? { value: variant, source } : null;
    } else if (selection && typeof selection === 'object') {
      const record = selection as Record<string, unknown>;
      const provider = typeof record.providerID === 'string' ? record.providerID : null;
      const id = typeof record.model === 'string' ? record.model : null;
      if (provider && id) model = { value: `${provider}/${id}`, source };
      const variant = typeof record.variant === 'string' && record.variant !== 'default' ? record.variant : null;
      reasoningEffort = variant ? { value: variant, source } : null;
    }
    for (const block of [value.providers, value.provider]) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      for (const [provider, providerValue] of Object.entries(block as Record<string, unknown>)) {
        if (!providerValue || typeof providerValue !== 'object') continue;
        const models = (providerValue as Record<string, unknown>).models;
        if (!models || typeof models !== 'object') continue;
        for (const [id, modelValue] of Object.entries(models as Record<string, unknown>)) {
          const limit = modelValue && typeof modelValue === 'object' ? (modelValue as Record<string, unknown>).limit : undefined;
          const context = limit && typeof limit === 'object' ? (limit as Record<string, unknown>).context : undefined;
          if (typeof context === 'number' && Number.isSafeInteger(context) && context > 0) limits.set(`${provider}/${id}`, { value: context, source });
        }
      }
    }
    const compaction = value.compaction && typeof value.compaction === 'object' ? value.compaction as Record<string, unknown> : undefined;
    const candidate = compaction?.buffer;
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0) buffer = { value: candidate, source };
    else if (typeof candidate === 'string' && /^\d{1,2}%$/.test(candidate)) {
      const percent = Number(candidate.slice(0, -1));
      if (percent >= 1 && percent <= 99) buffer = { value: candidate, source };
    }
  }
  const window = model ? limits.get(model.value) ?? null : null;
  let autoCompact: OpenCodeConfig['autoCompact'] = null;
  if (buffer) {
    if (typeof buffer.value === 'string') {
      const ratio = Math.round((1 - Number(buffer.value.slice(0, -1)) / 100) * 1000) / 1000;
      autoCompact = { value: { tokens: window ? Math.round(window.value * ratio) : null, ratio }, source: buffer.source };
    } else {
      const tokens = window ? Math.max(1, window.value - buffer.value) : null;
      const ratio = tokens !== null && window ? Math.round((tokens / window.value) * 1000) / 1000 : null;
      autoCompact = { value: { tokens, ratio }, source: buffer.source };
    }
  }
  return {
    model: model ? { value: model.value, source: model.source } : null,
    reasoningEffort: reasoningEffort ? { value: reasoningEffort.value, source: reasoningEffort.source } : null,
    window: window ? { value: window.value, source: window.source } : null,
    autoCompact: autoCompact ?? null,
  };
}

/** Read OpenCode config documents in documented precedence order. */
export async function probeOpenCodeConfig(workspace: string): Promise<OpenCodeConfig> {
  const documents: { value: Record<string, unknown>; source: 'config:user' | 'config:project' | 'config' }[] = [];
  for (const { file, source } of openCodeConfigPaths(workspace)) {
    const text = await readConfig(file);
    if (text === null) continue;
    const value = parseJsonc(text);
    if (value) documents.push({ value, source });
  }
  const inline = process.env.OPENCODE_CONFIG_CONTENT;
  if (inline) {
    const value = parseJsonc(inline);
    if (value) documents.push({ value, source: 'config' });
  }
  return mergeOpenCode(documents);
}

// ---------------------------------------------------------------------------
// YAML subset reader for DSH patch files (zero runtime dependencies).
// Supports the block-mapping / block-sequence / scalar subset DSH emits:
// `- id: x`, nested `key:` maps, `key: value` scalars, and `#` comments.
// Anchors, flow collections and multi-line scalars are ignored (schema-
// tolerant: an unsupported construct yields no value, never a guess).
// ---------------------------------------------------------------------------
type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

function stripYamlComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const ch = line[index]!;
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, index);
  }
  return line;
}

function yamlScalar(raw: string): YamlValue {
  const value = raw.trim();
  if (!value) return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (/^-?\d+$/.test(value)) { const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : null; }
  if (/^-?\d+\.\d+$/.test(value)) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
  if (value === 'true' || value === 'false') return value === 'true';
  if (value === 'null' || value === '~') return null;
  if (value.startsWith('[') || value.startsWith('{')) return null; // flow collections unsupported
  return value;
}

const YAML_KEY = /^([A-Za-z0-9_./-]+):(?:\s+(.*))?$/;

export function parseYamlSubset(text: string): YamlValue {
  interface Frame { indent: number; container: any; parent?: { container: any; key: string } }
  const lines = text.split(/\r?\n/).map(stripYamlComment).filter(line => line.trim().length > 0);
  let root: any = {};
  const rootHolder = { value: root };
  if (lines.length > 0 && lines[0]!.trim().startsWith('- ')) { root = []; rootHolder.value = root; }
  const stack: Frame[] = [{ indent: -1, container: root }];
  for (const raw of lines) {
    const indent = raw.length - raw.trimStart().length;
    const content = raw.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();
    const top = stack[stack.length - 1]!;
    if (content.startsWith('- ')) {
      if (!Array.isArray(top.container)) {
        const replacement: any[] = [];
        if (top.parent) top.parent.container[top.parent.key] = replacement;
        else rootHolder.value = replacement;
        top.container = replacement;
      }
      const item: any = {};
      top.container.push(item);
      const frame: Frame = { indent, container: item };
      stack.push(frame);
      const match = YAML_KEY.exec(content.slice(2).trim());
      if (!match) continue;
      if (match[2] === undefined || match[2].trim() === '') {
        const child: any = {};
        item[match[1]!] = child;
        stack.push({ indent, container: child, parent: { container: item, key: match[1]! } });
      } else item[match[1]!] = yamlScalar(match[2]);
      continue;
    }
    const match = YAML_KEY.exec(content);
    if (!match) continue;
    if (match[2] === undefined || match[2].trim() === '') {
      const child: any = {};
      top.container[match[1]!] = child;
      stack.push({ indent, container: child, parent: { container: top.container, key: match[1]! } });
    } else top.container[match[1]!] = yamlScalar(match[2]);
  }
  return rootHolder.value;
}

export interface DshConfig {
  model: ConfigField<string> | null;
  reasoningEffort: ConfigField<string> | null;
  window: ConfigField<number> | null;
  autoCompactRatio: ConfigField<number> | null;
}

function asObject(value: YamlValue | undefined): Record<string, YamlValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, YamlValue> : null;
}

/** Find a patch entry by id and return its `config` mapping. */
function patchConfig(root: YamlValue, id: string): Record<string, YamlValue> | null {
  if (!Array.isArray(root)) return null;
  for (const entry of root) {
    const record = asObject(entry);
    if (record?.id === id) return asObject(record.config);
  }
  return null;
}

/**
 * DSH configuration, read from the headless profile patch
 * (`$DSH_HOME/profiles/headless/cordis.patch.yml`) — the profile the detached
 * carrier runs. DSH's config is a user-scope home; scope labels are
 * `config:user`. `model-selection.patch.yml` is a runtime `--patch` overlay the
 * carrier does not pass, so it is deliberately not consulted. Only the
 * allowlisted keys are read.
 */
export async function probeDshConfig(dshHome?: string): Promise<DshConfig> {
  const empty: DshConfig = { model: null, reasoningEffort: null, window: null, autoCompactRatio: null };
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const text = await readConfig(path.join(home, 'profiles', 'headless', 'cordis.patch.yml'));
  if (text === null) return empty;
  let root: YamlValue;
  try { root = parseYamlSubset(text); } catch { return empty; }
  const agent = patchConfig(root, 'agent-default-model');
  const compaction = patchConfig(root, 'compaction-basic');
  const model = typeof agent?.model === 'string' && agent.model.trim() ? agent.model.trim() : null;
  const reasoningEffort = typeof agent?.reasoningEffort === 'string' && agent.reasoningEffort.trim() ? agent.reasoningEffort.trim() : null;
  const provider = typeof agent?.provider === 'string' ? agent.provider.trim() : null;
  let window: number | null = null;
  const catalog = patchConfig(root, 'llm-pi-ai');
  const providers = asObject(catalog?.providers ?? undefined);
  const route = provider && providers ? asObject(providers[provider]) : null;
  if (route && model) {
    const models = Array.isArray(route.models) ? route.models : [];
    for (const entry of models) {
      const record = asObject(entry);
      if (record?.id === model && typeof record.contextWindow === 'number' && Number.isSafeInteger(record.contextWindow) && record.contextWindow > 0) {
        window = record.contextWindow;
      }
    }
    if (window === null && typeof route.defaultContextWindow === 'number' && Number.isSafeInteger(route.defaultContextWindow) && route.defaultContextWindow > 0) {
      window = route.defaultContextWindow;
    }
  }
  const ratio = typeof compaction?.thresholdRatio === 'number' && compaction.thresholdRatio > 0 && compaction.thresholdRatio <= 1
    ? compaction.thresholdRatio : null;
  return {
    model: model ? { value: model, source: 'config:user' } : null,
    reasoningEffort: reasoningEffort ? { value: reasoningEffort, source: 'config:user' } : null,
    window: window !== null ? { value: window, source: 'config:user' } : null,
    autoCompactRatio: ratio !== null ? { value: ratio, source: 'config:user' } : null,
  };
}
