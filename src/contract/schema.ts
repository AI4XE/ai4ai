import { FEATURES } from './version.js';
import {
  AVAILABILITY, CONTEXT_VERIFICATION, HANDOFF_MODES, HANDOFF_PHASES, HARNESSES, ISOLATION, LIFECYCLE_STATES,
  AUTOCOMPACT_SOURCES, FIELD_STATE_KEYS, FIELD_STATE_VALUES, SOURCE_LABELS, MODEL_VERIFICATION, OPERATIONS, OSES, PERCENT_SOURCE, STATES, SURFACES,
} from './states.js';

const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' } as const;
const boundedText = { type: 'string', minLength: 1, maxLength: 16384 } as const;
const shortText = { type: 'string', minLength: 1, maxLength: 4096 } as const;
const nonNegative = { type: 'integer', minimum: 0 } as const;

const operationEnum = { enum: [...OPERATIONS] } as const;

/** Every input property carries a description: the AI must not guess semantics. */
export const REQUEST_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'AI4AI request',
  description: 'One AI4AI session operation. Use status to query this session\'s context window, tokens used, usage percent, model, reasoning effort and auto-compact setting; handoff to renew the context at a safe point; spawn/message/stop/list to manage detached executors.',
  type: 'object',
  additionalProperties: false,
  properties: {
    requiredFeatures: { type: 'array', maxItems: 32, uniqueItems: true, items: { enum: [...FEATURES] }, description: 'Feature names this caller requires; the request fails when the harness does not declare them.' },
    operation: { ...operationEnum, description: 'Operation to perform: handoff, spawn, status, message, cancel/stop, list or capabilities.' },
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
    count: { type: 'integer', minimum: 1, maximum: 16, description: 'Number of detached executors to spawn (1-16).' },
    timeoutMs: { type: 'integer', minimum: 0, maximum: 300000, description: 'Maximum wait in milliseconds for a stop confirmation.' },
    reason: { ...shortText, description: 'Human-readable reason recorded with the operation.' },
  },
  required: ['operation', 'operationId'],
  allOf: [
    {
      if: { properties: { operation: { const: 'handoff' } } },
      then: {
        required: ['target', 'task'],
        not: { anyOf: [{ required: ['owner'] }, { required: ['count'] }, { required: ['isolation'] }, { required: ['policy'] }] },
      },
    },
    {
      if: { properties: { operation: { const: 'spawn' } } },
      then: {
        required: ['task'],
        not: { anyOf: [{ required: ['target'] }, { required: ['owner'] }, { required: ['mode'] }, { required: ['surface'] }] },
      },
    },
    {
      if: { properties: { operation: { const: 'status' } } },
      then: { not: { anyOf: [{ required: ['owner'] }, { required: ['task'] }, { required: ['model'] }, { required: ['reasoningEffort'] }, { required: ['policy'] }, { required: ['isolation'] }, { required: ['count'] }, { required: ['mode'] }, { required: ['surface'] }] } },
    },
    {
      if: { properties: { operation: { enum: ['message'] } } },
      then: { required: ['target', 'task'], not: { anyOf: [{ required: ['owner'] }, { required: ['model'] }, { required: ['reasoningEffort'] }, { required: ['policy'] }, { required: ['isolation'] }, { required: ['count'] }, { required: ['mode'] }, { required: ['surface'] }] } },
    },
    {
      if: { properties: { operation: { enum: ['cancel', 'stop'] } } },
      then: { required: ['target'], not: { anyOf: [{ required: ['owner'] }, { required: ['task'] }, { required: ['model'] }, { required: ['reasoningEffort'] }, { required: ['policy'] }, { required: ['isolation'] }, { required: ['count'] }, { required: ['mode'] }, { required: ['surface'] }] } },
    },
    {
      if: { properties: { operation: { const: 'list' } } },
      then: { not: { anyOf: [{ required: ['target'] }, { required: ['task'] }, { required: ['model'] }, { required: ['reasoningEffort'] }, { required: ['policy'] }, { required: ['isolation'] }, { required: ['count'] }, { required: ['mode'] }, { required: ['surface'] }, { required: ['reason'] }, { required: ['timeoutMs'] }] } },
    },
    {
      if: { properties: { operation: { const: 'capabilities' } } },
      then: { not: { anyOf: [{ required: ['target'] }, { required: ['owner'] }, { required: ['task'] }, { required: ['model'] }, { required: ['reasoningEffort'] }, { required: ['policy'] }, { required: ['isolation'] }, { required: ['count'] }, { required: ['mode'] }, { required: ['surface'] }, { required: ['reason'] }, { required: ['timeoutMs'] }] } },
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
        modes: { type: 'array', uniqueItems: true, items: { enum: [...HANDOFF_MODES] } },
        modelOverride: { enum: [...AVAILABILITY] },
        reasoningEffortOverride: { enum: [...AVAILABILITY] },
        crossSurface: { enum: [...AVAILABILITY] },
        tmuxFallback: { enum: ['off', 'experimental'] },
      },
      required: ['availability', 'modes', 'modelOverride', 'reasoningEffortOverride', 'crossSurface', 'tmuxFallback'],
    },
    spawn: {
      type: 'object', additionalProperties: false,
      properties: {
        availability: { enum: [...AVAILABILITY] },
        lifecycle: { enum: ['detached', 'attached', 'none'] },
        maxConcurrent: { type: 'integer', minimum: 1 },
        isolation: { enum: [...AVAILABILITY] },
      },
      required: ['availability', 'lifecycle', 'maxConcurrent', 'isolation'],
    },
    status: {
      type: 'object', additionalProperties: false,
      properties: {
        availability: { enum: [...AVAILABILITY] },
        model: { enum: [...AVAILABILITY] },
        reasoningEffort: { enum: [...AVAILABILITY] },
        context: { enum: [...AVAILABILITY] },
        percentSource: { anyOf: [{ enum: [...PERCENT_SOURCE] }, { type: 'null' }] },
      },
      required: ['availability', 'model', 'reasoningEffort', 'context', 'percentSource'],
    },
    experimental: { type: 'array', items: shortText },
    reason: shortText,
    evidence: shortText,
  },
  required: ['harness', 'os', 'interface', 'operations', 'handoff', 'spawn', 'status', 'experimental', 'reason'],
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
    exitCode: { type: ['integer', 'null'] },
    signal: { type: ['string', 'null'] },
    session: sessionPointerSchema,
    modelVerification: { enum: [...MODEL_VERIFICATION] },
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
      },
      required: ['tokens', 'ratio', 'source'],
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
        mechanism: { enum: ['new-session', 'surface-replacement'] },
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
