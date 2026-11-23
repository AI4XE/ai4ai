/**
 * Default spawn environment policy.
 *
 * A detached executor must never inherit the orchestrator's messaging
 * transport, bot tokens, tmux session markers or host provider route: those
 * bind the executor to the caller's control channel and can silently redirect
 * or hang it. The same policy is applied at launch and again by the
 * supervisor, for every harness. Callers may only add names to remove
 * (`spawn.envExclude`); nothing here can be re-enabled.
 */

/** Exact variable names removed from every spawned executor. */
export const DEFAULT_ENV_STRIP_EXACT: readonly string[] = [
  'CC_SESSION_KEY',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SSE_TOKEN',
  'CLAUDECODE',
  'AI_AGENT',
  'TMUX',
  'TMUX_PANE',
];

/** Prefix families removed from every spawned executor. */
export const DEFAULT_ENV_STRIP_PREFIX: readonly string[] = [
  'TELEGRAM_',
  'ANTHROPIC_',
  'CLAUDE_CODE_MESSAGING_',
  'CLAUDE_CODE_SSE_',
];

/** Suffix families removed from every spawned executor. */
export const DEFAULT_ENV_STRIP_SUFFIX: readonly string[] = [
  '_BOT_TOKEN',
  '_SESSION_DRIVER',
];

export function shouldStripEnv(name: string): boolean {
  if (DEFAULT_ENV_STRIP_EXACT.includes(name)) return true;
  if (DEFAULT_ENV_STRIP_PREFIX.some(prefix => name.startsWith(prefix))) return true;
  return DEFAULT_ENV_STRIP_SUFFIX.some(suffix => name.endsWith(suffix));
}

/**
 * Filter an environment: built-in defaults plus the caller's additive list.
 * `explicit` values supplied by the adapter (trusted carrier settings such as
 * CLAUDE_CONFIG_DIR) are merged afterwards so a carrier keeps its own knobs.
 */
export function spawnEnvironment(
  inherited: NodeJS.ProcessEnv,
  options: { envExclude?: readonly string[]; explicit?: Record<string, string> } = {},
): Record<string, string> {
  const extra = new Set(options.envExclude ?? []);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    if (shouldStripEnv(name) || extra.has(name)) continue;
    env[name] = value;
  }
  Object.assign(env, options.explicit ?? {});
  return env;
}

/** Default message/transport MCP servers that never reach an executor. */
export const DEFAULT_MCP_DENY_PATTERN = /telegram|cc-connect|ccgram|feishu|wechat|slack|discord/i;

/** A server is denied when a built-in pattern matches or a caller name matches. */
export function isMcpDenied(name: string, extraDeny: readonly string[] = []): boolean {
  if (DEFAULT_MCP_DENY_PATTERN.test(name)) return true;
  const lower = name.toLowerCase();
  return extraDeny.some(denied => denied.toLowerCase() === lower);
}
