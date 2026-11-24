# AI4AI contract reference

This document is generated from the machine-readable schema and validators in
`src/contract/`; a test regenerates it and fails on drift.

## Concepts

- **session** — a context identity inside one harness.
- **agent** — an AI entity; an agent may be a root session or a managed executor.
- **executor** — a detached, externally managed agent created by `spawn`.
- **orchestrator** — a role a caller plays, not a product object.

## Operations

| Operation | Purpose |
|---|---|
| `handoff` | Renew the caller's or an owned executor's context without losing the task. |
| `spawn` | Create 1..N detached executors seeded with a task. |
| `status` | Report state, model, reasoning effort, context usage and unavailable fields. |
| `message` | Deliver text to an owned executor, or revive a terminal one in its recorded session. |
| `cancel` / `stop` | Cancel an operation or stop an owned executor (`cancelled`). |
| `finish` | Complete a detached owned executor gracefully (`completed`). |
| `list` | List executors owned by the caller. |
| `capabilities` | Return the adapter's declared capabilities for this OS. |

Operations: `handoff`, `spawn`, `status`, `message`, `cancel`, `stop`, `finish`, `list`, `capabilities`.

## Result state machine

| State | Meaning |
|---|---|
| `accepted` | Request accepted; native effect not started. |
| `pending` | Scheduled or in progress; not applied. |
| `applied` | Native effect applied; final acknowledgement pending. |
| `completed` | Applied and confirmed. |
| `cancelled` | Cancelled before completion; terminal. |
| `unsupported` | Capability or parameter unsupported by this adapter. |
| `authorization-required` | The harness requires user/trust approval. |
| `unauthorized` | The caller does not own the target; no information leak. |
| `forbidden` | Ownership is valid but policy denies the action. |
| `failed` | Execution failed. |
| `unknown` | Delivery/application cannot be determined; reconcile before retry. |

States: `accepted`, `pending`, `applied`, `completed`, `cancelled`, `unsupported`, `authorization-required`, `unauthorized`, `forbidden`, `failed`, `unknown`.

A pending handoff cancelled before application returns `cancelled`. For `cancel`/`stop`,
`completed` means the target confirmed stopped, `pending` means the stop was requested,
`unknown` means no confirmation was obtained.

## Handoff phases, successors and idempotency

- `handoff.phase` is a set of reportable states, not a mandatory sequence. An implementation
  is not required to visit every value in order, and `scheduled` is optional: an adapter may
  report `pending` -> `applied` -> `completed` directly when its native safe point is atomic.
- `successor` is a complete Identity: `harness`, `workspace`, `surface`, `session`,
  `generation` and `agent`. A handoff always keeps the native `session` and advances only
  `generation`; it never changes the session identity. Use `spawn` for a new session, and
  never fabricate a successor identity from a CLI carrier id.
- `proof.mechanism` is `surface-replacement` (zero-summary in-place restart) or
  `native-compaction` (explicit compact opt-in that used the harness summarizer).
  `new-session` is legacy read-only evidence from releases before 0.0.5 and is accepted
  only when re-reading those records; current adapters never produce it.
- The first `handoff` call may return `pending` because the native transition completes at a
  safe point. Re-querying with the same `operationId` is idempotent and returns the
  progressed (eventually `completed`) result; it must not start a second transition.
- A handoff is atomic once accepted: real user input that arrives while it is `pending`,
  `scheduled` or `applied` does not cancel it. Adapters retain that input and deliver it in
  the fresh context, after the handoff task and in arrival order; consecutive messages may be
  merged into one replay. Only an explicit abort/cancel or a mechanism failure (marker,
  phase or session identity mismatch) terminates a handoff, and an aborted handoff discards
  its retained input instead of replaying it later.

## Request fields

- `operation`: `handoff`, `spawn`, `status`, `message`, `cancel`, `stop`, `finish`, `list`, `capabilities`.
- `operationId`: caller-chosen idempotency key.
- `target`: `"self"` or an owned executor id (`handoff`, `status`, `message`, `cancel`, `stop`, `finish`).
- `mode`: `compact` | `restart` | `rotation` (`restart` is the default and replaces the context in place with the material only; `compact` is an explicit opt-in that uses the harness summarizer and is refused where the capability declaration does not list it).
- `surface`: `preserve` | `tui` | `headless` | `web`; default `preserve`. A silent surface change is forbidden.
- `task`: seed material for `handoff`, `spawn`, `message`.
- `model`, `reasoningEffort`: optional overrides. The default is to pass nothing and inherit the harness configuration.
- `policy`: `allowSelfHandoff` (default `true`), `allowSpawnChildren` (default `false`), `allowSelfStop` (default `true`).
- `isolation`: `inherit` | `isolated`; `inherit` is the default.
- `count`: 1..16 for `spawn`; the adapter declares the effective concurrency limit and over-limit requests fail loudly.
- `spawn` (spawn only): `{ persistence: "one-shot"|"persistent", surface: "headless"|"web", profile, permissionMode: "bypassPermissions"|"dontAsk", allowedTools, disallowedTools, envExclude, mcp: { deny } }`. Options are persisted and re-applied to every resumed or revived turn.
- `logTail` (status only): `{ tail: 1..1000, cursor, format: "events"|"lines" }`; asks for a bounded event/log tail.
- `reason` applicability: accepted for `handoff`, `spawn`, `status`, `message`, `cancel`, `stop` and `finish`; **not applicable** to `list` and `capabilities` (a closed-request error, never a journal failure).
- `requiredFeatures`: optional mandatory feature names: `handoff`, `spawn`, `status`, `message`, `cancel`, `stop`, `finish`, `list`, `surface-preserve`, `surface-cross`, `spawn-isolation`, `spawn-policy`, `spawn-persistence`, `spawn-surface`, `spawn-permission-mode`, `spawn-env-exclude`, `spawn-mcp-deny`, `message-revival`, `events`, `watch`, `model-override`, `reasoning-effort-override`.

## Result fields

- `status`: the state machine value above.
- `target`, `executorId`, `sessionId`, `surfaceChanged`, `state`.
- `model`, `reasoningEffort`, `modelVerification` (`verified` | `reported` | `configured-only` | `unknown`).
- `verification`: `{ model, context }`, where context is `native` | `derived` | `reported`.
- `lastActivityAt` / `lastActivityAtSource`: the last child output observed by the supervisor (`native`), otherwise the persisted session store modification time (`session`), otherwise `null` with source `unknown`. The executor never self-reports this value.
- `stateSource`: provenance of the observed state (`native` from the status file and pid check, `session` when only a persisted store is known, `unknown`).
- `exitCode` / `signal`: the terminal process outcome when known, `null` otherwise; surfaced only on terminal states.
- `session`: `{ id, store, path }` — a pointer to the persisted session store (`path` is a host-local file or SQLite path, `null` when unresolvable). Content is never read or returned. `list` executor summaries carry the same pointer.
- Lifecycle states: `running | idle | completed | failed | cancelled | unknown`. `idle` is non-terminal: the supervisor (and, for a resident carrier, the harness child) is alive, no turn runs, and queued turns may exist. `finish` completes an executor; `stop` cancels it. `idle` is never a task-completion signal.
- `processState`: `alive | orphaned | dead | unknown`, independent of the lifecycle. `orphaned` means the supervisor died while the harness child is still alive; revival is refused until `ai4ai sweep` or a force stop cleans it. Unverifiable liveness fails closed to `unknown`.
- Turn reconciliation: `turns`, `lastOperationId`, `lastTurnOutcome`, `queuedTurns`, `lastTurnAt`, `turnStartedAt`, `idleSince`. The supervisor owns a separate append-only `turns.ndjson`; `status.json` remains its single-writer snapshot.
- Receipts: `message` returns `turnId` and `queuePosition` (1-based while pending, 0 once claimed). A revived executor keeps its `executorId` and native `sessionId`; the old inbox generation is swapped out and never replayed.
- `persistence`: the executor's `one-shot` or `persistent` model. `runtimeVersion` reports the native harness version when observed; `mcpFiltered` reports the kept MCP server names/count (never definitions or secrets).
- `logTail`: `{ format, events?|lines?, nextCursor, reset? }`. `nextCursor` is a byte offset at a line boundary; a cursor beyond the file yields `reset: true` and restarts from the beginning. Events are truncated to 4 KB and unknown lines are `unmapped` with bounded raw detail.
- State is always cross-checked against process liveness: a live supervisor is never reported terminal, a dead supervisor with a live child is `orphaned` (never `running`), and an `idle` per-turn executor is not `failed` because its child exited between turns.
- `context`: `{ window, used, percent?, percentSource, sources? }`; `sources` labels the provenance of each value and `percent` is derived locally from `used`/`window` whenever both are known.
- `context.used` semantics: prompt/context occupancy — input tokens plus cache reads/writes, excluding generated output and reasoning. Adapters populate it whenever the harness exposes it, even when `window`/`percent` are `null`. Generated output is deliberately excluded: the orchestrator and executor thresholds both use this prompt-occupancy value.
- Units: `context.window` and `context.used` are **token counts** (non-negative integers); `context.percent` is **0-100 with one decimal**. Adapters convert platform values; an unreliable conversion becomes `null` and is listed in `unavailable` — units are never mixed.
- `context.percent` is exactly `used / window` against the harness native context window. A configured auto-compact/soft limit is not a substitute for the window; when the native window is unknown, `window` and `percent` are `null` and `unavailable` names the gap.
- `context.percent`: computed locally (`derived`) whenever both `used` and `window` are known; a native percentage is used only when those inputs are unavailable. A `null` percent is a known limitation, not a reason to skip context management: absolute thresholds can use `used` (with a declared window when available).
- `autoCompact`: `{ tokens, ratio, source }`. `tokens` is an absolute threshold, `ratio` is `tokens / window` and is only derived when the window is known and verified; a platform ratio is normalized to 0-1. A configured threshold above the observed window yields `ratio: null` plus an informational notice (never a false 100% clamp, never an invalid result). Unknown values stay `null` with source `unknown` and a `fieldStates` reason.
- `fieldStates`: closed per-field state map. Keys are only `model`, `reasoningEffort`, `context.window`, `context.used`, `context.percent`, `context.autoCompact`; values are only `unsupported`, `unavailable`, `unknown`, `disabled`. `disabled` means the harness has the feature but it is turned off by configuration (it is not missing and is never listed in `unavailable`); every other state is a missing value and is listed there (single source).
- `unavailable`: names of fields the adapter could not obtain; their values are `null`. Missing values are never omitted or replaced with 0/empty placeholders.
- `notices`: `{ code, impact: "none", action_required: false, message }`. **Skills must treat notices as informational: never stop, retry or prompt because of one.**
- `error`: `{ code, message }` for refusals and failures.
- `proof` (any result that claims a context replacement, including `applied`): source/successor identities, mechanism and native evidence. For a current mechanism the successor `session` must equal the source `session`; a mismatch is rejected as `invalid-result`, never accepted as a handoff.
- `capabilities`, `executors` for the corresponding operations.

## Status resolution: the per-field source ladder

Every status field resolves independently. The default ladder is
`native > session > env > config`; whichever source first yields a **verified**
value for that field wins, and only that field is labeled with that source.
A source that returns a result but leaves a field empty does not stop the
field: the next source is consulted for exactly the missing fields. A field
that every source fails stays `null` and is named in `fieldStates` /
`unavailable` with its provenance.

| Field | Provenance slot | Units / rules |
|---|---|---|
| `model` | `modelSource` | harness model id |
| `reasoningEffort` | `modelVerification` (reported/configured-only) | harness reasoning-effort label |
| `context.window` | `context.sources.window` | positive token integer |
| `context.used` | `context.sources.used` | non-negative token integer (prompt occupancy) |
| `context.percent` | `context.sources.percent` | derived locally; 0-100, one decimal |
| `autoCompact` | `autoCompact.source` | `{tokens, ratio}`; ratio only with a verified window |

Source labels are `native`, `session`, `env`, `config`, `config:project`,
`config:user`, `derived` (computed here) and `unknown`. Scope-qualified
`config:*` labels are used whenever the harness documents a project/user
precedence; a bare `config` is only used when the scope cannot be determined.

Acquisition rules for every source path:

- read-only and bounded (file size / date window / message count);
- explicit identity binding — session stores are keyed by `sessionId` **and**
  the project key (`cwd`/workspace); there is no "newest file" fallback;
- schema-tolerant: an unknown shape degrades to `null`, never a guess;
- errors and timeouts degrade to the next source, never fail `status`;
- configuration is read through an allowlist of keys, mirroring each
  harness's documented precedence; credentials are never read or returned.

Platform source applicability (implemented layers; `—` means not applicable
because the harness persists no such value):

| Harness | native | session | env | config |
|---|---|---|---|---|
| Claude Code | stream-json result / live session usage (model, used, window) | transcript JSONL (model, used, window, effort) | `ANTHROPIC_MODEL`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_CODE_EFFORT_LEVEL` | settings `env`, `effortLevel`, `autoCompactWindow` (local project > project > user; settings `env` overrides the process env) |
| Codex | runner `usage.json` / `model.json` (used, window, model) | rollout JSONL under `~/.codex/sessions` (model, effort, window, used) | — | `$CODEX_HOME/config.toml` and the trusted project `.codex/config.toml` (`model`, `model_reasoning_effort`, `model_context_window`, `model_auto_compact_token_limit`); `$CODEX_HOME/models_cache.json` model metadata (window, effective window percent, catalog limit); the core default auto-compaction limit is 90% of the resolved window |
| OpenCode | `run --format json` events (model, used) | `opencode.db` session + last assistant message (model, used, variant) and model catalog (window) | — | `opencode.json(c)`: `model` (optionally `#variant`), `providers.<p>.models.<m>.limit.context`, `settings`/`options`/`variants[].settings` `reasoningEffort`, `compaction.auto`, `compaction.buffer` (legacy `reserved`); the default ceiling keeps 15% of the window free, at least 16k |
| DSH | headless `--json` events (used); in-harness events (model, window, effort) | `DSH_HOME/sessions` records (model, window, used, effort) | — | headless profile patch (`agent-default-model`, `llm-pi-ai` limits, `compaction-basic.thresholdRatio`) |

## AI-facing tool

Every harness registers one tool in the `ai4ai` namespace: `session`.
Surfaces: claude-code = `mcp__ai4ai__session`, opencode = `ai4ai_session`, dsh = `ai4ai_session`, codex = `ai4ai session`.
The plugin/server name stays `ai4ai`; the tool name is `session`. The description is the
primary discovery surface and every input property carries its own description.

```text
AI Harness Extension Kit (ai4ai)
- status — query this session's context window, tokens used, usage percent, model, reasoning effort and auto-compact setting. Returns context {window, used (tokens), percent (0–100), sources}, model, reasoningEffort, autoCompact {tokens, ratio, source}.
- handoff — renew this session's context at a safe point: start a fresh context that keeps the same task when the conversation gets long or the context is nearly full.
- spawn — start a detached executor that works in parallel while this session continues.
- message / stop / finish / list — manage executors (message revives a terminal executor in its session; finish completes gracefully).
- capabilities — list supported operations for this harness.
- CLI helpers (orchestrator-side; shell commands, not tool calls): `ai4ai watch --executor <id> --until "<condition>" [--timeout S]` (exit 0 met / 3 timeout / 2 usage / 1 runtime), `ai4ai events --executor <id> [--follow]` (normalized tail with cursor; opt-in read-only follow), `ai4ai transcript --executor <id> [--tail N]` (opt-in bounded/redacted transcript tail), `ai4ai adoption --executor <id>` (verify-adoption proof), `ai4ai activity --executor <id>` (bounded activity summary), `ai4ai sweep` (identity-checked orphan cleanup). Run `ai4ai --help` for conditions and flags.
Notices are informational; on pending, finish the turn.
```

Returns legend: `context.window` is the harness context window in tokens; `context.used` is
prompt occupancy in tokens (input plus cache reads/writes, excluding generated output and
reasoning); `context.percent` is 0-100 with one decimal (derived from used/window);
`context.sources` labels each value with its source (`native`, `session`, `env`,
`config:project`, `config:user`, `derived`, `unknown`); `model` and `reasoningEffort` are the
harness model id and effort label (`modelVerification` says `reported`, `configured-only` or
`unknown`); `autoCompact` is `{ tokens, ratio, source }` with an absolute threshold, a 0-1
window ratio and its source. `unavailable`/`fieldStates` name every field no source could
provide.

## Capability declarations

Each adapter declares, per OS and interface (`tui` | `headless` | `web`): operation availability, handoff modes and overrides,
spawn lifecycle, persistence modes, surfaces, permission modes, MCP filtering, status introspection, event observation level, and experimental features. Availability values: `supported`, `limited`, `unsupported`, `not-tested`.
A `supported` spawn must declare `lifecycle: "detached"`; a tested failure is reported as `limited` or `unsupported`, never left untested.

## Ownership and policy

- Ownership flows from creator to created object. An executor may operate on itself and its own children.
- Parent/peer delegation is not part of this contract; foreign targets return `unauthorized` without leaking state.
- Policy denial returns `forbidden`; harness approval returns `authorization-required`.
- Parent close does not kill a detached child; durable state enables reattachment.

## Executors, environment and observation

- Default environment policy (all harnesses, applied at launch and again by the supervisor): remove `TELEGRAM_*`, `CC_SESSION_KEY`, `CLAUDE_CODE_*` transport variables, `TMUX*`, `*_BOT_TOKEN`, `*_SESSION_DRIVER` and host `ANTHROPIC_*`. `spawn.envExclude` only adds names; nothing is re-enabled. The executor identity (`AI4AI_EXECUTOR_ID`, `AI4AI_EXECUTOR_DIR`) is injected.
- Default MCP deny: `telegram`, `cc-connect`, `ccgram`, `feishu`, `wechat`, `slack`, `discord` (case-insensitive) plus `spawn.mcp.deny`. The only source is the project `.mcp.json`; user-level MCP is out of scope and never copied. The filtered config is written 0600 in the executor directory and only kept names/counts are reported.
- Event v1 kinds: `message | tool | result | error | progress | system | unmapped`. The log is mapped at read time; harness transcripts are never read.
- CLI-only helpers (not contract operations): `ai4ai watch` (declarative conditions, JSON, exit 0 met / 3 timeout / 2 usage / 1 runtime), `ai4ai events` (bounded normalized tail with cursor), `ai4ai sweep` (list + identity-check + kill orphan trees + reconcile dead records).

## JSON Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AI4AI request",
  "description": "One AI4AI session operation. Use status to query this session's context window, tokens used, usage percent, model, reasoning effort and auto-compact setting; handoff to renew the context at a safe point; spawn/message/stop/list to manage detached executors.",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "requiredFeatures": {
      "type": "array",
      "maxItems": 32,
      "uniqueItems": true,
      "items": {
        "enum": [
          "handoff",
          "spawn",
          "status",
          "message",
          "cancel",
          "stop",
          "finish",
          "list",
          "surface-preserve",
          "surface-cross",
          "spawn-isolation",
          "spawn-policy",
          "spawn-persistence",
          "spawn-surface",
          "spawn-permission-mode",
          "spawn-env-exclude",
          "spawn-mcp-deny",
          "message-revival",
          "events",
          "watch",
          "model-override",
          "reasoning-effort-override"
        ]
      },
      "description": "Feature names this caller requires; the request fails when the harness does not declare them."
    },
    "operation": {
      "enum": [
        "handoff",
        "spawn",
        "status",
        "message",
        "cancel",
        "stop",
        "finish",
        "list",
        "capabilities"
      ],
      "description": "Operation to perform: handoff, spawn, status, message, cancel/stop, finish, list or capabilities."
    },
    "operationId": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
      "description": "Caller-chosen idempotency key; reusing it with different input is rejected."
    },
    "target": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
      "description": "Target agent: \"self\" for this session or an owned executor id."
    },
    "owner": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
      "description": "For list: only return executors created by this owner identity."
    },
    "mode": {
      "enum": [
        "compact",
        "restart",
        "rotation"
      ],
      "description": "Handoff mode: restart (default) starts a fresh context containing only the task material with no summary; compact is an explicit opt-in that keeps a harness-generated history summary."
    },
    "surface": {
      "enum": [
        "preserve",
        "tui",
        "headless",
        "web"
      ],
      "description": "Interaction surface: preserve (default) or an explicit cross-surface target."
    },
    "task": {
      "type": "string",
      "minLength": 1,
      "maxLength": 16384,
      "description": "Seed material for handoff, spawn or message: the task the context or executor adopts."
    },
    "model": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096,
      "description": "Optional model override; when omitted the harness configuration is inherited."
    },
    "reasoningEffort": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096,
      "description": "Optional reasoning-effort override (for example low, medium, high); when omitted the harness configuration is inherited."
    },
    "policy": {
      "type": "object",
      "additionalProperties": false,
      "description": "Child policy for spawned executors; a denial returns forbidden.",
      "properties": {
        "allowSelfHandoff": {
          "type": "boolean",
          "description": "Whether a spawned executor may renew its own context (default true)."
        },
        "allowSpawnChildren": {
          "type": "boolean",
          "description": "Whether a spawned executor may create further executors (default false)."
        },
        "allowSelfStop": {
          "type": "boolean",
          "description": "Whether a spawned executor may stop itself (default true)."
        }
      }
    },
    "isolation": {
      "enum": [
        "inherit",
        "isolated"
      ],
      "description": "Executor isolation: inherit the caller environment (default) or isolated."
    },
    "spawn": {
      "type": "object",
      "additionalProperties": false,
      "description": "Carrier options for a spawned executor; persisted and re-applied to every resumed or revived turn.",
      "properties": {
        "persistence": {
          "enum": [
            "one-shot",
            "persistent"
          ],
          "description": "one-shot (default) exits after the turn queue drains; persistent stays alive in idle between turns."
        },
        "surface": {
          "enum": [
            "headless",
            "web"
          ],
          "description": "Carrier surface; defaults are feasibility-gated per harness."
        },
        "profile": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096,
          "description": "DSH profile name; unsupported on other harnesses."
        },
        "permissionMode": {
          "enum": [
            "bypassPermissions",
            "dontAsk"
          ],
          "description": "Claude permission mode; interactive modes are refused."
        },
        "allowedTools": {
          "type": "array",
          "maxItems": 64,
          "uniqueItems": true,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "description": "Tool allow-list used with permissionMode dontAsk."
        },
        "disallowedTools": {
          "type": "array",
          "maxItems": 64,
          "uniqueItems": true,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "description": "Tools the carrier must refuse even when installed (for example Skill(gclear))."
        },
        "envExclude": {
          "type": "array",
          "maxItems": 64,
          "uniqueItems": true,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "description": "Extra environment variable names removed before launch; the built-in defaults are always removed."
        },
        "mcp": {
          "type": "object",
          "additionalProperties": false,
          "description": "Extra MCP servers to deny; default message-class denials cannot be re-enabled.",
          "properties": {
            "deny": {
              "type": "array",
              "maxItems": 64,
              "uniqueItems": true,
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "description": "Additional MCP server names to remove (case-insensitive)."
            }
          }
        },
        "origin": {
          "enum": [
            "rotation"
          ],
          "description": "Internal: marks a rotation successor seeded with the handoff delivery text."
        }
      }
    },
    "count": {
      "type": "integer",
      "minimum": 1,
      "maximum": 16,
      "description": "Number of detached executors to spawn (1-16)."
    },
    "timeoutMs": {
      "type": "integer",
      "minimum": 0,
      "maximum": 300000,
      "description": "Maximum wait in milliseconds for a stop/finish confirmation."
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096,
      "description": "Human-readable reason recorded with the operation."
    },
    "logTail": {
      "type": "object",
      "additionalProperties": false,
      "description": "Bounded log tail for status; events are normalized (event v1), lines are raw log lines.",
      "properties": {
        "tail": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1000,
          "description": "Maximum number of entries (default 50)."
        },
        "cursor": {
          "type": "integer",
          "minimum": 0,
          "description": "Byte cursor returned by a previous call; at a line boundary."
        },
        "format": {
          "enum": [
            "events",
            "lines"
          ],
          "description": "events (default) or raw lines."
        }
      }
    }
  },
  "required": [
    "operation",
    "operationId"
  ],
  "allOf": [
    {
      "if": {
        "properties": {
          "operation": {
            "const": "handoff"
          }
        }
      },
      "then": {
        "required": [
          "target"
        ],
        "not": {
          "anyOf": [
            {
              "required": [
                "owner"
              ]
            },
            {
              "required": [
                "count"
              ]
            },
            {
              "required": [
                "isolation"
              ]
            },
            {
              "required": [
                "policy"
              ]
            },
            {
              "required": [
                "spawn"
              ]
            },
            {
              "required": [
                "logTail"
              ]
            }
          ]
        }
      }
    },
    {
      "if": {
        "properties": {
          "operation": {
            "const": "handoff"
          },
          "target": {
            "const": "self"
          }
        },
        "required": [
          "operation",
          "target"
        ]
      },
      "then": {
        "properties": {
          "mode": {
            "not": {
              "const": "rotation"
            }
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "operation": {
            "const": "handoff"
          },
          "target": {
            "not": {
              "const": "self"
            }
          },
          "mode": {
            "enum": [
              "restart",
              "rotation"
            ]
          }
        },
        "required": [
          "operation",
          "target",
          "mode"
        ]
      },
      "then": {
        "required": [
          "task"
        ]
      }
    },
    {
      "if": {
        "properties": {
          "operation": {
            "const": "spawn"
          }
        }
      },
      "then": {
        "required": [
          "task"
        ],
        "not": {
          "anyOf": [
            {
              "required": [
                "target"
              ]
            },
            {
              "required": [
                "owner"
              ]
            },
            {
              "required": [
                "mode"
              ]
            },
            {
              "required": [
                "surface"
              ]
            },
            {
              "required": [
                "logTail"
              ]
            }
          ]
        }
      }
    },
    {
      "if": {
        "properties": {
          "operation": {
            "const": "status"
          }
        }
      },
      "then": {
        "not": {
          "anyOf": [
            {
              "required": [
                "owner"
              ]
            },
            {
              "required": [
                "task"
              ]
            },
            {
              "required": [
                "model"
              ]
            },
            {
              "required": [
                "reasoningEffort"
              ]
            },
            {
              "required": [
                "policy"
              ]
            },
            {
              "required": [
                "isolation"
              ]
            },
            {
              "required": [
                "count"
              ]
            },
            {
              "required": [
                "mode"
              ]
            },
            {
              "required": [
                "surface"
              ]
            },
            {
              "required": [
                "spawn"
              ]
            }
          ]
        }
      }
    },
    {
      "if": {
        "properties": {
          "operation": {
            "enum": [
              "message"
            ]
          }
        }
      },
      "then": {
        "required": [
          "target",
          "task"
        ],
        "not": {
          "anyOf": [
            {
              "required": [
                "owner"
              ]
            },
            {
              "required": [
                "model"
              ]
            },
            {
              "required": [
                "reasoningEffort"
              ]
            },
            {
              "required": [
                "policy"
              ]
            },
            {
              "required": [
                "isolation"
              ]
            },
            {
              "required": [
                "count"
              ]
            },
            {
              "required": [
                "mode"
              ]
            },
            {
              "required": [
                "surface"
              ]
            },
            {
              "required": [
                "spawn"
              ]
            },
            {
              "required": [
                "logTail"
              ]
            }
          ]
        }
      }
    },
    {
      "if": {
        "properties": {
          "operation": {
            "enum": [
              "cancel",
              "stop",
              "finish"
            ]
          }
        }
      },
      "then": {
        "required": [
          "target"
        ],
        "not": {
          "anyOf": [
            {
              "required": [
                "owner"
              ]
            },
            {
              "required": [
                "task"
              ]
            },
            {
              "required": [
                "model"
              ]
            },
            {
              "required": [
                "reasoningEffort"
              ]
            },
            {
              "required": [
                "policy"
              ]
            },
            {
              "required": [
                "isolation"
              ]
            },
            {
              "required": [
                "count"
              ]
            },
            {
              "required": [
                "mode"
              ]
            },
            {
              "required": [
                "surface"
              ]
            },
            {
              "required": [
                "spawn"
              ]
            },
            {
              "required": [
                "logTail"
              ]
            }
          ]
        }
      }
    },
    {
      "if": {
        "properties": {
          "operation": {
            "const": "list"
          }
        }
      },
      "then": {
        "not": {
          "anyOf": [
            {
              "required": [
                "target"
              ]
            },
            {
              "required": [
                "task"
              ]
            },
            {
              "required": [
                "model"
              ]
            },
            {
              "required": [
                "reasoningEffort"
              ]
            },
            {
              "required": [
                "policy"
              ]
            },
            {
              "required": [
                "isolation"
              ]
            },
            {
              "required": [
                "count"
              ]
            },
            {
              "required": [
                "mode"
              ]
            },
            {
              "required": [
                "surface"
              ]
            },
            {
              "required": [
                "reason"
              ]
            },
            {
              "required": [
                "timeoutMs"
              ]
            },
            {
              "required": [
                "spawn"
              ]
            },
            {
              "required": [
                "logTail"
              ]
            }
          ]
        }
      }
    },
    {
      "if": {
        "properties": {
          "operation": {
            "const": "capabilities"
          }
        }
      },
      "then": {
        "not": {
          "anyOf": [
            {
              "required": [
                "target"
              ]
            },
            {
              "required": [
                "owner"
              ]
            },
            {
              "required": [
                "task"
              ]
            },
            {
              "required": [
                "model"
              ]
            },
            {
              "required": [
                "reasoningEffort"
              ]
            },
            {
              "required": [
                "policy"
              ]
            },
            {
              "required": [
                "isolation"
              ]
            },
            {
              "required": [
                "count"
              ]
            },
            {
              "required": [
                "mode"
              ]
            },
            {
              "required": [
                "surface"
              ]
            },
            {
              "required": [
                "reason"
              ]
            },
            {
              "required": [
                "timeoutMs"
              ]
            },
            {
              "required": [
                "spawn"
              ]
            },
            {
              "required": [
                "logTail"
              ]
            }
          ]
        }
      }
    }
  ]
}
```

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AI4AI result",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "operation": {
      "enum": [
        "handoff",
        "spawn",
        "status",
        "message",
        "cancel",
        "stop",
        "finish",
        "list",
        "capabilities"
      ]
    },
    "operationId": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
    },
    "status": {
      "enum": [
        "accepted",
        "pending",
        "applied",
        "completed",
        "cancelled",
        "unsupported",
        "authorization-required",
        "unauthorized",
        "forbidden",
        "failed",
        "unknown"
      ]
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096
    },
    "durable": {
      "type": "boolean"
    },
    "target": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
    },
    "executorId": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
    },
    "sessionId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096
    },
    "surfaceChanged": {
      "type": "boolean"
    },
    "state": {
      "enum": [
        "running",
        "idle",
        "completed",
        "failed",
        "cancelled",
        "unknown"
      ]
    },
    "handoff": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "phase": {
          "enum": [
            "pending",
            "scheduled",
            "applied",
            "completed"
          ]
        }
      },
      "required": [
        "phase"
      ]
    },
    "model": {
      "type": [
        "string",
        "null"
      ]
    },
    "reasoningEffort": {
      "type": [
        "string",
        "null"
      ]
    },
    "lastActivityAt": {
      "type": [
        "string",
        "null"
      ]
    },
    "lastActivityAtSource": {
      "anyOf": [
        {
          "enum": [
            "native",
            "session",
            "env",
            "config",
            "config:project",
            "config:user",
            "derived",
            "unknown"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "stateSource": {
      "anyOf": [
        {
          "enum": [
            "native",
            "session",
            "env",
            "config",
            "config:project",
            "config:user",
            "derived",
            "unknown"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "processState": {
      "enum": [
        "alive",
        "orphaned",
        "dead",
        "unknown"
      ]
    },
    "processStateReason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096
    },
    "turns": {
      "type": "integer",
      "minimum": 0
    },
    "lastOperationId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "lastTurnOutcome": {
      "anyOf": [
        {
          "enum": [
            "completed",
            "failed",
            "cancelled"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "queuedTurns": {
      "type": "integer",
      "minimum": 0
    },
    "lastTurnAt": {
      "type": [
        "string",
        "null"
      ]
    },
    "turnStartedAt": {
      "type": [
        "string",
        "null"
      ]
    },
    "idleSince": {
      "type": [
        "string",
        "null"
      ]
    },
    "turnId": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
    },
    "queuePosition": {
      "type": "integer",
      "minimum": 0
    },
    "persistence": {
      "enum": [
        "one-shot",
        "persistent"
      ]
    },
    "runtimeVersion": {
      "type": [
        "string",
        "null"
      ]
    },
    "mcpFiltered": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "names": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          }
        },
        "count": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "names",
        "count"
      ]
    },
    "logTail": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "format": {
          "enum": [
            "events",
            "lines"
          ]
        },
        "events": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "seq": {
                "type": "integer",
                "minimum": 0
              },
              "ts": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "kind": {
                "enum": [
                  "message",
                  "tool",
                  "result",
                  "error",
                  "progress",
                  "system",
                  "unmapped"
                ]
              },
              "role": {
                "enum": [
                  "user",
                  "assistant",
                  "system",
                  "tool"
                ]
              },
              "text": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "tool": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "phase": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "detail": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              }
            },
            "required": [
              "seq",
              "ts",
              "kind"
            ]
          }
        },
        "lines": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          }
        },
        "nextCursor": {
          "type": "integer",
          "minimum": 0
        },
        "reset": {
          "type": "boolean"
        }
      },
      "required": [
        "format",
        "nextCursor"
      ]
    },
    "exitCode": {
      "type": [
        "integer",
        "null"
      ]
    },
    "signal": {
      "type": [
        "string",
        "null"
      ]
    },
    "session": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        },
        "store": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        },
        "path": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "id",
        "store",
        "path"
      ]
    },
    "modelVerification": {
      "enum": [
        "verified",
        "reported",
        "configured-only",
        "unknown"
      ]
    },
    "mechanism": {
      "enum": [
        "surface-replacement",
        "native-compaction",
        "session-rotation",
        "new-session"
      ]
    },
    "sessionChanged": {
      "type": "boolean"
    },
    "sourceSession": {
      "type": [
        "string",
        "null"
      ]
    },
    "successorSession": {
      "type": [
        "string",
        "null"
      ]
    },
    "sourceGeneration": {
      "type": [
        "string",
        "null"
      ]
    },
    "successorGeneration": {
      "type": [
        "string",
        "null"
      ]
    },
    "successor": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "harness": {
          "enum": [
            "claude-code",
            "codex",
            "opencode",
            "dsh"
          ]
        },
        "workspace": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        },
        "surface": {
          "enum": [
            "tui",
            "headless",
            "web"
          ]
        },
        "session": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        },
        "generation": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        },
        "agent": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        }
      },
      "required": [
        "harness",
        "workspace",
        "surface",
        "session",
        "generation",
        "agent"
      ]
    },
    "predecessorExecutorId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "successorExecutorId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "lineage": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "predecessorExecutorId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
        },
        "predecessorGeneration": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        },
        "lineageGeneration": {
          "type": "integer",
          "minimum": 0
        },
        "operationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
        },
        "taskHash": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        },
        "predecessorSession": {
          "type": [
            "string",
            "null"
          ]
        },
        "predecessorStopped": {
          "type": "boolean"
        },
        "stopExitCode": {
          "type": [
            "integer",
            "null"
          ]
        },
        "stopSignal": {
          "type": [
            "string",
            "null"
          ]
        },
        "transferredAt": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        }
      },
      "required": [
        "predecessorExecutorId",
        "predecessorGeneration",
        "lineageGeneration",
        "operationId"
      ]
    },
    "predecessorStopped": {
      "type": [
        "boolean",
        "null"
      ]
    },
    "alternatives": {
      "type": "array",
      "uniqueItems": true,
      "items": {
        "enum": [
          "compact",
          "restart",
          "rotation"
        ]
      }
    },
    "continued": {
      "type": [
        "boolean",
        "null"
      ]
    },
    "idleAfter": {
      "type": [
        "boolean",
        "null"
      ]
    },
    "lastError": {
      "anyOf": [
        {
          "type": "null"
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "code": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            },
            "message": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            }
          },
          "required": [
            "code",
            "message"
          ]
        }
      ]
    },
    "verification": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "model": {
          "enum": [
            "verified",
            "reported",
            "configured-only",
            "unknown"
          ]
        },
        "context": {
          "enum": [
            "native",
            "derived",
            "reported"
          ]
        }
      },
      "required": [
        "model",
        "context"
      ]
    },
    "context": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "window": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0
        },
        "used": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0
        },
        "percent": {
          "type": [
            "number",
            "null"
          ],
          "minimum": 0
        },
        "percentSource": {
          "anyOf": [
            {
              "enum": [
                "native",
                "derived"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "sources": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "window": {
              "anyOf": [
                {
                  "enum": [
                    "native",
                    "session",
                    "env",
                    "config",
                    "config:project",
                    "config:user",
                    "derived",
                    "unknown"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "used": {
              "anyOf": [
                {
                  "enum": [
                    "native",
                    "session",
                    "env",
                    "config",
                    "config:project",
                    "config:user",
                    "derived",
                    "unknown"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "percent": {
              "anyOf": [
                {
                  "enum": [
                    "native",
                    "session",
                    "env",
                    "config",
                    "config:project",
                    "config:user",
                    "derived",
                    "unknown"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            }
          }
        }
      },
      "required": [
        "window",
        "used"
      ]
    },
    "unavailable": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      }
    },
    "notices": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "code": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "impact": {
            "const": "none"
          },
          "action_required": {
            "const": false
          },
          "message": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          }
        },
        "required": [
          "code",
          "impact",
          "action_required",
          "message"
        ]
      }
    },
    "autoCompact": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "tokens": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 1
        },
        "ratio": {
          "type": [
            "number",
            "null"
          ],
          "exclusiveMinimum": 0,
          "maximum": 1
        },
        "source": {
          "enum": [
            "native",
            "session",
            "env",
            "config",
            "config:project",
            "config:user",
            "default",
            "unknown"
          ]
        },
        "enabled": {
          "type": [
            "boolean",
            "null"
          ]
        },
        "enforced": {
          "type": [
            "boolean",
            "null"
          ]
        },
        "nativeSource": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "tokens",
        "ratio",
        "source"
      ]
    },
    "credentials": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "isolation": {
          "enum": [
            "inherit",
            "isolated"
          ]
        },
        "source": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        },
        "keys": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          }
        },
        "fields": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "key": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "source": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              }
            },
            "required": [
              "key",
              "source"
            ]
          }
        },
        "masked": {
          "const": true
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          }
        }
      },
      "required": [
        "isolation",
        "source",
        "keys",
        "masked"
      ]
    },
    "fieldStates": {
      "type": "object",
      "propertyNames": {
        "enum": [
          "model",
          "reasoningEffort",
          "context.window",
          "context.used",
          "context.percent",
          "context.autoCompact"
        ]
      },
      "additionalProperties": {
        "enum": [
          "unsupported",
          "unavailable",
          "unknown",
          "disabled"
        ]
      }
    },
    "error": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "code": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        },
        "message": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        }
      },
      "required": [
        "code",
        "message"
      ]
    },
    "proof": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "source": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "harness": {
              "enum": [
                "claude-code",
                "codex",
                "opencode",
                "dsh"
              ]
            },
            "workspace": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            },
            "surface": {
              "enum": [
                "tui",
                "headless",
                "web"
              ]
            },
            "session": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            },
            "generation": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            },
            "agent": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            }
          },
          "required": [
            "harness",
            "workspace",
            "surface",
            "session",
            "generation",
            "agent"
          ]
        },
        "successor": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "harness": {
              "enum": [
                "claude-code",
                "codex",
                "opencode",
                "dsh"
              ]
            },
            "workspace": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            },
            "surface": {
              "enum": [
                "tui",
                "headless",
                "web"
              ]
            },
            "session": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            },
            "generation": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            },
            "agent": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            }
          },
          "required": [
            "harness",
            "workspace",
            "surface",
            "session",
            "generation",
            "agent"
          ]
        },
        "mechanism": {
          "enum": [
            "surface-replacement",
            "native-compaction",
            "session-rotation",
            "new-session"
          ]
        },
        "nativeEvidence": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        }
      },
      "required": [
        "source",
        "successor",
        "mechanism",
        "nativeEvidence"
      ]
    },
    "capabilities": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "harness": {
            "enum": [
              "claude-code",
              "codex",
              "opencode",
              "dsh"
            ]
          },
          "os": {
            "enum": [
              "linux",
              "windows",
              "darwin"
            ]
          },
          "interface": {
            "enum": [
              "tui",
              "headless",
              "web"
            ]
          },
          "operations": {
            "type": "object",
            "additionalProperties": {
              "enum": [
                "supported",
                "limited",
                "unsupported",
                "not-tested"
              ]
            }
          },
          "handoff": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "availability": {
                "enum": [
                  "supported",
                  "limited",
                  "unsupported",
                  "not-tested"
                ]
              },
              "modes": {
                "type": "array",
                "uniqueItems": true,
                "items": {
                  "enum": [
                    "compact",
                    "restart"
                  ]
                }
              },
              "self": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "modes": {
                    "type": "array",
                    "uniqueItems": true,
                    "items": {
                      "enum": [
                        "compact",
                        "restart",
                        "rotation"
                      ]
                    }
                  }
                },
                "required": [
                  "modes"
                ]
              },
              "executor": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "modes": {
                    "type": "array",
                    "uniqueItems": true,
                    "items": {
                      "enum": [
                        "compact",
                        "restart",
                        "rotation"
                      ]
                    }
                  }
                },
                "required": [
                  "modes"
                ]
              },
              "modelOverride": {
                "enum": [
                  "supported",
                  "limited",
                  "unsupported",
                  "not-tested"
                ]
              },
              "reasoningEffortOverride": {
                "enum": [
                  "supported",
                  "limited",
                  "unsupported",
                  "not-tested"
                ]
              },
              "crossSurface": {
                "enum": [
                  "supported",
                  "limited",
                  "unsupported",
                  "not-tested"
                ]
              }
            },
            "required": [
              "availability",
              "modes",
              "modelOverride",
              "reasoningEffortOverride",
              "crossSurface"
            ]
          },
          "spawn": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "availability": {
                "enum": [
                  "supported",
                  "limited",
                  "unsupported",
                  "not-tested"
                ]
              },
              "lifecycle": {
                "enum": [
                  "detached",
                  "attached",
                  "none"
                ]
              },
              "maxConcurrent": {
                "type": "integer",
                "minimum": 1
              },
              "isolation": {
                "enum": [
                  "supported",
                  "limited",
                  "unsupported",
                  "not-tested"
                ]
              },
              "persistenceModes": {
                "type": "array",
                "uniqueItems": true,
                "items": {
                  "enum": [
                    "one-shot",
                    "persistent"
                  ]
                }
              },
              "surfaces": {
                "type": "array",
                "uniqueItems": true,
                "items": {
                  "enum": [
                    "headless",
                    "web"
                  ]
                }
              },
              "permissionModes": {
                "type": "array",
                "uniqueItems": true,
                "items": {
                  "enum": [
                    "bypassPermissions",
                    "dontAsk"
                  ]
                }
              },
              "mcpFilter": {
                "enum": [
                  "supported",
                  "limited",
                  "unsupported",
                  "not-tested"
                ]
              }
            },
            "required": [
              "availability",
              "lifecycle",
              "maxConcurrent",
              "isolation",
              "persistenceModes",
              "surfaces",
              "permissionModes",
              "mcpFilter"
            ]
          },
          "observation": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "events": {
                "enum": [
                  "normalized",
                  "raw",
                  "unsupported"
                ]
              }
            },
            "required": [
              "events"
            ]
          },
          "status": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "availability": {
                "enum": [
                  "supported",
                  "limited",
                  "unsupported",
                  "not-tested"
                ]
              },
              "model": {
                "enum": [
                  "supported",
                  "limited",
                  "unsupported",
                  "not-tested"
                ]
              },
              "reasoningEffort": {
                "enum": [
                  "supported",
                  "limited",
                  "unsupported",
                  "not-tested"
                ]
              },
              "context": {
                "enum": [
                  "supported",
                  "limited",
                  "unsupported",
                  "not-tested"
                ]
              },
              "percentSource": {
                "anyOf": [
                  {
                    "enum": [
                      "native",
                      "derived"
                    ]
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "autoCompact": {
                "enum": [
                  "supported",
                  "limited",
                  "unsupported",
                  "not-tested"
                ]
              }
            },
            "required": [
              "availability",
              "model",
              "reasoningEffort",
              "context",
              "percentSource",
              "autoCompact"
            ]
          },
          "experimental": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            }
          },
          "reason": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "evidence": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          }
        },
        "required": [
          "harness",
          "os",
          "interface",
          "operations",
          "handoff",
          "spawn",
          "status",
          "observation",
          "experimental",
          "reason"
        ],
        "allOf": [
          {
            "if": {
              "properties": {
                "spawn": {
                  "properties": {
                    "availability": {
                      "const": "supported"
                    }
                  },
                  "required": [
                    "availability"
                  ]
                }
              },
              "required": [
                "spawn"
              ]
            },
            "then": {
              "properties": {
                "spawn": {
                  "properties": {
                    "lifecycle": {
                      "const": "detached"
                    }
                  },
                  "required": [
                    "lifecycle"
                  ]
                }
              }
            }
          }
        ]
      }
    },
    "executors": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "executorId": {
            "type": "string",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
          },
          "state": {
            "enum": [
              "running",
              "idle",
              "completed",
              "failed",
              "cancelled",
              "unknown"
            ]
          },
          "sessionId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "model": {
            "type": [
              "string",
              "null"
            ]
          },
          "reasoningEffort": {
            "type": [
              "string",
              "null"
            ]
          },
          "context": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "window": {
                "type": [
                  "integer",
                  "null"
                ],
                "minimum": 0
              },
              "used": {
                "type": [
                  "integer",
                  "null"
                ],
                "minimum": 0
              },
              "percent": {
                "type": [
                  "number",
                  "null"
                ],
                "minimum": 0
              },
              "percentSource": {
                "anyOf": [
                  {
                    "enum": [
                      "native",
                      "derived"
                    ]
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "sources": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "window": {
                    "anyOf": [
                      {
                        "enum": [
                          "native",
                          "session",
                          "env",
                          "config",
                          "config:project",
                          "config:user",
                          "derived",
                          "unknown"
                        ]
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "used": {
                    "anyOf": [
                      {
                        "enum": [
                          "native",
                          "session",
                          "env",
                          "config",
                          "config:project",
                          "config:user",
                          "derived",
                          "unknown"
                        ]
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "percent": {
                    "anyOf": [
                      {
                        "enum": [
                          "native",
                          "session",
                          "env",
                          "config",
                          "config:project",
                          "config:user",
                          "derived",
                          "unknown"
                        ]
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                }
              }
            },
            "required": [
              "window",
              "used"
            ]
          },
          "surface": {
            "enum": [
              "tui",
              "headless",
              "web"
            ]
          },
          "turns": {
            "type": "integer",
            "minimum": 0
          },
          "queuedTurns": {
            "type": "integer",
            "minimum": 0
          },
          "lastTurnAt": {
            "type": [
              "string",
              "null"
            ]
          },
          "lastTurnOutcome": {
            "anyOf": [
              {
                "enum": [
                  "completed",
                  "failed",
                  "cancelled"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "lastOperationId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "turnStartedAt": {
            "type": [
              "string",
              "null"
            ]
          },
          "idleSince": {
            "type": [
              "string",
              "null"
            ]
          },
          "processState": {
            "enum": [
              "alive",
              "orphaned",
              "dead",
              "unknown"
            ]
          },
          "persistence": {
            "enum": [
              "one-shot",
              "persistent"
            ]
          },
          "session": {
            "type": [
              "object",
              "null"
            ],
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "store": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "path": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "id",
              "store",
              "path"
            ]
          }
        },
        "required": [
          "executorId",
          "state",
          "surface"
        ]
      }
    }
  },
  "required": [
    "operation",
    "operationId",
    "status",
    "reason",
    "durable",
    "modelVerification",
    "verification",
    "notices"
  ],
  "allOf": [
    {
      "if": {
        "properties": {
          "operation": {
            "const": "handoff"
          },
          "status": {
            "const": "completed"
          }
        },
        "required": [
          "operation",
          "status"
        ]
      },
      "then": {
        "required": [
          "proof"
        ],
        "properties": {
          "durable": {
            "const": true
          }
        }
      }
    }
  ]
}
```
