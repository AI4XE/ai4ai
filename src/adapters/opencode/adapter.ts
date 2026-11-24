import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AdapterContext, CarrierCommand, StatusDetails, NativeOutcome } from '../external.js';
import { ExternalExecutorAdapter, contextFromUsage, lastJson } from '../external.js';
import { openCodeSessionUsage } from '../../core/session-probe.js';
import { probeOpenCodeConfig, openCodeAutoCompact } from '../../core/config-probe.js';
import { firstVerified, verifiedText, verifiedTokens } from '../../core/ladder.js';
import { envValue } from '../../core/config-probe.js';
import type { CapabilityDeclaration, Request } from '../../contract/types.js';
import type { HarnessId, Os } from '../../contract/states.js';
import type { ExecutorRecord } from '../../core/store.js';
import { resolveNodeRuntime, type LogLine, type ExecutorStatus } from '../executors.js';
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
    // Linux and macOS were exercised in this release. macOS used the OpenCode
    // 2.3.2 binary at ~/data/opencode-2.3.2, not the older 1.19.6 on PATH:
    // handoff (pending→scheduled→applied→completed, same session) and the
    // detached carrier (spawn/status/message×2/stop/error) both completed.
    // The TUI export stores assistant tokens as tokens{input,output,reasoning,
    // cache}, so prompt occupancy and output-inclusive occupancy are native.
    const verified = os === 'linux' || os === 'darwin';
    const reason = os === 'linux'
      ? 'The native plugin replacement supplies a fresh window containing only the task material (restart) and was exercised on Linux with a real handoff (pending, scheduled, applied, completed) and a successor turn; the detached carrier and status mapping were also exercised.'
      : os === 'darwin'
        ? 'macOS was exercised with OpenCode 2.3.2 (not the older 1.19.6 on PATH): the native plugin handoff completed in the same session (pending→scheduled→applied→completed) with the old codeword absent from the replaced context, and the detached carrier completed spawn/status/message×2/stop/error. A free OpenCode Go model was used because the account weekly quota was exhausted; the mechanism is model-agnostic.'
        : 'In-harness plugin implements a restart-equivalent in-session handoff; detached opencode run processes implement spawn. Native Windows is out of scope (WSL counts as Linux).';
    const level = verified ? 'supported' as const : 'not-tested' as const;
    // The native plugin runs inside an interactive session and its API exposes
    // no surface signal, so it declares `tui` only rather than fabricating a
    // headless identity. A detached `opencode run` executor cannot replace its
    // context in place (the shared external adapter refuses), so headless
    // handoff is declared unsupported instead of over-claiming.
    const common = {
      spawn: {
        availability: level, maxConcurrent: 4,
        persistenceModes: ['one-shot', 'persistent'] as ('one-shot' | 'persistent')[],
        surfaces: ['headless'] as ('headless' | 'web')[],
        permissionModes: [] as ('bypassPermissions' | 'dontAsk')[],
        mcpFilter: 'not-tested' as const,
      },
      events: 'normalized' as const,
      status: { availability: level, model: level, reasoningEffort: level, context: verified ? 'supported' as const : 'not-tested' as const, percentSource: 'derived' as const, autoCompact: 'supported' as const },
    };
    return [
      declaration({
        harness: 'opencode', os, interface: 'tui', reason,
        handoff: { availability: level, modes: ['restart', 'compact'] as ('compact' | 'restart')[], self: { modes: ['restart', 'compact'] as ('compact' | 'restart' | 'rotation')[] }, executor: { modes: ['restart', 'compact', 'rotation'] as ('compact' | 'restart' | 'rotation')[] } },
        ...common,
        ...(verified ? { evidence: `matrix:opencode/${os}/tui/2026-11-21` } : {}),
      }),
      declaration({
        harness: 'opencode', os, interface: 'headless',
        reason: 'A detached opencode executor loads the same native plugin; restart and compact replace or summarize the window in place, and an executor-target request is consumed through the prompt/compaction hooks.',
        handoff: { availability: level, modes: ['restart', 'compact'] as ('compact' | 'restart')[], self: { modes: ['restart', 'compact'] as ('compact' | 'restart' | 'rotation')[] }, executor: { modes: ['restart', 'compact', 'rotation'] as ('compact' | 'restart' | 'rotation')[] } },
        ...common,
        ...(verified ? { evidence: `matrix:opencode/${os}/headless/2026-11-24` } : {}),
      }),
    ];
  }

  /**
   * The carrier selects `request.model || AI4AI_OPENCODE_MODEL`; persist that
   * effective value so a resumed turn keeps the same model even when the
   * supervisor's environment differs from the spawning caller's.
   */
  protected persistedModel(request: Request): string | undefined {
    return request.model || process.env.AI4AI_OPENCODE_MODEL || undefined;
  }

  /**
   * OpenCode's detached `run` has no reasoning-effort selector; the model is
   * the only per-request override the carrier can apply.
   */
  async spawn(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    if (request.reasoningEffort !== undefined) {
      return {
        status: 'unsupported',
        reason: 'opencode detached runs have no reasoning-effort selector; omit reasoningEffort and configure the model instead',
        unavailable: ['spawn.reasoningEffort'],
      };
    }
    return super.spawn(request, ctx);
  }

  protected async carrier(request: Parameters<ExternalExecutorAdapter['spawn']>[0], ctx: AdapterContext, _executorId: string, resumeSessionId?: string): Promise<CarrierCommand> {
    const command = openCodeBinary(ctx.home);
    if (!command) throw new Error('OpenCode executable not found; set AI4AI_OPENCODE_BIN or put opencode on PATH');
    // Persistent executors are backed by one per-executor `opencode serve`;
    // each turn attaches to it, so the project plugin (and the ai4ai tool) is
    // loaded inside the server rather than a throwaway `run` process.
    if (request.spawn?.persistence === 'persistent') {
      const runner = fileURLToPath(new URL('./serve-carrier.js', import.meta.url));
      const model = request.model || process.env.AI4AI_OPENCODE_MODEL;
      return {
        command: resolveNodeRuntime(),
        args: [runner, ...(resumeSessionId ? ['--session', resumeSessionId] : []), ...(model ? ['--model', model] : [])],
        env: {
          AI4AI_OPENCODE_BIN: command,
          AI4AI_OPENCODE_CWD: ctx.identity.workspace,
          AI4AI_OPENCODE_SURFACE: 'headless',
          ...(model ? { AI4AI_OPENCODE_MODEL: model } : {}),
        },
        sessionRegex: '"session(?:ID|_id)"\\s*:\\s*"([^"]+)"',
      };
    }
    // OpenCode 1.x rejects `--standalone` and requires an existing session id
    // for `--session`; 2.x accepts both. Probe the binary instead of assuming.
    let major = 2;
    try {
      const probe = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const match = /(\d+)\.\d+\.\d+/.exec(String(probe.stdout ?? ''));
      if (match) major = Number(match[1]);
    } catch { /* keep the 2.x shape when the probe fails */ }
    // One session selector only: resume the existing session or create one.
    const args = ['run', '--format', 'json'];
    if (major >= 2) {
      args.push('--standalone', '--session', resumeSessionId ?? `ses_ai4ai_${randomUUID().replaceAll('-', '')}`);
    } else {
      args.push('--auto');
      if (resumeSessionId) args.push('--session', resumeSessionId);
    }
    const model = request.model || process.env.AI4AI_OPENCODE_MODEL;
    if (model) args.push('--model', model);
    return { command, args, sessionRegex: '"session(?:ID|_id)"\\s*:\\s*"([^"]+)"' };
  }

  protected async statusDetails(record: ExecutorRecord, status: ExecutorStatus, log: LogLine[], ctx: AdapterContext): Promise<StatusDetails> {
    // Layer 1: the live `run --format json` events.
    const message = lastJson(log, value => typeof value.sessionID === 'string' || typeof value.session_id === 'string');
    const usage = lastJson(log, value => {
      const part = value.part as Record<string, unknown> | undefined;
      return !!part && ((typeof part.tokens === 'object' && part.tokens !== null)
        || (typeof part.usage === 'object' && part.usage !== null));
    });
    const part = usage ? usage.part as Record<string, unknown> : undefined;
    const tokens = (part && typeof part.tokens === 'object' && part.tokens !== null ? part.tokens
      : part && typeof part.usage === 'object' && part.usage !== null ? part.usage : undefined) as Record<string, unknown> | undefined;
    // `used` is prompt/context occupancy: input plus cache reads/writes.
    // Generated output and reasoning are deliberately excluded so absolute
    // thresholds stay comparable with the other harnesses.
    const cache = tokens && typeof tokens.cache === 'object' && tokens.cache !== null ? tokens.cache as Record<string, unknown> : {};
    const input = tokens && typeof tokens.input === 'number' ? tokens.input as number : null;
    const cached = ['read', 'write'].reduce((sum, key) => sum + (typeof cache[key] === 'number' ? cache[key] as number : 0), 0);
    const nativeUsed = input === null ? null : verifiedTokens(input + cached);
    const nativeModel = message && typeof message.model === 'string' ? verifiedText(message.model) : null;

    // Layer 2: the persisted session store and its model catalog (window).
    const session = await openCodeSessionUsage(ctx.identity.workspace, status.sessionId ?? record.sessionId).catch(() => null);
    // Layer 4: configuration (model default, per-model limits, compaction buffer).
    // OpenCode exposes no model-selection environment variable, so the env layer
    // is genuinely N/A for this harness.
    const config = await probeOpenCodeConfig(ctx.identity.workspace).catch(() => null);

    const modelField = firstVerified<string>([
      { value: nativeModel, source: 'native' },
      { value: session?.model ?? null, source: 'session' },
      { value: envValue('AI4AI_OPENCODE_MODEL') ?? envValue('OPENCODE_MODEL'), source: 'env' },
      { value: config?.model?.value ?? null, source: config?.model?.source ?? 'config' },
    ]);
    const usedField = firstVerified<number>([
      { value: nativeUsed, source: 'native' },
      { value: session?.used ?? null, source: 'session' },
    ]);
    const windowField = firstVerified<number>([
      { value: session?.window ?? null, source: 'session' },
      { value: Number(envValue('AI4AI_OPENCODE_CONTEXT_WINDOW') ?? envValue('OPENCODE_CONTEXT_WINDOW')) || null, source: 'env' },
      { value: config?.window?.value ?? null, source: config?.window?.source ?? 'config' },
    ]);
    const reasoningEffortField = firstVerified<string>([
      { value: session?.reasoningEffort ?? null, source: 'session' },
      { value: envValue('AI4AI_OPENCODE_REASONING_EFFORT') ?? envValue('OPENCODE_REASONING_EFFORT'), source: 'env' },
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
    // OpenCode's ceiling: the window minus compaction.buffer (or the 15%/16k
    // default); compaction.auto=false is a disabled state, not a missing value.
    const derived = openCodeAutoCompact(config?.compaction ?? null, window);
    const autoCompact = derived.autoCompact;
    const autoCompactState = derived.fieldState;

    const unavailable: string[] = [];
    if (!modelField) unavailable.push('model');
    if (window === null) unavailable.push('context.window');
    if (used === null) unavailable.push('context.used');
    return {
      model: modelField?.value ?? null,
      reasoningEffort: reasoningEffortField?.value ?? null,
      fieldStates: {
        ...(reasoningEffortField ? {} : { reasoningEffort: session?.reasoningSupported === false ? ('unsupported' as const) : ('unknown' as const) }),
        ...(autoCompact ? {} : autoCompactState ? { 'context.autoCompact': autoCompactState } : {}),
      },
      context,
      ...(autoCompact ? { autoCompact } : {}),
      ...(modelField ? { modelVerification: modelField.source === 'native' || modelField.source === 'session' ? 'reported' as const : 'configured-only' as const } : {}),
      unavailable,
    };
  }
}

export const openCodeAdapter = new OpenCodeAdapter();
export const openCodePluginRoot = (home: string): string => path.join(home, 'runtime', 'opencode-plugin');
