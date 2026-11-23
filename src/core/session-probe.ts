import { existsSync } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { dshSelectionValues } from './dsh-selection.js';

/**
 * Read-only probes of persisted harness session stores, used by the per-field
 * source ladder when a live source cannot answer a field.
 *
 * Every probe is identity-bound: it requires both the caller's workspace (the
 * harness project key) and an explicit session id, verifies the store record
 * against both, and never falls back to "the newest file". Bounded,
 * schema-tolerant and read-only: an unexpected shape yields null, never a guess.
 */
export interface SessionUsage {
  used: number | null;
  model: string | null;
  window: number | null;
  reasoningEffort?: string | null;
  /** Completed/started task turns observed in the rollout (Codex only). */
  turns?: number;
  /** Last task event type, used to distinguish a running turn from idle (Codex only). */
  lastEvent?: string | null;
  source: string;
}

const MAX_BYTES = 4 * 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;

/** Session ids come from harness output; reject anything that could escape a store path. */
function safeSessionId(sessionId: unknown): string | null {
  return typeof sessionId === 'string' && SESSION_ID.test(sessionId) && !sessionId.includes('..') ? sessionId : null;
}

function sameWorkspace(left: unknown, right: string): boolean {
  if (typeof left !== 'string') return false;
  const normalize = (value: string): string => value.replace(/[\\/]+$/, '');
  return normalize(left) === normalize(right);
}

/** Decompress concatenated zstd frames (DSH appends one frame per flush). */
function decompressZstdFrames(buffer: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const magic = buffer.readUInt32LE(offset);
    if ((magic & 0xFFFFFFF0) === 0x184D2A50) { // skippable frame
      const size = buffer.readUInt32LE(offset + 4);
      offset += 8 + size;
      continue;
    }
    if (magic !== 0xFD2FB528) break;
    const end = zstdFrameEnd(buffer, offset);
    if (end <= offset || end > buffer.length) break;
    try { parts.push(zlib.zstdDecompressSync(buffer.subarray(offset, end))); }
    catch { break; }
    offset = end;
  }
  if (!parts.length) return zlib.zstdDecompressSync(buffer);
  return Buffer.concat(parts);
}

function zstdFrameEnd(buffer: Buffer, start: number): number {
  let offset = start + 4;
  if (offset >= buffer.length) return -1;
  const descriptor = buffer[offset++]!;
  const fcsFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const checksum = (descriptor >> 2) & 1;
  const dictFlag = descriptor & 3;
  if (!singleSegment) offset += 1;
  offset += [0, 1, 2, 4][dictFlag]!;
  offset += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  for (;;) {
    if (offset + 3 > buffer.length) return -1;
    const header = buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);
    offset += 3;
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >>> 3;
    offset += type === 1 ? 1 : size;
    if (last) break;
  }
  if (checksum) offset += 4;
  return offset;
}

async function readBounded(file: string, max = MAX_BYTES): Promise<string> {
  const info = await stat(file);
  if (info.size > 64 * 1024 * 1024) throw new Error('session file too large');
  const handle = await open(file, 'r');
  try {
    const length = Math.min(info.size, max);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    return buffer.toString('utf8');
  } finally { await handle.close(); }
}

/** Read the head of a file; session metadata lives at the start. */
async function readHeadBounded(file: string, max = 512 * 1024): Promise<string> {
  const info = await stat(file);
  const handle = await open(file, 'r');
  try {
    const length = Math.min(info.size, max);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return buffer.toString('utf8');
  } finally { await handle.close(); }
}

/** A compressed stream needs the whole file; the size is bounded before reading. */
async function readWholeBounded(file: string, max = 32 * 1024 * 1024): Promise<Buffer> {
  const info = await stat(file);
  if (info.size > max) throw new Error('session file too large');
  return readFile(file);
}

function lines(text: string): Record<string, any>[] {
  const rows: Record<string, any>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { /* tolerate a torn tail line */ }
  }
  return rows;
}

function safeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 ? value : null;
}

function escapedDshCwd(cwd: string): string {
  let readable = '';
  let separator = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') { if (!separator) readable += '-'; separator = true; }
    else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) { readable += ch; separator = false; }
    else { readable += '~' + code.toString(16).toUpperCase().padStart(4, '0'); separator = false; }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * Persisted DSH session usage.
 *
 * Double key: the exact escaped-workspace directory plus the explicit session
 * id. The stored directory name equals the session header id (verified across
 * the store), and a `type: "session"` record inside the file, when present,
 * must declare the same id. No basename or "newest" fallback.
 */
export async function dshSessionUsage(workspace: string, sessionId?: string, dshHome?: string): Promise<SessionUsage | null> {
  const id = safeSessionId(sessionId);
  if (!id) return null;
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const directory = path.join(home, 'sessions', escapedDshCwd(workspace));
  if (!existsSync(directory)) return null;
  for (const name of [id]) {
    const candidate = path.join(directory, name);
    const file = path.join(candidate, 'session.v4.jsonl.zstd');
    if (!existsSync(file)) continue;
    try {
      const compressed = await readWholeBounded(file, 32 * 1024 * 1024);
      const rows = lines(decompressZstdFrames(compressed).toString('utf8'));
      const declared = rows.find(row => row.type === 'session' && (typeof row.sessionId === 'string' || typeof row.id === 'string'));
      const declaredId = declared ? safeText(declared.sessionId ?? declared.id) : null;
      if (declaredId !== null && declaredId !== id) continue; // identity mismatch: never read another session
      // Model and effort come from the official DSH projection only: a literal
      // replica of `modelSelectionProjectionDefinition` (pending ?? lastUsed).
      // Title/compaction/context events are excluded, so a title request's
      // effort can never overwrite the request header (AI4AI-DSH-013).
      const selection = dshSelectionValues(rows.map(row => ({
        type: row.type,
        data: row.data && typeof row.data === 'object' ? row.data : row,
      })));
      const model = selection.model;
      const reasoningEffort = selection.reasoningEffort;
      let used: number | null = null;
        let window: number | null = null;
      for (const row of rows) {
        // DSH persists typed events under `data`; tolerate older flat shapes.
        const data = row.data && typeof row.data === 'object' ? row.data as Record<string, unknown> : row;
        const usage = data.usage && typeof data.usage === 'object' ? data.usage as Record<string, unknown>
          : row.usage && typeof row.usage === 'object' ? row.usage as Record<string, unknown> : undefined;
        if (usage && typeof usage.inputTokens === 'number') {
          used = safeInt(usage.inputTokens)! + (safeInt(usage.cacheReadTokens) ?? 0) + (safeInt(usage.cacheWriteTokens) ?? 0);
        }
        const contextWindow = safeInt(data.contextWindow)
          ?? safeInt((data.context as Record<string, unknown> | undefined)?.contextWindow)
          ?? safeInt(row.contextWindow);
        if (contextWindow) window = contextWindow;
      }
      if (used !== null || model !== null || window !== null) {
        return { used, model, window, reasoningEffort, source: 'dsh-session-store' };
      }
    } catch { /* schema change or unreadable store: try the next canonical name */ }
  }
  return null;
}

/**
 * Persisted Claude transcript usage (input + cache creation + cache read).
 *
 * Double key: the project directory derived from the workspace plus the exact
 * session id. There is no "newest transcript" fallback: without a session id
 * the probe returns null.
 */
export async function claudeTranscriptUsage(workspace: string, sessionId?: string): Promise<SessionUsage | null> {
  const id = safeSessionId(sessionId);
  if (!id) return null;
  const root = process.env.CLAUDE_CONFIG_DIR || process.env.AI4AI_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const escaped = workspace.replace(/[^A-Za-z0-9]/g, '-');
  const file = path.join(root, 'projects', escaped, `${id}.jsonl`);
  if (!existsSync(file)) return null;
  try {
    const rows = lines(await readBounded(file));
    let used: number | null = null;
    let model: string | null = null;
    let window: number | null = null;
    let reasoningEffort: string | null = null;
    for (const row of rows) {
      const message = row.message && typeof row.message === 'object' ? row.message as Record<string, any> : undefined;
      const usage = message?.usage ?? row.usage;
      if (usage && typeof usage === 'object') {
        const input = safeInt(usage.input_tokens);
        if (input !== null) {
          used = input + (safeInt(usage.cache_creation_input_tokens) ?? 0) + (safeInt(usage.cache_read_input_tokens) ?? 0);
        }
      }
      if (typeof message?.model === 'string') model = message.model;
      if (typeof row.effort === 'string') reasoningEffort = row.effort;
      const modelUsage = row.modelUsage as Record<string, { contextWindow?: unknown }> | undefined;
      if (modelUsage && typeof modelUsage === 'object') {
        for (const value of Object.values(modelUsage)) {
          const candidate = safeInt(value?.contextWindow);
          if (candidate) { window = candidate; break; }
        }
      }
    }
    if (used !== null || model !== null || window !== null) {
      return { used, model, window, reasoningEffort, source: 'claude-transcript' };
    }
  } catch { /* schema change: no fallback */ }
  return null;
}

/**
 * Persisted Codex rollout sessions (~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl).
 *
 * Double key: the rollout must declare the requested session id and the same
 * workspace cwd. Only the last week of date directories is scanned, bounded, so
 * a status read never walks the whole store. `used` uses Codex's `input_tokens`
 * (cached input is a subset, never added again).
 */
export async function codexSessionUsage(workspace: string, sessionId?: string, codexHome?: string): Promise<SessionUsage | null> {
  const id = safeSessionId(sessionId);
  if (!id) return null;
  const root = path.join(codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  if (!existsSync(root)) return null;
  const file = await findCodexRollout(root, id);
  if (!file) return null;
  try {
    const head = lines(await readHeadBounded(file));
    const meta = head.find(row => row.type === 'session_meta')?.payload as Record<string, unknown> | undefined;
    const declaredId = safeText(meta?.session_id ?? meta?.id);
    if (declaredId !== null && declaredId !== id) return null;
    if (meta && typeof meta.cwd === 'string' && !sameWorkspace(meta.cwd, workspace)) return null;
    const rows = lines(await readBounded(file, 8 * 1024 * 1024));
    let used: number | null = null;
    let model: string | null = null;
    let window: number | null = null;
    let reasoningEffort: string | null = null;
    let turns = 0;
    let lastEvent: string | null = null;
    for (const row of rows) {
      if (row.type === 'turn_context' && row.payload && typeof row.payload === 'object') {
        const payload = row.payload as Record<string, unknown>;
        if (typeof payload.cwd === 'string' && !sameWorkspace(payload.cwd, workspace)) continue;
        if (typeof payload.model === 'string') model = payload.model;
        if (typeof payload.effort === 'string') reasoningEffort = payload.effort;
      }
      if (row.type === 'event_msg' && row.payload && typeof row.payload === 'object') {
        const payload = row.payload as Record<string, any>;
        if (payload.type === 'token_count' && payload.info && typeof payload.info === 'object') {
          const last = payload.info.last_token_usage as Record<string, unknown> | undefined;
          const input = safeInt(last?.input_tokens);
          if (input !== null) {
            used = input;
          }
          const candidate = safeInt(payload.info.model_context_window);
          if (candidate) window = candidate;
        }
        if (payload.type === 'task_started') {
          turns += 1;
          lastEvent = 'task_started';
          const candidate = safeInt(payload.model_context_window);
          if (candidate) window = candidate;
        }
        if (payload.type === 'task_complete') lastEvent = 'task_complete';
      }
    }
    if (used !== null || model !== null || window !== null || reasoningEffort !== null) {
      return { used, model, window, reasoningEffort, turns, lastEvent, source: 'codex-session-store' };
    }
  } catch { /* schema change: no fallback */ }
  return null;
}

/** Scan the last week of Codex date directories for a rollout file carrying the session id. */
async function findCodexRollout(root: string, sessionId: string): Promise<string | null> {
  const days = 7;
  for (let offset = 0; offset < days; offset++) {
    const date = new Date(Date.now() - offset * 86_400_000);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const directory = path.join(root, year, month, day);
    if (!existsSync(directory)) continue;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const match = entries.find(entry => entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(sessionId));
    if (match) return path.join(directory, match.name);
  }
  return null;
}

export interface OpenCodeUsage extends SessionUsage {
  provider?: string | null;
  /** Whether the model catalog declares reasoning support (null when not stated). */
  reasoningSupported?: boolean | null;
}

/**
 * Persisted OpenCode session usage and model, plus the context window from
 * OpenCode's own models.dev catalog cache.
 *
 * Double key: the session row's `directory` must equal the caller workspace and
 * the row must be the explicit session id. `used` comes from the last assistant
 * message's tokens (input + cache read/write) so it matches the live log
 * semantics; the cumulative session counters are not used. Read-only SQLite
 * (node:sqlite); any failure degrades to null.
 */
export async function openCodeSessionUsage(workspace: string, sessionId?: string, dbPath?: string): Promise<OpenCodeUsage | null> {
  const id = safeSessionId(sessionId);
  if (!id) return null;
  const file = dbPath || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db');
  if (!existsSync(file)) return null;
  let db: { prepare: (sql: string) => { get: (...params: unknown[]) => Record<string, unknown> | undefined; all: (...params: unknown[]) => Record<string, unknown>[] }; close: () => void } | null = null;
  try {
    const sqlite = await import('node:sqlite');
    db = new (sqlite as unknown as { DatabaseSync: new (path: string, options: { readOnly: boolean }) => any }).DatabaseSync(file, { readOnly: true });
    // 2.x keeps sessions in `session_v2`; 1.x uses `session` with flat token columns.
    let row: Record<string, unknown> | undefined;
    let schema: 'v2' | 'v1' = 'v2';
    try {
      row = db!.prepare('SELECT directory, model FROM session_v2 WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    } catch { row = undefined; /* the 1.x schema has no session_v2 table */ }
    if (!row) {
      try {
        const legacy = db!.prepare('SELECT directory, model, tokens_input, tokens_cache_read, tokens_cache_write FROM session WHERE id = ?').get(id);
        if (legacy) { row = legacy; schema = 'v1'; }
      } catch { /* not the 1.x schema either */ }
    }
    if (!row || !sameWorkspace(row.directory, workspace)) return null;
    let model: string | null = null;
    let provider: string | null = null;
    let variant: string | null = null;
    try {
      const parsed = JSON.parse(String(row.model)) as { id?: unknown; providerID?: unknown; variant?: unknown };
      model = safeText(parsed.id);
      provider = safeText(parsed.providerID);
      variant = safeText(parsed.variant);
    } catch { /* older or malformed model column */ }
    let used: number | null = null;
    if (schema === 'v2') {
      // A status call can run while the newest assistant row is still streaming
      // (tokens null). Walk back to the most recent completed message that carries
      // token figures instead of stopping at the in-progress row.
      const messageRows = db!.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 20").all(id);
      for (const message of messageRows) {
        if (!message || typeof message.data !== 'string') continue;
        try {
          const data = JSON.parse(message.data) as { tokens?: Record<string, any> };
          const tokens = data.tokens;
          const input = safeInt(tokens?.input);
          if (input === null) continue;
          const cache = tokens?.cache && typeof tokens.cache === 'object' ? tokens.cache as Record<string, unknown> : {};
          used = input + (safeInt(cache.read) ?? 0) + (safeInt(cache.write) ?? 0);
          break;
        } catch { /* malformed message */ }
      }
    } else {
      const input = safeInt(row.tokens_input);
      if (input !== null) used = input + (safeInt(row.tokens_cache_read) ?? 0) + (safeInt(row.tokens_cache_write) ?? 0);
    }
    let window: number | null = null;
    let reasoningSupported: boolean | null = null;
    if (provider && model) {
      try {
        const catalogRow = db!.prepare('SELECT value FROM kv WHERE key = ?').get('models-dev:v2:catalog');
        if (catalogRow && typeof catalogRow.value === 'string') {
          const catalog = JSON.parse(String(JSON.parse(catalogRow.value).body)) as Record<string, any>;
          const entry = catalog?.[provider]?.models?.[model];
          const limit = entry?.limit?.context;
          window = safeInt(limit) || null;
          const capability = entry?.capabilities?.reasoning;
          if (typeof capability === 'boolean') reasoningSupported = capability;
          else if (capability && typeof capability === 'object' && typeof capability.supported === 'boolean') reasoningSupported = capability.supported;
        }
      } catch { /* 1.x or an unexpected catalog cache shape */ }
    }
    // OpenCode records the selected variant (`default` = the provider default).
    // It is the harness's own value for the reasoning-effort selection; a model
    // the catalog declares non-reasoning has no effort to report.
    const reasoningEffort = reasoningSupported === false ? null : variant ?? (model ? 'default' : null);
    return { used, model, window, reasoningEffort, reasoningSupported, provider, source: 'opencode-session-store' };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

export type SessionStore = 'claude-transcript' | 'codex-rollout' | 'opencode-db' | 'dsh-session-store';

/** Pointer to where a session is persisted; contents are never read here. */
export interface SessionPointer {
  id: string;
  store: SessionStore;
  /** Host-local file or SQLite path, or null when it cannot be resolved. */
  path: string | null;
}

/**
 * Resolve the persisted store pointer for a session. This is a pointer only:
 * no transcript content, summary or extra operation is produced.
 */
export async function sessionPointer(
  harness: 'claude-code' | 'codex' | 'opencode' | 'dsh',
  workspace: string,
  sessionId?: string,
  options: { codexHome?: string; dshHome?: string; openCodeDb?: string } = {},
): Promise<SessionPointer | null> {
  const id = safeSessionId(sessionId);
  if (!id) return null;
  if (harness === 'claude-code') {
    const root = process.env.CLAUDE_CONFIG_DIR || process.env.AI4AI_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const file = path.join(root, 'projects', workspace.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
    return { id, store: 'claude-transcript', path: existsSync(file) ? file : null };
  }
  if (harness === 'codex') {
    const root = path.join(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
    const file = existsSync(root) ? await findCodexRollout(root, id) : null;
    return { id, store: 'codex-rollout', path: file };
  }
  if (harness === 'opencode') {
    const file = options.openCodeDb || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db');
    return { id, store: 'opencode-db', path: existsSync(file) ? file : null };
  }
  const home = options.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const file = path.join(home, 'sessions', escapedDshCwd(workspace), id, 'session.v4.jsonl.zstd');
  return { id, store: 'dsh-session-store', path: existsSync(file) ? file : null };
}

/** Persisted-session activity fallback: the store file's last modification time. */
export async function sessionActivity(storePath: string | null): Promise<string | null> {
  if (!storePath) return null;
  try {
    const info = await stat(storePath);
    return info.mtime.toISOString();
  } catch { return null; }
}
