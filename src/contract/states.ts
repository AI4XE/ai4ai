/** Operations accepted by the contract. `stop` is an alias of `cancel`. */
export const OPERATIONS = [
  'handoff', 'spawn', 'status', 'message', 'cancel', 'stop', 'finish', 'list', 'capabilities',
] as const;
export type Operation = typeof OPERATIONS[number];

/**
 * Result state machine (single source of truth).
 * Schema, validator and tests must agree with this list.
 */
export const STATES = [
  'accepted', 'pending', 'applied', 'completed', 'cancelled',
  'unsupported', 'authorization-required', 'unauthorized', 'forbidden',
  'failed', 'unknown',
] as const;
export type State = typeof STATES[number];

/** Terminal states never transition again. */
export const TERMINAL_STATES: readonly State[] = ['completed', 'cancelled', 'unsupported', 'unauthorized', 'forbidden', 'failed'];

/**
 * Lifecycle vocabulary shared by a session and its executors. `idle` is a
 * first-class, non-terminal state: the supervisor and (for resident carriers)
 * the harness process are alive, no turn is running, and queued turns may
 * exist. It is never a completion signal; use `finish` to complete an executor
 * and `stop` to cancel it.
 */
export const LIFECYCLE_STATES = ['running', 'idle', 'completed', 'failed', 'cancelled', 'unknown'] as const;
export type LifecycleState = typeof LIFECYCLE_STATES[number];

/** Process liveness, independent of the lifecycle state. */
export const PROCESS_STATES = ['alive', 'orphaned', 'dead', 'unknown'] as const;
export type ProcessState = typeof PROCESS_STATES[number];

/** Persistence model requested for a spawned executor. */
export const PERSISTENCE_MODES = ['one-shot', 'persistent'] as const;
export type PersistenceMode = typeof PERSISTENCE_MODES[number];
export const DEFAULT_PERSISTENCE: PersistenceMode = 'one-shot';

/** Surfaces a spawn carrier can use. */
export const SPAWN_SURFACES = ['headless', 'web'] as const;
export type SpawnSurface = typeof SPAWN_SURFACES[number];

/** Permission modes a carrier can accept; interactive modes are refused. */
export const PERMISSION_MODES = ['bypassPermissions', 'dontAsk'] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];

/** Event observation level a harness declares. */
export const EVENT_LEVELS = ['normalized', 'raw', 'unsupported'] as const;
export type EventLevel = typeof EVENT_LEVELS[number];

/** Normalized event kinds (event v1). */
export const EVENT_KINDS = ['message', 'tool', 'result', 'error', 'progress', 'system', 'unmapped'] as const;
export type EventKind = typeof EVENT_KINDS[number];
export const EVENT_ROLES = ['user', 'assistant', 'system', 'tool'] as const;
export type EventRole = typeof EVENT_ROLES[number];

/** Outcome of one executor turn, reported by the supervisor ledger. */
export const TURN_OUTCOMES = ['completed', 'failed', 'cancelled'] as const;
export type TurnOutcome = typeof TURN_OUTCOMES[number];

/** Native handoff phases exposed separately from the lifecycle state. */
export const HANDOFF_PHASES = ['pending', 'scheduled', 'applied', 'completed'] as const;
export type HandoffPhase = typeof HANDOFF_PHASES[number];

/**
 * Map a native handoff journal phase into the public `state` and `handoff`
 * fields. `appliedIsTerminal` distinguishes adapters whose native "applied"
 * already means the replacement is complete (Codex, DSH) from those where the
 * fresh window is ready but task delivery is still pending (Claude, OpenCode).
 * Terminal failures/cancellations carry no handoff phase: the lifecycle state
 * expresses the outcome.
 */
export function handoffOutcome(phase: string, options: { appliedIsTerminal?: boolean } = {}): { state: LifecycleState; handoff?: { phase: HandoffPhase } } {
  switch (phase) {
    case 'intent':
    case 'pending':
      return { state: 'running', handoff: { phase: 'pending' } };
    case 'scheduled':
    case 'applying':
      return { state: 'running', handoff: { phase: 'scheduled' } };
    case 'applied':
      return options.appliedIsTerminal
        ? { state: 'completed', handoff: { phase: 'applied' } }
        : { state: 'running', handoff: { phase: 'applied' } };
    case 'completed':
      return { state: 'completed', handoff: { phase: 'completed' } };
    case 'cancelled':
    case 'stopped':
      return { state: 'cancelled' };
    case 'failed':
    case 'blocked':
      return { state: 'failed' };
    default:
      return { state: 'unknown' };
  }
}

export const HANDOFF_MODES = ['compact', 'restart'] as const;
export type HandoffMode = typeof HANDOFF_MODES[number];

/**
 * Proof mechanisms a current adapter may produce. `surface-replacement` is the
 * zero-summary, same-session restart; `native-compaction` is the explicit
 * compact opt-in where the harness summarized history. `new-session` is a
 * legacy read-only value: historical journals may contain it, but no adapter
 * produces it because a handoff must never change the session identity.
 */
export const PROOF_MECHANISMS = ['surface-replacement', 'native-compaction'] as const;
export type ProofMechanism = typeof PROOF_MECHANISMS[number];
export const LEGACY_PROOF_MECHANISM = 'new-session' as const;
export type StoredProofMechanism = ProofMechanism | typeof LEGACY_PROOF_MECHANISM;

/**
 * `restart` is the default handoff mode: the new context contains only the
 * caller-supplied material, with no harness summary. `compact` remains an
 * explicit opt-in for users who want history compaction plus new material.
 */
export const DEFAULT_HANDOFF_MODE: HandoffMode = 'restart';
export const handoffMode = (mode: HandoffMode | undefined): HandoffMode => mode ?? DEFAULT_HANDOFF_MODE;

/** Interaction surfaces a handoff can preserve or explicitly switch to. */
export const SURFACES = ['preserve', 'tui', 'headless', 'web'] as const;
export type Surface = typeof SURFACES[number];

export const ISOLATION = ['inherit', 'isolated'] as const;
export type Isolation = typeof ISOLATION[number];

export const MODEL_VERIFICATION = ['verified', 'reported', 'configured-only', 'unknown'] as const;
export type ModelVerification = typeof MODEL_VERIFICATION[number];

export const CONTEXT_VERIFICATION = ['native', 'derived', 'reported'] as const;
export type ContextVerification = typeof CONTEXT_VERIFICATION[number];

export const PERCENT_SOURCE = ['native', 'derived'] as const;
export type PercentSource = typeof PERCENT_SOURCE[number];

/** Closed vocabulary for per-field state reporting. */
export const FIELD_STATE_KEYS = [
  'model', 'reasoningEffort', 'context.window', 'context.used', 'context.percent',
  'context.autoCompact',
] as const;
export type FieldStateKey = typeof FIELD_STATE_KEYS[number];
export const FIELD_STATE_VALUES = ['unsupported', 'unavailable', 'unknown', 'disabled'] as const;

/**
 * Provenance labels for a value obtained through the source ladder.
 * `config:project` / `config:user` name the scope when the harness documents a
 * precedence between them; a bare `config` is only used when the scope is not
 * determinable.
 */
export const SOURCE_LABELS = ['native', 'session', 'env', 'config', 'config:project', 'config:user', 'derived', 'unknown'] as const;
export type SourceLabel = typeof SOURCE_LABELS[number];
export const AUTOCOMPACT_SOURCES = ['native', 'session', 'env', 'config', 'config:project', 'config:user', 'default', 'unknown'] as const;
export type AutoCompactSource = typeof AUTOCOMPACT_SOURCES[number];
export type FieldStateValue = typeof FIELD_STATE_VALUES[number];

export const AVAILABILITY = ['supported', 'limited', 'unsupported', 'not-tested'] as const;
export type Availability = typeof AVAILABILITY[number];

export const HARNESSES = ['claude-code', 'codex', 'opencode', 'dsh'] as const;
export type HarnessId = typeof HARNESSES[number];

export const OSES = ['linux', 'windows', 'darwin'] as const;
export type Os = typeof OSES[number];
