<div align="center">

# Xiu

**一个面向审计、重视恢复边界的终端编码 Agent。**

给 Xiu 一个目标。它会检查仓库、修改文件、运行命令、验证结果，并留下有界、可复查的执行证据。

[![CI](https://github.com/andrewjr1991/xiu/actions/workflows/ci.yml/badge.svg)](https://github.com/andrewjr1991/xiu/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@xiu-ai/cli)](https://www.npmjs.com/package/@xiu-ai/cli)
[![license](https://img.shields.io/npm/l/@xiu-ai/cli)](./LICENSE)

[English](./README.md) | 简体中文

</div>

## 安装

需要 Node.js 20.18.1 或更高版本。

```bash
npm install -g @xiu-ai/cli
xiu "找出登录测试失败的原因，修好它，然后运行测试"
```

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

- 自主检查、编辑、验证与迭代循环
- OpenAI、Anthropic、Agnes、Ollama、LM Studio、vLLM 和自定义 OpenAI 兼容 Provider
- 能力感知的 Provider 故障转移与分阶段路由
- Repository Map 与 TypeScript/JavaScript 符号、引用和调用方导航
- MCP stdio、Streamable HTTP、Resource、Prompt、OAuth 与权限清单
- 带摘要、签名、发布者和团队策略校验的声明式插件
- 后台任务、会话恢复、任务预算、诊断和执行报告
- 隔离 Git Worktree 与审查门禁的多 Agent 协作
- 简体中文和英文界面与模型输出契约

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

用户设置和本地记录位于 `~/.xiu/`，项目级 Xiu 状态位于 `.xiu/`。任务执行会按目标修改受信任工作区内的文件，并可运行明确批准的命令，因此 Xiu 不是容器沙箱。

可以通过环境变量或交互式 Provider 命令配置凭证：

```powershell
$env:OPENAI_API_KEY = "..."
xiu
```

会话中输入 `/` 打开命令面板。常用入口包括 `/providers`、`/models`、`/status`、`/diagnostics`、`/diff`、`/report`、`/recover` 和 `/help`。

## 文档

| 文档 | 内容 |
| --- | --- |
| [快速上手](./QUICKSTART.md) | 安装、配置并完成第一个任务 |
| [完整使用指南](./USAGE.zh-CN.md) | 全部命令与能力参考 |
| [安全与隐私边界](./SECURITY.zh-CN.md) | 跨版本永久安全规则 |
| [路线图](./ROADMAP.zh-CN.md) | 当前状态、当前版本和下一步 |
| [变更日志](./CHANGELOG.md) | 已发布版本摘要 |
| [发布指南](./PUBLISHING.zh-CN.md) | 维护者发布与安装门禁 |
| [贡献指南](./CONTRIBUTING.md) | 开发和 Pull Request 检查 |

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:package
```

## 当前限制

- 命令执行受策略和操作系统账户权限约束，不是容器沙箱。
- 检查点覆盖 Xiu 文件工具；任意命令和远端副作用仍需 Git 或系统特定手段恢复。
- 尚未实现 macOS Keychain 和 Linux Secret Service。
- 尚未实现 MCP Sampling。
- 多 Agent 冲突会被检测并保留，不自动解决。
- 尚未发布真实模型评测基线。

## 许可

MIT © [静然](https://github.com/andrewjr1991)
