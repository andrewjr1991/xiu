# Xiu 产品与工程路线图

> 本文档只维护当前状态、当前优先级和下一步。已发布版本摘要见 `CHANGELOG.md`，实现细节保存在 Git 历史，永久安全边界见 `SECURITY.zh-CN.md`。2026-10-13 整理前的逐轮记录原文保存在 [路线图历史快照](./docs/history/ROADMAP-2026-10-13.zh-CN.md)，早期交接与评估文档也已移到 `docs/history/`。

## 当前状态

- **0.20.13 CLI 质量与工程债线（2026-10-19，未发布，PR #88–#104 已合并）：** 管道（非 TTY）交互会话任务结束即回提示符并实时输出；无可交互终端时所有选项菜单一律按取消处理（插件授权、发布者信任、凭据删除、MCP 登录、崩溃恢复都不能因"第一项是同意"被放行）；审批边界、任务历史回放、`--json` 事件流、一次性退出码（0 完成 / 2 未验证 / 3 等待回答 / 1 失败，带不带 `--json` 一致）都有固定的端到端验收测试；一次性运行遇到未处理的中断记录或读不到恢复日志时返回 `not_started`、退出码 1；新增 `xiu recover [status]` 与 `xiu recover abandon <运行 ID>` 供脚本和 CI 处理中断任务（恢复仍只能在终端里确认）；修正 `run:<前缀>` 把全数字的运行 ID 前缀当成序号的偶发缺陷；CI 测试失败注解带完整断言块；桌面“报告与诊断”改用与 CLI `/report`/`xiu report` 相同的报告查询（之前桌面只按运行记录生成，不含文件变化与会话链）；桌面 host 的任务工具审批写入与 CLI 相同的本机安全审计账本（之前只有 CLI 记录审批）。新增 `xiu audit [approvals|credentials] [json] [条数]` 只读列出该账本中本工作区的记录。执行报告在会话日志缺失、无法读取或没有该次运行轮次时明确说明来源（之前静默降级为“无记录”）；`/diff runs` 区分无法读取的改动记录与没有记录；一条损坏的运行记录或会话日志不再让整个列表失败（`/report runs`、`/diff runs`、`/resume`、`/history sessions`、`--session-list` 与桌面任务列表跳过并说明跳过了几条、为何），中断任务检查仍严格失败；`xiu doctor` 新增“工作区记录”段，报告运行记录与会话日志的可读/不可读计数和原因，并提前做一次一次性运行的中断任务检查；`xiu doctor json` 输出同一份报告的 JSON 文档供脚本与 CI 判读，`doctor` 后的其他词按用法错误处理而不再当作任务；`/skills` 对扫描到但未列出的 Skill（无法读取、同名被覆盖、超限）给出一行说明。
- **0.20.13 桌面对话候选（2026-10-19，未发布）：** 用户请求与模型回复增加复制操作；宽屏正文和输入区采用居中阅读宽度，用户消息收窄并增加留白，左侧记录轨道支持按消息跳转并暂停自动跟随。桌面 UI 冒烟、全量测试和本地 Windows 安装生命周期已通过，待维护者试用。同版 CLI 新增一次性任务的 `--json` JSON Lines 事件流（第 4 项“已做”）。
- **0.20.12 已发布 GitHub 与 npm（2026-10-19）：** [Release](https://github.com/andrewjr1991/xiu/releases/tag/v0.20.12) 标签指向 `c5e273bffd6c3dde2bbb5f0ad84dc7b7a351cbf7`；同提交 CI 38936632221 九项作业与 CodeQL 通过，五份 CI 原始附件已按大小/SHA256 回读。Windows 安装器未签名；npm latest 已于 02:35 UTC 回读为 0.20.12，440 个代码文件与 CI tarball 一致。Computer Use 编辑器修复已通过本地真实记事本与隔离 Windows/Chromium 测试。

- **0.20.11 已发布 GitHub 与 npm：** 新增 /web configure managed 与托管搜索菜单，可跳过企业策略禁止的本机 free-search；健康检查 403 明确提示网关/代理/服务端访问规则，维护者已确认 403 为企业网络策略拦截，放行后可用。手动选择托管后不启动非默认本机搜索后端。

更新于 2026-10-19。

- **0.20.9 已发布 GitHub（2026-10-15）。** [Release](https://github.com/andrewjr1991/xiu/releases/tag/v0.20.9) 与标签精确绑定 `961fd47e154b43747e3136843caea9ae368f0c44`；[main CI 38674245057](https://github.com/andrewjr1991/xiu/actions/runs/38674245057) 九作业通过，Windows CLI 全量 1164 项：1155 通过、9 跳过、0 失败。发布前修正 npm 清单漏列当前设计稿并补回归；旧未公开草稿已删除，旧制品及 rejected 摘要保留本地。最终五份附件采用新 CI 原始制品，大小/SHA256 回读通过。固定 uv、安装/启动/升级/中断重启/卸载已再次本地验收。npm 0.20.9 已于 2026-10-15 发布，回读 version/latest 均为 0.20.9，integrity 与 tarball SHA256 与 Release 附件一致。Windows 未签名。仅文档补记跳过重复 CI，不改正式标签或附件。
- **0.20.8 已发布。** [GitHub 0.20.8](https://github.com/andrewjr1991/xiu/releases/tag/v0.20.8) 的标签指向 main 合并提交 `d36c488fc5706277562d3018a23907761440d124`，[main CI 38374657792](https://github.com/andrewjr1991/xiu/actions/runs/38374657792) 九作业全部通过，五份附件使用同源 CI 制品并已回读大小与 SHA256。npm latest 已于 2026-10-13 09:38 UTC 核实为 0.20.8。Windows 安装器仍未签名。
- **0.20.8 包含的安全修复：** 命令按实际执行片段分级（修复组合命令跳过审批和 Plan 只读的问题）；电脑操作自动额度按父任务累计、渲染进程输入逐步确认；Linux 僵尸进程视为已退出；MCP 客户端升级到 2.3.1（GHSA-6qxp-vccf-f47h）。
- **发布后的结构重构（main，未发布，行为不变）：** `src/cli.ts` 的斜杠命令按功能域移到 `src/commands/*-commands.ts`（Provider、插件、技能、MCP、后台任务、诊断/报告/审计、凭据、联网搜索，以及任务运行中“补充>”提示符的命令），`cli.ts` 由 3782 行降到 2075 行；`runTaskSequence` 其余部分直接读写会话状态，暂不再拆。桌面 `App.tsx` 拆出 `TaskTimeline.tsx`、`InteractiveTerminal.tsx`、`ReviewInspector.tsx`、`ProviderPicker.tsx`，由 1243 行降到 642 行。
- **联网搜索默认本机免 Key（main，未发布）：** 维护者于 2026-10-13 选定“默认加兜底”。用本机 free-search-mcp 0.13.1（桌面安装包内置固定版本 uv，CLI 在没有 uv 时首次搜索自动下载同一版本并校验 SHA-256）（依赖全部锁定，只开放 `search` 工具），不可用或没有结果时回退 `search.jingran.vip` 托管搜索；打开网页仍由 `web_open` 完成。需要在三平台和国内网络做真实搜索验收。
- **Anthropic 渠道适配当前 Claude 模型（main，未发布）：** 默认模型改为 `claude-opus-5-5`，能力探测在模型拒绝强制工具调用时改用 `auto` 重试，输出上限提高到 32000 并对只允许 8192 的旧模型自动回退，带工具调用的轮次按 API 要求回传不可读的思考状态（空文本签名与加密块）。`@anthropic-ai/sdk` 已升到 0.133。尚未用真实 Anthropic Key 验证，需要维护者在渠道管理里对 Anthropic 渠道点一次「测试连接」，再跑一轮带工具调用的任务。
- **Computer Use 加固（main，未发布，待 Windows 真机验证）：** 0.20.8 复核的中等问题 C3–C6 已在代码层处理：敏感窗口标题、禁用应用和高风险控件名三份规则改为 `apps/desktop/shared/computer-use-sensitive.ts` 单一来源，C# 桥程序内嵌同一字符串并由测试保证一致，列表补充终端、远程桌面、密码管理器、结账/验证码等；桥程序在读不到指针下或焦点控件（UIA 失败、跨进程焦点、无名称的按钮/链接/菜单项上的点击或 Enter/Space）时拒绝输入并返回 `control-uninspected`，主进程只在用户单独确认这一步后才带 `allowUninspected` 重发一次，自动模式不覆盖；截图结果带控件遍历完整度（complete/partial/unavailable）回传模型并写进逐步确认框；所有授权框说明控件名称与视觉描述会返回对话模型并写入会话历史。C# 改动只经 CI 编译，行为需要维护者在 Windows 上跑一次本地 `window-computer-smoke` 与一轮真实任务。
- **Computer Use 可用性改造（main，未发布，待 Windows 真机验证）：** 2026-10-15 评估指出的三大根因已处理：①对话模型本身是视觉模型时截图直接作为图片进入工具结果（OpenAI 兼容协议随后附一条不可信用户消息，Anthropic 放进 tool_result），内存只保留最新一帧，会话日志只记文本，大窗口先缩到 1568 像素长边；②自动操作改为独立授权，“电脑操作”面板“启用自动电脑操作”经主进程确认即可，不再要求完全访问，可随时撤销；③输入词汇扩展为单击/双击/右键/拖拽/滚动/文本/按键并分三级（一级自动、二级每次确认、三级拒绝），按键列表 `apps/desktop/shared/computer-use-inputs.ts` 与 C# 一致由测试保证。桌面指南新增“电脑操作”章节。C# 改动只经 CI 编译。
- **0.21 计划项已全部合并到 main（未发布）：** 首次体验六项（国产渠道模板、错误人话化、首次向导、`xiu doctor`、文档分层、偶发测试修复）、Node 20 弃用提示，以及可靠性与安全中低项 R4/A5/S4/S5/S3/S6，明细见下方“当前优先级”第 1–3 项的“已做”说明与 `CHANGELOG.md` 的 0.20.12 候选说明。维护者选择先以 0.20.12 提交这些已合并增量及 Computer Use 修复。
- **CI 与依赖：** CLI 在 Node 20.18.1 三平台验证，另有 Node 22/24 兼容作业和生产依赖审计。Dependabot 每月按目录合并为一个分组 PR（只合批 minor/patch），安全更新单独提出。2026-10-15 起 Windows 渠道配置不再做 ACL 校验（维护者决定，见 SECURITY §4），Windows 隐私预检步骤与相关测试已删除；Windows Verify 作业约 7 分钟，测试步骤约 3 分钟。未升级的大版本：chalk 6 / commander 15 / undici 8 / openai 7 要求 Node ≥22；@napi-rs/keyring 2 需先在 Windows 验证 1.3 写入的凭据能被 2.x 读回；@types/node 26 与运行的 Node 20 不匹配。
- **当前设计：** [0.20.13 设计](./V0.20.13_DESIGN.zh-CN.md)。根目录只保留当前设计，旧设计在 Git 历史中。

## 当前优先级

2026-10-15 维护者确认了[后续开发计划方案](./docs/proposals/DEVELOPMENT_PLAN_2026-10-15.zh-CN.md)。评估报告中的安全与工程债项基本收口，下一阶段主线是“好用”：

1. **0.21 首次体验版。** 偶发测试修复（已做：停止后台任务按墙钟等待而不是按固定轮询次数，测试清理直接杀进程组再复查；`lifecycleGate` 保留同步实现，锁只在另一进程正写同一记录时才等待，最长 2 秒仅出现在回收崩溃进程遗留锁时，改异步需要重写 worker 与 bootstrap 的临界区，收益不足）；`/provider add` 与桌面新增渠道增加国产 OpenAI 兼容模板（DeepSeek、通义千问、智谱、Kimi、火山方舟、硅基流动、MiniMax，只预填地址/模型/环境变量名，不占 ID、不内置 Key）；用户可见错误统一为“原因 / 下一步 / 诊断命令”三行并建立错误码表（已做：渠道配置、连接测试、联网搜索与后台任务的失败按统一格式显示，错误码表见 docs/guide/troubleshooting §22.0）；无渠道启动时直接进入三步首次向导（CLI 已做：选渠道/检测环境变量 → 填 Key 或地址 → 测试连接并选模型，通过后才保存；桌面端沿用“新增渠道”表单的模板与连接测试）；`xiu doctor` 合并更新、渠道配置、联网搜索、代理与 Node 环境诊断（已做：六段只读脱敏报告，含代理不一致、证书拦截、PowerShell 语言模式、Node 20 停维提示）；USAGE 按功能拆分并补英文精简版，PUBLISHING/ROADMAP/设计稿不再打进 npm 包（已做：USAGE 成为目录页，11 篇中文指南与英文精简版在 docs/guide，旧逐版本说明归档到 docs/history，check-docs 检查两份 README 章节与链接一致及 npm files 约束）。
2. **Node 20 弃用（维护者 2026-10-15 决定）。** Node 20 已于 2026-04-30 停止维护。0.21 在 Node 20 上启动时打印一行弃用提示（已做，`--check-update` 等一次性命令不打印）；0.22 起 `engines` 改为 `>=22.12`，随后一次性升级 chalk 6、commander 15、undici 8、openai 7、@types/node。`@napi-rs/keyring` 2 仍需维护者在 Windows 做一次 1.x 写、2.x 读的往返测试后再升。
3. **可靠性与安全中低项（随 0.21.x 逐项单独 PR）。** 后台模块去掉模块级可变状态（R4，已做：`src/background.ts` 只导出 `BackgroundManager`，工作区、存储根、worker 运行时与交接宽限都是实例字段，CLI 与每个桌面工作区 host 各持一份并把后台工具绑定到它，模块里不再有可变 `let`）；空 `catch` 进诊断通道或注明理由（A5，已做：产品代码里最后 7 处无说明的空 `catch`（后台 bootstrap/worker 的清理与信号、MCP 取消通知）都写明了忽略原因，ESLint `no-empty` 对 `src/`、`apps/`、`scripts/` 不再放行空 `catch`，只有 `test/` 保留例外；非空断言仍随改随清）；内置终端环境变量默认过滤 Key/Token 类并可在设置关闭（S4，维护者已选默认过滤；已做：按名称过滤 `*API_KEY*`/`*TOKEN*`/`*SECRET*`/`*PASSWORD*`/`*AUTHORIZATION*`/`*_AUTH` 与渠道 Key 变量，终端顶部列出被隐藏的名称，设置「终端隐藏凭据变量」可关闭）；后台任务停止前校验进程启动时间（S5，已做：记录发布 PID 时写入启动时间，停止与存活判断前比对 OS 启动时间，PID 被复用则不发信号并记为 interrupted/PID_REUSED；渠道配置写锁、任务运行记录与工作区任务锁同样记录并核对持有进程启动时间）；网页页签每次导航重新解析并拦截私网地址（S3，已做：`apps/desktop/main/browser-network-policy.ts` 对每个请求用页签会话自己的 Chromium 解析器核对，检查与连接共用一份 DNS 缓存；解析到本机/私网的域名在本次网页会话内全部封禁，页面给出明确提示；SECURITY 写明残余窗口）；`assertTrustedSender` 单测与 asarUnpack 内 worker/桥程序启动前哈希比对（S6，已做：IPC 发送者判断抽成 `assertTrustedIpcSender` 并有失败场景单测；`build:main` 把解包文件的 SHA-256 写进 asar 内的 `dist/main/unpacked-manifest.json`，打包版每次启动后台 worker 与桥程序前比对，不一致即拒绝；`node-pty` 原生模块不在清单内，安装器签名仍待证书）。
4. **0.22 桌面对齐与电脑操作闭环。** 按第 4 节缺口表接入联网搜索、Skills、插件、故障转移/路由，并给 IPC 加运行时校验（已做：联网搜索与 Skills 早已由共享 host 注册；0.20.13 起共享 host 复用 CLI 的插件授权记录加载已批准插件的渠道/MCP/Skills 贡献，桌面不新增授权入口；故障转移/路由与联网/技能管理面板早已由共享 host 与 `WorkspaceManagementService` 接入；IPC 运行时校验已做：`apps/desktop/main/ipc-schema.ts` 为全部 58 个 Renderer→主进程 invoke 通道建立结构 schema，发送者核对之后、处理器之前校验，未声明字段不传给处理器、多余参数拒绝，无 schema 的通道无法注册，领域规则仍在控制器；待做：桌面插件管理入口）；Computer Use 待维护者 Windows 真机跑 `window-computer-smoke` 与一轮真实任务后修正（已做：截图直给视觉对话模型、独立自动授权、输入一级自动 / 二级逐步确认 / 三级拒绝分级；待定：按进程而非窗口句柄授权、Electron/游戏窗口控件读取回退）；非交互 `--json` 事件流（已做：`xiu --json <任务>` 的标准输出只写 JSON Lines——`session.started`、全部脱敏运行时事件、末行 `result`，人读文字转标准错误；退出码 0/2/3/1 分别为完成/未验证/等待回答/失败或未开始；未信任工作区不从管道读取信任决定，直接返回 `not_started`）与 `/report` 单文件 HTML 导出（已做：`/report export html`，样式内联、无脚本、不加载外部资源并带 CSP，内容与 Markdown 报告一致；`xiu report [markdown|json|html] [summary|details] [路径]` 不进入交互模式导出同一份报告，省略路径写到标准输出，已存在文件需 `--yes` 才覆盖，仅限已信任工作区；维护者 2026-10-19 决定新增 `--trust-workspace`：仅本进程生效、不写信任列表、只能来自命令行的显式信任，供 CI 使用，快速上手附 GitHub Actions 只读审查示例）；历史变更回放接入 CLI（已做：任务结束时 CLI 也把有界脱敏改动报告写到 `.xiu/task-change-history/<runId>.json`，与桌面同一份记录；`/diff runs` 列最近运行及改动文件数，`/diff run:<序号|ID 前缀> [文件]` 回放保存的报告或单个文件的完整差异，没有记录的运行明确提示而不用当前差异冒充）。
5. **已完成并保持的项。** 测试文件纳入类型检查、Windows 后台状态竞态、统一 Agent 装配、ESLint/CodeQL、桌面审批模式上下文绑定、Computer Use C1–C7、Windows CI 缩减、Windows ACL 去除。

维护者 2026-10-15 的决定：发布继续纯本地手动执行，暂不做 npm provenance；安装器签名暂无证书，有了再做；真实模型评测基线暂不启动；真实用户试用后面安排；桥程序完整性校验完整版不做（只保留上面 S6 的低成本哈希比对）。

需要维护者决定或提供：

- Windows 代码签名证书。拿到后把 CI 的“断言未签名”改为“有证书时签名并校验”。
- Microsoft Store 身份、外部 Windows x64/ARM64/企业设备、macOS/Linux 真实用户矩阵，以及真实计费 Provider 的验收授权。

## 下一步

2026-10-19 下午：CLI 质量与工程债线（PR #88–#94）已合并到 main，见"当前状态"第一条；统一报告查询已做（桌面“报告与诊断”与 CLI `/report`、`xiu report` 共用 `src/execution-report-query.ts`，同一次运行两端内容一致）；桌面审批审计已做（共享 host 的工具审批写入 CLI 同一份 `security-audit.jsonl`）；`xiu audit` 已做（脚本版 `/audit`）；报告的会话日志来源说明已做；`/diff` 区分无法读取的改动记录、运行记录与会话日志列表容忍单条坏文件、`xiu doctor` 工作区记录段与 `xiu doctor json`、`/skills` 未列出 Skill 的说明已做（PR #99–#104）；共享运行时中英文资源抽取（1028 处、36 个文件）规模大、用户价值低，暂不做，0.22（`engines >=22.12` 与依赖大版本）等维护者明示后开始。

0.20.13 的复制、记录跳转与宽窄布局已通过本地验证，安装候选已准备，接下来由维护者在真实任务中试用；发布仍沿用手动流程。

2026-10-19：0.20.12 GitHub Release、附件回读与 npm 发布回读（version/latest/integrity）均已完成；之后推进 0.22 的桌面对齐与真实用户矩阵。

0.20.11 已于 2026-10-15 发布至 [GitHub](https://github.com/andrewjr1991/xiu/releases/tag/v0.20.11) 与 npm，标签精确绑定 c0ba7fda8624bde8dcf4940ab1288d7f911db3d2。README 已于同日重写为中英文同构概览（#58），旧版归档在 `docs/history/`。

0.21 计划项已于 2026-10-15 全部合并到 main（未发布）：当前优先级第 1 项的六项首次体验改进（#59–#65）、Node 20 弃用提示（#64）与第 3 项的 R4/A5/S4/S5/S3/S6（#66–#72）。0.20.12 GitHub Release 与 npm 发布均已完成并回读。当前版本设计及变更已同步，不能覆盖 0.20.12。后续进入第 4 项 0.22：`engines` 改为 `>=22.12` 并一次性升级受 Node 20 限制的依赖，再做桌面对齐与电脑操作闭环。维护者侧待办：Windows 原生窗口与真实记事本 Computer Use 验收已通过，其他应用场景继续验证；`@napi-rs/keyring` 1.x 写、2.x 读的往返测试；企业机器上确认托管搜索选择持久化；在 Security 页把 CodeQL 告警 #19（测试 worker 的 `eval`，仅测试代码）标为 used in tests。

## 1. 项目定位

Xiu 是由静然开发的自主编码助手，面向需要看见执行过程、复查结果、控制权限并从中断安全恢复的真实项目环境。CLI 是当前稳定入口，桌面工作台从 v0.20.0 开始设计和实现。

| 项目 | 当前值 |
| --- | --- |
| npm 包 | `@xiu-ai/cli` |
| 全局命令 | `xiu` |
| 当前公开 npm 版本 | `0.20.12`，Registry latest 已回读 |
| 当前开发版本 | `0.20.13`，本地候选 |
| 主要运行时 | Node.js 20.18.1+ / TypeScript |
| 主要验收平台 | Windows PowerShell / Windows x64 桌面 |
| 跨平台状态 | 0.20.8 main CI 九作业通过（三平台 CLI 与桌面、Node 22/24 兼容、生产依赖审计），含 Windows 未签名 NSIS 安装生命周期；真实用户/企业设备、模型长任务和浏览器实玩仍需独立验收 |

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

## 3. 桌面工作台基线：v0.20.0

`0.20.0` 已完成并作为跨平台 CLI 与 Windows x64 桌面预览发布。该版本交付共享无界面运行时 G1、Electron 安全壳/可信工作区 G2、任务与审批闭环 G3、审查/证据/恢复 G4、Provider/模型配置 G5A、受控交互终端 G5B 和 G5C Windows x64 候选包验收。历史续做、附件、模型目录、自定义渠道、权限模式、安全删除、运行事件回放、独立有界的历史变更报告及事实型模型进展均已落地；旧任务不伪造缺失过程或 Diff，源码 Diff 不进入通用审计。G5B 的 PTY 仍由主进程持有并与 Agent 单写者互斥。G5C 新增按用户安装的辅助 NSIS 包，以及含空格/中文路径的安装、覆盖升级、异常中断重启和卸载验收；隔离测试壳驱动真实 Renderer 覆盖两种窗口尺寸、键盘、Provider/模型、审批、30 轮事件流、停止、未知副作用门禁、检查点还原和终端生命周期。提交 `d65fffe` 的 GitHub Actions 运行 `36707411436` 已通过三平台 CLI 与 Desktop 共六个作业；下一步进入 Microsoft Store 身份接入、Windows 外部设备和 macOS/Linux 真实用户桌面矩阵，不对现有 CLI 进行一次性重写。

G5A 已扩展为 Provider 中立的能力模型配置：内置与自定义渠道都按对话、视觉、生图、视频、音频分组展示并持久化独立选择，自定义 OpenAI-compatible 渠道使用自身 Base URL、凭据和能力模型；桌面 Agent 与 CLI 复用媒体危险审批、持久化账本和未知结果不重放边界。Agnes 走专用媒体适配，OpenAI/OpenAI-compatible 走兼容端点，Anthropic 当前只开放视觉理解。本轮类型检查、662 项全量测试、桌面构建/UI smoke、NSIS 安装器验收和 MSIX 结构 smoke 已通过；真实 Provider 计费请求、可信 MSIX 签名和外部设备安装仍须单独验收，不能由本地模拟替代。

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

当时的设计已归档到 Git 历史；当前设计见 [0.20.13 设计](./V0.20.13_DESIGN.zh-CN.md)。共享运行时、可信工作区、真实 Agent 任务、审批、单写者、审查/恢复、Provider/模型、历史变更快照与受控 PTY 的既有边界保持不变。G5C 已生成 Windows x64 辅助安装器，并完成含空格/中文路径的全新安装、安装物启动、覆盖升级、异常中断后重启和卸载验收；隔离测试壳驱动真实 Renderer 覆盖 1366×768、900px 窄窗、键盘、Provider/模型、审批、30 轮事件流、停止、未知副作用门禁、检查点还原与终端生命周期，测试桥不进入正式包。GitHub Actions 的 Windows、Ubuntu、macOS CLI 与 Desktop 六作业均通过；macOS/Linux 真实用户桌面与外部 Windows 设备矩阵尚未完成，因此仍不能作为跨平台稳定桌面产品发布。

## 4. 后续工程化

### CLI 与桌面能力盘点（2026-10-02，部分已过时，待按 0.20.8 重新核对）

以下是当前源码接线情况，不是下一版本已交付声明。“共享模块存在”不等于桌面已注册工具、控制器或管理入口。

| 功能域 | CLI 当前入口/能力 | 桌面当前入口/能力 | 下一步 |
| --- | --- | --- | --- |
| 编码、索引、验证、审批、检查点 | 已接入 | 复用 Agent、文件/命令/索引工具与审批、恢复检查器 | 保持同一安全和完成门禁 |
| Provider 与能力模型 | 多类型添加模板、渠道增删改、模型、凭证管理 | 多类型渠道表单与添加模板、连接测试、模型分组、系统凭据 | 0.20.2 候选已统一首次配置；继续补齐能力配置向导 |
| 首次安装的渠道 | 0.20.2 候选默认零渠道，由用户添加 | 同一注册表；所有用户渠道可见，支持删除最后一个渠道 | 0.20.1 的隐藏 ID 占位问题已修复，候选待验收/发布 |
| 故障转移、分阶段路由 | 已接入控制器和配置命令 | 共享 host 挂载同一故障转移/路由控制器；管理面板经 `WorkspaceManagementService` 修改路由、分阶段渠道与回退链 | 保持两端共用一份策略 |
| Skills | 加载、调用、浏览、安装 | 注册 SkillRegistry 与调用工具，无完整安装管理入口 | 共享发现/安装服务，补桌面管理 |
| MCP、OAuth、Resource/Prompt | 已接入；与桌面共用 Manager 组合，权限确认绑定预览指纹 | 0.20.2 候选支持 stdio/HTTP 连接、精确权限确认、基本用户配置新增/编辑/删除、OAuth 确认/取消/退出、Resource/Prompt 有界脱敏只读浏览 | 项目/高级/显式权限配置继续 CLI/文件管理；CLI 已有 `/credentials migrate` 与可填参数的 `/mcp read <模板名> 变量=值`（0.20.13），桌面对应入口待补 |
| 原生联网检索 | 已注册检索工具、来源门禁及配置入口 | 共享 host 已注册同一组 web_search/web_open 工具，复用设置与托管认证 | 保持两端同一来源门禁 |
| 插件及团队策略 | 已发现、授权、加载贡献，并支持生命周期管理 | 0.20.13 起共享 host 复用 CLI 授权记录加载已批准插件的渠道/MCP/Skills 贡献；无桌面授权入口 | 桌面插件管理入口（查看、授权、禁用）待做 |
| 多 Agent、Worktree 集成 | 已接入协调器、审查和集成命令 | 0.20.2 本地候选接入真实任务卡/状态/结果、父任务取消等待 | 保留独立确认与审查证据，补其他平台验收 |
| 后台任务 | 有跨进程任务和输出游标 | 0.20.2 本地候选接入 4 个共享工具，Node worker 独立解包；PTY 不是后台任务 | 补其他平台生命周期验收 |
| 历史、Diff、报告、诊断 | 会话恢复、实时任务 Diff、任务结束时保存改动记录并可用 `/diff runs` / `/diff run:<选择>` 回放、/report（可按 `run:` 选择任一近期运行）、`xiu report`、`xiu recover [status|abandon]`、`xiu audit`（脚本/CI 处理中断任务）、/diagnostics | 历史事件、独立 Diff 文件树/搜索/轮次切换、持久任务变更卡（与 CLI 共用 `.xiu/task-change-history`）、分类数据及证据/恢复；无完整报告/诊断管理入口 | 统一报告查询 |
| 计划 | 有计划工具及只读 Plan 模式入口 | preview.4 候选接入共享只读模式切换及会话/恢复模式保护 | 精确候选 CI 和真实输入/平台验收后确认交付 |
| 媒体 | 共享媒体工具、危险审批、账本 | 同一媒体工具，额外提供本地媒体预览 | 保持供应商中立，真实计费验收另行授权 |
| 界面与分发 | 终端、参数、脚本/无交互、npm 更新诊断 | 文件选择/拖放、安全预览、PTY、Windows 安装器 | 允许入口不同，不要求界面或安装机制相同 |

分界原则：共享核心负责 Provider、工具注册、信任/审批、只读模式、任务生命周期、历史、恢复与证据；CLI 负责终端和脚本入口；桌面负责可视化与系统集成。两端不同时写同一工作区，不复制安全策略，不把桌面功能放进 CLI 的 Electron 依赖。后续每个功能同时标记两端状态；每个共享变更必须有共享契约测试和两端入口回归，尚未接入的一端明确列为缺口。

首次配置修复的验收范围：无用户数据的新安装即使存在环境变量也不自动注册渠道；Agnes/OpenAI/本地等名称仅是用户添加时可选模板，不占用 ID；无渠道时 CLI 和桌面仍能进入配置流程，不默认回退到 OpenAI、不空指针；添加首个渠道、编辑、删除最后一个渠道、重启均可完成。既有显式选择、凭据引用、能力模型、路由和会话引用须兼容迁移；不自动清除用户设置、不导出真实 Key。企业预设、注册、Key/积分分发属于未来独立产品设计，本轮不实现。

- 以功能域增量迁移 `cli.ts`；GUI 所需路径优先抽到共享运行时，不做一次性大规模改写。
- `Agent` 构造函数已是 options 对象（`AgentOptions`）；`run` 等长方法按阶段拆分仍未做，随功能改动渐进进行。
- 随迁移逐步抽取中英文资源，不做一次性千处重写（2026-10-19：共享运行时的审批影响说明、恢复提示与失败原因改为跟随调用方语言，CLI 传入 `--language`，桌面保持中文默认）。
- 将关键静默降级统一送入有界诊断通道（2026-10-19 盘点：`src/` 中 66 处吞掉错误的 `.catch` 几乎都是存在性检查、临时文件清理或已注明的尽力而为持久化，不构成降级；唯一面向用户的静默项——一次性任务结束时会话记录保存失败——已改为在标准错误打印一行说明。后续新增的尽力而为路径沿用“失败即提示一行”的做法，不单独建诊断通道）。
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
