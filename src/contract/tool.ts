/**
 * The AI-facing tool registration. The plugin/server namespace stays `ai4ai`;
 * the tool name is `session` on every platform (Claude exposes it as
 * `mcp__ai4ai__session`, OpenCode/DSH as `ai4ai_session`, and the Codex CLI
 * surface as `ai4ai session`).
 *
 * This module is imported by the Claude hooks module as well, whose sandbox
 * allows relative imports and "claude-code" only: never add a Node import here.
 */
import type { Notice } from './types.js';

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

/** Caller facts the tool layer may use. Programmatic/CLI callers never pass this. */
export interface ToolCallContext {
  /** Set when the in-harness tool runs inside a detached executor. */
  executorId?: string;
}

export interface ToolCallFailure {
  code: 'handoff-target-required' | 'handoff-executor-self-renewal';
  message: string;
  correctedCall: string;
}

/** The D38 default notice (a contract Notice object; its message is the spec text). */
export const TARGET_DEFAULTED_NOTICE: Notice = {
  code: 'handoff-target-defaulted', impact: 'none', action_required: false,
  message: 'target defaulted to self',
};

export type ToolCallNormalization =
  | { ok: true; request: Record<string, unknown>; notices: Notice[] }
  | { ok: false; operation: string; operationId: string; failure: ToolCallFailure };

/**
 * D38 tool-layer normalization. An in-harness `handoff` that omits `target`
 * defaults to `self` (with a notice); an executor-context caller or an explicit
 * rotation never defaults — both fail closed with the corrected call shape.
 * The CLI/programmatic request path is not affected: it keeps its strict
 * contract and never calls this function.
 */
export function normalizeToolCall(value: unknown, caller: ToolCallContext = {}): ToolCallNormalization {
  const base = normalizeToolRequest(value);
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    return { ok: false, operation: 'handoff', operationId: 'invalid', failure: {
      code: 'handoff-target-required',
      message: 'The tool request must be an object with operation=handoff and target=<owned executor id>',
      correctedCall: '{"operation":"handoff","target":"<owned executor id>","mode":"restart","task":"..."}',
    } };
  }
  const request = base as Record<string, unknown>;
  const operation = typeof request.operation === 'string' ? request.operation : '';
  const operationId = typeof request.operationId === 'string' ? request.operationId : 'unknown';
  if (operation !== 'handoff') return { ok: true, request, notices: [] };
  const target = typeof request.target === 'string' ? request.target.trim() : '';
  if (target !== '') return { ok: true, request, notices: [] };
  const mode = typeof request.mode === 'string' ? request.mode : undefined;
  if (caller.executorId) {
    return { ok: false, operation, operationId, failure: {
      code: 'handoff-executor-self-renewal',
      message: `A detached executor (${caller.executorId}) cannot omit target and cannot renew itself; an executor handoff requires an explicit target=<owned executor id>.`,
      correctedCall: `{"operation":"handoff","target":"<owned executor id>","mode":"${mode ?? 'restart'}","operationId":"...","task":"..."}`,
    } };
  }
  if (mode === 'rotation') {
    return { ok: false, operation, operationId, failure: {
      code: 'handoff-target-required',
      message: 'mode=rotation requires an explicit target: rotation stops the target executor and spawns a successor, so it cannot target the current session.',
      correctedCall: '{"operation":"handoff","target":"<owned executor id>","mode":"rotation","operationId":"...","task":"..."}',
    } };
  }
  return { ok: true, request: { ...request, target: 'self' }, notices: [TARGET_DEFAULTED_NOTICE] };
}

/**
 * Approved description (user decision 2026-11-19 ~00:55). It states what the
 * tool does, names the user's vocabulary (context window, tokens used, usage
 * percent, model, reasoning effort, auto-compact) and gives the Returns
 * legend. No summary line and no imperative "use this tool" guidance.
 */
export const TOOL_DESCRIPTION = `AI Harness Extension Kit (ai4ai)
- status — query this session's context window, tokens used, usage percent, model, reasoning effort and auto-compact setting. Returns context {window, used (tokens), percent (0–100), sources}, model, reasoningEffort, autoCompact {tokens, ratio, source}.
- handoff — renew a context at a safe point. target defaults to self for an in-harness call; an executor handoff requires an explicit target=<owned executor id> (mode restart|compact|rotation; rotation and executor contexts never default).
- spawn — start a detached executor that works in parallel while this session continues.
- message / stop / finish / list — manage executors (message revives a terminal executor in its session; finish completes gracefully).
- capabilities — list supported operations for this harness.
- CLI helpers (orchestrator-side; shell commands, not tool calls): \`ai4ai watch --executor <id> --until "<condition>" [--timeout S]\` (exit 0 met / 3 timeout / 2 usage / 1 runtime), \`ai4ai events --executor <id> [--follow] [--kind message,tool,...]\` (normalized tail with cursor and optional kind filter; opt-in read-only follow), \`ai4ai transcript --executor <id> [--tail N]\` (opt-in bounded/redacted transcript tail), \`ai4ai adoption --executor <id>\` (verify-adoption proof), \`ai4ai activity --executor <id>\` (bounded activity summary), \`ai4ai sweep\` (identity-checked orphan cleanup). Run \`ai4ai --help\` for conditions and flags.
Notices are informational; on pending, finish the turn.`;

/** Logical tool identifier per surface, for docs and help text. */
export const TOOL_IDS = {
  'claude-code': 'mcp__ai4ai__session',
  opencode: 'ai4ai_session',
  dsh: 'ai4ai_session',
  codex: 'ai4ai session',
} as const;
