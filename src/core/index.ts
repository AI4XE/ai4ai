export { Ai4aiStore, StoreError } from './store.js';
export type { ExecutorRecord, OperationRecord, CarrierInfo } from './store.js';
export { fingerprint, sameIdentity } from './fingerprint.js';
export { activeRecord } from './journal.js';
export { DEFAULT_POLICY, normalizePolicy, checkPolicy } from './policy.js';
export { execute, currentOs, newExecutorId, ownedBy } from './operations.js';
export type { OperationsOptions } from './operations.js';
export {
  finalizeHandoff, guardHandoffOutcome, isLegacyMechanism, isProducedMechanism,
  legacyProofMechanism, sameSessionProof,
} from './handoff.js';
export type { HandoffFinalizeInput, HandoffFinalizeResult } from './handoff.js';
