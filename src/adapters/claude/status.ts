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
}

export interface ClaudeStatusDetails {
  model: string | null;
  reasoningEffort: string | null;
  context: ContextInfo;
  autoCompact?: AutoCompact;
  modelVerification: 'reported' | 'configured-only' | 'unknown';
  fieldStates?: Record<string, 'unsupported' | 'unavailable' | 'unknown'>;
  unavailable: string[];
}

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
    { value: modelSettings.env[0]?.value ?? null, source: modelSettings.env[0]?.source ?? 'config' },
    { value: envValue('ANTHROPIC_MODEL'), source: 'env' },
  ]);
  const windowField = firstVerified<number>([
    { value: window, source: windowSource ?? 'native' },
    { value: verifiedWindow(Number(windowSettings.env[0]?.value)), source: windowSettings.env[0]?.source ?? 'config' },
    { value: verifiedWindow(Number(envValue('CLAUDE_CODE_MAX_CONTEXT_TOKENS'))), source: 'env' },
  ]);
  // Env before config: CLAUDE_CODE_EFFORT_LEVEL overrides settings effortLevel.
  const reasoningEffortField = firstVerified<string>([
    { value: reasoningEffort, source: reasoningEffortSource },
    { value: envValue('CLAUDE_CODE_EFFORT_LEVEL'), source: 'env' },
    { value: settings.effortLevel?.value ?? null, source: settings.effortLevel?.source ?? 'config' },
  ]);
  const autoField = firstVerified<number>([
    { value: verifiedThreshold(Number(autoSettings.env[0]?.value)), source: autoSettings.env[0]?.source ?? 'config' },
    { value: settings.autoCompactWindow?.value ?? null, source: settings.autoCompactWindow?.source ?? 'config' },
    { value: verifiedThreshold(Number(envValue('CLAUDE_CODE_AUTO_COMPACT_WINDOW'))), source: 'env' },
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

  const autoCompact = autoField
    ? { tokens: autoField.value, ratio: windowValue && windowValue > 0 ? Math.round((autoField.value / windowValue) * 1000) / 1000 : null, source: autoField.source as AutoCompact['source'] }
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
