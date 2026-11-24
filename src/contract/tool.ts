/**
 * The AI-facing tool registration. The plugin/server namespace stays `ai4ai`;
 * the tool name is `session` on every platform (Claude exposes it as
 * `mcp__ai4ai__session`, OpenCode/DSH as `ai4ai_session`, and the Codex CLI
 * surface as `ai4ai session`).
 *
 * This module is imported by the Claude hooks module as well, whose sandbox
 * allows relative imports and "claude-code" only: never add a Node import here.
 */
export const TOOL_NAME = 'session';

/** Process-local, import-free token. The sandbox rejects node:crypto. */
let sequence = 0;
function localToken(): string {
  sequence = (sequence + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${sequence.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * Fill the caller-side idempotency key when the model omits it. A tool call is
 * a complete request on its own; the model should not have to invent a
 * bookkeeping id, and the CLI already does the same defaulting.
 */
export function normalizeToolRequest(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  // Always a fresh object: tool hosts can hand out frozen/proxied events and
  // callers (the Claude plugin) strip bookkeeping fields from the copy.
  if (typeof input.operationId === 'string' && input.operationId.trim() !== '') return { ...input };
  const operation = typeof input.operation === 'string' && input.operation.trim() !== '' ? input.operation : 'session';
  return { ...input, operationId: `${operation}-${localToken()}` };
}

/**
 * Approved description (user decision 2026-11-19 ~00:55). It states what the
 * tool does, names the user's vocabulary (context window, tokens used, usage
 * percent, model, reasoning effort, auto-compact) and gives the Returns
 * legend. No summary line and no imperative "use this tool" guidance.
 */
export const TOOL_DESCRIPTION = `AI Harness Extension Kit (ai4ai)
- status — query this session's context window, tokens used, usage percent, model, reasoning effort and auto-compact setting. Returns context {window, used (tokens), percent (0–100), sources}, model, reasoningEffort, autoCompact {tokens, ratio, source}.
- handoff — renew this session's context at a safe point: start a fresh context that keeps the same task when the conversation gets long or the context is nearly full.
- spawn — start a detached executor that works in parallel while this session continues.
- message / stop / finish / list — manage executors (message revives a terminal executor in its session; finish completes gracefully).
- capabilities — list supported operations for this harness.
- CLI helpers (orchestrator-side; shell commands, not tool calls): \`ai4ai watch --executor <id> --until "<condition>" [--timeout S]\` (exit 0 met / 3 timeout / 2 usage / 1 runtime), \`ai4ai events --executor <id> [--follow]\` (normalized tail with cursor; opt-in read-only follow), \`ai4ai transcript --executor <id> [--tail N]\` (opt-in bounded/redacted transcript tail), \`ai4ai adoption --executor <id>\` (verify-adoption proof), \`ai4ai activity --executor <id>\` (bounded activity summary), \`ai4ai sweep\` (identity-checked orphan cleanup). Run \`ai4ai --help\` for conditions and flags.
Notices are informational; on pending, finish the turn.`;

/** Logical tool identifier per surface, for docs and help text. */
export const TOOL_IDS = {
  'claude-code': 'mcp__ai4ai__session',
  opencode: 'ai4ai_session',
  dsh: 'ai4ai_session',
  codex: 'ai4ai session',
} as const;
