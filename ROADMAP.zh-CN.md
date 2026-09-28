# Xiu 产品与工程路线图

> 本文档只维护当前状态、当前版本目标和下一步。已发布版本摘要见 `CHANGELOG.md`，实现细节保存在 Git 历史，永久安全边界见 `SECURITY.zh-CN.md`。

## 1. 项目定位

Xiu 是由静然开发的自主终端编码助手，面向需要看见执行过程、复查结果、控制权限并从中断安全恢复的真实项目环境。

| 项目 | 当前值 |
| --- | --- |
| npm 包 | `@xiu-ai/cli` |
| 全局命令 | `xiu` |
| 当前公开版本 | `0.18.1`，Windows 稳定性、安全依赖与发布状态收束 |
| 当前开发版本 | `0.18.1` 发布闭环完成；下一版本尚未立项 |
| 主要运行时 | Node.js 20.18.1+ / TypeScript |
| 主要验收平台 | Windows PowerShell |
| 跨平台状态 | macOS/Linux 进入 CI；真实终端、凭证和企业策略验收待完成 |

## 2. 当前产品基线

截至 `0.18.1`，已经发布：

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
- 显式更新检查、可选提醒、安装路径诊断和官方发布元数据核验。
- Windows、Ubuntu、macOS CI，确定性的完整测试、打包预览和临时目录安装冒烟。
- 准确的中英文 README、快速开始、变更日志、贡献指南和机器校验的文档链接。

仍需外部环境验证：

- Windows ARM64。
- 另一台受企业策略约束的 Windows 机器。
- 真实 Cloudflare OAuth 凭证迁移、重启读取与注销闭环。
- macOS/Linux 的完整安装、终端、后台任务和 Provider/MCP 路径。

Windows 系统凭证后端在既有外部矩阵完成前继续显式选择，不设为默认。macOS Keychain 与 Linux Secret Service 尚未实现。

## 3. 当前版本：v0.18.1 发布闭环与 Windows 稳定化

`0.18.0` 已于 2026-09-16 发布，npm `latest`、发布包 `gitHead` 与 `v0.18.0` 标签均对应提交 `56fbf41`。但该提交的 Windows CI 失败，默认分支、README、使用说明与路线图也未及时收束，因此 `0.18.1` 不扩功能，先修复发布债务。

当前交付：评测临时目录只允许删除本次创建的精确路径，并对 Windows 短暂占用做有界重试；后台 worker 独占启动后的状态迁移，launcher 不再覆盖终态，并为 worker 退出与终态原子写入之间保留 2 秒有界交接窗口；无 Git 扫描对实际目录项执行 `lstat`，不遍历 Junction；`csv-parse` 升级到已修复版本。完整本地门禁通过，精确远程状态见 `docs/verification/V0.18.1_2026-09-28.zh-CN.md` 与 GitHub Actions。

### 实施范围

1. 修复 Windows `eval:smoke` 临时目录清理阻断并增加精确路径保护。
2. 修复快速后台任务把 `completed` 误判为 `interrupted` 的竞态。
3. 修复无 Git 工作区扫描对 Windows Junction 的平台差异。
4. 升级存在已知公告的 CSV 生产依赖并回归结构化提取。
5. 同步版本、文档、验证记录、默认分支、tag 与 npm Registry。

### 非目标

不补跑旧真实基线，不扩题，不启动新付费调用，不实施 P2–P4，不新增 GUI、插件市场或凭证后端，不移动或覆盖已发布的 `v0.18.0` 标签。

### 验收

完整本地门禁通过；`eval:smoke` 连续运行无残留；生产依赖审计为零；Windows、Ubuntu、macOS CI 全绿；本地产品入口验收完成。官方 Registry 的版本、latest、完整性和文件清单完成回读，精确发布提交与标签保持一致。缺少硬件或真实平台时准确保留外部待验项。

## 4. 后续工程化

- 以命令组为单位增量迁移 `cli.ts`，先 `/update`、`/web`、`/credentials`，每组独立测试。
- 将 `Agent` 构造函数改为 options 对象，并按阶段拆分长方法。
- 随命令迁移逐步抽取中英文资源，不做一次性千处重写。
- 将关键静默降级统一送入有界诊断通道。
- 根据真实平台验收设计 macOS Keychain 与 Linux Secret Service；已选择系统后端后仍必须失败关闭，不能静默回退明文。

## 5. v1.0 稳定产品化门槛

- Windows、macOS、Linux 的安装和升级流程稳定，平台差异有准确说明。
- 崩溃恢复通过压力和未知副作用测试。
- Provider、Tool、Skill、MCP 和插件 API 有兼容承诺。
- 自动更新、版本回滚和供应链验证具备独立设计与恢复方案。
- 完整中英文首次配置路径，不依赖阅读长手册才能开始。
- 固定评测无明显质量、安全或成本退化。
- 隐私、安全和诊断上传策略清晰且默认保守。

## 6. 永久安全边界

- 不绕过工作区信任、Plan 只读、风险审批、检查点和危险操作确认。
- 不静默扩大 MCP、Skill、插件或子 Agent 权限。
- 不默认上传代码、会话、审计或诊断数据。
- 不在不确定副作用后自动重放操作。
- 不把 Key、Token、Client Secret、Cookie 或 Authorization 写入日志、会话或错误。
- 不显示、保存或伪造 Provider API 未返回的隐藏思维链。
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
- 中断、崩溃和关闭终端后的恢复成功率。
- 审批拒绝率、权限扩张率和秘密泄漏回归。
- 大型项目检索命中率。
- 多 Agent 冲突率与安全集成成功率。

## 9. 下一步

1. 保留 Windows ARM64、企业策略设备、真实 OAuth 迁移和 macOS/Linux 真实终端矩阵；外部条件具备后补验，不伪造结果。
2. 观察 `0.18.1` 安装、更新、后台任务和无 Git 工作区的真实使用反馈，出现回归时优先发布补丁版本。
3. 下一版本立项前，按收益与风险评估 `/update`、`/web`、`/credentials` 命令组的增量拆分，不进行一次性大规模重写。
