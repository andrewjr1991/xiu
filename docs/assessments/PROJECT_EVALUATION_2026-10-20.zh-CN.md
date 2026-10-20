# Xiu 项目评估报告（2026-10-20）

评估基线：`main` 的 `bd1eed2`，加上本轮 0.20.14 桌面对话修复与版本调整。依据是源码、[路线图](../../ROADMAP.zh-CN.md)、[安全边界](../../SECURITY.zh-CN.md)、[CI](../../.github/workflows/ci.yml)、测试和本地构建；未使用真实付费模型、外部企业设备或跨平台人工试用代替自动化证据。2026-10-20 从官方 npm Registry 回读 `@xiu-ai/cli` 的 `latest` 为 0.20.12；0.20.14 仍是开发候选。

## 判断

Xiu 已有可用的本地优先编码助手核心：CLI 的任务、工具、权限、恢复和脚本接口较完整；Windows x64 桌面工作台能复用同一运行时并完成本地安装生命周期。当前最主要的距离是**真实任务成功率与外部平台验收**，其次是桌面管理入口和正式分发。自动化测试通过能说明契约和受控场景成立，不能证明所有模型、企业网络或桌面应用中的实际完成率；因此桌面仍应标注为预览版，不宜宣称 v1.0 稳定。

## 本地验证结果

0.20.14 在 Windows x64 / Node 22.20.0 本机通过：CLI、测试和桌面类型检查；源码 lint；文档检查；CLI 与桌面构建；完整测试 **1362 项（1350 通过、12 跳过、0 失败）**；确定性评测 smoke **10/10**；npm dry-run 包 **491 个文件**，不含桌面程序、设计稿或本报告；隔离包安装 smoke、真实 npm 命令入口的 Windows 平台 smoke、桌面 UI 冒烟（含表格和宽窄布局）以及 Windows 安装器的全新安装、fuses、启动、内置 uv、覆盖升级、中断重启、卸载。安装器 SHA-256 为 `12228b51c329acf9b762680ee15730007f30e7a68ce5529d2f5811a686e61670`，Authenticode 状态为 `NotSigned`。这些是本机结果，提交后的跨平台 CI 与外部机器尚需单独确认。

## 已有什么

| 范围 | 已落地的能力 | 证据 |
| --- | --- | --- |
| 共享核心与 CLI | 交互任务和一次性任务、`--json` 事件流、明确退出码、计划与验证门禁、会话恢复、运行列表、历史 Diff、报告与只读审计；启动重依赖按需加载。 | [`src/cli.ts`](../../src/cli.ts)、[`src/runtime/xiu-runtime.ts`](../../src/runtime/xiu-runtime.ts)、[`src/task-run.ts`](../../src/task-run.ts)、[`src/execution-report-query.ts`](../../src/execution-report-query.ts) |
| 编码与协作 | 文件/命令/结构化读取、项目索引、后台任务、多 Agent 独立 Worktree、冲突检查和 Reviewer/Tester 证据。 | [`src/tools.ts`](../../src/tools.ts)、[`src/project-index.ts`](../../src/project-index.ts)、[`src/background.ts`](../../src/background.ts)、[`src/multi-agent.ts`](../../src/multi-agent.ts) |
| 模型与扩展 | OpenAI、Anthropic、Agnes、本地和兼容渠道；能力模型、路由/故障转移、媒体工具、Skills、MCP/OAuth/Resource Template、声明式插件和本机/托管只读搜索。 | [`src/providers.ts`](../../src/providers.ts)、[`src/provider-routing.ts`](../../src/provider-routing.ts)、[`src/skills.ts`](../../src/skills.ts)、[`src/mcp.ts`](../../src/mcp.ts)、[`src/plugins.ts`](../../src/plugins.ts)、[`src/web-search.ts`](../../src/web-search.ts) |
| 桌面预览 | Electron/React 工作台、历史续聊、复制和记录跳转、Markdown 表格、Diff/文件/终端/报告面板、Provider/MCP 管理、本地 Skill 安装预览和受控 Computer Use；Windows x64 NSIS 安装包。 | [`apps/desktop/renderer/src/App.tsx`](../../apps/desktop/renderer/src/App.tsx)、[`TaskTimeline.tsx`](../../apps/desktop/renderer/src/TaskTimeline.tsx)、[`ManagementPanel.tsx`](../../apps/desktop/renderer/src/ManagementPanel.tsx)、[`apps/desktop/main/computer-use-controller.ts`](../../apps/desktop/main/computer-use-controller.ts) |
| 安全与恢复 | 工作区信任、Plan 只读、风险审批、单写者、检查点、未知副作用不重放、凭据脱敏、IPC 发送者与逐通道参数校验，以及解包 worker/桥程序哈希检查。 | [`src/trust.ts`](../../src/trust.ts)、[`src/verification.ts`](../../src/verification.ts)、[`apps/desktop/main/ipc-schema.ts`](../../apps/desktop/main/ipc-schema.ts)、[`apps/desktop/main/unpacked-integrity.ts`](../../apps/desktop/main/unpacked-integrity.ts)、[安全边界](../../SECURITY.zh-CN.md) |
| 工程与分发 | CLI 的 Windows/Ubuntu/macOS 验证、Node 兼容作业、桌面三平台构建/UI smoke、依赖审计、确定性模拟评测及 Windows 安装生命周期测试。用户文档有 README → QUICKSTART → 专题指南三层。 | [CI](../../.github/workflows/ci.yml)、[`evals/README.md`](../../evals/README.md)、[`scripts/package-smoke.mjs`](../../scripts/package-smoke.mjs)、[`docs/guide/desktop.zh-CN.md`](../guide/desktop.zh-CN.md) |

## 缺什么

1. **真实效果证据（高优先级）。** [`evals`](../../evals/README.md) 已有确定性模拟任务和受授权的真实运行器，但 README 明确没有公开的真实模型质量基线。缺少按模型/任务类别的成功率、首次修改正确率、验证率、耗时、Token/费用及回归阈值；模拟 smoke 不能代表企业代理、长任务或真实模型输出。
2. **外部平台矩阵（高优先级）。** Windows x64 本机安装已覆盖，Windows ARM64、另一台企业策略设备、macOS/Linux 的完整真实安装与后台/终端/MCP 路径仍未验收。Computer Use 的 Electron/游戏窗口、受保护窗口、多显示器和实际视觉模型也需要独立验证。现有桥程序不构成 OS 级单窗口沙箱，[安全边界](../../SECURITY.zh-CN.md)已明确这一点。
3. **正式分发（高优先级）。** Windows 安装器缺代码签名证书；自动更新、失败回滚和供应链恢复尚未形成可验收闭环。根包仍声明 Node `>=20.18.1`，路线图计划在 0.22 转向 `>=22.12`，同时升级受旧运行时限制的大版本依赖。桌面跨平台 CI 成功不等于已经提供跨平台正式安装包。
4. **桌面管理功能差距（中优先级）。** 已批准插件可在桌面任务中生效，但缺插件查看/授权/禁用的完整入口；Skills 有本地安装预览，远程 Git、替换和卸载仍需 CLI；MCP 高级/项目配置及 Resource Template 的完整桌面操作尚未与 CLI 对齐。macOS Keychain、Linux Secret Service 和 MCP Sampling 也尚未实现。[能力盘点](../../ROADMAP.zh-CN.md)第 4 节仍标注“部分已过时”，需要持续校正。
5. **表达与维护成本（中优先级）。** 桌面消息渲染是安全的轻量 Markdown 子集，此轮补齐表格和分隔线后仍不是完整 GFM。`src/cli.ts` 约 2330 行、桌面 `App.tsx` 约 640 行，后续增加入口会继续提高修改和回归成本。中英文运行时文案仍有分散字符串，路线图记录的全量抽取成本较高。

## 需要完善什么：建议顺序和完成标准

| 顺序 | 工作 | 可验收的完成标准 |
| --- | --- | --- |
| P0 | 冻结 0.20.14 候选并完成真实 Windows 试用 | 用精确提交的 CI 制品在另一台 Windows x64 和受企业策略约束的机器上，分别走首次配置、搜索、长任务、历史续聊、表格、Computer Use、升级和卸载；记录成功/失败及可复现步骤。发布前保持 npm 与 GitHub 制品同源并回读摘要。 |
| P0 | 建立质量与成本基线 | 从已定义的评测任务中选固定模型和任务集，经单独授权做多次真实运行；按成功、验证、时间、费用和安全拒绝统计，与候选版本比较。模型/环境异常单独归类，不把本地 smoke 当质量分。 |
| P1 | 完成分发和平台闭环 | 获取签名证书后核验 Windows 安装器签名；明确更新失败回滚；对 ARM64、macOS/Linux 建立真实安装/终端/后台/MCP 清单，逐项标注支持级别。 |
| P1 | 补桌面管理入口 | 先实现只读查看和明确授权/撤销，再补 Skill/MCP 高级操作；复用 CLI 的权限指纹和主进程守卫，测试未信任、Plan、取消、重配与权限变化。 |
| P2 | 渐进减小核心入口和文档漂移 | 按功能域继续拆分 CLI/桌面控制器，不一次性重写；每次迁移保留共享契约测试。把路线图的桌面能力表从旧候选叙述改为“代码已接入/本地验收/外部验收”三列，并保持 README、指南与发布说明同步。 |

## 本次评估的证据边界

- 本轮版本门禁的测试计数、npm 包文件数和 Windows 安装器结果只证明上述本地候选；未运行的真实模型或跨平台人工场景均写为待验收。
- 这是一份产品与工程现状评估，不替代完整安全审计、渗透测试、隐私合规意见或用户研究。已有安全规则见 [SECURITY.zh-CN.md](../../SECURITY.zh-CN.md)；任何扩大授权的实现须单独审查。
