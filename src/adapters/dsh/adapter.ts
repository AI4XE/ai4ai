import path from 'node:path';
import { existsSync } from 'node:fs';
import type { AdapterContext, CarrierCommand, StatusDetails } from '../external.js';
import { ExternalExecutorAdapter, lastJson } from '../external.js';
import type { CapabilityDeclaration } from '../../contract/types.js';
import type { HarnessId, Os } from '../../contract/states.js';
import type { ExecutorRecord } from '../../core/store.js';
import type { LogLine, ExecutorStatus } from '../executors.js';
import { declaration } from '../declarations.js';
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
/** First executable `dsh` on PATH (PATHEXT-aware on Windows). */
function lookPath(name: string): string | undefined {
  const search = process.env.PATH;
  if (!search) return undefined;
  // The carrier is spawned without a shell, so only real executables count on
  // Windows: a .cmd/.bat shim cannot be executed directly.
  const extensions = process.platform === 'win32' ? ['.exe'] : [''];
  for (const directory of search.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension.toLowerCase());
      try { if (existsSync(candidate)) return candidate; } catch { /* keep searching */ }
    }
  }
  return undefined;
}

export class DshAdapter extends ExternalExecutorAdapter {
  readonly harness: HarnessId = 'dsh';

  private command(): { command: string; prefix: string[] } {
    if (process.env.AI4AI_DSH_ENTRY) {
      return { command: process.env.AI4AI_DSH_NODE || process.execPath, prefix: [process.env.AI4AI_DSH_ENTRY] };
    }
    // Explicit override first, then the installed runtime's own DSH_BIN (the
    // shell and the daemon that host the agent usually export it), then PATH.
    // A bare `dsh` remains the last resort so the failure mode is unchanged
    // when none of these is present.
    const explicit = process.env.AI4AI_DSH_BIN || process.env.DSH_BIN;
    if (explicit) return { command: explicit, prefix: [] };
    const found = lookPath('dsh');
    return { command: found || 'dsh', prefix: [] };
  }

  capabilities(os: Os): CapabilityDeclaration[] {
    const linux = os === 'linux';
    const mac = os === 'darwin';
    const windows = os === 'windows';
    const reason = linux
      ? 'Detached dsh headless carriers were exercised with a real session and usage reporting; the Cordis plugin implements same-session surface replacement and the handoff journal/apply/successor path is verified.'
      : mac
        ? 'macOS headless carrier and the Cordis same-session handoff were verified with the installed DSH and its existing credential path; detached spawn/status use the same carrier.'
        : 'Native Windows headless spawn/status and the Cordis same-session handoff were verified with the installed DSH runtime and a new test profile.';
    const carrier = linux || mac || windows ? 'supported' as const : 'not-tested' as const;
    const handoffLevel = linux || mac || windows ? 'supported' as const : 'not-tested' as const;
    const common = {
      handoff: { availability: handoffLevel, modes: ['restart'] as ('compact' | 'restart')[], tmuxFallback: 'off' as const },
      spawn: { availability: carrier, maxConcurrent: 4 },
      status: { availability: carrier, model: 'not-tested' as const, reasoningEffort: 'not-tested' as const, context: carrier, percentSource: 'derived' as const },
      ...(linux || mac ? { evidence: `matrix:dsh/${os}/headless/2026-11-18` } : {}),
    };
    return [
      declaration({ harness: 'dsh', os, interface: 'headless', reason, ...common }),
      declaration({ harness: 'dsh', os, interface: 'web', reason, ...common, status: { ...common.status, percentSource: 'native' as const } }),
    ];
  }

  protected async carrier(request: Parameters<ExternalExecutorAdapter['spawn']>[0], ctx: AdapterContext, _executorId: string, resumeSessionId?: string): Promise<CarrierCommand> {
    const { command, prefix } = this.command();
    const args = [...prefix, 'headless', '--json', '-'];
    if (resumeSessionId) args.push('--session-id', resumeSessionId);
    if (request.model) args.push('--model', request.model);
    return {
      command,
      args,
      env: { ...(process.env.DSH_HOME ? { DSH_HOME: process.env.DSH_HOME } : {}) },
      sessionRegex: '"session(?:Id|ID|_id)"\\s*:\\s*"([^"]+)"',
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
    try {
      const spec = JSON.parse(await readFile(path.join(executorDir(ctx.home, record.executorId), 'spec.json'), 'utf8')) as { env?: Record<string, string> };
      dshHome = spec.env?.DSH_HOME;
    } catch { /* the environment may not be recorded */ }
    return resolveDshStatus(ctx.identity.workspace, status.sessionId, {
      used: input === null ? null : verifiedTokens(input + cached),
    }, dshHome);
  }
}

export const dshAdapter = new DshAdapter();
export const dshPluginRoot = (home: string): string => path.join(home, 'runtime', 'dsh-plugin');
