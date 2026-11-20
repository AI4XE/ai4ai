import type { SourceLabel } from '../contract/states.js';

/**
 * Per-field source ladder.
 *
 * Every status field walks its own sources independently (native > session >
 * env > config). A source that yields a verified value for the field wins; a
 * source that yields nothing for that field is simply skipped. Adapters must
 * build one candidate list per field — never resolve the whole status object
 * from a single source.
 */
export interface FieldCandidate<T> {
  value: T | null | undefined;
  source: SourceLabel;
}

export interface FieldResolution<T> {
  value: T;
  source: SourceLabel;
}

/** First verified value wins; `null`/`undefined` candidates are skipped. */
export function firstVerified<T>(candidates: readonly FieldCandidate<T>[]): FieldResolution<T> | null {
  for (const candidate of candidates) {
    if (candidate.value !== null && candidate.value !== undefined) {
      return { value: candidate.value, source: candidate.source };
    }
  }
  return null;
}

/** Verified token count: a non-negative safe integer, otherwise null. */
export function verifiedTokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Verified context window: a positive safe integer, otherwise null. */
export function verifiedWindow(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Verified non-empty bounded text, otherwise null. */
export function verifiedText(value: unknown, max = 4096): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max && !trimmed.includes('\0') ? trimmed : null;
}

/** Verified auto-compaction threshold: a positive safe integer, otherwise null. */
export function verifiedThreshold(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}
