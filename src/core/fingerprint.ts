import { createHash } from 'node:crypto';
import type { Identity, Request } from '../contract/types.js';

/** Full identity equality; every component is part of the native binding. */
export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.harness === b.harness && a.workspace === b.workspace && a.surface === b.surface
    && a.session === b.session && a.generation === b.generation && a.agent === b.agent;
}

const policyKey = (policy: Request['policy']): unknown => policy === undefined ? null : {
  allowSelfHandoff: policy.allowSelfHandoff ?? null,
  allowSpawnChildren: policy.allowSpawnChildren ?? null,
  allowSelfStop: policy.allowSelfStop ?? null,
};

/**
 * Idempotency fingerprint over every semantic request field. Property order of
 * caller input is irrelevant; changing any field changes the fingerprint.
 */
export function fingerprint(request: Request): string {
  return createHash('sha256').update(JSON.stringify([
    request.operation,
    request.operationId,
    request.target ?? null,
    request.owner ?? null,
    request.mode ?? null,
    request.surface ?? 'preserve',
    request.task ?? null,
    request.model ?? null,
    request.reasoningEffort ?? null,
    policyKey(request.policy),
    request.isolation ?? 'inherit',
    request.count ?? 1,
    request.timeoutMs ?? null,
    request.reason ?? null,
    [...(request.requiredFeatures ?? [])].sort(),
  ])).digest('hex');
}
