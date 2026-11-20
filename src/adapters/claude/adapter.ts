import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AdapterContext, CarrierCommand, StatusDetails } from '../external.js';
import { ExternalExecutorAdapter, lastJson } from '../external.js';
import { resolveClaudeStatus } from './status.js';
import { verifiedText, verifiedTokens, verifiedWindow } from '../../core/ladder.js';
import type { CapabilityDeclaration } from '../../contract/types.js';
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
    const verified = os === 'linux' || os === 'darwin';
    const reason = os === 'linux'
      ? 'The mods plugin loads and both native handoff modes completed in place: restart via the built-in /clear (new session, same process) and compact via the native safe point; detached carriers spawn, report status and survive the parent. Exercised on Linux.'
      : os === 'darwin'
        ? 'The mods plugin loads and the native in-place handoff completed on macOS; detached carriers spawn and report status with model and context. Exercised on macOS.'
        : 'The mods plugin and the detached carrier are implemented; native Windows is out of scope (WSL counts as Linux) and was not exercised.';
    const level = verified ? 'supported' as const : 'not-tested' as const;
    const common = {
      handoff: { availability: level, modes: ['compact', 'restart'] as ('compact' | 'restart')[], tmuxFallback: 'off' as const },
      spawn: { availability: level, maxConcurrent: 4 },
      status: { availability: level, model: level, reasoningEffort: 'unsupported' as const, context: level, percentSource: 'derived' as const },
      ...(verified ? { evidence: `matrix:claude-code/${os}/2026-11-18` } : {}),
    };
    return [
      declaration({ harness: 'claude-code', os, interface: 'tui', reason, ...common }),
      declaration({ harness: 'claude-code', os, interface: 'headless', reason, ...common }),
    ];
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
