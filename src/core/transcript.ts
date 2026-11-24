/**
 * PARITY-037: opt-in, bounded, redacted transcript reader.
 *
 * The default status/observation path never reads a harness transcript. This
 * module is only called by an explicit CLI request (`ai4ai adoption
 * --transcript`, `ai4ai transcript`). It reuses `sessionPointer` (no duplicate
 * store resolver), reads at most a bounded slice, truncates each entry and
 * redacts credential-shaped strings. Binary stores (OpenCode SQLite, DSH
 * zstd) are reported as unsupported rather than guessed.
 */
import { open, stat } from 'node:fs/promises';
import { sessionPointer } from './session-probe.js';

export interface TranscriptEntry {
  ts?: string;
  role?: string;
  text: string;
  redacted?: boolean;
}

export interface TranscriptTail {
  store: string;
  path: string;
  entries: TranscriptEntry[];
  nextCursor: number;
  reset?: boolean;
  truncated?: boolean;
  reason?: string;
}

const MAX_ENTRY = 4096;
const MAX_BYTES = 1024 * 1024;

const REDACTIONS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /\b(?:sk|oc_sk|oc-|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, replacement: '[redacted-key]' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: 'Bearer [redacted]' },
  { pattern: /\b(?:api[_-]?key|token|secret|password|auth[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi, replacement: '[redacted-secret]' },
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[redacted-email]' },
];

export function redact(value: string): { text: string; redacted: boolean } {
  let text = value;
  let redacted = false;
  for (const rule of REDACTIONS) {
    text = text.replace(rule.pattern, rule.replacement);
    if (text !== value) redacted = true;
  }
  return { text, redacted };
}

const clip = (value: string): { text: string; truncated: boolean } =>
  value.length <= MAX_ENTRY ? { text: value, truncated: false } : { text: `${value.slice(0, MAX_ENTRY)}…`, truncated: true };

/** Extract a bounded, redacted text/role pair from one store row. */
export function entryFromRow(row: unknown): TranscriptEntry | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const record = row as Record<string, unknown>;
  const pickText = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const parts = value.map(item => (item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string'
        ? String((item as Record<string, unknown>).text) : '')).filter(Boolean);
      return parts.length ? parts.join('\n') : undefined;
    }
    return undefined;
  };
  const message = record.message && typeof record.message === 'object' ? record.message as Record<string, unknown> : undefined;
  const text = pickText(record.text) ?? pickText(record.content) ?? (message ? pickText(message.content) : undefined);
  if (!text) return undefined;
  const clipped = clip(text);
  const safe = redact(clipped.text);
  const role = typeof record.role === 'string' ? record.role
    : typeof record.type === 'string' ? record.type
    : message && typeof message.role === 'string' ? String(message.role) : undefined;
  const ts = typeof record.timestamp === 'string' ? record.timestamp
    : typeof record.ts === 'string' ? record.ts : undefined;
  return {
    ...(ts ? { ts } : {}),
    ...(role ? { role } : {}),
    text: safe.text,
    ...(safe.redacted || clipped.truncated ? { redacted: true } : {}),
  };
}

/**
 * Read at most `limit` recent entries from a line-delimited store. `cursor` is
 * a byte offset; the caller reuses `nextCursor` for follow mode.
 */
export async function readTranscriptTail(
  harness: 'claude-code' | 'codex' | 'opencode' | 'dsh',
  workspace: string,
  sessionId: string | undefined,
  options: { limit?: number; cursor?: number; redact?: boolean; codexHome?: string; dshHome?: string; openCodeDb?: string } = {},
): Promise<TranscriptTail | null> {
  const pointer = await sessionPointer(harness, workspace, sessionId, options);
  if (!pointer) return null;
  if (pointer.path === null) return { store: pointer.store, path: '', entries: [], nextCursor: options.cursor ?? 0, reason: 'The session store path could not be resolved' };
  if (pointer.store === 'opencode-db' || pointer.store === 'dsh-session-store') {
    return { store: pointer.store, path: pointer.path, entries: [], nextCursor: 0, reason: `The ${pointer.store} format is binary; the bounded text reader does not decode it` };
  }
  let size: number;
  try { size = (await stat(pointer.path)).size; } catch { return { store: pointer.store, path: pointer.path, entries: [], nextCursor: 0, reason: 'The session store is unreadable' }; }
  const start = Math.max(0, Math.min(options.cursor ?? 0, size));
  const reset = (options.cursor ?? 0) > size;
  const from = reset ? 0 : start;
  const readFrom = Math.max(from, size - MAX_BYTES);
  const handle = await open(pointer.path, 'r').catch(() => null);
  if (!handle) return { store: pointer.store, path: pointer.path, entries: [], nextCursor: from, reason: 'The session store could not be opened' };
  try {
    const length = size - readFrom;
    const buffer = Buffer.alloc(Math.max(1, length));
    await handle.read(buffer, 0, length, readFrom);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    // A slice that starts mid-file may begin mid-line; drop that fragment.
    if (readFrom > 0) lines.shift();
    const entries: TranscriptEntry[] = [];
    let truncated = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row: unknown;
      try { row = JSON.parse(trimmed); } catch { continue; }
      const entry = entryFromRow(row);
      if (!entry) continue;
      if (options.redact === false) entry.text = entry.text.slice(0, MAX_ENTRY);
      if (entry.redacted) truncated = true;
      entries.push(entry);
    }
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    return {
      store: pointer.store, path: pointer.path,
      entries: entries.slice(-limit),
      nextCursor: size,
      ...(reset ? { reset: true } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  } finally { await handle.close(); }
}

/** Search the bounded tail for a marker; the only content use in verify-adoption. */
export async function findMarker(
  harness: 'claude-code' | 'codex' | 'opencode' | 'dsh',
  workspace: string,
  sessionId: string | undefined,
  marker: string,
  options: { limit?: number; codexHome?: string; dshHome?: string; openCodeDb?: string } = {},
): Promise<{ found: boolean; tail: TranscriptTail | null }> {
  const tail = await readTranscriptTail(harness, workspace, sessionId, { ...options, limit: options.limit ?? 200 });
  if (!tail) return { found: false, tail: null };
  const needle = `[[ai4ai:${marker}]]`;
  return { found: tail.entries.some(entry => entry.text.includes(needle) || entry.text.includes(marker)), tail };
}
