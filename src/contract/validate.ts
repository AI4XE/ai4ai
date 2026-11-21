import { FEATURES } from './version.js';
import {
  AVAILABILITY, AUTOCOMPACT_SOURCES, CONTEXT_VERIFICATION, FIELD_STATE_KEYS, HANDOFF_MODES, HANDOFF_PHASES, HARNESSES, ISOLATION,
  LEGACY_PROOF_MECHANISM, LIFECYCLE_STATES, MODEL_VERIFICATION, OPERATIONS, OSES, PERCENT_SOURCE, PROOF_MECHANISMS, SOURCE_LABELS, STATES, SURFACES,
} from './states.js';
import type {
  CapabilityDeclaration, ContextInfo, Identity, Issue, Notice, Request, Result,
  Validation,
} from './types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !v.includes('\0');
const member = (v: unknown, values: readonly string[]): boolean => typeof v === 'string' && values.includes(v);
const problem = (path: string, code: string, message: string): Issue => ({ path, code, message });
const done = <T>(value: unknown, issues: Issue[]): Validation<T> => issues.length ? { ok: false, issues } : { ok: true, value: value as T };

const REQUEST_KEYS = [
  'requiredFeatures', 'operation', 'operationId', 'target', 'owner', 'mode', 'surface',
  'task', 'model', 'reasoningEffort', 'policy', 'isolation', 'count', 'timeoutMs', 'reason',
] as const;

/** Requests are closed: unknown fields never silently mutate a session. */
export function validateRequest(value: unknown, features: readonly string[] = FEATURES): Validation<Request> {
  if (!object(value)) return { ok: false, issues: [problem('$', 'schema', 'Expected an object')] };
  const issues: Issue[] = [];
  for (const key of Object.keys(value)) if (!(REQUEST_KEYS as readonly string[]).includes(key)) issues.push(problem(key, 'unknown-field', 'Unknown request field'));
  if (value.requiredFeatures !== undefined) {
    if (!Array.isArray(value.requiredFeatures) || value.requiredFeatures.length > 32 || new Set(value.requiredFeatures).size !== value.requiredFeatures.length || value.requiredFeatures.some(f => !member(f, FEATURES))) {
      issues.push(problem('requiredFeatures', 'schema', 'Expected distinct known feature names'));
    } else for (const feature of value.requiredFeatures as string[]) {
      if (!features.includes(feature)) issues.push(problem('requiredFeatures', 'feature-mismatch', `Unknown mandatory feature: ${feature}`));
    }
  }
  const operation = value.operation;
  if (!member(operation, OPERATIONS)) issues.push(problem('operation', 'schema', 'Unknown operation'));
  if (!text(value.operationId, 128) || !ID.test(value.operationId)) issues.push(problem('operationId', 'schema', 'Expected a bounded operation identifier'));
  for (const key of ['target', 'owner'] as const) if (value[key] !== undefined && (!text(value[key], 128) || !ID.test(value[key] as string))) issues.push(problem(key, 'schema', 'Expected a bounded identifier'));
  if (value.mode !== undefined && !member(value.mode, HANDOFF_MODES)) issues.push(problem('mode', 'schema', 'Unknown handoff mode'));
  if (value.surface !== undefined && !member(value.surface, SURFACES)) issues.push(problem('surface', 'schema', 'Unknown surface'));
  if (value.isolation !== undefined && !member(value.isolation, ISOLATION)) issues.push(problem('isolation', 'schema', 'Unknown isolation'));
  if (value.task !== undefined && !text(value.task, 16384)) issues.push(problem('task', 'schema', 'Expected 1-16384 characters without NUL'));
  for (const key of ['model', 'reasoningEffort', 'reason'] as const) if (value[key] !== undefined && !text(value[key], 4096)) issues.push(problem(key, 'schema', 'Expected bounded text'));
  if (value.policy !== undefined) {
    if (!object(value.policy)) issues.push(problem('policy', 'schema', 'Expected a policy object'));
    else {
      for (const key of Object.keys(value.policy)) if (!['allowSelfHandoff', 'allowSpawnChildren', 'allowSelfStop'].includes(key)) issues.push(problem(`policy.${key}`, 'unknown-field', 'Unknown policy field'));
      for (const key of ['allowSelfHandoff', 'allowSpawnChildren', 'allowSelfStop']) {
        if (value.policy[key] !== undefined && typeof value.policy[key] !== 'boolean') issues.push(problem(`policy.${key}`, 'schema', 'Expected boolean'));
      }
    }
  }
  if (value.count !== undefined && (!Number.isSafeInteger(value.count) || Number(value.count) < 1 || Number(value.count) > 16)) issues.push(problem('count', 'schema', 'Expected an integer from 1 to 16'));
  if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 0 || Number(value.timeoutMs) > 300000)) issues.push(problem('timeoutMs', 'schema', 'Expected an integer from 0 to 300000'));

  // Operation-specific applicability mirrors REQUEST_SCHEMA's if/then blocks.
  const has = (key: string): boolean => value[key] !== undefined;
  const notApplicable = (keys: readonly string[]): void => {
    for (const key of keys) if (has(key)) issues.push(problem(key, 'not-applicable', `${key} is not applicable to ${String(operation)}`));
  };
  if (operation === 'handoff') {
    if (!has('target')) issues.push(problem('target', 'required', 'handoff requires target "self" or an owned executor id'));
    if (!has('task')) issues.push(problem('task', 'required', 'handoff requires handoff material'));
    notApplicable(['owner', 'count', 'isolation', 'policy']);
  } else if (operation === 'spawn') {
    if (!has('task')) issues.push(problem('task', 'required', 'spawn requires task material'));
    notApplicable(['target', 'owner', 'mode', 'surface']);
  } else if (operation === 'status') {
    notApplicable(['owner', 'task', 'model', 'reasoningEffort', 'policy', 'isolation', 'count', 'mode', 'surface']);
  } else if (operation === 'message') {
    if (!has('target')) issues.push(problem('target', 'required', 'message requires an owned target'));
    if (!has('task')) issues.push(problem('task', 'required', 'message requires text'));
    notApplicable(['owner', 'model', 'reasoningEffort', 'policy', 'isolation', 'count', 'mode', 'surface']);
  } else if (operation === 'cancel' || operation === 'stop') {
    if (!has('target')) issues.push(problem('target', 'required', 'cancel/stop requires an owned target'));
    notApplicable(['owner', 'task', 'model', 'reasoningEffort', 'policy', 'isolation', 'count', 'mode', 'surface']);
  } else if (operation === 'list') {
    notApplicable(['target', 'task', 'model', 'reasoningEffort', 'policy', 'isolation', 'count', 'mode', 'surface', 'reason', 'timeoutMs']);
  } else if (operation === 'capabilities') {
    notApplicable(['target', 'owner', 'task', 'model', 'reasoningEffort', 'policy', 'isolation', 'count', 'mode', 'surface', 'reason', 'timeoutMs']);
  }
  return done<Request>(value, issues);
}

export function validateIdentity(value: unknown): Validation<Identity> {
  if (!object(value)) return { ok: false, issues: [problem('$', 'schema', 'Expected a native identity')] };
  const issues: Issue[] = [];
  for (const key of Object.keys(value)) if (!['harness', 'workspace', 'surface', 'session', 'generation', 'agent'].includes(key)) issues.push(problem(key, 'unknown-field', 'Unknown identity field'));
  if (!member(value.harness, HARNESSES)) issues.push(problem('harness', 'schema', 'Unknown harness'));
  if (!member(value.surface, ['tui', 'headless', 'web'])) issues.push(problem('surface', 'schema', 'Unknown surface'));
  for (const key of ['workspace', 'session', 'generation', 'agent']) if (!text(value[key], 4096)) issues.push(problem(key, 'schema', 'Missing bounded native identity component'));
  return done<Identity>(value, issues);
}

const CONTEXT_FIELDS = ['window', 'used', 'percent', 'percentSource', 'sources'] as const;
export function validateContext(value: unknown): Validation<ContextInfo> {
  if (!object(value)) return { ok: false, issues: [problem('$', 'schema', 'Expected context info')] };
  const issues: Issue[] = [];
  for (const key of Object.keys(value)) if (!(CONTEXT_FIELDS as readonly string[]).includes(key)) issues.push(problem(key, 'unknown-field', 'Unknown context field'));
  for (const key of ['window', 'used'] as const) {
    if (!(key in value)) issues.push(problem(key, 'required', 'Expected window and used'));
    else if (value[key] !== null && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) issues.push(problem(key, 'schema', 'Expected a non-negative integer or null'));
  }
  if (value.percent !== undefined && value.percent !== null) {
    const percent = value.percent;
    // Percent is a 0-100 ratio with one decimal; other precisions indicate a
    // mixed/unknown unit and must be normalized by the adapter instead.
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100
      || Math.abs(percent * 10 - Math.round(percent * 10)) > 1e-9) {
      issues.push(problem('percent', 'schema', 'Expected a 0-100 number with one decimal or null'));
    }
  }
  if (value.percentSource !== undefined && value.percentSource !== null && !member(value.percentSource, PERCENT_SOURCE)) issues.push(problem('percentSource', 'schema', 'Unknown percent source'));
  if (value.sources !== undefined && value.sources !== null) {
    if (!object(value.sources)) issues.push(problem('sources', 'schema', 'Expected a source map'));
    else {
      for (const key of Object.keys(value.sources)) {
        if (!['window', 'used', 'percent'].includes(key)) issues.push(problem(`sources.${key}`, 'unknown-field', 'Unknown context source'));
        else if (value.sources[key] !== null && !member(value.sources[key], SOURCE_LABELS)) issues.push(problem(`sources.${key}`, 'schema', 'Unknown source label'));
      }
    }
  }
  if (value.percentSource === 'derived' && value.percent === undefined) issues.push(problem('percent', 'required', 'A derived percent requires the value it was derived from'));
  return done<ContextInfo>(value, issues);
}

export function validateNotice(value: unknown): Validation<Notice> {
  if (!object(value)) return { ok: false, issues: [problem('$', 'schema', 'Expected a notice')] };
  const issues: Issue[] = [];
  for (const key of Object.keys(value)) if (!['code', 'impact', 'action_required', 'message'].includes(key)) issues.push(problem(key, 'unknown-field', 'Unknown notice field'));
  if (!text(value.code, 4096)) issues.push(problem('code', 'schema', 'Expected a notice code'));
  if (value.impact !== 'none') issues.push(problem('impact', 'schema', 'Notices must be non-blocking (impact "none")'));
  if (value.action_required !== false) issues.push(problem('action_required', 'schema', 'Notices must not require action'));
  if (!text(value.message, 4096)) issues.push(problem('message', 'schema', 'Expected notice text'));
  return done<Notice>(value, issues);
}

export function validateCapability(value: unknown): Validation<CapabilityDeclaration> {
  if (!object(value)) return { ok: false, issues: [problem('$', 'schema', 'Expected a capability declaration')] };
  const issues: Issue[] = [];
  if (!member(value.harness, HARNESSES)) issues.push(problem('harness', 'schema', 'Unknown harness'));
  if (!member(value.os, OSES)) issues.push(problem('os', 'schema', 'Unknown OS'));
  if (!member(value.interface, ['tui', 'headless', 'web'])) issues.push(problem('interface', 'schema', 'Unknown interface'));
  if (!object(value.operations)) issues.push(problem('operations', 'schema', 'Expected operation availability'));
  else for (const [op, availability] of Object.entries(value.operations)) {
    if (!member(op, OPERATIONS)) issues.push(problem(`operations.${op}`, 'schema', 'Unknown operation'));
    else if (!member(availability, AVAILABILITY)) issues.push(problem(`operations.${op}`, 'schema', 'Unknown availability'));
  }
  if (object(value.handoff)) {
    if (!member(value.handoff.availability, AVAILABILITY)) issues.push(problem('handoff.availability', 'schema', 'Unknown availability'));
    if (!Array.isArray(value.handoff.modes) || value.handoff.modes.some(m => !member(m, HANDOFF_MODES))) issues.push(problem('handoff.modes', 'schema', 'Unknown mode list'));
    for (const key of ['modelOverride', 'reasoningEffortOverride', 'crossSurface'] as const) if (!member(value.handoff[key], AVAILABILITY)) issues.push(problem(`handoff.${key}`, 'schema', 'Unknown availability'));
  } else issues.push(problem('handoff', 'required', 'Expected handoff capabilities'));
  if (object(value.spawn)) {
    if (!member(value.spawn.availability, AVAILABILITY)) issues.push(problem('spawn.availability', 'schema', 'Unknown availability'));
    if (!member(value.spawn.lifecycle, ['detached', 'attached', 'none'])) issues.push(problem('spawn.lifecycle', 'schema', 'Unknown lifecycle'));
    if (!Number.isSafeInteger(value.spawn.maxConcurrent) || Number(value.spawn.maxConcurrent) < 1) issues.push(problem('spawn.maxConcurrent', 'schema', 'Expected a positive integer'));
    if (!member(value.spawn.isolation, AVAILABILITY)) issues.push(problem('spawn.isolation', 'schema', 'Unknown availability'));
    if (value.spawn.availability === 'supported' && value.spawn.lifecycle !== 'detached') issues.push(problem('spawn.lifecycle', 'contract', 'Supported spawn requires detached lifecycle'));
  } else issues.push(problem('spawn', 'required', 'Expected spawn capabilities'));
  if (object(value.status)) {
    for (const key of ['availability', 'model', 'reasoningEffort', 'context'] as const) if (!member(value.status[key], AVAILABILITY)) issues.push(problem(`status.${key}`, 'schema', 'Unknown availability'));
    if (value.status.percentSource !== null && !member(value.status.percentSource, PERCENT_SOURCE)) issues.push(problem('status.percentSource', 'schema', 'Unknown percent source'));
  } else issues.push(problem('status', 'required', 'Expected status capabilities'));
  if (!Array.isArray(value.experimental) || value.experimental.some(e => typeof e !== 'string')) issues.push(problem('experimental', 'schema', 'Expected an experimental feature list'));
  if (!text(value.reason, 4096)) issues.push(problem('reason', 'schema', 'Expected a reason'));
  if (value.evidence !== undefined && !text(value.evidence, 4096)) issues.push(problem('evidence', 'schema', 'Expected an evidence reference'));
  return done<CapabilityDeclaration>(value, issues);
}

const RESULT_KEYS = [
  'operation', 'operationId', 'status', 'reason', 'durable', 'target', 'executorId',
  'sessionId', 'surfaceChanged', 'state', 'handoff', 'model', 'reasoningEffort', 'lastActivityAt', 'lastActivityAtSource', 'stateSource', 'exitCode', 'signal', 'session', 'modelVerification', 'verification',
  'context', 'unavailable', 'notices', 'error', 'proof', 'capabilities', 'executors', 'fieldStates', 'autoCompact',
] as const;

/** Results are closed too, so a misspelled field cannot masquerade as evidence. */
export function validateResult(value: unknown): Validation<Result> {
  if (!object(value)) return { ok: false, issues: [problem('$', 'schema', 'Expected a result')] };
  const issues: Issue[] = [];
  for (const key of Object.keys(value)) if (!(RESULT_KEYS as readonly string[]).includes(key)) issues.push(problem(key, 'unknown-field', 'Unknown result field'));
  if (!member(value.operation, OPERATIONS)) issues.push(problem('operation', 'schema', 'Unknown operation'));
  if (!text(value.operationId, 128) || !ID.test(value.operationId)) issues.push(problem('operationId', 'schema', 'Invalid operation identifier'));
  if (!member(value.status, STATES)) issues.push(problem('status', 'schema', 'Unknown status'));
  // `state` is the lifecycle vocabulary shared by a session and its executors;
  // handoff progress lives in `handoff.phase`, never in `state`.
  if (value.state !== undefined && !member(value.state, LIFECYCLE_STATES)) issues.push(problem('state', 'schema', 'Unknown lifecycle state'));
  if (value.handoff !== undefined) {
    if (!object(value.handoff)) issues.push(problem('handoff', 'schema', 'Expected a handoff progress object'));
    else {
      for (const key of Object.keys(value.handoff)) if (key !== 'phase') issues.push(problem(`handoff.${key}`, 'unknown-field', 'Unknown handoff field'));
      if (!member(value.handoff.phase, HANDOFF_PHASES)) issues.push(problem('handoff.phase', 'schema', 'Unknown handoff phase'));
    }
  }
  if (!text(value.reason, 4096)) issues.push(problem('reason', 'schema', 'Expected a bounded human-readable reason'));
  if (typeof value.durable !== 'boolean') issues.push(problem('durable', 'schema', 'Expected boolean'));
  if (!member(value.modelVerification, MODEL_VERIFICATION)) issues.push(problem('modelVerification', 'schema', 'Unknown model verification level'));
  if (object(value.verification)) {
    if (!member(value.verification.model, MODEL_VERIFICATION)) issues.push(problem('verification.model', 'schema', 'Unknown model verification'));
    if (!member(value.verification.context, CONTEXT_VERIFICATION)) issues.push(problem('verification.context', 'schema', 'Unknown context verification'));
  } else issues.push(problem('verification', 'required', 'Expected a verification object'));
  if (value.context !== undefined) {
    const context = validateContext(value.context);
    if (!context.ok) issues.push(...context.issues.map(i => ({ ...i, path: `context.${i.path}` })));
  }
  if (value.unavailable !== undefined && (!Array.isArray(value.unavailable) || value.unavailable.some(u => typeof u !== 'string'))) issues.push(problem('unavailable', 'schema', 'Expected an unavailable field list'));
  if (value.autoCompact !== undefined) {
    const auto = value.autoCompact as Record<string, unknown>;
    if (!object(auto)) issues.push(problem('autoCompact', 'schema', 'Expected an auto-compaction object'));
    else {
      const tokens = auto.tokens;
      const ratio = auto.ratio;
      if (tokens !== null && (!Number.isSafeInteger(tokens) || Number(tokens) <= 0)) issues.push(problem('autoCompact.tokens', 'schema', 'Expected a positive integer or null'));
      if (ratio !== null && (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1)) issues.push(problem('autoCompact.ratio', 'schema', 'Expected a ratio in (0,1] or null'));
      if (!member(auto.source, AUTOCOMPACT_SOURCES)) issues.push(problem('autoCompact.source', 'schema', 'Unknown auto-compaction source'));
      if ((tokens !== null || ratio !== null) && auto.source === 'unknown') issues.push(problem('autoCompact.source', 'schema', 'A known threshold needs a real source'));
      for (const key of Object.keys(auto)) if (!['tokens', 'ratio', 'source'].includes(key)) issues.push(problem(`autoCompact.${key}`, 'unknown-field', 'Unknown auto-compaction field'));
    }
  }
  if (value.fieldStates !== undefined) {
    if (!object(value.fieldStates)) issues.push(problem('fieldStates', 'schema', 'Expected a field-state map'));
    else {
      for (const [key, state] of Object.entries(value.fieldStates)) {
        if (!(FIELD_STATE_KEYS as readonly string[]).includes(key)) issues.push(problem(`fieldStates.${key}`, 'unknown-field', 'Unknown field-state key'));
        if (!['unsupported', 'unavailable', 'unknown'].includes(String(state))) issues.push(problem(`fieldStates.${key}`, 'schema', 'Unknown field state'));
        if (Array.isArray(value.unavailable) && !value.unavailable.includes(key)) issues.push(problem(`fieldStates.${key}`, 'inconsistent', 'A missing field must also appear in unavailable'));
        if (value.unavailable === undefined) issues.push(problem(`fieldStates.${key}`, 'inconsistent', 'A field state map requires the unavailable list it derives from'));
      }
    }
  }
  if (!Array.isArray(value.notices)) issues.push(problem('notices', 'schema', 'Expected a notices array'));
  else value.notices.forEach((notice, i) => { const checked = validateNotice(notice); if (!checked.ok) issues.push(...checked.issues.map(p => ({ ...p, path: `notices[${i}].${p.path}` }))); });
  for (const key of ['target', 'executorId'] as const) if (value[key] !== undefined && (!text(value[key], 128) || !ID.test(value[key] as string))) issues.push(problem(key, 'schema', 'Expected a bounded identifier'));
  if (value.surfaceChanged !== undefined && typeof value.surfaceChanged !== 'boolean') issues.push(problem('surfaceChanged', 'schema', 'Expected boolean'));
  if (value.model !== undefined && value.model !== null && !text(value.model, 4096)) issues.push(problem('model', 'schema', 'Expected model text or null'));
  if (value.reasoningEffort !== undefined && value.reasoningEffort !== null && !text(value.reasoningEffort, 4096)) issues.push(problem('reasoningEffort', 'schema', 'Expected reasoning effort text or null'));
  if (value.lastActivityAt !== undefined && value.lastActivityAt !== null && !text(value.lastActivityAt, 64)) issues.push(problem('lastActivityAt', 'schema', 'Expected an ISO timestamp or null'));
  for (const key of ['lastActivityAtSource', 'stateSource'] as const) {
    if (value[key] !== undefined && value[key] !== null && !member(value[key], SOURCE_LABELS)) issues.push(problem(key, 'schema', 'Unknown source label'));
  }
  if (value.exitCode !== undefined && value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) issues.push(problem('exitCode', 'schema', 'Expected an integer or null'));
  if (value.signal !== undefined && value.signal !== null && !text(value.signal, 64)) issues.push(problem('signal', 'schema', 'Expected a signal name or null'));
  if (value.session !== undefined && value.session !== null) {
    if (!object(value.session)) issues.push(problem('session', 'schema', 'Expected a session pointer or null'));
    else {
      const pointer = value.session as Record<string, unknown>;
      for (const key of Object.keys(pointer)) if (!['id', 'store', 'path'].includes(key)) issues.push(problem(`session.${key}`, 'unknown-field', 'Unknown session pointer field'));
      if (!text(pointer.id, 4096) || !text(pointer.store, 256)) issues.push(problem('session', 'schema', 'Expected id and store'));
      if (pointer.path !== null && !text(pointer.path, 4096)) issues.push(problem('session.path', 'schema', 'Expected a path or null'));
    }
  }
  if (value.error !== undefined) {
    if (!object(value.error) || !text(value.error.code, 4096) || !text(value.error.message, 4096)) issues.push(problem('error', 'schema', 'Expected an error code and message'));
  }
  if (value.capabilities !== undefined) {
    if (!Array.isArray(value.capabilities)) issues.push(problem('capabilities', 'schema', 'Expected a capability list'));
    else value.capabilities.forEach((capability, i) => { const checked = validateCapability(capability); if (!checked.ok) issues.push(...checked.issues.map(p => ({ ...p, path: `capabilities[${i}].${p.path}` }))); });
  }
  if (value.executors !== undefined) {
    if (!Array.isArray(value.executors)) issues.push(problem('executors', 'schema', 'Expected an executor list'));
    else value.executors.forEach((executor, i) => {
      if (!object(executor) || !text(executor.executorId, 128) || !ID.test(executor.executorId as string) || !member(executor.state, LIFECYCLE_STATES) || !member(executor.surface, ['tui', 'headless', 'web'])) issues.push(problem(`executors[${i}]`, 'schema', 'Invalid executor summary'));
      else if (executor.session !== undefined && executor.session !== null && (!object(executor.session) || !text((executor.session as Record<string, unknown>).id, 4096) || !text((executor.session as Record<string, unknown>).store, 256))) issues.push(problem(`executors[${i}].session`, 'schema', 'Invalid session pointer'));
    });
  }
  // A completed handoff must carry durable trusted adoption proof; a status
  // query completion is much weaker and needs none.
  if (value.status === 'completed' && value.operation === 'handoff' && (value.durable !== true || value.proof === undefined)) issues.push(problem('proof', 'required', 'Completed handoff requires durable adoption proof'));
  // Any result carrying adoption proof is checked, not only `completed`: an
  // `applied` result also claims the context was replaced. A current mechanism
  // must keep the native session identity (a handoff never changes the SID);
  // `new-session` is accepted only as legacy evidence written by older releases.
  if (value.proof !== undefined) {
    if (!object(value.proof)) issues.push(problem('proof', 'schema', 'Expected adoption proof'));
    else {
      const source = validateIdentity(value.proof.source);
      const successor = validateIdentity(value.proof.successor);
      if (!source.ok) issues.push(...source.issues.map(p => ({ ...p, path: `proof.source.${p.path}` })));
      if (!successor.ok) issues.push(...successor.issues.map(p => ({ ...p, path: `proof.successor.${p.path}` })));
      if (!member(value.proof.mechanism, [...PROOF_MECHANISMS, LEGACY_PROOF_MECHANISM])) issues.push(problem('proof.mechanism', 'schema', 'Unknown handoff mechanism'));
      if (!text(value.proof.nativeEvidence, 4096)) issues.push(problem('proof.nativeEvidence', 'schema', 'Expected native adoption evidence'));
      if (member(value.proof.mechanism, PROOF_MECHANISMS) && source.ok && successor.ok
        && source.value.session !== successor.value.session) {
        issues.push(problem('proof.successor.session', 'same-session', 'A handoff must preserve the native session identity; use spawn for a new session'));
      }
    }
  }
  return done<Result>(value, issues);
}

/** Build a result with the mandatory defaults every adapter must report honestly. */
export function result(
  request: Pick<Request, 'operationId' | 'operation'>,
  status: Result['status'],
  reason: string,
  options: Partial<Omit<Result, 'operation' | 'operationId' | 'status' | 'reason'>> = {},
): Result {
  // Only operations that report observed state synthesize the per-field
  // context block. A capabilities/spawn/message/stop/cancel/handoff result must
  // not imply that model/context/autoCompact are unavailable: they are simply
  // not part of that result. Explicit options still override for any operation
  // (e.g. a handoff failure names the unavailable handoff features).
  const reportsState = request.operation === 'status' || request.operation === 'list';
  const composed: Result = {
    operation: request.operation,
    operationId: request.operationId,
    status,
    reason,
    durable: false,
    modelVerification: 'unknown',
    verification: { model: 'unknown', context: 'reported' },
    notices: [],
    ...options,
  };
  if (!reportsState && options.context === undefined) return composed;
  const context: ContextInfo = {
    window: null, used: null, percent: null, percentSource: null,
    ...(options.context ?? {}),
  };
  // Missing fields are explicit: null value + a closed field state + the
  // derived `unavailable` entry. Nothing is omitted or defaulted to 0.
  const autoCompact = {
    tokens: null as number | null, ratio: null as number | null, source: 'unknown' as const,
    ...(options.autoCompact ?? {}),
  };
  const fieldStates: Record<string, 'unsupported' | 'unavailable' | 'unknown'> = { ...(options.fieldStates ?? {}) };
  if (autoCompact.tokens === null && autoCompact.ratio === null) fieldStates['context.autoCompact'] = fieldStates['context.autoCompact'] ?? 'unavailable';
  if ((options.model ?? null) === null) fieldStates.model = fieldStates.model ?? 'unavailable';
  if ((options.reasoningEffort ?? null) === null) fieldStates.reasoningEffort = fieldStates.reasoningEffort ?? 'unavailable';
  if (context.window === null) fieldStates['context.window'] = fieldStates['context.window'] ?? 'unavailable';
  if (context.used === null) fieldStates['context.used'] = fieldStates['context.used'] ?? 'unavailable';
  if (context.percent === null) fieldStates['context.percent'] = fieldStates['context.percent'] ?? 'unavailable';
  const unavailable = [...new Set([...(options.unavailable ?? []), ...Object.keys(fieldStates)])];
  return { ...composed, context, unavailable, fieldStates, autoCompact };
}

/** Derive a labeled percentage; never present a derived ratio as native. */
export function derivedPercent(used: number, window: number): number | null {
  if (!Number.isSafeInteger(used) || !Number.isSafeInteger(window) || used < 0 || window <= 0) return null;
  return Math.min(100, Math.round((used / window) * 1000) / 10);
}
