import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AdapterContext, CarrierCommand, StatusDetails } from '../external.js';
import { ExternalExecutorAdapter, lastJson } from '../external.js';
import { resolveClaudeStatus } from './status.js';
import { verifiedText, verifiedTokens, verifiedWindow } from '../../core/ladder.js';
import { envValue, probeClaudeSettings } from '../../core/config-probe.js';
import type { CapabilityDeclaration, Request } from '../../contract/types.js';
import type { HarnessId, Os } from '../../contract/states.js';
import type { ExecutorRecord } from '../../core/store.js';
import type { LogLine, ExecutorStatus } from '../executors.js';
import { declaration } from '../declarations.js';

/**
 * Claude Code adapter.
 *
 * Self-handoff is implemented by the installed in-harness plugin (`mods`); the
 * external adapter owns detached executors (`claude -p` headless process).
 */
/** Resolve the installed Claude plugin directory across marketplace and versioned runtimes. */
export function claudePluginDir(home: string): string | undefined {
  const marketplace = path.join(home, 'marketplace', 'plugins', 'ai4ai');
  if (existsSync(path.join(marketplace, '.claude-plugin', 'plugin.json'))) return marketplace;
  const runtime = path.join(home, 'runtime');
  try {
    for (const entry of readdirSync(runtime)) {
      const candidate = path.join(runtime, entry, 'claude-plugin');
      if (existsSync(path.join(candidate, '.claude-plugin', 'plugin.json'))) return candidate;
    }
  } catch { /* no runtime tree */ }
  const direct = path.join(runtime, 'claude-plugin');
  return existsSync(path.join(direct, '.claude-plugin', 'plugin.json')) ? direct : undefined;
}

export class ClaudeAdapter extends ExternalExecutorAdapter {
  readonly harness: HarnessId = 'claude-code';

  capabilities(os: Os): CapabilityDeclaration[] {
    const linux = os === 'linux';
    const mac = os === 'darwin';
    // macOS proves both the handoff and the detached carrier in this release.
    const reason = linux
      ? 'The mods plugin loads and the zero-summary restart replaces the context in place through the native compact hook while keeping the session id; a disabled-compaction session is reported unsupported. Detached carriers spawn, report status and survive the parent. Exercised on Linux.'
      : mac
        ? 'The mods plugin loads and the zero-summary in-place restart completed on macOS with the session id preserved (handoff verified). The detached carrier was exercised on macOS with a real two-turn executor: spawn, status, message queued into the same session (both turn markers in the executor log), stop, and the error paths (unauthorized target, message to a completed executor) all completed.'
        : 'The mods plugin and the detached carrier are implemented; native Windows is out of scope (WSL counts as Linux) and was not exercised.';
    const carrier = linux || mac ? 'supported' as const : 'not-tested' as const;
    const common = {
      handoff: { availability: linux || mac ? 'supported' as const : 'not-tested' as const, modes: ['restart'] as ('compact' | 'restart')[] },
      spawn: { availability: carrier, maxConcurrent: 4 },
      status: { availability: carrier, model: carrier, reasoningEffort: 'unsupported' as const, context: carrier, percentSource: 'derived' as const },
      ...(linux || mac ? { evidence: `matrix:claude-code/${os}/2026-11-21` } : {}),
    };
    return [
      declaration({ harness: 'claude-code', os, interface: 'tui', reason, ...common }),
      declaration({ harness: 'claude-code', os, interface: 'headless', reason, ...common }),
    ];
  }

  /**
   * Persist the model a resumed turn must keep. The carrier passes `--model`
   * only when the request has one, so the effective value can come from the
   * settings `env` block (which overrides the inherited process environment)
   * or the process environment.
   */
  protected async persistedModel(request: Request, ctx: AdapterContext): Promise<string | undefined> {
    if (request.model) return request.model;
    const settings = await probeClaudeSettings(ctx.identity.workspace, undefined, ['ANTHROPIC_MODEL']).catch(() => null);
    return settings?.env[0]?.value ?? envValue('ANTHROPIC_MODEL') ?? undefined;
  }

  /** `CLAUDE_CODE_EFFORT_LEVEL` overrides the settings `effortLevel`. */
  protected async persistedReasoningEffort(request: Request, ctx: AdapterContext): Promise<string | undefined> {
    if (request.reasoningEffort) return request.reasoningEffort;
    const env = envValue('CLAUDE_CODE_EFFORT_LEVEL');
    if (env) return env;
    const settings = await probeClaudeSettings(ctx.identity.workspace, undefined, []).catch(() => null);
    return settings?.effortLevel?.value ?? undefined;
  }

  protected async carrier(request: Parameters<ExternalExecutorAdapter['spawn']>[0], ctx: AdapterContext, _executorId: string, resumeSessionId?: string): Promise<CarrierCommand> {
    // A detached executor has no one to answer permission prompts: run it in the
    // harness's non-interactive bypass mode, consistent with the spawn contract.
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'];
    // Resume selects the existing session; a new turn gets a fresh session id.
    // Never pass both: the CLI rejects two session selectors.
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    else args.push('--session-id', randomUUID());
    const plugin = claudePluginDir(ctx.home);
    if (plugin) args.push('--plugin-dir', plugin);
    if (request.model) args.push('--model', request.model);
    if (request.reasoningEffort) args.push('--effort', request.reasoningEffort);
    // A nested CLI must not inherit the parent's session markers: they bind it
    // to the orchestrator's transport and can make it hang or route elsewhere.
    // Only explicit overrides are persisted; the inherited environment is
    // filtered at launch so credentials never land in the executor state.
    const envExclude = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_ATTRIBUTION_HEADER', 'AI_AGENT'];
    const env: Record<string, string> = {};
    // Test/CI may point the carrier at an isolated Claude config so the user's
    // personal settings (including a different provider) do not override the
    // caller's intended route.
    if (process.env.AI4AI_CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.AI4AI_CLAUDE_CONFIG_DIR;
    return {
      command: process.env.AI4AI_CLAUDE_BIN || 'claude',
      args,
      env,
      envExclude,
      sessionRegex: '"session_id"\\s*:\\s*"([^"]+)"',
    };
  }

  protected async statusDetails(_record: ExecutorRecord, status: ExecutorStatus, log: LogLine[], ctx: AdapterContext): Promise<StatusDetails> {
    // Layer 1: the native stream-json result of the carrier turn. The shared
    // resolver then walks transcript > environment > settings per field.
    const result = lastJson(log, value => value.type === 'result' && typeof value.usage === 'object');
    let nativeUsed: number | null = null;
    let nativeModel: string | null = null;
    let nativeWindow: number | null = null;
    if (result) {
      const usage = (result.usage ?? {}) as Record<string, unknown>;
      const used = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
        .map(key => verifiedTokens(usage[key]) ?? 0)
        .reduce((sum, value) => sum + value, 0);
      nativeUsed = used > 0 ? used : null;
      const modelUsage = (result.modelUsage ?? {}) as Record<string, { contextWindow?: number }>;
      nativeModel = verifiedText(Object.keys(modelUsage)[0] ?? result.model);
      nativeWindow = nativeModel ? verifiedWindow(modelUsage[nativeModel]?.contextWindow) : null;
    }
    return resolveClaudeStatus(ctx.identity.workspace, status.sessionId, {
      used: nativeUsed, model: nativeModel, window: nativeWindow,
    });
  }
}

export const claudeAdapter = new ClaudeAdapter();
