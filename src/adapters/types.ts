import type {
  AdoptionProof, AutoCompact, CapabilityDeclaration, ContextInfo, ContractError, Notice, Request, Result,
} from '../contract/types.js';
import type { HarnessId, LifecycleState, Os, State } from '../contract/states.js';
import type { Identity } from '../contract/types.js';
import type { Ai4aiStore } from '../core/store.js';

/** Result fields an adapter may supply; the dispatcher fills honest defaults. */
export interface NativeOutcome {
  status: State;
  reason: string;
  durable?: boolean;
  state?: LifecycleState;
  handoff?: Result['handoff'];
  executorId?: string;
  sessionId?: string;
  surfaceChanged?: boolean;
  model?: string | null;
  reasoningEffort?: string | null;
  lastActivityAt?: string | null;
  lastActivityAtSource?: import('../contract/states.js').SourceLabel | null;
  stateSource?: import('../contract/states.js').SourceLabel | null;
  exitCode?: number | null;
  signal?: string | null;
  session?: Result['session'];
  modelVerification?: Result['modelVerification'];
  verification?: Result['verification'];
  context?: ContextInfo;
  autoCompact?: AutoCompact;
  fieldStates?: Record<string, 'unsupported' | 'unavailable' | 'unknown'>;
  unavailable?: string[];
  notices?: Notice[];
  error?: ContractError;
  proof?: AdoptionProof;
}

export interface AdapterContext {
  identity: Identity;
  store: Ai4aiStore;
  home: string;
  /** Trusted executor binding supplied by the spawn carrier environment. */
  executorId?: string;
  signal?: AbortSignal;
}

/**
 * A harness adapter. Implementations must use real native mechanisms and must
 * never claim a surface or lifecycle they have not been verified to provide.
 */
export interface Adapter {
  readonly harness: HarnessId;
  /** Declarations for every surface the adapter targets on this OS. */
  capabilities(os: Os): CapabilityDeclaration[];
  handoff(request: Request, ctx: AdapterContext): Promise<NativeOutcome>;
  /**
   * Re-query a pending handoff the adapter or its detached watcher owns.
   * Returning `undefined` means "no newer observation"; a terminal outcome is
   * written back in place so the same operationId eventually completes instead
   * of returning a stale pending result forever.
   */
  reconcileHandoff?(request: Request, ctx: AdapterContext): Promise<NativeOutcome | undefined>;
  spawn(request: Request, ctx: AdapterContext): Promise<NativeOutcome>;
  status(request: Request, ctx: AdapterContext): Promise<NativeOutcome>;
  message(request: Request, ctx: AdapterContext): Promise<NativeOutcome>;
  cancel(request: Request, ctx: AdapterContext): Promise<NativeOutcome>;
}
