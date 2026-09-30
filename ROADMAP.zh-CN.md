# Xiu 产品与工程路线图

> 本文档只维护当前状态、当前版本目标和下一步。已发布版本摘要见 `CHANGELOG.md`，实现细节保存在 Git 历史，永久安全边界见 `SECURITY.zh-CN.md`。

## 1. 项目定位

Xiu 是由静然开发的自主编码助手，面向需要看见执行过程、复查结果、控制权限并从中断安全恢复的真实项目环境。CLI 是当前稳定入口，桌面工作台从 v0.20.0 开始设计和实现。

| 项目 | 当前值 |
| --- | --- |
| npm 包 | `@xiu-ai/cli` |
| 全局命令 | `xiu` |
| 当前公开版本 | `0.19.0`，更新命令模块化与三平台候选包验收 |
| 当前开发版本 | `0.20.0`，已完成 G1-G5C、Provider 中立的视觉/生图/视频/音频能力模型接入及本机完整验证；下一步核验 CI、真实 Provider 与外部设备矩阵 |
| 主要运行时 | Node.js 20.18.1+ / TypeScript |
| 主要验收平台 | Windows PowerShell / Windows x64 桌面 |
| 跨平台状态 | CLI 与桌面自动化已通过 Windows、Ubuntu、macOS CI；桌面 Windows x64 NSIS 已完成本机安装/升级/中断重启/卸载，MSIX 已完成结构核验但仍待可信签名与企业设备安装验收，macOS/Linux 真实用户桌面仍待验收 |

## 2. 当前产品基线

截至 `0.19.0`，已经发布：

- 交互式中英文终端 UI、运行过程滚动历史、命令面板、文件/图片引用、Diff、计划和诊断。
- 工作区信任、Plan 只读模式、风险审批、危险操作确认、检查点和验证门禁。
- 项目索引、Repository Map、TypeScript/JavaScript 符号、引用和调用方检索，以及结构化 HTML/JSON/CSV 提取。
- 项目会话隔离、恢复、历史、上下文压缩、任务预算、停滞诊断、崩溃恢复、后台任务和执行报告。
- OpenAI、Anthropic、Agnes、本地模型及 OpenAI-compatible Provider；能力探测、故障转移和分阶段路由。
- Skills、MCP stdio/Streamable HTTP、Resource、Prompt、OAuth 和权限清单。
- 声明式插件发现、精确授权、安装/更新/禁用/恢复、完整包摘要、可选签名和团队策略。
- Provider/MCP 凭证的兼容存储、可选 Windows Credential Manager、显式迁移/回退/清理和统一脱敏。
- 只读联网搜索、来源打开门禁、托管设备认证、设备可观测性和安全数据库迁移。
- 多 Agent 角色、独立 Worktree、冲突检测、Reviewer/Tester 证据和显式集成确认。
- 独立 `/update` 命令模块、显式更新检查、可选提醒、安装路径诊断和官方发布元数据核验。
- Windows、Ubuntu、macOS CI，以及从候选 tarball 安装后调用真实 npm shim、Unicode 路径和后台 worker 的平台 smoke。

仍需外部环境验证：

- Windows ARM64 和另一台受企业策略约束的 Windows 机器。
- 真实 Cloudflare OAuth 凭证迁移、重启读取与注销闭环。
- macOS/Linux 的完整用户安装、终端、后台任务和 Provider/MCP 路径。

Windows 系统凭证后端在既有外部矩阵完成前继续显式选择，不设为默认。macOS Keychain 与 Linux Secret Service 尚未实现。

## 3. 当前版本：v0.20.0 本地优先桌面工作台

`0.19.0` 已发布到官方 npm Registry。v0.20.0 已完成共享无界面运行时 G1、Electron 安全壳/可信工作区 G2、任务与审批闭环 G3、审查/证据/恢复 G4、Provider/模型配置 G5A、受控交互终端 G5B 和 G5C Windows x64 候选包验收。历史续做、附件、模型目录、自定义渠道、权限模式、安全删除、运行事件回放、独立有界的历史变更报告及事实型模型进展均已落地；旧任务不伪造缺失过程或 Diff，源码 Diff 不进入通用审计。G5B 的 PTY 仍由主进程持有并与 Agent 单写者互斥。G5C 新增按用户安装的辅助 NSIS 包，以及含空格/中文路径的安装、覆盖升级、异常中断重启和卸载验收；隔离测试壳驱动真实 Renderer 覆盖两种窗口尺寸、键盘、Provider/模型、审批、30 轮事件流、停止、未知副作用门禁、检查点还原和终端生命周期。提交 `28081a1` 的 GitHub Actions 运行 `36691490514` 已通过三平台 CLI 与 Desktop 共六个作业；下一步进入 Windows 外部设备和 macOS/Linux 真实用户桌面矩阵，不对现有 CLI 进行一次性重写。

G5A 已扩展为 Provider 中立的能力模型配置：对话模型列表与视觉、生图、视频、音频模型分离，自定义 OpenAI-compatible 渠道使用自身 Base URL、凭据和能力模型；桌面 Agent 与 CLI 复用媒体危险审批、持久化账本和未知结果不重放边界。Agnes 走专用媒体适配，OpenAI/OpenAI-compatible 走兼容端点，Anthropic 当前只开放视觉理解。本轮类型检查、661 项全量测试、桌面构建/UI smoke、NSIS 安装器验收和 MSIX 结构 smoke 已通过；真实 Provider 计费请求、可信 MSIX 签名和外部设备安装仍须单独验收，不能由本地模拟替代。

### 实施范围

1. 建立类型化 `XiuRuntime` 命令、快照与事件协议，让 CLI 和 GUI 使用同一任务事实源。
2. 使用 Electron + React/TypeScript 构建隔离的桌面壳，Renderer 无 Node 权限，Preload 只暴露白名单 API。
3. 实现工作区信任、任务历史、任务流、输入、计划、停止、审批和完成门禁。
4. 实现变更、文件、安全预览、命令输出、验证证据、检查点和恢复检查器。
5. 保持 CLI 独立可用，并通过单写者锁和显式交接处理 CLI/GUI 同时访问。
6. 提供受工作区、信任和进程生命周期约束的交互终端，不把 Renderer 变成任意进程入口。
7. 先完成 Windows x64 真实验收，再扩展 macOS/Linux 真实桌面矩阵。

### 非目标

不新增云账号、同步、分享或 PR 自动化；不构建完整 IDE；不改变现有凭证解析优先级、更新安装、MCP/Skill/插件权限和危险操作规则；不把 Electron 依赖加入 CLI npm 包。交互终端仅作为 G5B 的受控工作区能力，不替代 Agent 的审批与审计路径。

### 设计与验收

当前设计见 `V0.20.0_DESIGN.zh-CN.md`。共享运行时、可信工作区、真实 Agent 任务、审批、单写者、审查/恢复、Provider/模型、历史变更快照与受控 PTY 的既有边界保持不变。G5C 已生成 Windows x64 辅助安装器，并完成含空格/中文路径的全新安装、安装物启动、覆盖升级、异常中断后重启和卸载验收；隔离测试壳驱动真实 Renderer 覆盖 1366×768、900px 窄窗、键盘、Provider/模型、审批、30 轮事件流、停止、未知副作用门禁、检查点还原与终端生命周期，测试桥不进入正式包。GitHub Actions 的 Windows、Ubuntu、macOS CLI 与 Desktop 六作业均通过；macOS/Linux 真实用户桌面与外部 Windows 设备矩阵尚未完成，因此仍不能作为跨平台稳定桌面产品发布。

## 4. 后续工程化

- 以功能域增量迁移 `cli.ts`；GUI 所需路径优先抽到共享运行时，不做一次性大规模改写。
- 将 `Agent` 构造函数改为 options 对象，并按阶段拆分长方法。
- 随迁移逐步抽取中英文资源，不做一次性千处重写。
- 将关键静默降级统一送入有界诊断通道。
- 根据真实平台验收设计 macOS Keychain 与 Linux Secret Service；已选择系统后端后仍必须失败关闭，不能静默回退明文。

## 5. v1.0 稳定产品化门槛

- Windows、macOS、Linux 的 CLI 安装和升级流程稳定，平台差异有准确说明。
- 桌面工作台完成至少 Windows x64 稳定验收；其他平台状态准确标记。
- 崩溃恢复通过压力和未知副作用测试。
- Provider、Tool、Skill、MCP、插件和桌面运行时协议有兼容承诺。
- 自动更新、版本回滚和供应链验证具备独立设计与恢复方案。
- 完整中英文首次配置路径，不依赖阅读长手册才能开始。
- 固定评测无明显质量、安全或成本退化。
- 隐私、安全和诊断上传策略清晰且默认保守。

## 6. 永久安全边界

- 不绕过工作区信任、Plan 只读、风险审批、检查点和危险操作确认。
- 不静默扩大 MCP、Skill、插件或子 Agent 权限。
- 不默认上传代码、会话、审计或诊断数据。
- 不在不确定副作用后自动重放操作。
- 不把 Key、Token、Client Secret、Cookie 或 Authorization 写入日志、会话、IPC 或错误。
- 不显示、保存或伪造 Provider API 未返回的隐藏思维链。
- 不把 Renderer 的按钮状态当作安全控制。
- 不在测试失败或外部验收缺失时宣称能力稳定。

详细规则见 `SECURITY.zh-CN.md`。

## 7. 发布与验证规则

每个版本必须：

1. 明确目标、非目标、风险和验收标准。
2. 补充失败场景测试，再实现最小闭环。
3. 运行 `npm run typecheck`、`npm test`、`npm run build`、`npm pack --dry-run --json` 和 `npm run smoke:package`。
4. 检查包内文件、版本和唯一当前设计稿。
5. 不覆盖已经发布的 npm 版本。
6. 发布后从官方 Registry 回读版本、latest、完整性摘要和文件清单。
7. tag 必须指向与发布包对应的精确源码提交；不使用“最接近”的提交补造历史。
8. 同步 README、使用说明、发布说明、CHANGELOG 和本路线图。

## 8. 持续评测指标

- 端到端成功率、验证率和首次修改正确率。
- 无关文件修改率与安全拒绝正确率。
- 重复失败率、重试成功率和未知副作用次数。
- Token、费用、完成时间和首字延迟。
- 中断、崩溃和关闭终端/窗口后的恢复成功率。
- 审批拒绝率、权限扩张率和秘密泄漏回归。
- 大型项目检索命中率。
- 多 Agent 冲突率与安全集成成功率。
- GUI 事件延迟、断流恢复率、CLI/GUI 状态一致率和误报完成率。

## 9. 下一步

1. 固定 G5C 候选提交并读取 Windows、Ubuntu、macOS CI 的真实最终结果；任一作业未运行或失败时不宣称候选通过。
2. 对 Windows x64 候选安装器做一次用户侧真实 Agent 长任务体验，复核审批、取消、终端互斥和恢复提示；自动化结果不冒充真实 Provider 体验。
3. 使用目标组织的受信任代码签名证书或 Microsoft Store 签名 MSIX，并在只能接收 MSIX 的企业设备上验证安装、启动、升级和卸载；待签名结构包不得冒充可部署产物。
4. 保留 Windows ARM64、企业策略设备、真实 OAuth 迁移和 macOS/Linux 用户真实终端矩阵；外部条件具备后补验，不伪造结果。
