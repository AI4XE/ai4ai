import { FEATURES } from './version.js';
import {
  AVAILABILITY, CONTEXT_VERIFICATION, EVENT_KINDS, EVENT_LEVELS, EVENT_ROLES, HANDOFF_MODES, HANDOFF_PHASES, HARNESSES, ISOLATION, LIFECYCLE_STATES,
  AUTOCOMPACT_SOURCES, FIELD_STATE_KEYS, FIELD_STATE_VALUES, LEGACY_HANDOFF_MODES, LEGACY_PROOF_MECHANISM, PERMISSION_MODES, PERSISTENCE_MODES, PROCESS_STATES, PROOF_MECHANISMS,
  SOURCE_LABELS, MODEL_VERIFICATION, OPERATIONS, OSES, PERCENT_SOURCE, SPAWN_SURFACES, STATES, SURFACES, TURN_OUTCOMES,
} from './states.js';

const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' } as const;
const boundedText = { type: 'string', minLength: 1, maxLength: 16384 } as const;
const shortText = { type: 'string', minLength: 1, maxLength: 4096 } as const;
const nonNegative = { type: 'integer', minimum: 0 } as const;

const operationEnum = { enum: [...OPERATIONS] } as const;

const stringList = (description: string, maxItems = 64) => ({
  type: 'array', maxItems, uniqueItems: true, items: shortText, description,
}) as const;

/** Carrier options persisted with a spawned executor and reused on resume. */
const spawnOptionsSchema = {
  type: 'object', additionalProperties: false,
  description: 'Carrier options for a spawned executor; persisted and re-applied to every resumed or revived turn.',
  properties: {
    persistence: { enum: [...PERSISTENCE_MODES], description: 'one-shot (default) exits after the turn queue drains; persistent stays alive in idle between turns.' },
    surface: { enum: [...SPAWN_SURFACES], description: 'Carrier surface; defaults are feasibility-gated per harness.' },
    profile: { ...shortText, description: 'DSH profile name; unsupported on other harnesses.' },
    permissionMode: { enum: [...PERMISSION_MODES], description: 'Claude permission mode; interactive modes are refused.' },
    allowedTools: stringList('Tool allow-list used with permissionMode dontAsk.'),
    disallowedTools: stringList('Tools the carrier must refuse even when installed (for example Skill(gclear)).'),
    envExclude: stringList('Extra environment variable names removed before launch; the built-in defaults are always removed.'),
    mcp: {
      type: 'object', additionalProperties: false,
      description: 'Extra MCP servers to deny; default message-class denials cannot be re-enabled.',
      properties: { deny: stringList('Additional MCP server names to remove (case-insensitive).') },
    },
    origin: { enum: ['rotation'], description: 'Internal: marks a rotation successor seeded with the handoff delivery text.' },
  },
} as const;

const logTailSchema = {
  type: 'object', additionalProperties: false,
  description: 'Bounded log tail for status; events are normalized (event v1), lines are raw log lines.',
  properties: {
    tail: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum number of entries (default 50).' },
    cursor: { type: 'integer', minimum: 0, description: 'Byte cursor returned by a previous call; at a line boundary.' },
    format: { enum: ['events', 'lines'], description: 'events (default) or raw lines.' },
  },
} as const;

/** Every input property carries a description: the AI must not guess semantics. */
export const REQUEST_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'AI4AI request',
  description: 'One AI4AI session operation. Use status to query this session\'s context window, tokens used, usage percent, model, reasoning effort and auto-compact setting; handoff to renew the context at a safe point; spawn/message/stop/list to manage detached executors.',
  type: 'object',
  additionalProperties: false,
  properties: {
    requiredFeatures: { type: 'array', maxItems: 32, uniqueItems: true, items: { enum: [...FEATURES] }, description: 'Feature names this caller requires; the request fails when the harness does not declare them.' },
    operation: { ...operationEnum, description: 'Operation to perform: handoff, spawn, status, message, cancel/stop, finish, list or capabilities.' },
    operationId: { ...id, description: 'Caller-chosen idempotency key; reusing it with different input is rejected.' },
    target: { ...id, description: 'Target agent: "self" for this session or an owned executor id.' },
    owner: { ...id, description: 'For list: only return executors created by this owner identity.' },
    mode: { enum: [...HANDOFF_MODES], description: 'Handoff mode: restart (default) starts a fresh context containing only the task material with no summary; compact is an explicit opt-in that keeps a harness-generated history summary.' },
    surface: { enum: [...SURFACES], description: 'Interaction surface: preserve (default) or an explicit cross-surface target.' },
    task: { ...boundedText, description: 'Seed material for handoff, spawn or message: the task the context or executor adopts.' },
    model: { ...shortText, description: 'Optional model override; when omitted the harness configuration is inherited.' },
    reasoningEffort: { ...shortText, description: 'Optional reasoning-effort override (for example low, medium, high); when omitted the harness configuration is inherited.' },
    policy: {
      type: 'object', additionalProperties: false,
      description: 'Child policy for spawned executors; a denial returns forbidden.',
      properties: {
        allowSelfHandoff: { type: 'boolean', description: 'Whether a spawned executor may renew its own context (default true).' },
        allowSpawnChildren: { type: 'boolean', description: 'Whether a spawned executor may create further executors (default false).' },
        allowSelfStop: { type: 'boolean', description: 'Whether a spawned executor may stop itself (default true).' },
      },
    },
    isolation: { enum: [...ISOLATION], description: 'Executor isolation: inherit the caller environment (default) or isolated.' },
    spawn: spawnOptionsSchema,
    count: { type: 'integer', minimum: 1, maximum: 16, description: 'Number of detached executors to spawn (1-16).' },
    timeoutMs: { type: 'integer', minimum: 0, maximum: 300000, description: 'Maximum wait in milliseconds for a stop/finish confirmation.' },
    reason: { ...shortText, description: 'Human-readable reason recorded with the operation.' },
    logTail: logTailSchema,
  },
  required: ['operation', 'operationId'],
  allOf: [
    {
      if: { properties: { operation: { const: 'handoff' } } },
      then: {
        required: ['target'],
        not: { anyOf: [{ required: ['owner'] }, { required: ['count'] }, { required: ['isolation'] }, { required: ['policy'] }, { required: ['spawn'] }, { required: ['logTail'] }] },
      },
    },
    {
      // A session cannot rotate itself; rotation is an executor-target mode.
      if: { properties: { operation: { const: 'handoff' }, target: { const: 'self' } }, required: ['operation', 'target'] },
      then: { properties: { mode: { not: { const: 'rotation' } } } },
    },
    {
      // Executor-target restart/rotation require the continuation material.
      if: { properties: { operation: { const: 'handoff' }, target: { not: { const: 'self' } }, mode: { enum: ['restart', 'rotation'] } }, required: ['operation', 'target', 'mode'] },
      then: { required: ['task'] },
    },
    {
      if: { properties: { operation: { const: 'spawn' } } },
      then: {
        required: ['task'],
        not: { anyOf: [{ required: ['target'] }, { required: ['owner'] }, { required: ['mode'] }, { required: ['surface'] }, { required: ['logTail'] }] },
      },
    },
    {
      if: { properties: { operation: { const: 'status' } } },
      then: { not: { anyOf: [{ required: ['owner'] }, { required: ['task'] }, { required: ['model'] }, { required: ['reasoningEffort'] }, { required: ['policy'] }, { required: ['isolation'] }, { required: ['count'] }, { required: ['mode'] }, { required: ['surface'] }, { required: ['spawn'] }] } },
    },
    {
      if: { properties: { operation: { enum: ['message'] } } },
      then: { required: ['target', 'task'], not: { anyOf: [{ required: ['owner'] }, { required: ['model'] }, { required: ['reasoningEffort'] }, { required: ['policy'] }, { required: ['isolation'] }, { required: ['count'] }, { required: ['mode'] }, { required: ['surface'] }, { required: ['spawn'] }, { required: ['logTail'] }] } },
    },
    {
      if: { properties: { operation: { enum: ['cancel', 'stop', 'finish'] } } },
      then: { required: ['target'], not: { anyOf: [{ required: ['owner'] }, { required: ['task'] }, { required: ['model'] }, { required: ['reasoningEffort'] }, { required: ['policy'] }, { required: ['isolation'] }, { required: ['count'] }, { required: ['mode'] }, { required: ['surface'] }, { required: ['spawn'] }, { required: ['logTail'] }] } },
    },
    {
      if: { properties: { operation: { const: 'list' } } },
      then: { not: { anyOf: [{ required: ['target'] }, { required: ['task'] }, { required: ['model'] }, { required: ['reasoningEffort'] }, { required: ['policy'] }, { required: ['isolation'] }, { required: ['count'] }, { required: ['mode'] }, { required: ['surface'] }, { required: ['reason'] }, { required: ['timeoutMs'] }, { required: ['spawn'] }, { required: ['logTail'] }] } },
    },
    {
      if: { properties: { operation: { const: 'capabilities' } } },
      then: { not: { anyOf: [{ required: ['target'] }, { required: ['owner'] }, { required: ['task'] }, { required: ['model'] }, { required: ['reasoningEffort'] }, { required: ['policy'] }, { required: ['isolation'] }, { required: ['count'] }, { required: ['mode'] }, { required: ['surface'] }, { required: ['reason'] }, { required: ['timeoutMs'] }, { required: ['spawn'] }, { required: ['logTail'] }] } },
    },
  ],
} as const;

export const IDENTITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    harness: { enum: [...HARNESSES] },
    workspace: shortText,
    surface: { enum: ['tui', 'headless', 'web'] },
    session: shortText,
    generation: shortText,
    agent: shortText,
  },
  required: ['harness', 'workspace', 'surface', 'session', 'generation', 'agent'],
} as const;

const contextSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    window: { type: ['integer', 'null'], minimum: 0 },
    used: { type: ['integer', 'null'], minimum: 0 },
    percent: { type: ['number', 'null'], minimum: 0 },
    percentSource: { anyOf: [{ enum: [...PERCENT_SOURCE] }, { type: 'null' }] },
    sources: {
      type: 'object', additionalProperties: false,
      properties: {
        window: { anyOf: [{ enum: [...SOURCE_LABELS] }, { type: 'null' }] },
        used: { anyOf: [{ enum: [...SOURCE_LABELS] }, { type: 'null' }] },
        percent: { anyOf: [{ enum: [...SOURCE_LABELS] }, { type: 'null' }] },
      },
    },
  },
  required: ['window', 'used'],
} as const;

const sessionPointerSchema = {
  type: ['object', 'null'], additionalProperties: false,
  properties: { id: shortText, store: shortText, path: { type: ['string', 'null'] } },
  required: ['id', 'store', 'path'],
} as const;

const noticeSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    code: shortText,
    impact: { const: 'none' },
    action_required: { const: false },
    message: shortText,
  },
  required: ['code', 'impact', 'action_required', 'message'],
} as const;

const capabilitySchema = {
  type: 'object', additionalProperties: false,
  properties: {
    harness: { enum: [...HARNESSES] },
    os: { enum: [...OSES] },
    interface: { enum: ['tui', 'headless', 'web'] },
    operations: { type: 'object', additionalProperties: { enum: [...AVAILABILITY] } },
    handoff: {
      type: 'object', additionalProperties: false,
      properties: {
        availability: { enum: [...AVAILABILITY] },
        modes: { type: 'array', uniqueItems: true, items: { enum: [...LEGACY_HANDOFF_MODES] } },
        self: {
          type: 'object', additionalProperties: false,
          properties: { modes: { type: 'array', uniqueItems: true, items: { enum: [...HANDOFF_MODES] } } },
          required: ['modes'],
        },
        executor: {
          type: 'object', additionalProperties: false,
          properties: { modes: { type: 'array', uniqueItems: true, items: { enum: [...HANDOFF_MODES] } } },
          required: ['modes'],
        },
        modelOverride: { enum: [...AVAILABILITY] },
        reasoningEffortOverride: { enum: [...AVAILABILITY] },
        crossSurface: { enum: [...AVAILABILITY] },
      },
      required: ['availability', 'modes', 'modelOverride', 'reasoningEffortOverride', 'crossSurface'],
    },
    spawn: {
      type: 'object', additionalProperties: false,
      properties: {
        availability: { enum: [...AVAILABILITY] },
        lifecycle: { enum: ['detached', 'attached', 'none'] },
        maxConcurrent: { type: 'integer', minimum: 1 },
        isolation: { enum: [...AVAILABILITY] },
        persistenceModes: { type: 'array', uniqueItems: true, items: { enum: [...PERSISTENCE_MODES] } },
        surfaces: { type: 'array', uniqueItems: true, items: { enum: [...SPAWN_SURFACES] } },
        permissionModes: { type: 'array', uniqueItems: true, items: { enum: [...PERMISSION_MODES] } },
        mcpFilter: { enum: [...AVAILABILITY] },
      },
      required: ['availability', 'lifecycle', 'maxConcurrent', 'isolation', 'persistenceModes', 'surfaces', 'permissionModes', 'mcpFilter'],
    },
    observation: {
      type: 'object', additionalProperties: false,
      properties: { events: { enum: [...EVENT_LEVELS] } },
      required: ['events'],
    },
    status: {
      type: 'object', additionalProperties: false,
      properties: {
        availability: { enum: [...AVAILABILITY] },
        model: { enum: [...AVAILABILITY] },
        reasoningEffort: { enum: [...AVAILABILITY] },
        context: { enum: [...AVAILABILITY] },
        percentSource: { anyOf: [{ enum: [...PERCENT_SOURCE] }, { type: 'null' }] },
        autoCompact: { enum: [...AVAILABILITY] },
      },
      required: ['availability', 'model', 'reasoningEffort', 'context', 'percentSource', 'autoCompact'],
    },
    experimental: { type: 'array', items: shortText },
    reason: shortText,
    evidence: shortText,
  },
  required: ['harness', 'os', 'interface', 'operations', 'handoff', 'spawn', 'status', 'observation', 'experimental', 'reason'],
  allOf: [
    {
      if: { properties: { spawn: { properties: { availability: { const: 'supported' } }, required: ['availability'] } }, required: ['spawn'] },
      then: { properties: { spawn: { properties: { lifecycle: { const: 'detached' } }, required: ['lifecycle'] } } },
    },
  ],
} as const;

export const RESULT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'AI4AI result',
  type: 'object',
  additionalProperties: false,
  properties: {
    operation: operationEnum,
    operationId: id,
    status: { enum: [...STATES] },
    reason: shortText,
    durable: { type: 'boolean' },
    target: id,
    executorId: id,
    sessionId: shortText,
    surfaceChanged: { type: 'boolean' },
    state: { enum: [...LIFECYCLE_STATES] },
    handoff: {
      type: 'object', additionalProperties: false,
      properties: { phase: { enum: [...HANDOFF_PHASES] } },
      required: ['phase'],
    },
    model: { type: ['string', 'null'] },
    reasoningEffort: { type: ['string', 'null'] },
    lastActivityAt: { type: ['string', 'null'] },
    lastActivityAtSource: { anyOf: [{ enum: [...SOURCE_LABELS] }, { type: 'null' }] },
    stateSource: { anyOf: [{ enum: [...SOURCE_LABELS] }, { type: 'null' }] },
    processState: { enum: [...PROCESS_STATES] },
    processStateReason: shortText,
    turns: { type: 'integer', minimum: 0 },
    lastOperationId: { anyOf: [{ ...id }, { type: 'null' }] },
    lastTurnOutcome: { anyOf: [{ enum: [...TURN_OUTCOMES] }, { type: 'null' }] },
    queuedTurns: { type: 'integer', minimum: 0 },
    lastTurnAt: { type: ['string', 'null'] },
    turnStartedAt: { type: ['string', 'null'] },
    idleSince: { type: ['string', 'null'] },
    turnId: id,
    queuePosition: { type: 'integer', minimum: 0 },
    persistence: { enum: [...PERSISTENCE_MODES] },
    runtimeVersion: { type: ['string', 'null'] },
    mcpFiltered: {
      type: 'object', additionalProperties: false,
      properties: { names: { type: 'array', items: shortText }, count: { type: 'integer', minimum: 0 } },
      required: ['names', 'count'],
    },
    logTail: {
      type: 'object', additionalProperties: false,
      properties: {
        format: { enum: ['events', 'lines'] },
        events: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              seq: { type: 'integer', minimum: 0 },
              ts: shortText,
              kind: { enum: [...EVENT_KINDS] },
              role: { enum: [...EVENT_ROLES] },
              text: shortText,
              tool: shortText,
              phase: shortText,
              detail: shortText,
            },
            required: ['seq', 'ts', 'kind'],
          },
        },
        lines: { type: 'array', items: shortText },
        nextCursor: { type: 'integer', minimum: 0 },
        reset: { type: 'boolean' },
      },
      required: ['format', 'nextCursor'],
    },
    exitCode: { type: ['integer', 'null'] },
    signal: { type: ['string', 'null'] },
    session: sessionPointerSchema,
    modelVerification: { enum: [...MODEL_VERIFICATION] },
    mechanism: { enum: [...PROOF_MECHANISMS, LEGACY_PROOF_MECHANISM] },
    sessionChanged: { type: 'boolean' },
    sourceSession: { type: ['string', 'null'] },
    successorSession: { type: ['string', 'null'] },
    sourceGeneration: { type: ['string', 'null'] },
    successorGeneration: { type: ['string', 'null'] },
    successor: IDENTITY_SCHEMA,
    predecessorExecutorId: { anyOf: [{ ...id }, { type: 'null' }] },
    successorExecutorId: { anyOf: [{ ...id }, { type: 'null' }] },
    lineage: {
      type: 'object', additionalProperties: false,
      properties: {
        predecessorExecutorId: id,
        predecessorGeneration: shortText,
        lineageGeneration: { type: 'integer', minimum: 0 },
        operationId: id,
        taskHash: shortText,
        predecessorSession: { type: ['string', 'null'] },
        predecessorStopped: { type: 'boolean' },
        stopExitCode: { type: ['integer', 'null'] },
        stopSignal: { type: ['string', 'null'] },
        transferredAt: shortText,
      },
      required: ['predecessorExecutorId', 'predecessorGeneration', 'lineageGeneration', 'operationId'],
    },
    predecessorStopped: { type: ['boolean', 'null'] },
    alternatives: { type: 'array', uniqueItems: true, items: { enum: [...HANDOFF_MODES] } },
    continued: { type: ['boolean', 'null'] },
    idleAfter: { type: ['boolean', 'null'] },
    lastError: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object', additionalProperties: false,
          properties: { code: shortText, message: shortText },
          required: ['code', 'message'],
        },
      ],
    },
    verification: {
      type: 'object', additionalProperties: false,
      properties: { model: { enum: [...MODEL_VERIFICATION] }, context: { enum: [...CONTEXT_VERIFICATION] } },
      required: ['model', 'context'],
    },
    context: contextSchema,
    unavailable: { type: 'array', items: shortText },
    notices: { type: 'array', items: noticeSchema },
    autoCompact: {
      type: 'object', additionalProperties: false,
      properties: {
        tokens: { type: ['integer', 'null'], minimum: 1 },
        ratio: { type: ['number', 'null'], exclusiveMinimum: 0, maximum: 1 },
        source: { enum: [...AUTOCOMPACT_SOURCES] },
        enabled: { type: ['boolean', 'null'] },
        enforced: { type: ['boolean', 'null'] },
        nativeSource: { type: ['string', 'null'] },
      },
      required: ['tokens', 'ratio', 'source'],
    },
    credentials: {
      type: 'object', additionalProperties: false,
      properties: {
        isolation: { enum: ['inherit', 'isolated'] },
        source: shortText,
        keys: { type: 'array', uniqueItems: true, items: shortText },
        fields: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: { key: shortText, source: shortText },
            required: ['key', 'source'],
          },
        },
        masked: { const: true },
        notes: { type: 'array', items: shortText },
      },
      required: ['isolation', 'source', 'keys', 'masked'],
    },
    fieldStates: {
      type: 'object',
      propertyNames: { enum: [...FIELD_STATE_KEYS] },
      additionalProperties: { enum: [...FIELD_STATE_VALUES] },
    },
    error: {
      type: 'object', additionalProperties: false,
      properties: { code: shortText, message: shortText },
      required: ['code', 'message'],
    },
    proof: {
      type: 'object', additionalProperties: false,
      properties: {
        source: IDENTITY_SCHEMA,
        successor: IDENTITY_SCHEMA,
        mechanism: { enum: [...PROOF_MECHANISMS, LEGACY_PROOF_MECHANISM] },
        nativeEvidence: shortText,
      },
      required: ['source', 'successor', 'mechanism', 'nativeEvidence'],
    },
    capabilities: { type: 'array', items: capabilitySchema },
    executors: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          executorId: id, state: { enum: [...LIFECYCLE_STATES] }, sessionId: shortText,
          model: { type: ['string', 'null'] }, reasoningEffort: { type: ['string', 'null'] },
          context: contextSchema, surface: { enum: ['tui', 'headless', 'web'] },
          turns: { type: 'integer', minimum: 0 }, queuedTurns: { type: 'integer', minimum: 0 },
          lastTurnAt: { type: ['string', 'null'] }, lastTurnOutcome: { anyOf: [{ enum: [...TURN_OUTCOMES] }, { type: 'null' }] },
          lastOperationId: { anyOf: [{ ...id }, { type: 'null' }] }, turnStartedAt: { type: ['string', 'null'] }, idleSince: { type: ['string', 'null'] },
          processState: { enum: [...PROCESS_STATES] }, persistence: { enum: [...PERSISTENCE_MODES] },
          session: sessionPointerSchema,
        },
        required: ['executorId', 'state', 'surface'],
      },
    },
  },
  required: ['operation', 'operationId', 'status', 'reason', 'durable', 'modelVerification', 'verification', 'notices'],
  allOf: [
    {
      if: { properties: { operation: { const: 'handoff' }, status: { const: 'completed' } }, required: ['operation', 'status'] },
      then: { required: ['proof'], properties: { durable: { const: true } } },
    },
  ],
} as const;


/**
 * Tool-facing request schema. The Anthropic API rejects a top-level `allOf`,
 * so the adapter tool registration uses a plain object; the semantic
 * validators still enforce the same operation-specific rules and version.
 */
export const TOOL_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { ...REQUEST_SCHEMA.properties },
  required: ['operation', 'operationId'],
} as const;

/** Emitted into `docs/contract.md` by the docs generator. */
export const SCHEMAS = { request: REQUEST_SCHEMA, result: RESULT_SCHEMA, identity: IDENTITY_SCHEMA, capability: capabilitySchema } as const;
