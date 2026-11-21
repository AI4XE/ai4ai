import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AdapterContext, CarrierCommand, StatusDetails } from '../external.js';
import { ExternalExecutorAdapter, contextFromUsage, lastJson } from '../external.js';
import { openCodeSessionUsage } from '../../core/session-probe.js';
import { probeOpenCodeConfig } from '../../core/config-probe.js';
import { firstVerified, verifiedText, verifiedTokens } from '../../core/ladder.js';
import type { CapabilityDeclaration, Request } from '../../contract/types.js';
import type { HarnessId, Os } from '../../contract/states.js';
import type { ExecutorRecord } from '../../core/store.js';
import type { LogLine, ExecutorStatus } from '../executors.js';
import { declaration } from '../declarations.js';

/**
 * OpenCode adapter.
 *
 * The interactive session uses the native plugin (`ctx.session.compact`); the
 * external adapter owns detached `opencode run` processes.
 */

/** Resolve a harness binary against the caller's PATH so detached carriers do not depend on the supervisor PATH. */
function resolveBinary(name: string): string | undefined {
  if (path.isAbsolute(name)) return name;
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The binary recorded by the installer, so an in-harness plugin uses the same runtime. */
function recordedBinary(home?: string): string | undefined {
  // The CLI runtime snapshot is not inside the plugin repository, so check the
  // managed home first; the plugin package keeps the record at its own root.
  // Repositories are content-versioned (`opencode-plugin-repo-<revision>`).
  const candidates: string[] = [];
  if (home) {
    let entries: string[] = [];
    try { entries = readdirSync(home); } catch { entries = []; }
    for (const entry of entries.filter(name => name.startsWith('opencode-plugin-repo')).sort().reverse()) {
      candidates.push(path.join(home, entry, 'opencode-runtime.json'));
    }
  }
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    candidates.push(path.join(directory, 'opencode-runtime.json'));
    directory = path.dirname(directory);
  }
  for (const file of candidates) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as { opencode?: unknown };
      // Only an absolute, existing path is a usable carrier. A bare name would
      // resolve against the supervisor's PATH, which may differ from the one
      // the plugin was installed under.
      if (typeof value.opencode === 'string' && path.isAbsolute(value.opencode) && existsSync(value.opencode)) return value.opencode;
    } catch { /* try the next location */ }
  }
  return undefined;
}

/**
 * Resolve the executable that can start a detached `opencode run`.
 *
 * Priority: explicit configuration, the installer's absolute record, PATH, and
 * finally the binary running this plugin. OpenCode 2.x ships a compiled binary
 * as `process.execPath`, so an in-harness plugin can always spawn with the
 * exact runtime it is itself running on even when the install shell could not
 * resolve `opencode`. Returning undefined is a launch defect, not a silent
 * fallback to a name the supervisor cannot execute.
 */
function openCodeBinary(home?: string): string | undefined {
  const explicit = process.env.AI4AI_OPENCODE_BIN;
  if (explicit) return resolveBinary(explicit) ?? (path.isAbsolute(explicit) ? explicit : undefined);
  return recordedBinary(home) ?? resolveBinary('opencode') ?? (isOpenCodeExecutable(process.execPath) ? process.execPath : undefined);
}

function isOpenCodeExecutable(executable: string): boolean {
  return /(?:^|[\\/])opencode(?:\.exe)?$/i.test(executable) && existsSync(executable);
}

export class OpenCodeAdapter extends ExternalExecutorAdapter {
  readonly harness: HarnessId = 'opencode';

  capabilities(os: Os): CapabilityDeclaration[] {
    const verified = os === 'linux' || os === 'darwin';
    const reason = os === 'linux'
      ? 'The native plugin replacement supplies a fresh window containing only the task material (restart) and was exercised on Linux with a real handoff (pending, scheduled, applied, completed) and a successor turn; the detached carrier and status mapping were also exercised.'
      : os === 'darwin'
        ? 'The native plugin restart replacement and the detached carrier were exercised on macOS with runtime 2.3.2; the plugin requires the 2.x OpenCode plugin/session API.'
        : 'In-harness plugin implements a restart-equivalent in-session handoff; detached opencode run processes implement spawn. Native Windows is out of scope (WSL counts as Linux).';
    const level = verified ? 'supported' as const : 'not-tested' as const;
    const availability = level;
    const make = (surface: 'tui' | 'headless') => declaration({
      harness: 'opencode', os, interface: surface, reason,
      handoff: { availability, modes: ['restart'] as ('compact' | 'restart')[], tmuxFallback: 'off' },
      spawn: { availability, maxConcurrent: 4 },
      status: { availability, model: availability, reasoningEffort: 'unsupported', context: verified ? 'limited' as const : 'not-tested' as const, percentSource: 'derived' },
      ...(verified ? { evidence: `matrix:opencode/${os}/${surface}/2026-11-18` } : {}),
    });
    return [make('tui'), make('headless')];
  }

  /**
   * The carrier selects `request.model || AI4AI_OPENCODE_MODEL`; persist that
   * effective value so a resumed turn keeps the same model even when the
   * supervisor's environment differs from the spawning caller's.
   */
  protected persistedModel(request: Request): string | undefined {
    return request.model || process.env.AI4AI_OPENCODE_MODEL || undefined;
  }

  protected async carrier(request: Parameters<ExternalExecutorAdapter['spawn']>[0], ctx: AdapterContext, _executorId: string, resumeSessionId?: string): Promise<CarrierCommand> {
    // One session selector only: resume the existing session or create one.
    const args = ['run', '--standalone', '--format', 'json', '--session', resumeSessionId ?? `ses_ai4ai_${randomUUID().replaceAll('-', '')}`];
    const model = request.model || process.env.AI4AI_OPENCODE_MODEL;
    if (model) args.push('--model', model);
    const command = openCodeBinary(ctx.home);
    if (!command) throw new Error('OpenCode executable not found; set AI4AI_OPENCODE_BIN or put opencode on PATH');
    return { command, args, sessionRegex: '"session(?:ID|_id)"\\s*:\\s*"([^"]+)"' };
  }

  protected async statusDetails(_record: ExecutorRecord, status: ExecutorStatus, log: LogLine[], ctx: AdapterContext): Promise<StatusDetails> {
    // Layer 1: the live `run --format json` events.
    const message = lastJson(log, value => typeof value.sessionID === 'string' || typeof value.session_id === 'string');
    const usage = lastJson(log, value => {
      const part = value.part as Record<string, unknown> | undefined;
      return !!part && typeof part.tokens === 'object' && part.tokens !== null;
    });
    const tokens = usage ? (usage.part as Record<string, unknown>).tokens as Record<string, unknown> : undefined;
    // `used` is prompt/context occupancy: input plus cache reads/writes.
    // Generated output and reasoning are deliberately excluded so absolute
    // thresholds stay comparable with the other harnesses.
    const cache = tokens && typeof tokens.cache === 'object' && tokens.cache !== null ? tokens.cache as Record<string, unknown> : {};
    const input = tokens && typeof tokens.input === 'number' ? tokens.input as number : null;
    const cached = ['read', 'write'].reduce((sum, key) => sum + (typeof cache[key] === 'number' ? cache[key] as number : 0), 0);
    const nativeUsed = input === null ? null : verifiedTokens(input + cached);
    const nativeModel = message && typeof message.model === 'string' ? verifiedText(message.model) : null;

    // Layer 2: the persisted session store and its model catalog (window).
    const session = await openCodeSessionUsage(ctx.identity.workspace, status.sessionId).catch(() => null);
    // Layer 4: configuration (model default, per-model limits, compaction buffer).
    // OpenCode exposes no model-selection environment variable, so the env layer
    // is genuinely N/A for this harness.
    const config = await probeOpenCodeConfig(ctx.identity.workspace).catch(() => null);

    const modelField = firstVerified<string>([
      { value: nativeModel, source: 'native' },
      { value: session?.model ?? null, source: 'session' },
      { value: config?.model?.value ?? null, source: config?.model?.source ?? 'config' },
    ]);
    const usedField = firstVerified<number>([
      { value: nativeUsed, source: 'native' },
      { value: session?.used ?? null, source: 'session' },
    ]);
    const windowField = firstVerified<number>([
      { value: session?.window ?? null, source: 'session' },
      { value: config?.window?.value ?? null, source: config?.window?.source ?? 'config' },
    ]);
    const reasoningEffortField = firstVerified<string>([
      { value: session?.reasoningEffort ?? null, source: 'session' },
      { value: config?.reasoningEffort?.value ?? null, source: config?.reasoningEffort?.source ?? 'config' },
    ]);

    const used = usedField?.value ?? null;
    const window = windowField?.value ?? null;
    const context = contextFromUsage(used, window);
    context.sources = {
      window: windowField?.source ?? null,
      used: usedField?.source ?? null,
      percent: context.percent !== null ? 'derived' : null,
    };
    const autoCompact = config?.autoCompact
      ? { tokens: config.autoCompact.value.tokens, ratio: config.autoCompact.value.ratio, source: config.autoCompact.source }
      : undefined;

    const unavailable: string[] = [];
    if (!modelField) unavailable.push('model');
    if (window === null) unavailable.push('context.window');
    if (used === null) unavailable.push('context.used');
    return {
      model: modelField?.value ?? null,
      reasoningEffort: reasoningEffortField?.value ?? null,
      ...(reasoningEffortField ? {} : { fieldStates: { reasoningEffort: 'unavailable' as const } }),
      context,
      ...(autoCompact ? { autoCompact } : {}),
      ...(modelField ? { modelVerification: modelField.source === 'native' || modelField.source === 'session' ? 'reported' as const : 'configured-only' as const } : {}),
      unavailable,
    };
  }
}

export const openCodeAdapter = new OpenCodeAdapter();
export const openCodePluginRoot = (home: string): string => path.join(home, 'runtime', 'opencode-plugin');
