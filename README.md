![AI4AI — Let AI Manage Itself](docs/banner.svg)

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

On Windows, all harnesses except DeepSeek Harness run via WSL; details and limits are in the contract docs.

## Start

Requires Node.js 22+.

```bash
npx ai4ai init                                      # recommended: no global install
npm install -g ai4ai && ai4ai init                  # global install, command persists
npm i -D ai4ai && npx ai4ai init --scope project    # project-scope install
```

`init` detects and registers local harnesses (idempotent); `--yes` skips the prompt.

```bash
npx ai4ai status      # show state
npx ai4ai upgrade     # re-register
npx ai4ai uninstall   # remove registrations
```

Claude Code / OpenCode / DSH expose the tools after registration; Codex uses the CLI:

```bash
npx ai4ai session --operation status --harness codex
```

### DeepSeek Harness Web

1. In DSH Web, open **Plugins** → **Add plugin** and choose `ai4ai`.
2. **Enable** the plugin.
3. Restart the DSH service the way you normally start it, then refresh the page.

Contract and details: [docs/contract.md](docs/contract.md). MIT.
