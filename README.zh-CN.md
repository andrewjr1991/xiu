<div align="center">

# Xiu

**中文友好、改动可审查的日常终端编码助手。**

给 Xiu 一个目标。它会检查仓库、修改文件、运行命令、验证结果，并留下有界、可复查的执行证据。

[![CI](https://github.com/andrewjr1991/xiu/actions/workflows/ci.yml/badge.svg)](https://github.com/andrewjr1991/xiu/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@xiu-ai/cli)](https://www.npmjs.com/package/@xiu-ai/cli)
[![license](https://img.shields.io/npm/l/@xiu-ai/cli)](./LICENSE)

[English](./README.md) | 简体中文

</div>

当前公开产品基线为 `0.20.1`。该版本新增 Windows 桌面预览、可持久复查的任务变更、受控交互终端，以及 Provider 中立的视觉、生图、视频和音频模型路由，同时保留跨平台 CLI；补丁版本还持久化各能力模型选择、统一限制生成媒体下载大小，并修复 Windows 后台进程交接。

## 安装

需要 Node.js 20.18.1 或更高版本。

```bash
npm install -g @xiu-ai/cli
xiu "找出登录测试失败的原因，修好它，然后运行测试"
```

Windows PowerShell 中若 `npm.ps1` 被执行策略或 ConstrainedLanguage 限制，请使用 `npm.cmd` 代替 `npm`。

交互式工作和恢复会话：

```bash
xiu
xiu --resume
```

Provider 配置和常用命令见[快速上手](./QUICKSTART.md)。

## 为什么是 Xiu

### 运行时看得见，结束后可复查

任务运行期间，Xiu 会在补充输入框上方持续写入模型轮次、明确面向用户的摘要、工具活动、有界结果、文件变化和验证进度。它不会伪造 Provider API 没有返回的隐藏思维链。

任务结束后，`/report` 会从持久任务记录、精确会话回放、诊断、验证证据和工作区安全审计事实中组装脱敏执行报告。实时视图与报告具有不同的保留边界；两者都不依赖模型回忆自己做过什么。

### 崩溃恢复不静默重放副作用

进程在任务中途停止后，Xiu 会保留最近的安全边界和未决副作用。结果未知的操作只报告，必须先核验或确认，绝不静默重放。

### 由程序执行的安全边界

- 工作区信任前，不加载项目指令、项目 Skill、项目 MCP，也不执行命令或写入。
- Plan 模式在工具边界强制只读。
- 写入与执行按风险分类；危险操作始终需要明确确认。
- 所有工作区路径按真实路径约束，拒绝符号链接、Junction、重解析点、父目录和 Glob 越界。
- 插件内容摘要、可选 Ed25519 签名与本机精确授权是相互独立的门禁。

### 有证据门禁的联网检索

对于时效性任务，搜索摘要只用于发现。最终引用必须成功打开；证据不足时 Xiu 会失败，而不是让模型凭记忆补齐当前事实。

### 本地优先的记录

Xiu 默认不上传项目代码、会话、审计或诊断数据。模型调用以及用户明确配置的 Web/MCP 服务仍会连接相应端点。更新提醒默认关闭；除非用户主动开启，普通启动不会执行更新检查。

## 核心能力

下列是 CLI 的完整能力列表，不代表桌面预览全部已接入。桌面已支持核心编码、审批、索引、媒体、历史变更和恢复；MCP、原生联网、插件、后台任务、多 Agent、Provider 故障转移/分阶段路由尚未接入桌面任务。两端分界与同步计划见[路线图能力盘点](./ROADMAP.zh-CN.md#4-后续工程化)。

- 自主检查、编辑、验证与迭代循环
- OpenAI、Anthropic、Agnes、Ollama、LM Studio、vLLM 和自定义 OpenAI 兼容 Provider
- 能力感知的 Provider 故障转移与分阶段路由
- Provider 中立的视觉、生图、视频和音频模型路由，以及受控的付费媒体恢复
- Repository Map 与 TypeScript/JavaScript 符号、引用和调用方导航
- MCP stdio、Streamable HTTP、Resource、Prompt、OAuth 与权限清单
- 带摘要、签名、发布者和团队策略校验的声明式插件
- 后台任务、会话恢复、任务预算、诊断和执行报告
- 隔离 Git Worktree 与审查门禁的多 Agent 协作
- 简体中文和英文界面与模型输出契约

## 0.18.0 已交付变化

- `/check` 发现根目录 npm 项目的 `typecheck`、`lint`、`test`、`build` 脚本；`/check test` 执行单项，`/check all` 按顺序运行可用检查。真实脚本及前后置脚本会展示并复用审批路径；Plan 模式只允许发现，执行时可按 `Ctrl+C` 取消。
- `/diff`（或 `/diff task`）显示本任务内存起点以来的变化；`/diff workspace` 对比 HEAD，包含暂存、未暂存和未跟踪文件；`/diff staged` 对比暂存区与 HEAD。已有修改、来源不确定和覆盖限制会明确标注；快照与预览有上限，重启后不恢复原任务起点。
- 中文和英文响应到达时显示临时草稿；先脱敏再展示，代码字面量保留原文，草稿不代表任务已完成。
- 工具失败统一状态与原因；换参数但持续同类失败会有界停止，失败命令不算进展。`echo test`、版本和帮助输出不算验证，另一项通过不能覆盖已记录的失败，本任务再次修改后旧验证过期。
- 跨 Provider 历史从公开文本和工具调用重建；截断、过滤或未知结束状态不能误报完成，也不能执行不完整工具调用。

脚本退出成功只证明一次执行结果，不等于所有需求均已正确实现。详细命令与边界见[使用指南](./USAGE.zh-CN.md)。

## 平台状态

| 能力 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 核心 CLI 与 Agent 循环 | 主要平台，本机已验收 | CI 目标，外部验收待完成 | CI 目标，外部验收待完成 |
| MCP、Skill、插件 | 主要平台，本机已验收 | CI 目标 | CI 目标 |
| 系统凭证后端 | 凭据管理器，显式选择 | 尚未支持 | 尚未支持 |
| 剪贴板图片附件 | 支持 | 使用 `@路径` | 使用 `@路径` |
| 后台 Shell | PowerShell | `/bin/sh` 路径待验收 | `/bin/sh` 路径待验收 |

目前 Windows 的验收最充分。CI 通过不能替代真实系统凭证库、企业策略、终端和 OAuth 迁移验收。

## 配置与存储

未发布的 `0.20.2` 候选已实现两端零渠道首次配置：通过 CLI `/provider add` 或桌面“设置与模型 → 新增渠道”显式添加，Agnes 等仅是可选模板，不占用 ID；用户渠道始终可见，确认删除最后一个渠道后回到配置状态。旧版明确使用过的渠道、凭据引用和模型/路由配置会迁移保留。下面的 0.20.1 已知问题仅描述已发布包，不代表当前候选源码。

0.20.1 仍自动注册预设渠道，桌面隐藏的未配置渠道也会占用 ID，新增同名 Agnes 等可能失败。已登记为首个修复项：普通版新安装默认零渠道，全部由用户显式添加，本地模型也不例外；此行为尚未发布，升级不会擅自清除已有设置。

用户设置和本地记录位于 `~/.xiu/`，项目级 Xiu 状态位于 `.xiu/`。任务执行会按目标修改受信任工作区内的文件，并可运行明确批准的命令，因此 Xiu 不是容器沙箱。

可以通过环境变量或交互式 Provider 命令配置凭证：

```powershell
$env:OPENAI_API_KEY = "..."
xiu
```

会话中输入 `/` 打开命令面板。常用入口包括 `/providers`、`/models`、`/status`、`/diagnostics`、`/diff`、`/check`、`/report`、`/recover` 和 `/help`。

## 文档

| 文档 | 内容 |
| --- | --- |
| [快速上手](./QUICKSTART.md) | 安装、配置并完成第一个任务 |
| [完整使用指南](./USAGE.zh-CN.md) | 全部命令与能力参考 |
| [安全与隐私边界](./SECURITY.zh-CN.md) | 跨版本永久安全规则 |
| [路线图](./ROADMAP.zh-CN.md) | 当前状态、当前版本和下一步 |
| [变更日志](./CHANGELOG.md) | 未发布工作与已发布版本摘要 |
| [发布指南](./PUBLISHING.zh-CN.md) | 维护者发布与安装门禁 |
| [贡献指南](./CONTRIBUTING.md) | 开发和 Pull Request 检查 |

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run check:docs
npm run eval:smoke
npm pack --dry-run --json
npm run smoke:package
npm run smoke:platform
```

v0.20.1 Windows 桌面预览与 CLI npm 包独立打包：

```bash
npm --prefix apps/desktop ci
npm run desktop:typecheck
npm run desktop:build
npm run desktop:smoke
npm run desktop:pack:win
npm run desktop:installer:win
npm run desktop:installer:msix:win
```

桌面 Provider 配置会把对话模型与视觉、生图、视频、音频模型分开。兼容的非 Agnes 渠道使用自己的 Base URL 与凭据调用媒体端点，不会被静默改投 Agnes。桌面任务注册受控媒体工具，生成文件只能写入可信工作区，小型图片、音频和视频可在文件检查器中本地预览；所有可能计费的生成仍要求危险操作审批并进入持久媒体恢复账本。

G5B 预览会在可信工作区中运行真实共享 Agent，保留 G4 的审查与恢复检查器，并允许空闲工作区发现和切换 Provider/模型、测试连接，以及把新 Key 保存到 Windows Credential Manager。选择器会把当前渠道置顶，只显示有真实凭据或已成功发现模型目录的渠道，未连接的免 Key 本地预设不会占位；各渠道目录独立持久化。输入区完整展示 Provider/模型标识，并提供“每次询问、工作区自动、高权限”三种权限模式；模式由主进程实施，危险操作仍需精确确认，工作区信任和路径边界不可绕过。最近任务可恢复会话后继续，不会重放旧工具；新完成任务会在工作区独立保存有界、脱敏的变更报告，当前会话和历史会话都显示 Codex 风格变更摘要卡，点击文件可展开保存的有界 Diff，右侧“本任务”也回放同一份报告。没有快照的旧任务会明确提示，不会显示当前工作区 Diff；删除任务会同步清理对应快照，但不会删除项目文件或检查点。界面也提供显式新建任务、文件/图片选择、粘贴和拖放。删除任务或移出最近项目使用应用内确认卡，并在主进程边界再次要求确认；不会删除项目文件或目录。每轮模型调用都会显示一条“模型进展”：优先呈现 Provider 明确返回的公开说明；若该轮只有工具调用，则只根据计划、工具、文件变化和验证事件生成可核验事实摘要。Xiu 不请求、保存、伪造或暴露私有思维链。Renderer 只收到凭据来源状态，不会收到已保存 Key 或 Base URL；任务运行中和外部写入者存在时禁止重配。检查器中的“终端”现由主进程持有 PTY，并固定绑定当前可信工作区；Renderer 只有会话化输入、输出、尺寸和关闭接口。启动终端前会拒绝运行中的 Agent 或已检测到的外部写者，终端运行时同一桌面进程不能启动或恢复 Agent。输出只作有界内存回放，不写入任务审计或验证证据；切换工作区、关闭窗口或退出应用会清理子进程。Agent 的脱敏命令证据仍独立显示在“证据”页。Windows x64 NSIS 已完成本机安装、升级、中断重启和卸载验收，MSIX 已完成结构核验但仍需 Microsoft Store 或企业信任证书签名后才能正常部署；稳定跨平台桌面验收仍未完成，桌面端也不会进入已发布的 CLI npm 包。

## 当前限制

- 命令执行受策略和操作系统账户权限约束，不是容器沙箱。
- 检查点覆盖 Xiu 文件工具；任意命令和远端副作用仍需 Git 或系统特定手段恢复。
- 尚未实现 macOS Keychain 和 Linux Secret Service。
- 尚未实现 MCP Sampling。
- 多 Agent 冲突会被检测并保留，不自动解决。
- 尚未发布完整真实模型评测基线。旧评测最近留下 14/30 条记录且仍未完成，其受限工具配置不能证明产品成功率。保留原始结果，完成旧评测不再是开发门槛；P0/P1 使用针对性离线场景和候选检查，不自动授权新模型费用。

## 许可

MIT © [静然](https://github.com/andrewjr1991)
