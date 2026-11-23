import type { AutoCompact, ContextInfo } from '../../contract/types.js';
import type { FieldStateValue } from '../../contract/states.js';
import { contextFromUsage } from '../external.js';
import { dshSessionUsage } from '../../core/session-probe.js';
import { probeDshConfig, type DshProfile } from '../../core/config-probe.js';
import { firstVerified, verifiedText, verifiedTokens, verifiedWindow } from '../../core/ladder.js';
import { envValue, dshRuntimeVersion } from '../../core/config-probe.js';

/**
 * Per-field status resolution for DSH, shared by the external adapter and the
 * Cordis plugin.
 *
 * Layers per field: native session events (usage; model/effort/window when the
 * record carries them) > persisted DSH_HOME session store > process env > config
 * (headless profile patch). DSH publishes no documented model/effort variable;
 * the env candidates below are the only plausible overrides, and an absent one
 * simply skips that layer without affecting the other fields.
 */
export interface DshNativeStatus {
  used?: unknown;
  model?: unknown;
  window?: unknown;
  reasoningEffort?: unknown;
}

export interface DshStatusDetails {
  model: string | null;
  reasoningEffort: string | null;
  context: ContextInfo;
  autoCompact?: AutoCompact;
  /** Installed DSH runtime version (read from the carrier's package). */
  runtimeVersion?: string;
  modelVerification: 'reported' | 'configured-only' | 'unknown';
  fieldStates?: Record<string, FieldStateValue>;
  unavailable: string[];
}

export async function resolveDshStatus(workspace: string, sessionId: string | undefined, native: DshNativeStatus, dshHome?: string, options: { profile?: DshProfile; dshEntry?: string } = {}): Promise<DshStatusDetails> {
  let used = verifiedTokens(native.used);
  let usedSource: 'native' | 'session' | null = used !== null ? 'native' : null;
  let model = verifiedText(native.model);
  let modelSource: 'native' | 'session' | null = model !== null ? 'native' : null;
  let window = verifiedWindow(native.window);
  let windowSource: 'native' | 'session' | null = window !== null ? 'native' : null;
  let reasoningEffort = verifiedText(native.reasoningEffort);
  let reasoningEffortSource: 'native' | 'session' | null = reasoningEffort !== null ? 'native' : null;

  if (used === null || model === null || window === null || reasoningEffort === null) {
    const probe = await dshSessionUsage(workspace, sessionId, dshHome).catch(() => null);
    if (used === null) { used = verifiedTokens(probe?.used); if (used !== null) usedSource = 'session'; }
    if (model === null) { model = verifiedText(probe?.model); if (model !== null) modelSource = 'session'; }
    if (window === null) { window = verifiedWindow(probe?.window); if (window !== null) windowSource = 'session'; }
    if (reasoningEffort === null) { reasoningEffort = verifiedText(probe?.reasoningEffort); if (reasoningEffort !== null) reasoningEffortSource = 'session'; }
  }
  const config = await probeDshConfig(dshHome, options).catch(() => null);

  const modelField = firstVerified<string>([
    { value: model, source: modelSource ?? 'native' },
    { value: envValue('DSH_MODEL') ?? envValue('AI4AI_DSH_MODEL'), source: 'env' },
    { value: config?.model?.value ?? null, source: config?.model?.source ?? 'config' },
  ]);
  const windowField = firstVerified<number>([
    { value: window, source: windowSource ?? 'native' },
    { value: verifiedWindow(Number(envValue('DSH_CONTEXT_WINDOW') ?? envValue('AI4AI_DSH_CONTEXT_WINDOW'))), source: 'env' },
    { value: config?.window?.value ?? null, source: config?.window?.source ?? 'config' },
  ]);
  const reasoningEffortField = firstVerified<string>([
    { value: reasoningEffort, source: reasoningEffortSource ?? 'session' },
    { value: envValue('DSH_REASONING_EFFORT') ?? envValue('AI4AI_DSH_REASONING_EFFORT'), source: 'env' },
    { value: config?.reasoningEffort?.value ?? null, source: config?.reasoningEffort?.source ?? 'config' },
  ]);

  const usedValue = used;
  const windowValue = windowField?.value ?? null;
  const context = contextFromUsage(usedValue, windowValue);
  context.sources = {
    window: windowField?.source ?? null,
    used: usedValue !== null ? usedSource : null,
    percent: context.percent !== null ? 'derived' : null,
  };
  const autoCompact = !config?.autoCompactDisabled && config?.autoCompactRatio
    ? {
      tokens: windowValue ? Math.round(windowValue * config.autoCompactRatio.value) : null,
      ratio: config.autoCompactRatio.value,
      source: config.autoCompactRatio.source,
    }
    : undefined;

  const unavailable: string[] = [];
  if (!modelField) unavailable.push('model');
  if (windowValue === null) unavailable.push('context.window');
  if (usedValue === null) unavailable.push('context.used');
  // DSH never puts its version in status/usage records; the installed package is
  // the authoritative artifact the carrier executes. Absent means the runtime
  // could not be resolved at all, so the field is omitted instead of guessed.
  const runtimeVersion = await dshRuntimeVersion(options.dshEntry).catch(() => null);
  return {
    model: modelField?.value ?? null,
    reasoningEffort: reasoningEffortField?.value ?? null,
    context,
    ...(autoCompact ? { autoCompact } : {}),
    ...(runtimeVersion ? { runtimeVersion } : {}),
    modelVerification: !modelField ? 'unknown' : modelField.source === 'native' || modelField.source === 'session' ? 'reported' : 'configured-only',
    fieldStates: {
      ...(reasoningEffortField ? {} : { reasoningEffort: 'unavailable' as const }),
      // The active profile's configuration (the web bundle patch or a user
      // patch) turns compaction-basic off: the harness has the feature but it is
      // disabled, which is the contract's `disabled` state — never a missing
      // value and therefore never listed in `unavailable`.
      ...(config?.autoCompactDisabled ? { 'context.autoCompact': 'disabled' as const } : {}),
    },
    unavailable,
  };
}

/**
 * Reconcile the generic result defaults with the resolved status values. The
 * base result is built before the status fields are known, so its
 * `unavailable`/`fieldStates` mark every field missing; a field that the
 * resolver actually produced must never be reported unavailable.
 */
export function reconcileDshStatus(
  base: Pick<import('../../contract/types.js').Result, 'fieldStates'>,
  details: DshStatusDetails,
): { fieldStates: Record<string, FieldStateValue>; unavailable: string[] } {
  const missing = new Set(details.unavailable);
  // Every non-`disabled` field state is a missing value and must be listed in
  // `unavailable` (contract: disabled is the only state that is not missing).
  for (const [key, state] of Object.entries(details.fieldStates ?? {})) if (state !== 'disabled') missing.add(key);
  if (details.context.percent === null) missing.add('context.percent');
  const fieldStates: Record<string, FieldStateValue> = { ...(base.fieldStates ?? {}), ...(details.fieldStates ?? {}) };
  const auto = details.autoCompact;
  if ((!auto || (auto.tokens === null && auto.ratio === null)) && fieldStates['context.autoCompact'] !== 'disabled') missing.add('context.autoCompact');
  for (const key of Object.keys(fieldStates)) {
    if (fieldStates[key] === 'disabled') missing.delete(key);
    else if (!missing.has(key)) delete fieldStates[key];
  }
  for (const key of missing) fieldStates[key] = fieldStates[key] ?? 'unavailable';
  return { fieldStates, unavailable: [...missing] };
}
