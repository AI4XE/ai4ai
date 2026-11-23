import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { LogTail, NormalizedEvent } from '../contract/types.js';
import type { EventKind, EventRole, HarnessId } from '../contract/states.js';
import type { LogLine } from '../adapters/executors.js';

/**
 * Normalized event stream (event v1).
 *
 * `log.ndjson` is the supervisor's raw carrier log (`{ts, stream, line}`). This
 * module maps it at read time; the file format is not reinterpreted, so older
 * executors remain readable and unmapped lines are preserved with a bounded
 * raw detail rather than dropped. Harness transcripts are never read.
 *
 * The cursor is a byte offset at a line boundary. A cursor beyond the current
 * file size means the log was truncated or replaced: the tail restarts at 0
 * and reports `reset: true` so callers can re-anchor instead of silently
 * losing events.
 */

const MAX_TEXT = 4096;
const truncate = (value: unknown, max = MAX_TEXT): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\0/g, '').trim();
  if (!text) return undefined;
  return text.length <= max ? text : text.slice(0, max) + '…';
};

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

interface EventExtra {
  role?: EventRole | undefined;
  text?: string | undefined;
  tool?: string | undefined;
  phase?: string | undefined;
  detail?: string | undefined;
}
const event = (seq: number, ts: string, kind: EventKind, extra: EventExtra = {}): NormalizedEvent => {
  const value: NormalizedEvent = { seq, ts, kind };
  if (extra.role) value.role = extra.role;
  if (extra.text) value.text = extra.text;
  if (extra.tool) value.tool = extra.tool;
  if (extra.phase) value.phase = extra.phase;
  if (extra.detail) value.detail = extra.detail;
  return value;
};

/** Extract text from an Anthropic-style content block list. */
function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return truncate(content);
  if (!Array.isArray(content)) {
    const block = asObject(content);
    return truncate(block?.text);
  }
  const parts: string[] = [];
  for (const entry of content) {
    const block = asObject(entry);
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'tool_result') parts.push(typeof block.content === 'string' ? block.content : '');
  }
  return truncate(parts.filter(Boolean).join('\n'));
}

function firstTool(content: unknown): { tool?: string | undefined; phase?: string | undefined } {
  if (!Array.isArray(content)) return {};
  for (const entry of content) {
    const block = asObject(entry);
    if (block?.type === 'tool_use' && typeof block.name === 'string') return { tool: truncate(block.name, 256), phase: 'call' };
    if (block?.type === 'tool_result') return { phase: 'result' };
  }
  return {};
}

function mapClaudeLine(seq: number, ts: string, value: Record<string, unknown>): NormalizedEvent {
  const type = typeof value.type === 'string' ? value.type : '';
  if (type === 'system') {
    return event(seq, ts, 'system', {
      role: 'system',
      phase: truncate(value.subtype, 64),
      ...(typeof value.model === 'string' ? { detail: truncate(`model=${value.model}`, 256) } : {}),
    });
  }
  if (type === 'assistant' || type === 'user') {
    const message = asObject(value.message) ?? value;
    const content = message.content;
    const role: EventRole = type === 'assistant' ? 'assistant' : 'user';
    const tool = firstTool(content);
    if (tool.tool) return event(seq, ts, 'tool', { role, tool: tool.tool, phase: tool.phase });
    if (tool.phase === 'result') return event(seq, ts, 'tool', { role: 'tool', phase: 'result' });
    const text = contentText(content);
    return event(seq, ts, 'message', { role, ...(text ? { text } : {}) });
  }
  if (type === 'result') {
    const failed = value.is_error === true || (typeof value.subtype === 'string' && value.subtype !== 'success');
    return event(seq, ts, failed ? 'error' : 'result', {
      phase: truncate(value.subtype, 64),
      ...(failed ? { detail: truncate(contentText(value.result) ?? 'result reported an error') } : {}),
    });
  }
  if (type === 'stream_event') return event(seq, ts, 'progress', { detail: truncate(value.event && asObject(value.event)?.type, 64) });
  return event(seq, ts, 'unmapped', { detail: truncate(JSON.stringify(value)) });
}

function mapCodexLine(seq: number, ts: string, value: Record<string, unknown>): NormalizedEvent {
  if (value.ai4ai !== 'codex-event') {
    if (typeof value.session_id === 'string') return event(seq, ts, 'system', { phase: 'session' });
    return event(seq, ts, 'unmapped', { detail: truncate(JSON.stringify(value)) });
  }
  const method = typeof value.method === 'string' ? value.method : '';
  const params = asObject(value.params) ?? {};
  if (method === 'item/agentMessage/delta') return event(seq, ts, 'message', { role: 'assistant', text: truncate(params.delta) });
  if (method.startsWith('item/') && method.includes('commandExecution')) return event(seq, ts, 'tool', { role: 'tool', tool: 'commandExecution', phase: method });
  if (method.startsWith('item/')) return event(seq, ts, 'tool', { role: 'tool', tool: truncate(method.slice('item/'.length), 256), phase: method });
  if (method === 'turn/completed') {
    const turn = asObject(params.turn);
    const failed = turn?.status === 'failed';
    return event(seq, ts, failed ? 'error' : 'result', { phase: truncate(turn?.status, 64), ...(failed ? { detail: truncate(asObject(turn?.error)?.message) } : {}) });
  }
  if (method === 'turn/failed' || method === 'error') return event(seq, ts, 'error', { detail: truncate(asObject(params.error)?.message ?? method) });
  if (method === 'thread/tokenUsage/updated') return event(seq, ts, 'progress', { phase: 'tokenUsage' });
  if (method.startsWith('thread/')) return event(seq, ts, 'system', { phase: truncate(method, 64) });
  return event(seq, ts, 'unmapped', { detail: truncate(JSON.stringify(value)) });
}

function mapOpenCodeLine(seq: number, ts: string, value: Record<string, unknown>): NormalizedEvent {
  const type = typeof value.type === 'string' ? value.type : '';
  const part = asObject(value.part) ?? {};
  if (type === 'text') return event(seq, ts, 'message', { role: 'assistant', text: truncate(part.text) });
  if (type === 'reasoning') return event(seq, ts, 'progress', { text: truncate(part.text) });
  if (type === 'tool_use' || type === 'tool') {
    const tool = asObject(part.tool) ?? part;
    return event(seq, ts, 'tool', { role: 'tool', tool: truncate(tool.name ?? tool.tool, 256), phase: truncate(value.type, 32) });
  }
  if (type === 'step_start') return event(seq, ts, 'progress', { phase: 'step_start' });
  if (type === 'step_finish' || type === 'result' || type === 'done') return event(seq, ts, 'result', { phase: truncate(type, 32) });
  if (type === 'error') return event(seq, ts, 'error', { detail: truncate(asObject(value.error)?.message ?? JSON.stringify(value.error ?? value)) });
  if (typeof value.sessionID === 'string' || typeof value.session_id === 'string') return event(seq, ts, 'system', { phase: 'session' });
  return event(seq, ts, 'unmapped', { detail: truncate(JSON.stringify(value)) });
}

function mapDshLine(seq: number, ts: string, value: Record<string, unknown>): NormalizedEvent {
  const type = typeof value.type === 'string' ? value.type : '';
  if (type === 'status') {
    const phase = typeof value.phase === 'string' ? value.phase : '';
    const failed = phase.includes('error') || phase.includes('failed');
    return event(seq, ts, failed ? 'error' : phase === 'step_end' ? 'result' : 'progress', { phase: truncate(phase, 64) });
  }
  if (type === 'assistant/message') {
    return event(seq, ts, 'message', { role: 'assistant', text: truncate(contentText(value.content ?? asObject(value.data)?.content)) });
  }
  if (type === 'user/message' && asObject(value.source)?.kind === 'ai4ai-coordination') return event(seq, ts, 'system', { phase: 'ai4ai' });
  if (type === 'user/message') return event(seq, ts, 'message', { role: 'user', text: truncate(contentText(value.content ?? asObject(value.data)?.content)) });
  if (type.includes('tool')) return event(seq, ts, 'tool', { role: 'tool', tool: truncate(value.name, 256), phase: truncate(type, 64) });
  if (type === 'error') return event(seq, ts, 'error', { detail: truncate(asObject(value.error)?.message ?? JSON.stringify(value)) });
  return event(seq, ts, 'unmapped', { detail: truncate(JSON.stringify(value)) });
}

/** Map one raw supervisor log line into a normalized event. */
export function mapLogLine(entry: LogLine, seq: number, harness: HarnessId): NormalizedEvent {
  const ts = entry.ts || new Date(0).toISOString();
  const line = entry.line ?? '';
  if (entry.stream === 'stderr') return event(seq, ts, 'error', { detail: truncate(line) });
  if (entry.stream === 'error') return event(seq, ts, 'error', { detail: truncate(line) });
  if (entry.stream === 'driver' || entry.stream === 'supervisor') return event(seq, ts, 'system', { phase: truncate(line, 64) });
  let value: Record<string, unknown> | undefined;
  try { value = asObject(JSON.parse(line)); } catch { value = undefined; }
  if (!value) return event(seq, ts, 'unmapped', { detail: truncate(line) });
  switch (harness) {
    case 'claude-code': return mapClaudeLine(seq, ts, value);
    case 'codex': return mapCodexLine(seq, ts, value);
    case 'opencode': return mapOpenCodeLine(seq, ts, value);
    case 'dsh': return mapDshLine(seq, ts, value);
    default: return event(seq, ts, 'unmapped', { detail: truncate(line) });
  }
}

const logPath = (home: string, executorId: string): string => path.join(home, 'executors', executorId, 'log.ndjson');

/** Count newlines in `buffer[0..end)`; the line ordinal base for a cursor. */
function newlineCount(buffer: Buffer, end: number): number {
  let count = 0;
  for (let index = 0; index < end; index++) if (buffer[index] === 0x0a) count++;
  return count;
}

export interface ReadEventsOptions {
  cursor?: number;
  tail?: number;
  format?: 'events' | 'lines';
}

/**
 * Read a bounded tail from a line-aligned byte cursor. Only complete lines are
 * returned; the next cursor points after the last complete line so a partial
 * write is re-read on the next poll instead of being lost.
 */
export async function readEventTail(home: string, executorId: string, harness: HarnessId, options: ReadEventsOptions = {}): Promise<LogTail> {
  const format = options.format ?? 'events';
  const tail = Math.min(1000, Math.max(1, options.tail ?? 50));
  const requested = Math.max(0, options.cursor ?? 0);
  const file = logPath(home, executorId);
  let buffer: Buffer;
  try { buffer = await readFile(file); }
  catch { return { format, nextCursor: requested, ...(format === 'events' ? { events: [] } : { lines: [] }) }; }
  let reset = false;
  let cursor = requested;
  if (cursor > buffer.length) { cursor = 0; reset = true; }
  let end = buffer.length;
  if (end > cursor && buffer[end - 1] !== 0x0a) {
    const lastNewline = buffer.lastIndexOf(0x0a, end - 1);
    end = lastNewline + 1;
  }
  if (end <= cursor) return { format, nextCursor: cursor, reset, ...(format === 'events' ? { events: [] } : { lines: [] }) };
  const base = newlineCount(buffer, cursor);
  const rawLines = buffer.subarray(cursor, end).toString('utf8').split('\n').filter(line => line.length > 0);
  const start = Math.max(0, rawLines.length - tail);
  const selected = rawLines.slice(start);
  if (format === 'lines') {
    return { format, lines: selected.map(line => line.length <= MAX_TEXT ? line : line.slice(0, MAX_TEXT) + '…'), nextCursor: end, reset };
  }
  const events: NormalizedEvent[] = [];
  selected.forEach((line, index) => {
    let entry: LogLine;
    try { entry = JSON.parse(line) as LogLine; }
    catch { entry = { ts: '', stream: 'unknown', line }; }
    if (typeof entry?.line !== 'string') entry = { ts: '', stream: 'unknown', line };
    events.push(mapLogLine(entry, base + start + index + 1, harness));
  });
  return { format, events, nextCursor: end, reset };
}

/** Size of the log currently on disk (0 when absent). */
export async function logSize(home: string, executorId: string): Promise<number> {
  try { return (await stat(logPath(home, executorId))).size; } catch { return 0; }
}
