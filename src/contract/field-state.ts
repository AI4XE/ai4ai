import type { FieldStateValue } from './states.js';

/**
 * Classify a failed field read into the closed field-state vocabulary.
 *
 * The contract never carries raw HTTP codes or reasons; adapters classify from
 * API semantics and keep the diagnostic in logs/evidence. Timeouts and
 * transient failures are retryable (`unavailable`), `unsupported` only when the
 * platform/field is known absent, and `unknown` when we cannot determine it
 * (including our own parse/validation defects).
 */
export function fieldStateForError(error: unknown, options: { knownAbsent?: boolean } = {}): FieldStateValue {
  const record = (error ?? {}) as Record<string, unknown>;
  const nested = (record.response ?? record.cause ?? {}) as Record<string, unknown>;
  const status = firstNumber(record.status, record.statusCode, nested.status, nested.statusCode);
  const code = String(record.code ?? nested.code ?? '').toUpperCase();
  if (status === 501) return 'unsupported';
  if (status === 404) return options.knownAbsent ? 'unsupported' : 'unavailable';
  if (status === 400) return 'unknown';
  if (status === 401 || status === 403) return 'unavailable';
  if (status === 408 || status === 429) return 'unavailable';
  if (status !== undefined && status >= 500) return 'unavailable';
  if (['ETIMEDOUT', 'ETIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ABORT_ERR', 'TIMEOUT'].includes(code)) return 'unavailable';
  if (['PARSE', 'SYNTAXERROR', 'INVALID_JSON'].includes(code)) return 'unknown';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'unavailable';
  return 'unknown';
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  }
  return undefined;
}
