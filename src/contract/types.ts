import type {
  Availability, ContextVerification, EventKind, EventLevel, EventRole, HandoffMode, HandoffPhase, HarnessId, Isolation, LifecycleState,
  ModelVerification, Operation, Os, PercentSource, PermissionMode, PersistenceMode, ProcessState, SpawnSurface, State, StoredProofMechanism, Surface, SourceLabel, AutoCompactSource, TurnOutcome, FieldStateValue,
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

/**
 * Carrier options for `spawn`. They are persisted with the executor and
 * re-applied to every resumed/revived turn so no option is lost after turn 1.
 */
export interface SpawnOptions {
  /** Default `one-shot`; `persistent` keeps the supervisor (and, for a
   * resident carrier, the harness process) alive between turns in `idle`. */
  persistence?: PersistenceMode;
  /** Carrier surface. Defaults are feasibility-gated per harness. */
  surface?: SpawnSurface;
  /** DSH profile selection; unsupported on other harnesses. */
  profile?: string;
  /** Claude: `bypassPermissions` (default) or `dontAsk` + `allowedTools`. */
  permissionMode?: PermissionMode;
  /** Only meaningful with `permissionMode: "dontAsk"`. */
  allowedTools?: string[];
  /** Tools the carrier must refuse even when installed. */
  disallowedTools?: string[];
  /** Extra environment variables removed before launch (names only). */
  envExclude?: string[];
  /** Extra MCP server names to remove; defaults cannot be re-enabled. */
  mcp?: { deny?: string[] };
  /** Internal origin marker: a rotation successor is seeded with the D29 text and must not adopt it as a delivery. */
  origin?: 'rotation';
}

/** One normalized event (event v1). */
export interface NormalizedEvent {
  /** Global line ordinal inside the executor log. */
  seq: number;
  ts: string;
  kind: EventKind;
  role?: EventRole;
  /** Bounded to 4 KB. */
  text?: string;
  tool?: string;
  phase?: string;
  /** Bounded diagnostic/raw detail (≤4 KB), never a secret. */
  detail?: string;
}

/** Bounded log/event tail with a byte cursor at a line boundary. */
export interface LogTail {
  format: 'events' | 'lines';
  events?: NormalizedEvent[];
  lines?: string[];
  nextCursor: number;
  /** The log was truncated or replaced; the tail starts from the beginning. */
  reset?: boolean;
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
  /** Carrier options for `spawn`; persisted and reused on resumed turns. */
  spawn?: SpawnOptions;
  isolation?: Isolation;
  count?: number;
  timeoutMs?: number;
  reason?: string;
  /** For `status`: return a bounded normalized event tail. */
  logTail?: { tail?: number; cursor?: number; format?: 'events' | 'lines' };
}

export interface ContextSources {
  window?: SourceLabel | null;
  used?: SourceLabel | null;
  percent?: SourceLabel | null;
}

export interface ContextInfo {
  window: number | null;
  /** Prompt occupancy: input + cache read/write, output excluded. */
  used: number | null;
  percent?: number | null;
  percentSource?: PercentSource | null;
  /** Prompt occupancy including native output tokens (qgo-live compatible). */
  /** Per-value provenance; only fields with values are labelled. */
  sources?: ContextSources;
}

export interface AutoCompact {
  tokens: number | null;
  ratio: number | null;
  source: AutoCompactSource;
  /** Whether the harness's auto-compaction feature is enabled for this session. */
  enabled?: boolean | null;
  /** Whether the harness enforces the threshold (native flag when available). */
  enforced?: boolean | null;
  /** The harness's own source label when it maps onto the contract vocabulary. */
  nativeSource?: string | null;
}

/** Structured alternatives a failed handoff offers instead of silently switching. */
export interface HandoffAlternatives {
  modes?: import('./states.js').HandoffMode[];
  message?: string;
}

/** Rotation lineage: predecessor executor/generation and the new lineage depth. */
export interface RotationLineage {
  predecessorExecutorId: string;
  predecessorGeneration: string;
  lineageGeneration: number;
  operationId: string;
  taskHash?: string;
  predecessorSession?: string | null;
  predecessorStopped?: boolean;
  stopExitCode?: number | null;
  stopSignal?: string | null;
  transferredAt?: string;
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
  /** Current adapters produce the first two; `new-session` is legacy read-only. */
  mechanism: StoredProofMechanism;
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
  turns?: number;
  queuedTurns?: number;
  lastTurnAt?: string | null;
  lastTurnOutcome?: TurnOutcome | null;
  lastOperationId?: string | null;
  turnStartedAt?: string | null;
  idleSince?: string | null;
  processState?: ProcessState;
  persistence?: PersistenceMode;
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
  /** Supervisor/child liveness, independent of `state`. */
  processState?: ProcessState;
  processStateReason?: string;
  /** Turn reconciliation surface (durable ledger owned by the supervisor). */
  turns?: number;
  lastOperationId?: string | null;
  lastTurnOutcome?: TurnOutcome | null;
  queuedTurns?: number;
  lastTurnAt?: string | null;
  turnStartedAt?: string | null;
  /** Set while a persistent executor is quiescent between turns. */
  idleSince?: string | null;
  /** Receipt of a queued/started turn (`message`). */
  turnId?: string;
  /** 1-based position in the pending queue; 0 when already claimed. */
  queuePosition?: number;
  /** Persistence model of the executor. */
  persistence?: PersistenceMode;
  /** Native harness version when observed. */
  runtimeVersion?: string | null;
  /** MCP servers copied into the executor after filtering. */
  mcpFiltered?: { names: string[]; count: number };
  /** Bounded log/event tail (status with `logTail`). */
  logTail?: LogTail;
  /** Provenance of the observed state: native > session > unknown. */
  stateSource?: SourceLabel | null;
  /** Terminal process outcome, surfaced when known (null otherwise). */
  exitCode?: number | null;
  signal?: string | null;
  /** Pointer to the persisted session store; content is never returned. */
  session?: SessionPointer | null;
  /** Mechanism actually executed for a handoff (also present on `proof`). */
  mechanism?: StoredProofMechanism;
  /** True only when the native session identity changed (rotation / legacy new-session). */
  sessionChanged?: boolean;
  /** Native source session of a handoff. */
  sourceSession?: string | null;
  /** Native successor session of a handoff (equals source except rotation). */
  successorSession?: string | null;
  sourceGeneration?: string | null;
  successorGeneration?: string | null;
  /** Successor identity for a handoff (requires generation). */
  successor?: Identity;
  /** Rotation executor ids (predecessor is stopped, successor becomes the owner). */
  predecessorExecutorId?: string | null;
  successorExecutorId?: string | null;
  /** Rotation lineage record. */
  lineage?: RotationLineage;
  /** True when the predecessor was confirmed stopped during rotation. */
  predecessorStopped?: boolean | null;
  /** Structured alternatives when a requested mode is unavailable. */
  alternatives?: import('./states.js').HandoffMode[];
  /** Whether the original task continued after a compact (observation only). */
  continued?: boolean | null;
  /** True when an idle executor had no work to continue (not a failure). */
  idleAfter?: boolean | null;
  /** Last error observed for a durable in-flight request. */
  lastError?: ContractError | null;
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
  fieldStates?: Record<string, FieldStateValue>;
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
    /** Legacy union retained for older consumers: `restart|compact` only. */
    modes: HandoffMode[];
    /** Modes available when the caller hands off its own session. */
    self?: { modes: import('./states.js').HandoffMode[] };
    /** Modes available when the caller hands off an owned headless executor. */
    executor?: { modes: import('./states.js').HandoffMode[] };
    modelOverride: Availability;
    reasoningEffortOverride: Availability;
    crossSurface: Availability;
  };
  spawn: {
    availability: Availability;
    lifecycle: 'detached' | 'attached' | 'none';
    maxConcurrent: number;
    isolation: Availability;
    persistenceModes: PersistenceMode[];
    surfaces: SpawnSurface[];
    permissionModes: PermissionMode[];
    mcpFilter: Availability;
  };
  /** Event observation capability of the carrier log. */
  observation: { events: EventLevel };
  status: {
    availability: Availability;
    model: Availability;
    reasoningEffort: Availability;
    context: Availability;
    percentSource: PercentSource | null;
    /** Mandatory cell: whether `autoCompact` is reported truthfully on this surface. */
    autoCompact?: Availability;
  };
  experimental: string[];
  reason: string;
  /** Internal evidence reference; never a public URL. */
  evidence?: string;
}

export interface Issue { path: string; code: string; message: string }
export type Validation<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };
