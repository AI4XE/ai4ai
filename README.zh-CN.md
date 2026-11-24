![AI4AI — 让 AI 管理自己](docs/banner.zh-CN.svg)

[![X](https://img.shields.io/badge/X-@xAI4AI-000?logo=x&logoColor=white)](https://x.com/xAI4AI)

[English](README.md) | [中文](README.zh-CN.md)

**AI4AI** 让 AI 更方便地管理自己。

AI4AI 是面向 AI Harness 的扩展工具包：把扩展能力抽象为统一接口——同一套工具调用跨 Harness 通用，技能保持可移植。

- **认识自己** — 理解自身运行时状态，包括但不限于上下文占用、模型、推理强度和窗口。
- **更新自己** — 按需更新自己，刷新上下文，轻装上阵。
- **复制自己** — 创建自身的副本，让任务调度与协同更灵活。

## 已支持的 Harness

| Harness | Linux | macOS | Windows |
|---|---|---|---|
| Claude Code | ✅ | ✅ | WSL |
| Codex | ✅ | ✅ | WSL |
| OpenCode | ✅ | ✅ | WSL |
| DeepSeek Harness | ✅ | ✅ | ✅ |

Windows 下除 DeepSeek Harness 外，均通过 WSL 运行；细节与限制见[契约文档](docs/contract.md)。

## 开始

需要 Node.js 22+。任选其一，不要依次执行：

**最省事**

```bash
npm install -g ai4ai && ai4ai init
```

**自定义安装**

```bash
npx ai4ai init
```

**项目级安装**

```bash
npm i -D ai4ai && npx ai4ai init --scope project
```

对 DeepSeek Harness，`ai4ai init` 会同时安装 web 与 headless 两个 profile。

`init` 检测并注册本机 Harness（幂等）；`--yes` 跳过选择。

```bash
ai4ai status      # 查看状态
ai4ai upgrade     # 重新注册
ai4ai uninstall   # 卸载注册
```

## Provider 凭据

分离执行者保持**行为**隔离：不继承用户的 hooks、插件、权限或 MCP；但**凭据**不同。若 provider
只在用户层配置，ai4ai 会按「显式请求 → 项目 settings → 用户 settings（`~/.claude/settings.json`
或 `$CLAUDE_CONFIG_DIR/settings.json`）→ 进程环境」的顺序解析允许列表中的 `env`（Claude Code 为
`ANTHROPIC_*`），并在启动时注入 carrier。不会写入用户任何文件，值不会进入 `spec.json`、日志或
证据，`status` 只报告来源与键名。

Codex / OpenCode / DeepSeek Harness 默认读取各自的用户 home；钉住隔离 home（`CODEX_HOME`、
`OPENCODE_CONFIG`、`DSH_HOME`）即排除用户配置。

设置 `AI4AI_CREDENTIAL_INHERITANCE=isolated` 可恢复严格的 project/local-only 行为（测试与多租户）。

## 主要功能

同一套命令，跨 harness 一致（in-harness `session` 工具与 `ai4ai` CLI）：

- `status` — 查看自身上下文、模型、推理强度、窗口、自动压缩。
- `handoff` — 原地更新上下文并保留任务。
- `spawn` — 启动分离式执行者并行工作（不是子 agent）。
- `message` / `finish` / `stop` / `list` — 管理执行者。
- `watch` / `events` / `sweep` — 观测与清理会话进程（CLI 辅助）。

Claude Code / OpenCode / DSH 注册后直接使用工具；Codex 用 CLI：

```bash
ai4ai session --operation status --harness codex
```

MIT。
