<div align="center">

# Xiu

**中文友好、改动可审查的终端编码助手，附带 Windows 桌面预览。**

给 Xiu 一个目标。它会检查仓库、修改文件、运行命令、验证结果，并留下有界、可复查的执行证据。

[![CI](https://github.com/andrewjr1991/xiu/actions/workflows/ci.yml/badge.svg)](https://github.com/andrewjr1991/xiu/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@xiu-ai/cli)](https://www.npmjs.com/package/@xiu-ai/cli)
[![license](https://img.shields.io/npm/l/@xiu-ai/cli)](./LICENSE)

[English](./README.md) | 简体中文

</div>

当前版本 **0.20.11**（2026-10-15）：[GitHub Release](https://github.com/andrewjr1991/xiu/releases/tag/v0.20.11) · [npm](https://www.npmjs.com/package/@xiu-ai/cli) · [变更日志](./CHANGELOG.md)。CLI 支持 Windows、macOS、Linux；桌面端目前只提供 Windows x64 预览版安装包（未签名）。

## 安装

CLI 需要 Node.js 20.18.1 或更高版本，推荐 Node.js 22 LTS：Node 20 已于 2026-04-30 停止维护，0.21 在 Node 20 上启动时会打印一行提示，0.22 起要求 Node.js 22.12 或更高版本。

```bash
npm install -g @xiu-ai/cli
xiu --version
```

Windows PowerShell 中若 `npm.ps1` 被执行策略或 ConstrainedLanguage 限制，请用 `npm.cmd` 代替 `npm`。安装后找不到 `xiu` 命令时，重新打开终端，或运行 `xiu --update-doctor` 做只读诊断。

桌面预览版：从 [Releases](https://github.com/andrewjr1991/xiu/releases/latest) 下载 `Xiu-<版本>-x64-<提交>-unsigned.exe`。安装器按当前用户安装、不要求管理员；因为未签名，Windows SmartScreen 会提示“未知发布者”。

## 快速开始

Xiu 首次安装没有预置渠道。在终端里启动 `xiu` 会进入三步向导：选择渠道（OpenAI、Anthropic、本地 Ollama，或 DeepSeek、通义千问等国内模板）→ 填 Key 或服务地址 → 自动测试连接并拉取模型列表，测试通过后才保存配置，中途 Esc 退出不会留下半成品。之后随时可用 `/provider add` 再添加。也可以先设置环境变量，向导会把检测到的变量列在第一项：

```powershell
$env:OPENAI_API_KEY = "..."
xiu
```

```bash
export OPENAI_API_KEY="..."
xiu
```

支持 OpenAI、Anthropic、Agnes、Ollama、LM Studio、vLLM 和任意 OpenAI 兼容服务，并内置 DeepSeek、通义千问、智谱、Kimi、火山方舟、硅基流动、MiniMax 的模板（只预填地址和模型，不含 Key）；本地模型不需要官方 Key。

在 Git 仓库里运行：

```bash
xiu "解释这个项目的入口和测试方式，不要修改文件"
xiu "修复当前失败的测试，运行相关验证，并总结改动"
xiu            # 交互式会话
xiu --resume   # 恢复本工作区的会话
```

首次进入一个目录时，Xiu 会先询问是否信任该工作区。拒绝信任时不读取项目指令、不加载项目扩展、不修改文件、不执行命令。

会话中输入 `/` 打开命令面板。常用命令：

| 命令 | 用途 |
| --- | --- |
| `/providers`、`/provider add`、`/models` | 管理渠道、Key 和模型 |
| `/plan on` | 只读 Plan 模式，先调查再动手 |
| `/diff`、`/check`、`/report` | 查看改动、运行项目检查、生成执行报告 |
| `/resume`、`/recover` | 恢复会话、处理异常中断的任务 |
| `/background` | 启动和查看可断线续跑的后台命令 |
| `/web configure`、`/web doctor` | 配置和诊断联网搜索 |
| `/status`、`/diagnostics`、`/help` | 状态、诊断与完整命令列表 |

完整命令、启动参数和各功能说明见[使用指南](./USAGE.zh-CN.md)。

## 能做什么

- **自主编码循环**：阅读项目、定位问题、修改文件、运行测试/类型检查/Lint/构建、按结果迭代；自动识别技术栈和项目脚本（`/check`）。
- **可审查**：运行时逐轮显示模型摘要、工具活动、文件变化和验证进度；结束后 `/report` 生成脱敏执行报告；`/diff` 查看本任务、工作区或暂存区的改动。
- **可恢复**：会话、检查点、崩溃恢复、任务预算与停滞诊断；结果未知的副作用只报告、不静默重放。
- **多渠道模型**：能力探测、故障转移、分阶段路由；Provider 中立的视觉、生图、视频、音频模型配置；系统凭据可选存入 Windows 凭据管理器。
- **免 Key 联网搜索**：默认在本机用固定版本的开源 [free-search-mcp](https://github.com/sweetcornna/free-search-mcp) 聚合多个引擎（桌面安装包内置 uv，CLI 首次使用自动下载并校验），本机不可用时回退 Xiu 托管搜索；企业策略禁止本机子进程时用 `/web configure managed` 直接选择托管搜索。引用必须真实打开过，证据不足时失败而不是靠记忆补。
- **扩展**：Skills、MCP（stdio / Streamable HTTP、Resource、Prompt、OAuth、精确权限清单）、带摘要和可选签名校验的声明式插件。
- **多 Agent**：Explorer / Implementer / Reviewer / Tester 在隔离 Git Worktree 中并行，冲突检测、审查证据和显式确认后才集成。
- **后台任务**：开发服务器和长命令可跨终端运行、读取输出、显式取消。
- **桌面工作台（Windows 预览）**：任务流、变更/文件/终端/子智能体/证据标签页、设置中心、MCP 管理、Provider 配置诊断与恢复；受控的 Windows“电脑操作”（Computer Use）预览，需用户显式开启完全访问并逐项授权窗口。

## 安全模型

Xiu 用当前操作系统账号读写文件和运行命令，不是容器沙箱，请只在可信项目中使用。边界由程序执行，模型文字不能解除：

- 工作区信任之前不加载项目指令、Skills、MCP，不写入、不执行。
- Plan 模式在工具边界只读；写入和执行按风险分级，危险操作始终要求明确确认，`-y` 不能跳过。
- 文件访问按真实路径约束，拒绝符号链接、Junction、重解析点和 `..`/Glob 越界。
- 新增或变化的 MCP、插件权限必须由用户确认；网页、MCP 内容和项目文件都是不可信内容。
- Key、Token 等秘密在日志、会话、报告和错误中脱敏；不保存、不伪造模型的隐藏思维链。
- 默认不上传代码、会话、审计或诊断；只有模型调用和用户明确配置的 Web/MCP 服务会联网。

完整规则见[安全与隐私边界](./SECURITY.zh-CN.md)。

## 平台状态

| 能力 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| CLI 与 Agent 循环 | 主要平台，真机验收 | CI 通过，外部验收待完成 | CI 通过，外部验收待完成 |
| MCP、Skills、插件 | 主要平台，真机验收 | CI 通过 | CI 通过 |
| 系统凭据后端 | 凭据管理器（可选） | 未实现 | 未实现 |
| 桌面工作台 | x64 预览版，未签名 | 未提供 | 未提供 |
| 电脑操作（Computer Use） | 预览，需完全访问 | 不支持 | 不支持 |
| 剪贴板图片附件 | 支持 | 使用 `@路径` | 使用 `@路径` |

## 配置与存储

- 用户设置、会话和本地记录位于 `~/.xiu/`；项目级状态位于工作区的 `.xiu/`。
- 渠道 Key 可来自环境变量、本机配置文件或 Windows 凭据管理器；Xiu 只保存必要的引用，不把 Key 写进日志。
- 项目根目录的 `AGENTS.md` 或 `XIU.md` 会作为项目指令，在工作区信任后读取。
- 启动参数（`--provider`、`--model`、`--proxy`、预算与上下文限制等）见 `xiu --help` 和使用指南第二十节。

## 文档

| 文档 | 内容 |
| --- | --- |
| [快速上手](./QUICKSTART.md) | 安装、配置并完成第一个任务 |
| [完整使用指南](./USAGE.zh-CN.md) | 全部命令、参数与能力说明 |
| [安全与隐私边界](./SECURITY.zh-CN.md) | 跨版本长期有效的安全规则 |
| [路线图](./ROADMAP.zh-CN.md) | 当前状态、优先级和下一步 |
| [变更日志](./CHANGELOG.md) | 已发布版本摘要 |
| [发布指南](./PUBLISHING.zh-CN.md) | 维护者发布流程与记录 |
| [贡献指南](./CONTRIBUTING.md) | 开发与 Pull Request 检查 |

旧版 README 中的逐版本说明已归档到 [docs/history](./docs/history/README.zh-CN-before-2026-10-15.md)。

## 开发

```bash
npm ci
npm run typecheck
npm run typecheck:test
npm run lint
npm test
npm run build
npm run check:docs
npm run smoke:package
npm run smoke:platform
```

桌面端单独打包，开发与打包需要 Node.js 22.12 或更高版本（发布的 CLI 仍支持 20.18.1）：

```bash
npm --prefix apps/desktop ci
npm run desktop:typecheck
npm run desktop:build
npm run desktop:smoke
npm run desktop:smoke:ui
npm run desktop:pack:win
npm run desktop:installer:win
npm run desktop:smoke:installer:win
```

CI 在 Windows、Ubuntu、macOS 上运行 CLI 与桌面作业，另有 Node 22/24 兼容作业、生产依赖审计和 CodeQL。

## 当前限制

- 不是容器沙箱：命令以当前账号权限执行，受审批策略约束。
- 检查点只覆盖 Xiu 的文件工具；任意命令和远端副作用需要 Git 或系统手段恢复。
- macOS Keychain、Linux Secret Service 和 MCP Sampling 未实现。
- 多 Agent 冲突会被检测并保留，不自动解决。
- 桌面端仅 Windows x64 预览，安装器未签名；电脑操作不支持密码、支付、删除、发布等高风险流程。
- 尚无公开的真实模型评测基线。

## 许可

MIT © [静然](https://github.com/andrewjr1991)
