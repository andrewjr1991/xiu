# Xiu 使用指南

文档分三层：[README](./README.zh-CN.md) 回答“Xiu 是什么、能做什么、边界在哪”，[快速上手](./QUICKSTART.md) 带你在几分钟内完成安装、配置和第一个任务，本页是完整使用指南的目录，按功能拆成下面的篇章。英文读者请看精简版 [English guide](./docs/guide/en/README.md)。

遇到问题先运行 `xiu doctor`，它输出一份只读、已脱敏的诊断报告，可以直接贴给维护者。

## 篇章

| 篇章 | 内容 |
| --- | --- |
| [上手与界面](./docs/guide/getting-started.zh-CN.md) | Xiu 能做什么、安装与检查、从正确目录启动、工作区信任、交互界面与语言、任务描述技巧、常用任务示例、新手工作流、中断与退出 |
| [渠道与模型](./docs/guide/providers.zh-CN.md) | 首次向导、Agnes / OpenAI / Anthropic / 本地模型 / OpenAI 兼容服务与国内厂商模板、Key 与凭证管理、故障转移、阶段路由、模型选择 |
| [权限、Plan 模式与安全建议](./docs/guide/permissions.zh-CN.md) | 四级风险审批、`--yes` 的边界、只读 Plan 模式、多 Agent 并行任务、安全建议 |
| [会话、状态、差异与报告](./docs/guide/sessions.zh-CN.md) | 会话恢复、历史与上下文压缩、`/status`、`/diff`、`/check`、恢复点与回退、完整执行报告 |
| [Skills、MCP、项目指令与插件](./docs/guide/extensions.zh-CN.md) | Skills 安装与权限、MCP Server 配置 / 权限清单 / OAuth 凭证、`AGENTS.md` 项目指令、插件完整性与签名 |
| [图片、视频和音频](./docs/guide/media.zh-CN.md) | 图片分析、图片 / 视频 / 音频生成、媒体记录与恢复 |
| [后台命令和开发服务器](./docs/guide/background.zh-CN.md) | 跨终端的后台任务：启动、读取输出、取消 |
| [联网搜索](./docs/guide/web-search.zh-CN.md) | 本机免 Key free-search、Tavily / Brave / 自建 SearXNG、Xiu 托管搜索与设备凭证、搜索失败与证据门禁、`/web doctor` |
| [命令与启动参数速查](./docs/guide/commands.zh-CN.md) | 全部斜杠命令与 CLI 启动参数 |
| [常见问题、错误码与配置恢复](./docs/guide/troubleshooting.zh-CN.md) | 统一错误提示格式与全部错误码、安装与连接常见问题、渠道配置诊断与备份恢复 |
| [桌面开发预览](./docs/guide/desktop.zh-CN.md) | Windows 桌面工作台的开发、构建、打包与已知限制 |

## 相关文档

- [安全与隐私边界](./SECURITY.zh-CN.md)：跨版本长期有效的安全规则。
- [变更日志](./CHANGELOG.md)：每个版本的行为变化。
- [路线图](./ROADMAP.zh-CN.md)：当前状态、优先级和下一步（仅仓库，不随 npm 包分发）。
- [发布指南](./PUBLISHING.zh-CN.md)：维护者发布流程（仅仓库）。
- [逐版本说明归档](./docs/history/USAGE-release-notes-before-2026-10-15.zh-CN.md)：2026-10-15 文档分层前本页开头的候选与发布说明。

本指南的斜杠命令和启动参数属于 CLI；桌面端的对应功能在设置中心与侧栏，见桌面篇。
