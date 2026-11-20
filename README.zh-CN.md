![AI4AI — 让 AI 管理自己](docs/banner.zh-CN.svg)

[English](README.md) | [中文](README.zh-CN.md)

**AI4AI** 让 AI 更方便地管理自己。

AI4AI 是面向 AI Harness 的扩展工具包：把扩展能力抽象成统一接口——工具的调用方式跨 Harness 一致，技能保持可移植。

- **认识自己** —— 了解自己的运行状态，包括但不限于上下文用量、模型、推理强度与窗口。
- **更新自己** —— 按需主动刷新自己，更新上下文，卸下负担，轻装前行。
- **复制自己** —— 创建自己的分身，让任务安排和协同更加自由。

## 已支持的 Harness

| Harness | Linux | macOS | Windows |
|---|---|---|---|
| Claude Code | ✅ | ✅ | WSL |
| Codex | ✅ | ✅ | WSL |
| OpenCode | ✅ | ✅ | WSL |
| DeepSeek Harness | ✅ | ✅ | ✅ |

Windows 下除 DeepSeek Harness 外，均通过 WSL 运行；细节与限制见契约文档。

## 开始

需要 Node.js 22+。

```bash
npx ai4ai init                                      # 推荐：免全局安装
npm install -g ai4ai && ai4ai init                  # 全局安装，命令常驻
npm i -D ai4ai && npx ai4ai init --scope project    # 项目内安装
```

`init` 检测并注册本机 Harness（幂等）；`--yes` 跳过选择。

```bash
npx ai4ai status      # 查看状态
npx ai4ai upgrade     # 重新注册
npx ai4ai uninstall   # 卸载注册
```

Claude Code / OpenCode / DSH 注册后直接使用工具；Codex 用 CLI：

```bash
npx ai4ai session --operation status --harness codex
```

契约与细节见 [docs/contract.md](docs/contract.md)。MIT。
