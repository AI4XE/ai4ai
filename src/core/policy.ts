import type { Policy } from '../contract/types.js';

export const DEFAULT_POLICY: Required<Policy> = Object.freeze({
  allowSelfHandoff: true,
  allowSpawnChildren: false,
  allowSelfStop: true,
});

/**
 * A root session has no parent grant; it may spawn children. The restrictive
 * `allowSpawnChildren: false` default applies to executors it creates.
 */
export const ROOT_POLICY: Required<Policy> = Object.freeze({
  allowSelfHandoff: true,
  allowSpawnChildren: true,
  allowSelfStop: true,
});

export function normalizePolicy(policy: Policy | undefined): Required<Policy> {
  return { ...DEFAULT_POLICY, ...(policy ?? {}) };
}

export type PolicyAction = 'handoff' | 'spawn' | 'cancel';

/**
 * Runtime-enforced child policy. A denial is `forbidden`; it is distinct from
 * `unauthorized` (identity/ownership) and `authorization-required` (harness).
 */
export function checkPolicy(policy: Required<Policy>, action: PolicyAction): { ok: true } | { ok: false; reason: string } {
  if (action === 'handoff' && !policy.allowSelfHandoff) return { ok: false, reason: 'Policy denies self-handoff for this executor' };
  if (action === 'spawn' && !policy.allowSpawnChildren) return { ok: false, reason: 'Policy denies spawning child executors' };
  if (action === 'cancel' && !policy.allowSelfStop) return { ok: false, reason: 'Policy denies self-stop for this executor' };
  return { ok: true };
}
