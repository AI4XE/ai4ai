import type { AutoCompact, ContextInfo } from '../../contract/types.js';
import { contextFromUsage } from '../external.js';
import { dshSessionUsage } from '../../core/session-probe.js';
import { probeDshConfig } from '../../core/config-probe.js';
import { firstVerified, verifiedText, verifiedTokens, verifiedWindow } from '../../core/ladder.js';

/**
 * Per-field status resolution for DSH, shared by the external adapter and the
 * Cordis plugin.
 *
 * Layers: native session events (usage; model/effort/window when the record
 * carries them) > persisted DSH_HOME session store > config (headless profile
 * patch). DSH exposes no model-selection environment variable, so the env layer
 * is genuinely N/A for this harness.
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
  modelVerification: 'reported' | 'configured-only' | 'unknown';
  fieldStates?: Record<string, 'unsupported' | 'unavailable' | 'unknown'>;
  unavailable: string[];
}

export async function resolveDshStatus(workspace: string, sessionId: string | undefined, native: DshNativeStatus, dshHome?: string): Promise<DshStatusDetails> {
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
  const config = await probeDshConfig(dshHome).catch(() => null);

  const modelField = firstVerified<string>([
    { value: model, source: modelSource ?? 'native' },
    { value: config?.model?.value ?? null, source: config?.model?.source ?? 'config' },
  ]);
  const windowField = firstVerified<number>([
    { value: window, source: windowSource ?? 'native' },
    { value: config?.window?.value ?? null, source: config?.window?.source ?? 'config' },
  ]);
  const reasoningEffortField = firstVerified<string>([
    { value: reasoningEffort, source: reasoningEffortSource ?? 'session' },
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
  const autoCompact = config?.autoCompactRatio
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
  return {
    model: modelField?.value ?? null,
    reasoningEffort: reasoningEffortField?.value ?? null,
    context,
    ...(autoCompact ? { autoCompact } : {}),
    modelVerification: !modelField ? 'unknown' : modelField.source === 'native' || modelField.source === 'session' ? 'reported' : 'configured-only',
    ...(reasoningEffortField ? {} : { fieldStates: { reasoningEffort: 'unavailable' as const } }),
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
): { fieldStates: Record<string, 'unsupported' | 'unavailable' | 'unknown'>; unavailable: string[] } {
  const missing = new Set(details.unavailable);
  if (details.context.percent === null) missing.add('context.percent');
  const auto = details.autoCompact;
  if (!auto || (auto.tokens === null && auto.ratio === null)) missing.add('context.autoCompact');
  const fieldStates: Record<string, 'unsupported' | 'unavailable' | 'unknown'> = { ...(base.fieldStates ?? {}), ...(details.fieldStates ?? {}) };
  for (const key of Object.keys(fieldStates)) if (!missing.has(key)) delete fieldStates[key];
  for (const key of missing) fieldStates[key] = fieldStates[key] ?? 'unavailable';
  return { fieldStates, unavailable: [...missing] };
}
