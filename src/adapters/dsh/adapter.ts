import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { AdapterContext, CarrierCommand, StatusDetails, NativeOutcome } from '../external.js';
import { ExternalExecutorAdapter, lastJson } from '../external.js';
import type { CapabilityDeclaration, Request } from '../../contract/types.js';
import type { HarnessId, Os } from '../../contract/states.js';
import type { ExecutorRecord } from '../../core/store.js';
import type { LogLine, ExecutorStatus } from '../executors.js';
import { declaration } from '../declarations.js';
import { resolveAi4aiStoreHome } from '../../core/ai4ai-home.js';
import { verifiedTokens } from '../../core/ladder.js';
import { executorDir } from '../executors.js';
import { readFile } from 'node:fs/promises';
import { resolveDshStatus } from './status.js';

/**
 * DeepSeek Harness adapter.
 *
 * The in-harness Cordis plugin implements same-session handoff; the external
 * adapter owns detached `dsh headless` processes. The web surface is verified
 * separately through an isolated DSH_HOME instance.
 */

/** Windows looks up executable extensions from PATHEXT; this is the documented fallback. */
export const DEFAULT_PATHEXT = ['.EXE', '.CMD', '.BAT'] as const;
/** Session ids are placed on a command line; reject anything outside this alphabet. */
const SESSION_ID = /^[A-Za-z0-9._:-]+$/;

export interface ExecutableResolverOptions {
  platform: NodeJS.Platform | 'linux' | 'darwin' | 'win32';
  env: NodeJS.ProcessEnv;
  /** Injectable for unit tests; defaults to a real file check. */
  exists?: (candidate: string) => boolean;
  isFile?: (candidate: string) => boolean;
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const declared = env.PATHEXT?.split(';').map(value => value.trim()).filter(Boolean) ?? [];
  const extensions = declared.length ? declared : [...DEFAULT_PATHEXT];
  // A name already carrying a known extension is tested as-is first.
  return extensions.map(value => value.startsWith('.') ? value : `.${value}`);
}

function hasKnownExtension(name: string, extensions: readonly string[]): boolean {
  return extensions.some(extension => name.toLowerCase().endsWith(extension.toLowerCase()));
}

function pathDirectories(platform: string, env: NodeJS.ProcessEnv): string[] {
  const delimiter = platform === 'win32' ? ';' : ':';
  return (env.PATH ?? '').split(delimiter).filter(Boolean);
}

/** Join with the target platform's separator, not the host's. */
function joinFor(platform: string, directory: string, name: string): string {
  return platform === 'win32'
    ? `${directory.replace(/[\\/]+$/, '')}\\${name}`
    : path.join(directory, name);
}

/**
 * Resolve an executable name the way Windows does: a bare name (or a name with
 * a non-executable extension) is tried against every PATHEXT suffix in each
 * PATH directory, case-insensitively. A path containing `%` is refused because
 * cmd.exe would expand it.
 */
export function resolveExecutable(name: string, options: ExecutableResolverOptions): string | undefined {
  const exists = options.exists ?? existsSync;
  const isFile = options.isFile ?? ((candidate: string) => { try { return statSync(candidate).isFile(); } catch { return false; } });
  if (!name || name.includes('%')) return undefined;
  const windows = options.platform === 'win32';
  const hasSeparator = name.includes('/') || name.includes('\\');
  const extensions = windows ? windowsExtensions(options.env) : [];
  const tryFile = (candidate: string): string | undefined => candidate.includes('%') ? undefined : exists(candidate) && isFile(candidate) ? candidate : undefined;
  const candidatesFor = (base: string): string[] => {
    if (!windows) return [base];
    const list: string[] = [];
    if (hasKnownExtension(base, extensions)) list.push(base);
    else for (const extension of extensions) list.push(base + extension);
    return list;
  };
  if (path.isAbsolute(name) || hasSeparator) {
    for (const candidate of candidatesFor(name)) {
      const found = tryFile(candidate);
      if (found) return found;
    }
    return undefined;
  }
  for (const directory of pathDirectories(String(options.platform), options.env)) {
    for (const candidate of candidatesFor(joinFor(String(options.platform), directory, name))) {
      const found = tryFile(candidate);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Build the single `/c` payload cmd.exe receives under `/d /s /c`.
 *
 * `/s` strips exactly the outer pair of quotes, leaving
 * `"C:\path with space\dsh.cmd" headless ...` for cmd's own parser. The whole
 * argv element therefore starts with two quotes and ends with one.
 */
export function windowsCommandLine(entry: string, args: readonly string[]): string {
  return `""${entry}" ${args.join(' ')}"`;
}

/** First executable `dsh` on PATH (PATHEXT-aware on Windows). */
function lookPath(name: string): string | undefined {
  return resolveExecutable(name, { platform: process.platform, env: process.env });
}

interface CommandPlan {
  command: string;
  prefix: string[];
  /** Set when the command is a Windows .cmd/.bat shim that needs cmd.exe. */
  entry?: string;
}

export class DshAdapter extends ExternalExecutorAdapter {
  readonly harness: HarnessId = 'dsh';

  /**
   * DSH headless accepts no model or reasoning-effort selector (verified with
   * `dsh headless --help`). Refuse the override instead of building a command
   * that is guaranteed to exit 1. Handoff behavior is unchanged.
   */
  async spawn(request: Request, ctx: AdapterContext): Promise<NativeOutcome> {
    const unavailable: string[] = [];
    if (request.spawn?.profile !== undefined || request.spawn?.surface === 'web') {
      // `dsh <profile>` selects the app: a headless carrier cannot use the web
      // profile, and the web app has no headless task protocol (INFRA-084).
      // Refuse instead of silently booting the wrong profile.
      return {
        status: 'unsupported',
        reason: 'DSH detached carriers boot the headless profile only; spawn.profile and the web surface are not implemented (dual-profile installation is the documented fallback)',
        unavailable: ['spawn.profile', 'spawn.surface.web'],
      };
    }
    if (request.model !== undefined) unavailable.push('spawn.model');
    if (request.reasoningEffort !== undefined) unavailable.push('spawn.reasoningEffort');
    if (unavailable.length) {
      return {
        status: 'unsupported',
        reason: `dsh headless does not accept model or reasoning-effort overrides (${unavailable.join(', ')}); configure the DSH profile instead and omit them`,
        unavailable,
      };
    }
    return super.spawn(request, ctx);
  }

  private command(): CommandPlan {
    if (process.env.AI4AI_DSH_ENTRY) {
      return { command: process.env.AI4AI_DSH_NODE || process.execPath, prefix: [process.env.AI4AI_DSH_ENTRY] };
    }
    // Explicit override first, then the installed runtime's own DSH_BIN (the
    // shell and the daemon that host the agent usually export it), then PATH.
    // A bare `dsh` remains the last resort so the failure mode is unchanged
    // when none of these is present.
    const explicit = process.env.AI4AI_DSH_BIN || process.env.DSH_BIN;
    if (process.platform === 'win32') {
      const requested = explicit ?? 'dsh';
      const resolved = resolveExecutable(requested, { platform: 'win32', env: process.env });
      if (!resolved) return { command: requested, prefix: [] };
      return /\.(?:cmd|bat)$/i.test(resolved)
        ? { command: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe', prefix: [], entry: resolved }
        : { command: resolved, prefix: [] };
    }
    if (explicit) return { command: explicit, prefix: [] };
    const found = lookPath('dsh');
    return { command: found || 'dsh', prefix: [] };
  }

  capabilities(os: Os): CapabilityDeclaration[] {
    // All three platforms were exercised in this release. macOS and native
    // Windows use the DSH_HOME credential chain (OPENCODE_API_KEY) rather than
    // a clean profile without credentials. On Windows the installer needs the
    // real JS entry (AI4AI_DSH_ENTRY) because a .cmd entry is refused, but the
    // carrier also accepts a .cmd wrapper. The Web interface was exercised as an
    // orchestration host on isolated dual-profile homes (never the live 3091).
    const linux = os === 'linux';
    const mac = os === 'darwin';
    const windows = os === 'windows';
    const reason = linux
      ? 'Detached dsh headless carriers were exercised with a real session and usage reporting; the Cordis plugin implements same-session surface replacement and the handoff journal/apply/successor path is verified. The Web interface was exercised as an orchestration host on an isolated dual-profile home: self status/handoff in the web session, then ai4ai spawn/status/message/stop of a detached headless executor. spawn model/effort overrides are unsupported.'
      : mac
        ? 'macOS headless handoff was exercised with a real provider from the DSH_HOME credential chain: the model invoked ai4ai_session itself, the successor turn ran in the same session with surface-replacement proof, and the detached carrier completed spawn/status/message×2/stop/error. The Web interface was exercised as an orchestration host on an isolated dual-profile home: self status/handoff in the web session, then ai4ai spawn/status/message/stop of a detached headless executor. spawn model/effort overrides are unsupported.'
        : 'Native Windows headless handoff, spawn/status/message×2/stop/error and the .cmd carrier were exercised with the DSH plugin-manager profile and the real JS entry (AI4AI_DSH_ENTRY); the installer refuses a .cmd entry but succeeds with the JS entry. The Web interface was exercised as an orchestration host on an isolated dual-profile home: self status/handoff in the web session, then ai4ai spawn/status/message/stop of a detached headless executor. spawn model/effort overrides are unsupported.';
    const carrier = 'supported' as const;
    const headlessHandoff = 'supported' as const;
    const webLevel = 'supported' as const;
    const headless = {
      handoff: { availability: headlessHandoff, modes: ['restart', 'compact'] as ('compact' | 'restart')[], self: { modes: ['restart', 'compact'] as ('compact' | 'restart' | 'rotation')[] }, executor: { modes: ['restart', 'compact', 'rotation'] as ('compact' | 'restart' | 'rotation')[] } },
      spawn: {
        availability: carrier, maxConcurrent: 4,
        persistenceModes: ['one-shot', 'persistent'] as ('one-shot' | 'persistent')[],
        surfaces: ['headless'] as ('headless' | 'web')[],
        permissionModes: [] as ('bypassPermissions' | 'dontAsk')[],
        mcpFilter: 'not-tested' as const,
      },
      events: 'normalized' as const,
      status: { availability: carrier, model: carrier, reasoningEffort: carrier, context: carrier, percentSource: 'derived' as const, autoCompact: 'supported' as const },
      evidence: `matrix:dsh/${os}/headless/2026-11-22`,
    };
    const web = {
      handoff: { availability: webLevel, modes: ['restart', 'compact'] as ('compact' | 'restart')[], self: { modes: ['restart', 'compact'] as ('compact' | 'restart' | 'rotation')[] } },
      spawn: {
        availability: webLevel, maxConcurrent: 4,
        persistenceModes: ['one-shot', 'persistent'] as ('one-shot' | 'persistent')[],
        surfaces: ['headless'] as ('headless' | 'web')[],
        permissionModes: [] as ('bypassPermissions' | 'dontAsk')[],
        mcpFilter: 'not-tested' as const,
      },
      events: 'normalized' as const,
      status: { availability: webLevel, model: webLevel, reasoningEffort: webLevel, context: webLevel, percentSource: 'derived' as const, autoCompact: 'supported' as const },
      evidence: `matrix:dsh/${os}/web/2026-11-23`,
    };
    const webReason = linux
      ? 'The Linux Web interface is an orchestration host, not an executor carrier: ai4ai_session self status/handoff completed inside the web session and the web app bundle disables compaction-basic and the ai4ai bundle re-enables it so self compact runs natively in the same session, and the adapted Parallax team flow ran from that session through ai4ai spawn -> persistent headless executors (dual-profile install), a forced rotation (stop, spawn, message), finish and the completion receipt. spawn.surface "web" stays structurally unsupported; detached carriers boot the headless profile. spawn model/effort overrides are unsupported.'
      : mac
        ? 'The macOS Web interface is an orchestration host, not an executor carrier: self status/handoff completed inside the web session (the ai4ai bundle re-enables compaction-basic for native self compact), and the adapted Parallax solo and team flows ran from that session through ai4ai spawn -> headless executors (dual-profile install) with message, stop/finish and the receipts. spawn.surface "web" stays structurally unsupported. spawn model/effort overrides are unsupported.'
        : 'The native Windows Web interface is an orchestration host, not an executor carrier: self status/handoff completed inside the web session (the ai4ai bundle re-enables compaction-basic for native self compact), and the adapted Parallax solo and team flows ran from that session through ai4ai spawn -> headless executors (dual-profile install) with message, stop/finish and the receipts. spawn.surface "web" stays structurally unsupported. spawn model/effort overrides are unsupported.';
    return [
      declaration({ harness: 'dsh', os, interface: 'headless', reason, ...headless }),
      declaration({ harness: 'dsh', os, interface: 'web', reason: webReason, ...web }),
    ];
  }

  protected async carrier(request: Parameters<ExternalExecutorAdapter['spawn']>[0], ctx: AdapterContext, _executorId: string, resumeSessionId?: string): Promise<CarrierCommand> {
    if (resumeSessionId !== undefined && !SESSION_ID.test(resumeSessionId)) {
      // Never silently fall back to a session-less turn: that would lose the
      // previous context the caller is continuing.
      const error = new Error(`Refusing an unsafe DSH session id: ${JSON.stringify(resumeSessionId).slice(0, 120)}`) as Error & { code?: string };
      error.code = 'message-session-unknown';
      throw error;
    }
    const plan = this.command();
    // DSH headless has no model/effort flags; the profile owns those choices.
    const headless = ['headless', '--json', '-'];
    if (resumeSessionId) headless.push('--session-id', resumeSessionId);
    const env: Record<string, string> = { DSH_SURFACE: 'headless' };
    if (process.env.DSH_HOME) env.DSH_HOME = process.env.DSH_HOME;
    // The ai4ai ledger store is AI4AI_HOME; pass it through so a detached
    // executor and the in-harness plugin share one ledger (DSH_HOME is the
    // DSH runtime home only).
    if (process.env.AI4AI_HOME) env.AI4AI_HOME = process.env.AI4AI_HOME;
    else env.AI4AI_HOME = resolveAi4aiStoreHome({ workspace: ctx.identity.workspace }).home;
    const sessionRegex = '"session(?:Id|ID|_id)"\\s*:\\s*"([^"]+)"';
    if (plan.entry) {
      return {
        command: plan.command,
        args: ['/d', '/s', '/c', windowsCommandLine(plan.entry, [...plan.prefix, ...headless])],
        env,
        windowsVerbatimArguments: true,
        sessionRegex,
      };
    }
    return {
      command: plan.command,
      args: [...plan.prefix, ...headless],
      env,
      sessionRegex,
    };
  }

  protected async statusDetails(record: ExecutorRecord, status: ExecutorStatus, log: LogLine[], ctx: AdapterContext): Promise<StatusDetails> {
    // Layer 1: headless `--json` events. They carry usage but no model, effort
    // or context window (verified against the projection and real logs). The
    // shared resolver walks the persisted session store and config per field.
    const event = lastJson(log, value => value.type === 'status' && value.phase === 'step_end' && typeof value.usage === 'object');
    const usage = event?.usage as Record<string, unknown> | undefined;
    // DSH reports prompt input separately from cache reads/writes (total =
    // input + output + cacheRead). `used` includes prompt plus cache.
    const input = usage && typeof usage.inputTokens === 'number' ? usage.inputTokens : null;
    const cached = usage
      ? ['cacheReadTokens', 'cacheWriteTokens', 'cacheCreationTokens'].reduce((sum, key) => sum + (typeof usage[key] === 'number' ? usage[key] as number : 0), 0)
      : 0;
    let dshHome: string | undefined;
    let dshEntry: string | undefined;
    try {
      const spec = JSON.parse(await readFile(path.join(executorDir(ctx.home, record.executorId), 'spec.json'), 'utf8')) as { env?: Record<string, string>; args?: string[] };
      dshHome = spec.env?.DSH_HOME;
      dshEntry = spec.env?.AI4AI_DSH_ENTRY ?? spec.args?.find(arg => typeof arg === 'string' && arg.endsWith('.js'));
    } catch { /* the environment may not be recorded */ }
    // Detached executors always run the headless profile; the config layer must
    // read that profile's patch and bundle defaults, not the web app's.
    return resolveDshStatus(ctx.identity.workspace, status.sessionId, {
      used: input === null ? null : verifiedTokens(input + cached),
    }, dshHome, { profile: 'headless', ...(dshEntry ? { dshEntry } : {}) });
  }
}

export const dshAdapter = new DshAdapter();
export const dshPluginRoot = (home: string): string => path.join(home, 'runtime', 'dsh-plugin');
