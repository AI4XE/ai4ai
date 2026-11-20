import type {
  Availability, ContextVerification, HandoffMode, HandoffPhase, HarnessId, Isolation, LifecycleState,
  ModelVerification, Operation, Os, PercentSource, State, Surface, SourceLabel, AutoCompactSource,
} from './states.js';
import type { Feature } from './version.js';

/** Identity supplied exclusively by a trusted native integration, never by tool arguments. */
export interface Identity {
  harness: HarnessId;
  workspace: string;
  surface: 'tui' | 'headless' | 'web';
  session: string;
  generation: string;
  agent: string;
}

/** Caller-settable child policy. Denials return `forbidden`. */
export interface Policy {
  allowSelfHandoff?: boolean;
  allowSpawnChildren?: boolean;
  allowSelfStop?: boolean;
}

/**
 * A contract request. Requests are closed: unknown fields are rejected so that
 * misspelled semantics can never silently mutate a session.
 */
export interface Request {
  requiredFeatures?: Feature[];
  operation: Operation;
  operationId: string;
  /** `"self"` or an owned executor id. */
  target?: string;
  /** `list` filter: only executors created by this owner identity. */
  owner?: string;
  /**
   * Handoff mode. Omitted = `restart` (fresh context with only the caller
   * material and no harness summary). `compact` is an explicit opt-in that
   * keeps a harness-generated history summary alongside the material; it is
   * only available where the capability declaration lists it.
   */
  mode?: HandoffMode;
  /** `preserve` (default) or an explicit cross-surface value. */
  surface?: Surface;
  /** Task seed material for handoff/spawn/message. */
  task?: string;
  model?: string;
  reasoningEffort?: string;
  policy?: Policy;
  isolation?: Isolation;
  count?: number;
  timeoutMs?: number;
  reason?: string;
}

export interface ContextSources {
  window?: SourceLabel | null;
  used?: SourceLabel | null;
  percent?: SourceLabel | null;
}

export interface ContextInfo {
  window: number | null;
  used: number | null;
  percent?: number | null;
  percentSource?: PercentSource | null;
  /** Per-value provenance; only fields with values are labelled. */
  sources?: ContextSources;
}

export interface AutoCompact {
  tokens: number | null;
  ratio: number | null;
  source: AutoCompactSource;
}

export interface Verification {
  model: ModelVerification;
  context: ContextVerification;
}

/** Informational only: skills must not stop or retry because of a notice. */
export interface Notice {
  code: string;
  impact: 'none';
  action_required: false;
  message: string;
}

export interface ContractError {
  code: string;
  message: string;
}

export interface AdoptionProof {
  source: Identity;
  successor: Identity;
  mechanism: 'new-session' | 'surface-replacement';
  nativeEvidence: string;
}

export interface SessionPointer {
  id: string;
  store: string;
  /** Host-local file or SQLite path, or null when unresolvable. */
  path: string | null;
}

export interface ExecutorSummary {
  executorId: string;
  state: LifecycleState;
  sessionId?: string;
  model?: string | null;
  reasoningEffort?: string | null;
  context?: ContextInfo;
  surface: 'tui' | 'headless' | 'web';
  /** Pointer to the persisted session store; content is never returned. */
  session?: SessionPointer | null;
}

/**
 * Unified result. `status` is the operation outcome; `state` is the observed
 * lifecycle (same vocabulary for the session itself and its executors) and
 * `handoff.phase` reports handoff progress separately.
 */
export interface Result {
  operation: Operation;
  operationId: string;
  status: State;
  reason: string;
  durable: boolean;
  target?: string;
  executorId?: string;
  sessionId?: string;
  surfaceChanged?: boolean;
  /** Lifecycle state shared with executors: running | completed | failed | cancelled | unknown. */
  state?: LifecycleState;
  /** Handoff progress, exposed separately from the lifecycle state. */
  handoff?: { phase: HandoffPhase };
  model?: string | null;
  reasoningEffort?: string | null;
  /** Supervisor-observed activity time (native) or the persisted store mtime. */
  lastActivityAt?: string | null;
  lastActivityAtSource?: SourceLabel | null;
  /** Provenance of the observed state: native > session > unknown. */
  stateSource?: SourceLabel | null;
  /** Terminal process outcome, surfaced when known (null otherwise). */
  exitCode?: number | null;
  signal?: string | null;
  /** Pointer to the persisted session store; content is never returned. */
  session?: SessionPointer | null;
  modelVerification: ModelVerification;
  verification: Verification;
  /** Per-field context; present for status/list where observed state is reported. */
  context?: ContextInfo;
  /** Missing fields for the reported values; only meaningful where values are reported. */
  unavailable?: string[];
  notices: Notice[];
  error?: ContractError;
  proof?: AdoptionProof;
  /** Closed per-field state map; `unavailable` is derived from it. */
  fieldStates?: Record<string, 'unsupported' | 'unavailable' | 'unknown'>;
  /** Optional auto-compaction metadata; unknown values stay null with source `unknown`. */
  autoCompact?: AutoCompact;
  capabilities?: CapabilityDeclaration[];
  executors?: ExecutorSummary[];
}

/** Declared capability of one harness on one OS and interface. */
export interface CapabilityDeclaration {
  harness: HarnessId;
  os: Os;
  /** How the harness is driven. */
  interface: 'tui' | 'headless' | 'web';
  operations: Partial<Record<Operation, Availability>>;
  handoff: {
    availability: Availability;
    modes: HandoffMode[];
    modelOverride: Availability;
    reasoningEffortOverride: Availability;
    crossSurface: Availability;
    tmuxFallback: 'off' | 'experimental';
  };
  spawn: {
    availability: Availability;
    lifecycle: 'detached' | 'attached' | 'none';
    maxConcurrent: number;
    isolation: Availability;
  };
  status: {
    availability: Availability;
    model: Availability;
    reasoningEffort: Availability;
    context: Availability;
    percentSource: PercentSource | null;
  };
  experimental: string[];
  reason: string;
  /** Internal evidence reference; never a public URL. */
  evidence?: string;
}

export interface Issue { path: string; code: string; message: string }
export type Validation<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };
