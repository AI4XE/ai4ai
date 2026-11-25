![AI4AI — Let AI Manage Itself](docs/banner.svg)

[![X](https://img.shields.io/badge/X-@xAI4AI-000?logo=x&logoColor=white)](https://x.com/xAI4AI)

[English](README.md) | [中文](README.zh-CN.md)

**AI4AI** — Let AI manage itself more easily.

AI4AI is an extension kit for AI harnesses: it abstracts extension capabilities into a unified interface — the same tool calls work across harnesses, and skills stay portable.

- **Know Itself** — understand its own runtime state, including but not limited to context usage, model, reasoning effort and window.
- **Renew Itself** — renew itself on demand, refreshing the context, shedding the burden and traveling light.
- **Duplicate Itself** — create its own copies, making task scheduling and coordination more flexible.

## Supported harnesses

| Harness | Linux | macOS | Windows |
|---|---|---|---|
| Claude Code | ✅ | ✅ | WSL |
| Codex | ✅ | ✅ | WSL |
| OpenCode | ✅ | ✅ | WSL |
| DeepSeek Harness | ✅ | ✅ | ✅ |

On Windows, all harnesses except DeepSeek Harness run via WSL; details and limits are in [the contract docs](docs/contract.md).

## Start

Requires Node.js 22+. Choose one — do not run all three:

**Recommended**

```bash
npm install -g ai4ai && ai4ai init
```

**Custom install**

```bash
npx ai4ai init
```

**Project-scope install**

```bash
npm i -D ai4ai && npx ai4ai init --scope project
```

For DeepSeek Harness, `ai4ai init` installs both the web and headless profiles.

`init` detects and registers local harnesses (idempotent); `--yes` skips the prompt.

```bash
ai4ai status      # show state
ai4ai upgrade     # re-register
ai4ai uninstall   # remove registrations
```

## What AI can do

The same commands across harnesses (in-harness `session` tool and `ai4ai` CLI):

- `status` — know its own context, model, reasoning effort, window, auto-compaction.
- `handoff` — renew its context in place while keeping the task.
- `spawn` — start a detached executor that works in parallel (not a sub-agent).
- `message` / `finish` / `stop` / `list` — manage executors.
- `watch` / `events` / `sweep` — observe and clean up session processes (CLI helpers).

Claude Code / OpenCode / DSH expose the tools after registration; Codex uses the CLI:

```bash
ai4ai session --operation status --harness codex
```

MIT.
