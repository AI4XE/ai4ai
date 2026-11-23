import type { AutoCompact, ContextInfo } from '../../contract/types.js';
import { contextFromUsage } from '../external.js';
import { claudeTranscriptUsage } from '../../core/session-probe.js';
import { envValue, probeClaudeSettings } from '../../core/config-probe.js';
import { firstVerified, verifiedText, verifiedThreshold, verifiedTokens, verifiedWindow } from '../../core/ladder.js';

/**
 * Per-field status resolution for Claude Code (used by the external adapter and
 * the in-harness worker, so both surfaces apply one ladder).
 *
 * Layers: native stream-json result (or the plugin's live session usage) >
 * persisted transcript > environment > settings. Claude applies the settings
 * `env` block over the inherited process environment, so for the same key the
 * settings value is the effective one; the harness's own precedence is mirrored
 * instead of assuming the contract's default order. `CLAUDE_CODE_EFFORT_LEVEL`
 * is the documented exception: it overrides the settings `effortLevel`.
 */
export interface ClaudeNativeStatus {
  used?: unknown;
  window?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
  percent?: unknown;
  runtimeVersion?: unknown;
}

export interface ClaudeStatusDetails {
  model: string | null;
  reasoningEffort: string | null;
  context: ContextInfo;
  autoCompact?: AutoCompact;
  modelVerification: 'reported' | 'configured-only' | 'unknown';
  fieldStates?: Record<string, 'unsupported' | 'unavailable' | 'unknown'>;
  notices?: { code: string; impact: 'none'; action_required: false; message: string }[];
  unavailable: string[];
  runtimeVersion?: string | null;
}

/** Env layer number: absent variables must skip the layer, not become 0. */
const envNumber = (name: string): number | null => {
  const value = envValue(name);
  return value === null ? null : Number(value);
};

export async function resolveClaudeStatus(workspace: string, sessionId: string | undefined, native: ClaudeNativeStatus): Promise<ClaudeStatusDetails> {
  let used = verifiedTokens(native.used);
  let usedSource: 'native' | 'session' | null = used !== null ? 'native' : null;
  let window = verifiedWindow(native.window);
  let windowSource: 'native' | 'session' | null = window !== null ? 'native' : null;
  let model = verifiedText(native.model);
  let modelSource: 'native' | 'session' | null = model !== null ? 'native' : null;
  let reasoningEffort = verifiedText(native.reasoningEffort);
  const reasoningEffortSource: 'native' | 'session' = reasoningEffort !== null ? 'native' : 'session';
  const nativePercent = typeof native.percent === 'number' && Number.isFinite(native.percent) ? native.percent : null;

  // Layer 2: persisted transcript, for exactly the fields still missing.
  if (used === null || window === null || model === null || reasoningEffort === null) {
    const probe = await claudeTranscriptUsage(workspace, sessionId).catch(() => null);
    if (used === null) { used = verifiedTokens(probe?.used); if (used !== null) usedSource = 'session'; }
    if (window === null) { window = verifiedWindow(probe?.window); if (window !== null) windowSource = 'session'; }
    if (model === null) { model = verifiedText(probe?.model); if (model !== null) modelSource = 'session'; }
    if (reasoningEffort === null) reasoningEffort = verifiedText(probe?.reasoningEffort);
  }

  // Layers 3/4: settings `env` (local project > project > user) and process env.
  const settings = await probeClaudeSettings(workspace, undefined, [
    'ANTHROPIC_MODEL', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  ]).catch(() => ({ env: [] as { value: string; source: 'config:project' | 'config:user' }[], effortLevel: null, autoCompactWindow: null }));
  // The batch probe does not tag values by key; re-probe per key so a
  // higher-precedence file without the key cannot shadow a lower file with it.
  const byKey = (key: string) => probeClaudeSettings(workspace, undefined, [key]);
  const modelSettings = await byKey('ANTHROPIC_MODEL').catch(() => ({ env: [] as { value: string; source: 'config:project' | 'config:user' }[] }));
  const windowSettings = await byKey('CLAUDE_CODE_MAX_CONTEXT_TOKENS').catch(() => ({ env: [] as { value: string; source: 'config:project' | 'config:user' }[] }));
  const autoSettings = await byKey('CLAUDE_CODE_AUTO_COMPACT_WINDOW').catch(() => ({ env: [] as { value: string; source: 'config:project' | 'config:user' }[] }));

  const modelField = firstVerified<string>([
    { value: model, source: modelSource ?? 'native' },
    { value: envValue('ANTHROPIC_MODEL'), source: 'env' },
    { value: modelSettings.env[0]?.value ?? null, source: modelSettings.env[0]?.source ?? 'config' },
  ]);
  const windowField = firstVerified<number>([
    { value: window, source: windowSource ?? 'native' },
    { value: verifiedWindow(envNumber('CLAUDE_CODE_MAX_CONTEXT_TOKENS')), source: 'env' },
    { value: verifiedWindow(Number(windowSettings.env[0]?.value)), source: windowSettings.env[0]?.source ?? 'config' },
  ]);
  // Env before config: CLAUDE_CODE_EFFORT_LEVEL overrides settings effortLevel.
  const reasoningEffortField = firstVerified<string>([
    { value: reasoningEffort, source: reasoningEffortSource },
    { value: envValue('CLAUDE_CODE_EFFORT_LEVEL'), source: 'env' },
    { value: settings.effortLevel?.value ?? null, source: settings.effortLevel?.source ?? 'config' },
  ]);
  const autoField = firstVerified<number>([
    { value: verifiedThreshold(envNumber('CLAUDE_CODE_AUTO_COMPACT_WINDOW')), source: 'env' },
    { value: verifiedThreshold(Number(autoSettings.env[0]?.value)), source: autoSettings.env[0]?.source ?? 'config' },
    { value: settings.autoCompactWindow?.value ?? null, source: settings.autoCompactWindow?.source ?? 'config' },
  ]);

  const usedValue = used;
  const windowValue = windowField?.value ?? null;
  const context = contextFromUsage(usedValue, windowValue);
  // Native percent only when the inputs are missing; otherwise derive locally.
  if (context.percent === null && nativePercent !== null && (usedValue === null || windowValue === null)) {
    context.percent = Math.min(100, Math.round(nativePercent * 10) / 10);
    context.percentSource = 'native';
  }
  context.sources = {
    window: windowField?.source ?? null,
    used: usedValue !== null ? usedSource : null,
    percent: context.percentSource === 'native' ? 'native' : context.percent !== null ? 'derived' : null,
  };

  // INFRA-085 A: sanitize the auto-compact ratio. A configured threshold above
  // the observed window cannot be expressed as a (0,1] ratio; report the ratio
  // as null with a notice instead of invalidating the whole status or clamping
  // to a false 100%.
  const notices: { code: string; impact: 'none'; action_required: false; message: string }[] = [];
  let autoCompact: AutoCompact | undefined;
  if (autoField) {
    const tokens = verifiedThreshold(autoField.value);
    let ratio: number | null = null;
    if (tokens !== null && windowValue !== null && windowValue > 0) {
      const raw = tokens / windowValue;
      if (raw > 0 && raw <= 1) ratio = Math.round(raw * 1000) / 1000;
      else if (raw > 1) {
        notices.push({
          code: 'auto-compact-threshold-exceeds-window', impact: 'none', action_required: false,
          message: 'The configured auto-compact threshold exceeds the observed context window; the ratio is reported as unavailable while the threshold and window values remain valid.',
        });
      }
    }
    autoCompact = { tokens, ratio, source: autoField.source as AutoCompact['source'] };
  }

  const unavailable: string[] = [];
  if (!modelField) unavailable.push('model');
  if (windowValue === null) unavailable.push('context.window');
  if (usedValue === null) unavailable.push('context.used');
  const fieldStates: Record<string, 'unsupported' | 'unavailable' | 'unknown'> = {};
  if (!reasoningEffortField) fieldStates.reasoningEffort = 'unavailable';
  return {
    model: modelField?.value ?? null,
    reasoningEffort: reasoningEffortField?.value ?? null,
    context,
    ...(autoCompact ? { autoCompact } : {}),
    ...(notices.length ? { notices } : {}),
    modelVerification: !modelField ? 'unknown' : modelField.source === 'native' || modelField.source === 'session' ? 'reported' : 'configured-only',
    ...(Object.keys(fieldStates).length ? { fieldStates } : {}),
    runtimeVersion: typeof native.runtimeVersion === 'string' && native.runtimeVersion.trim() ? native.runtimeVersion.trim().slice(0, 256) : null,
    unavailable,
  };
}
