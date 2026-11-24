import type { AdoptionProof, Identity } from '../contract/types.js';
import type { NativeOutcome } from '../adapters/types.js';
import { LEGACY_PROOF_MECHANISM, PROOF_MECHANISMS, SAME_SESSION_MECHANISMS, sessionChangedOf, type HandoffMode, type ProofMechanism, type StoredProofMechanism } from '../contract/states.js';

/**
 * Handoff finalization shared by every adapter, journal and watcher.
 *
 * A same-session handoff never changes the native session identity: `restart`
 * replaces the context in place and `compact` adds a native summary in place.
 * The only mechanisms that change it are the explicit `session-rotation` and
 * the legacy `new-session`; a `session-rotation` result is valid only when it
 * reports `sessionChanged: true`. `new-session` stays readable for journals
 * written by older releases and is never produced again.
 */

export const isProducedMechanism = (value: unknown): value is ProofMechanism =>
  typeof value === 'string' && (PROOF_MECHANISMS as readonly string[]).includes(value);

export const isSameSessionMechanism = (value: unknown): boolean =>
  typeof value === 'string' && (SAME_SESSION_MECHANISMS as readonly string[]).includes(value);

export const isLegacyMechanism = (value: unknown): boolean => value === LEGACY_PROOF_MECHANISM;

/** `sessionChanged` for a proof/result mechanism. */
export { sessionChangedOf };

/** Old records stored only the mode; this reproduces the mechanism they implied. */
export function legacyProofMechanism(mode: HandoffMode | undefined): StoredProofMechanism {
  // Before 0.0.5, restart replaced the session (`/clear` or a new thread) and
  // compact replaced the surface in place. Rotation did not exist then.
  return mode === 'compact' ? 'surface-replacement' : LEGACY_PROOF_MECHANISM;
}

/** Build adoption proof that is same-session by construction. */
export function sameSessionProof(
  source: Identity,
  generation: string,
  mechanism: ProofMechanism,
  nativeEvidence: string,
): AdoptionProof {
  return { source, successor: { ...source, generation }, mechanism, nativeEvidence };
}

export interface HandoffFinalizeInput {
  /** Proof carried by the outcome, if any. */
  proof?: AdoptionProof;
  /** Explicit field on the durable record; absent on pre-0.0.5 records. */
  proofMechanism?: StoredProofMechanism;
  /** Mode stored by a pre-0.0.5 record. */
  mode?: HandoffMode;
}

export interface HandoffFinalizeResult {
  /** True when the record predates the explicit proofMechanism field. */
  legacy: boolean;
  mechanism?: StoredProofMechanism | undefined;
  error?: string | undefined;
}

/**
 * Check a completion point. Adapters that build their own proof call this (or
 * `sameSessionProof`) before returning; journals/watchers call it when applying
 * a record so an old pending record is not mislabelled and a new one cannot
 * silently change the session.
 */
export function finalizeHandoff(input: HandoffFinalizeInput): HandoffFinalizeResult {
  const explicit = input.proofMechanism;
  const mechanism = explicit ?? input.proof?.mechanism ?? (input.mode ? legacyProofMechanism(input.mode) : undefined);
  const legacy = explicit === undefined;
  if (!input.proof) return { legacy, ...(mechanism ? { mechanism } : {}) };
  if (isSameSessionMechanism(mechanism)
    && input.proof.source.session !== input.proof.successor.session) {
    return {
      legacy, mechanism,
      error: `A ${mechanism} handoff must preserve the native session identity (${input.proof.source.session} -> ${input.proof.successor.session}); use spawn for a new session`,
    };
  }
  if (mechanism === LEGACY_PROOF_MECHANISM && isProducedMechanism(input.proof.mechanism)) {
    // A record that says "legacy" cannot carry a newly produced mechanism;
    // that would relabel old behaviour as a current guarantee.
    return { legacy, mechanism, error: 'Legacy handoff records must keep their historical proof mechanism' };
  }
  return { legacy, mechanism };
}

/** Fail-closed normalization: a mismatched proof becomes a structured failure. */
export function guardHandoffOutcome(
  outcome: NativeOutcome,
  input: HandoffFinalizeInput,
): NativeOutcome {
  const finalized = finalizeHandoff({ ...input, ...(outcome.proof ? { proof: outcome.proof } : {}) });
  if (!finalized.error) return outcome;
  return {
    status: 'failed',
    reason: finalized.error,
    durable: outcome.durable ?? false,
    state: 'failed',
    unavailable: ['handoff.native'],
    error: { code: 'handoff-session-mismatch', message: finalized.error },
  };
}
