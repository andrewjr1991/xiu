# Xiu 后续开发计划方案（2026-10-15）

基线：0.20.11（main `c0ba7fd`，GitHub Release 与 npm 已发布并核对）。本方案接续 2026-10-13 的评估报告（项目文件 `xiu-assessment/评估报告与开发计划.md`，未入库），只写还没做的事和新的判断；已完成项只列一次用于对账。目标沿用你的定位：**有特色、安全、好用**。

---

## 1. 一页结论

1. **过去三天把“止血 + 门禁 + 减负”做完了**：S1 命令分级、R1/R2 后台竞态、MCP 高危依赖、ESLint/CodeQL/Dependabot、测试纳入类型检查、Node 22/24 作业、`cli.ts`/`App.tsx` 拆分、ROADMAP 整理、免 Key 搜索、Anthropic 新模型适配、Computer Use C1–C7、Windows CI 25→7 分钟、Windows ACL 去除。评估报告里的 24 个问题还剩 9 个，全部是中低优先级（见第 2 节）。
2. **下一阶段的主矛盾不再是安全和工程债，而是“好用”**。证据：第一个外部用户在企业 Windows 机器上连渠道都加不上，错误信息是 `Provider configuration storage is not a protected regular file/directory … stage: verify-owner`，没有人能看懂；你自己也说“权限不要搞这么死”。Xiu 的能力已经很多，但首次使用路径、错误提示、企业网络环境和文档入口都还是给维护者看的，不是给用户看的。
3. **建议的主线**：0.21 做“首次体验版”，0.22 做“桌面对齐与国产模型版”，之后按 v1.0 门槛收口。每一步继续保持“一个 PR 一轮 CI，CI 全绿再合并”，安全边界不放宽，但可选的加固不再做成硬失败。
4. **需要你拍板的 6 件事**在第 6 节，每件都给了我的建议；其中最影响后续的是 **是否放弃 Node 20 支持**（Node 20 已于 2026-04-30 停止维护，继续支持它挡住了四个大版本依赖）。

---

## 2. 对账：评估报告里还剩什么

| 编号 | 问题 | 现状 | 本方案的处理 |
|---|---|---|---|
| S3 | 桌面网页页签 DNS 重绑定窗口 | 未做 | 阶段 B，B3 |
| S4 | 内置终端继承完整 `process.env`（含 API Key） | 未做 | 阶段 B，B3 |
| S5 | 后台任务停止只认 PID，不校验启动时间 | 未做（Linux 僵尸进程已处理） | 阶段 B，B3 |
| S6 | `assertTrustedSender` 缺单测；asarUnpack 内容不在完整性校验内 | fuses 回读已做（#55），其余未做 | 阶段 B，B3 |
| R3 | `lifecycleGate` 用 `Atomics.wait` 阻塞事件循环 | 未做 | 阶段 B，B2 |
| R4 | 后台模块的模块级全局状态 | 未做 | 阶段 B，B2 |
| A4 | 桌面 IPC 只有编译期类型，无运行时校验 | 未做 | 阶段 C，C1 一起做 |
| A5 | 空 `catch`（现约 28 处）与非空断言 | 未系统处理 | 阶段 B，B2，随改随清 |
| P3 | 评测只有模拟模式，无真实模型基线 | 未做（`eval:real` 框架在，基线停在 0.17） | 阶段 B，B1，**需要你的 Key** |
| P4 | 后台测试依赖时序轮询 | 未做；`background.test.ts` 的 `STOP_UNCONFIRMED` 在 Ubuntu 也偶发 | 阶段 B，B2 |
| D2 | 约 400KB 内部文档打进 npm 包 | 未做 | 阶段 A，A4 |
| P1 | 发布自动化 / npm provenance / 安装器签名 | 你决定手动发布；证书未办 | 第 6 节决策 2、3 |

其余 12 项已关闭（S1、S2 由你决定保留托管兜底、R1、R2、A1、A2、A3、P2、D1、D3、C1–C7）。

---

## 3. 目标与原则

把三个关键词变成能验收的东西：

| 关键词 | 可验收的含义 | 现在差在哪 |
|---|---|---|
| **好用** | 新用户不读手册，5 分钟内从 `npm install` 到完成第一个任务；每条错误都说“原因 + 下一步”；企业代理、受限 PowerShell、国内网络下不需要额外折腾 | 零渠道后要自己摸索 `/provider add`；错误是内部状态机术语；诊断入口分散在 `--update-doctor`、`--provider-config-diagnostics`、`/web doctor`、`/diagnostics` 四处；USAGE 2000 行无英文版 |
| **安全** | SECURITY 边界一条不少；可选加固失败时降级并提示，不阻断主流程；供应链可验证 | 边界已经很扎实；剩 S3–S6 四项中低风险；安装器未签名、npm 无 provenance |
| **有特色** | 中文优先、国产模型与本地模型开箱即用、改动可审查有证据、免 Key 搜索、Windows 桌面与受控电脑操作 | 国产渠道（DeepSeek、通义、智谱、Kimi、火山方舟、硅基流动）只能走“OpenAI 兼容”手填地址；桌面端还缺搜索、Skills、插件、路由；电脑操作未经真机验收 |

原则（延续 AGENTS/SECURITY，加两条新的）：

- 一个 PR 一轮 CI，本地先跑 `check:docs`、typecheck、typecheck:test、test、lint；CI 全绿再合并。
- 安全边界由代码执行、不可被模型文字解除；**但“加固”与“边界”分开：边界失败必须关闭，加固失败只降级并进诊断**（Windows ACL 的教训）。
- 面向用户的每条错误必须有：一句人话原因、一句下一步、一个可复制的诊断命令；技术细节进 `/diagnostics`。
- 每个新功能同时标记 CLI 与桌面两端状态，没接入的一端写进 ROADMAP 缺口表，不在 README 里含糊。

---

## 4. 分阶段计划

工作量按“我在云端独立完成一个 PR 的量”估：S = 半天内，M = 1–2 天，L = 3 天以上或需要你真机配合。

### 阶段 A：首次体验（目标版本 0.21.0，约 2 周）

| 编号 | 事项 | 做法 | 验收 | 量 | 需要你 |
|---|---|---|---|---|---|
| A1 | **首次运行向导** | 无渠道启动 CLI 时直接进入三步向导：选类型（含国产模板，见 C3）→ 填地址/Key 或选环境变量 → 自动“测试连接 + 拉模型列表”，成功即进入会话。桌面端同一流程。检测到 `OPENAI_API_KEY` 等环境变量时提示一键导入。 | 全新用户目录 + 本地 Ollama，不看文档可在 2 分钟内发出第一条任务；向导可 Esc 退出且不留半成品配置 | M | 否 |
| A2 | **错误信息人话化** | 盘点 Provider 配置、搜索、更新、后台任务、MCP 五类用户可见错误，统一为“原因 / 下一步 / 诊断命令”三行格式，中英文；建立 `docs/errors.md` 错误码表；原始 `code/stage/category` 只进 `/diagnostics` 与报告 | 对照表覆盖全部 `ProviderConfigurationError` 与 web/update 错误码；截图里那条错误在新版本里读起来是“配置文件所在目录不可写：请检查 C:\Users\…\.xiu 的权限，或运行 xiu doctor” | M | 否 |
| A3 | **`xiu doctor` 一键诊断** | 合并 `--update-doctor`、`--provider-config-diagnostics`、`/web doctor`、代理与 Node 环境检查为一个只读命令，输出可直接贴给维护者的脱敏报告；检测系统代理 / `HTTPS_PROXY` / npm proxy 不一致、证书拦截（企业网关 403、自签证书）、PowerShell 语言模式 | 一条命令覆盖目前四个入口；在你同事的企业机器上贴回来的输出足够定位问题 | M | 一次真机试跑 |
| A4 | **文档分层与 npm 包瘦身** | README（已重写）→ QUICKSTART → USAGE 三层；USAGE 按功能拆到 `docs/guide/*.zh-CN.md` 并补英文精简版 `docs/guide/en/`；PUBLISHING、ROADMAP、设计稿不再打进 npm 包（保留 README、USAGE 索引、SECURITY、LICENSE）；`check-docs` 增加“两份 README 章节一致”检查 | npm 包体积下降（当前含约 400KB 文档）；英文用户不用读中文手册也能完成安装与配置 | M | 否 |
| A5 | **真实用户试用** | 找 3–5 个真实用户（含那位企业同事、一位 macOS、一位 Linux），给一张 10 分钟任务单和反馈表；问题全部进 Issue | 收到至少 3 份反馈；阻断性问题在 0.21.x 修完 | L | **是**（找人） |
| A6 | **偶发测试修复** | `test/background.test.ts` 的 `STOP_UNCONFIRMED` 偶发；把 300×100ms 轮询改成事件/文件监听 + 单一超时；R3 的 `Atomics.wait` 改异步 | main 连续 20 次运行无偶发红；Ubuntu/Windows 测试步骤再缩短 | M | 否 |

### 阶段 B：质量与可信度（与 A 并行，持续）

| 编号 | 事项 | 做法 | 验收 | 量 | 需要你 |
|---|---|---|---|---|---|
| B1 | **真实模型评测基线** | 复用 `evals/real-run.mjs`：新增 Anthropic（claude-sonnet-5-5）与一个国产 OpenAI 兼容模型的配置；每次发版前跑 1-trial canary，每月跑一次完整基线；结果脱敏后存 `docs/verification/`，`eval:compare` 对比上一版 | 0.21.0 发布附带第一份真实基线；之后每版有对比表 | M | **是**（Key 与费用上限） |
| B2 | **可靠性遗留** | R3 异步化；R4 把 workspace/storageRoot 改成显式上下文对象传入（CLI 与桌面 host 各持一份）；A5 空 catch 逐个改为进诊断通道或注释说明为何可忽略 | 后台模块无模块级可变状态；空 catch 数量归零或每处有理由 | M | 否 |
| B3 | **安全中低项收口** | S4：终端环境改白名单（PATH、HOME/USERPROFILE、TEMP、LANG、TERM、代理变量、SystemRoot 等），默认剔除 `*_API_KEY/*TOKEN*/*SECRET*/AUTHORIZATION`，设置里可整体关闭过滤并提示风险；S5：记录进程启动时间（Linux `/proc/<pid>/stat` 第 22 字段，Windows `Get-Process StartTime` 或 WMI，macOS `ps -o lstart`），停止前校验，不一致则拒绝杀进程并报告；S3：网页页签在每次导航与重定向时重新解析并拦截私网地址（`webRequest.onBeforeRequest`），文档写明残余窗口；S6：`assertTrustedSender` 单测 + asarUnpack 内 worker/桥程序启动前 SHA-256 与包内清单比对（即 C8 的低成本版） | 每项独立 PR，有失败场景测试；SECURITY 对应条目更新 | 4 × S/M | S4 的默认值需你确认 |
| B4 | **供应链** | npm 发布加 `--provenance`（手动发布也可以：在 GitHub Actions 里手动触发一次“仅 npm publish”的工作流，不改 Release 流程）；发布附 SBOM（`npm sbom`）；安装器签名见决策 3 | npm 页面显示 provenance 徽章 | S | **是**（决策 2、3） |
| B5 | **依赖大版本** | 取决于决策 1。若放弃 Node 20：一次性升 chalk 6、commander 15、undici 8、openai 7、@types/node；`@napi-rs/keyring` 2 需你在 Windows 做一次“1.x 写、2.x 读”往返后再升 | 全部大版本就位或明确挂起理由 | M | **是**（决策 1 + keyring 往返测试） |

### 阶段 C：桌面对齐与特色强化（目标版本 0.22，阶段 A 之后 3–4 周）

| 编号 | 事项 | 做法 | 验收 | 量 | 需要你 |
|---|---|---|---|---|---|
| C1 | **桌面功能对齐 CLI** | 按 ROADMAP §4 缺口表依次接入：联网搜索工具与配置页、Skills 浏览/安装、插件发现与授权、故障转移/分阶段路由配置；顺手给 IPC 加运行时校验（A4，手写校验器，不引新依赖） | 缺口表中“桌面未接入”清零或明确延后；UI smoke 覆盖新页 | L | 否 |
| C2 | **Computer Use 真机闭环** | 你在 Windows 跑一次 `window-computer-smoke` 和一轮真实任务（记事本/浏览器各一）；按结果修；再做快捷键分级：**一级自动**（方向键、Tab、Esc、Home/End、PageUp/Down、Ctrl+Z/Y、Ctrl+A、Ctrl+F），**二级逐步确认**（Enter/Space 落在高风险控件、Ctrl+S、Ctrl+V、Delete/Backspace 连续超过阈值、Ctrl+Enter），**三级禁止**（Win 组合键、Alt+F4、Alt+Tab、Ctrl+Alt+Del、Ctrl+Shift+Esc、任何会离开已授权窗口的组合）；剪贴板继续不开放 | 真机任务成功；分级表进 SECURITY §5，C# 与 TS 共用同一张表并有一致性测试 | L | **是**（真机） |
| C3 | **国产与本地模型开箱即用** | `/provider add` 与桌面“新增渠道”增加模板：DeepSeek、通义千问（DashScope 兼容模式）、智谱 GLM、Moonshot Kimi、火山方舟、硅基流动、MiniMax——全部走现有 `openai-compatible` 类型，只预填地址、常用模型和 Key 环境变量名，不占 ID、不内置 Key；对 Qwen3-Coder、DeepSeek-V3.x、GLM-4.x 做一次工具调用兼容矩阵（能力探测结果写进文档） | 选模板后只需粘 Key；矩阵表进 USAGE | M | 一次用你的 Key 跑矩阵 |
| C4 | **非交互与 CI 用法** | `xiu run "<任务>" --json` 输出结构化事件流与退出码；`/report` 支持 `xiu report --last --format md` 直接导出；给出 GitHub Actions 用法示例（只读审查类任务） | 文档中的 CI 示例能跑通；非交互模式下危险操作仍拒绝而不是挂起 | M | 否 |
| C5 | **会话与证据分享** | `/report` 导出可离线打开的单文件 HTML（Diff、命令、验证、审批记录，脱敏），方便发给同事复查 | 一个任务一个 HTML，无外链、无 Key | S | 否 |

### 阶段 D：v1.0 收口（0.22 之后）

按 ROADMAP §5 的八条门槛逐条给出证据，不新增大功能：

1. 三平台 CLI 安装/升级在真实用户机器上各至少一次验收（A5 的延续）。
2. 桌面 Windows x64 稳定验收 + 签名安装器（决策 3）。
3. 崩溃恢复压力测试脚本化，进 CI 的每周作业而不是每次 PR。
4. Provider / Tool / Skill / MCP / 插件 / 桌面运行时协议的兼容承诺写成 `docs/compat.md`，版本号规则明确。
5. 自动更新与回滚方案设计稿（CLI 仍走 npm；桌面用 Release 清单 + 手动回滚包）。
6. 评测基线连续三个版本无退化（B1）。
7. macOS Keychain / Linux Secret Service：**只有在 A5 出现真实 macOS/Linux 用户需求时才做**，否则 1.0 保持文件存储 + 文档说明。MCP Sampling 同理延后。

---

## 5. 版本节奏与规则

| 版本 | 内容 | 预计 |
|---|---|---|
| 0.21.0 | A1 向导、A2 错误信息、A3 doctor、A4 文档分层、A6 偶发修复、B1 首份真实基线、C3 国产模板（因为向导需要模板，提前） | 2 周内 |
| 0.21.x | A5 试用反馈修复、B2/B3 逐项、B5 依赖升级（若决策 1 通过则 0.22 起要求 Node 22） | 持续 |
| 0.22.0 | C1 桌面对齐、C2 电脑操作闭环与快捷键分级、C4 非交互、C5 报告导出 | 0.21 后 3–4 周 |
| 0.23 / 1.0-rc | 阶段 D 证据收集 | 视 A5/B1 结果 |

规则不变：你手动发布；每个 PR 一轮 CI；发布 PR 同步改 `package.json` 的 `files` 里设计稿文件名、CHANGELOG、ROADMAP、README 版本行；发布后回读 npm 与 Release。

---

## 6. 需要你决定的事（附建议）

| # | 问题 | 选项 | 我的建议 |
|---|---|---|---|
| 1 | **是否放弃 Node 20 支持** | A. 0.22 起要求 Node ≥ 22.12（与桌面一致）；B. 继续支持 20.18.1 | **A**。Node 20 已于 2026-04-30 结束维护，npm 本身的新版本也不再支持它；继续支持挡住 chalk/commander/undici/openai 四个大版本，且安全补丁不再覆盖 Node 20 运行时。做法：0.21 在启动时对 Node 20 打一行弃用提示，0.22 切 `engines`，README/USAGE 同步。 |
| 2 | **npm provenance** | A. 在 GitHub Actions 加一个只做 `npm publish --provenance` 的手动触发工作流（tag 与 Release 仍由你手动建）；B. 维持纯本地发布 | **A**。它不改变你手动发布的节奏，只是把“最后一步 publish”搬到 CI，换来 npm 页面的来源证明；需要在 npm 配 Trusted Publishing（无需长期 token）。 |
| 3 | **Windows 代码签名** | A. SignPath Foundation（开源项目免费，需要申请）；B. Azure Trusted Signing（约 10 美元/月，需个人/企业身份验证）；C. 传统 OV/EV 证书（数百美元/年）；D. 暂不签名 | **先申请 A，同时评估 B**。不签名的安装器每个新用户都会被 SmartScreen 拦一次，是“好用”最直接的损失之一。 |
| 4 | **S4 终端环境变量默认值** | A. 默认过滤 Key/Token 类变量，可在设置里关闭；B. 默认全量继承，可选开启过滤 | **A**。过滤只影响内置终端里手动跑的命令，Agent 的命令工具不受影响；需要 Key 的用户在设置里一键关闭并看到说明。 |
| 5 | **真实模型评测的 Key 与预算** | 提供 Anthropic / OpenAI / 一个国产渠道的 Key，各设月上限 | 建议每个渠道月上限 20–50 美元等值；canary 每次不到 1 美元。Key 只放在你本机或 GitHub Secrets，不进仓库、不进云端会话。 |
| 6 | **A5 试用对象** | 你来找 3–5 位真实用户 | 优先那位企业同事（Windows + 代理 + 受限 PowerShell，是最难的环境），再各找一位 macOS 与 Linux。 |

此外两件已挂起、建议明确不做的事：C8 桥程序完整性校验的“完整版”（与 app.asar 同信任域，收益小；B3 里的低成本哈希比对已够）；发布全自动化（你已决定手动）。

---

## 7. 衡量指标

- **首次体验**：全新环境从安装到第一条任务 ≤ 5 分钟；试用用户“没看文档就跑通”的比例 ≥ 3/5。
- **错误可读性**：用户可见错误 100% 有“原因 / 下一步 / 诊断命令”；错误码表覆盖率 100%。
- **稳定性**：main 连续 20 次运行无偶发失败；Windows Verify ≤ 7 分钟，Ubuntu Verify ≤ 5 分钟。
- **质量**：每个发布版本有真实基线对比，端到端成功率、无关文件修改率、安全拒绝正确率不劣于上一版。
- **安全**：SECURITY 条目零回退；S3–S6 全部有失败场景测试；npm 有 provenance；安装器签名（取决于决策 3）。
- **特色**：国产模板 ≥ 6 个且各有一次真实连接验证；桌面缺口表清零；电脑操作真机任务通过。

---

## 8. 如果你同意，我接下来一周按这个顺序做

1. A6 偶发测试修复（先让 main 稳定，顺手把 R3 改异步）。
2. C3 国产模板（小而独立，向导要用）。
3. A2 错误信息人话化（先做 Provider 配置与搜索两类）。
4. A1 首次运行向导（CLI 先行，桌面随后）。
5. A3 `xiu doctor`。
6. A4 文档分层与 npm 包瘦身。

每项一个 PR，CI 全绿后合并；需要你真机或 Key 的项（A3 试跑、B1、C2、B5 的 keyring 往返）我会在 PR 里写清楚要你做的具体步骤。ROADMAP 的“当前优先级 / 下一步”等你确认方案后我再改，不先动。

---

## 9. 维护者决定（2026-10-15 09:45）

| # | 问题 | 决定 | 对计划的影响 |
|---|---|---|---|
| 1 | 放弃 Node 20 | **放弃** | 0.21 在 Node 20 上打弃用提示；0.22 起 `engines >=22.12`，随后升级 chalk 6 / commander 15 / undici 8 / openai 7 / @types/node；keyring 2 仍待 Windows 往返测试 |
| 2 | npm provenance | **先保持纯本地**，有资源后再升级 | B4 的 provenance 项挂起；SBOM 可随手动发布附带 |
| 3 | Windows 签名 | **暂无**，有了再说 | 安装器继续未签名，CI 继续断言未签名 |
| 4 | S4 终端环境变量默认值 | **A：默认过滤** Key/Token 类，可在设置关闭 | B3 按 A 实现 |
| 5 | 真实模型评测 Key | **暂不**（未接入企业） | B1 挂起；发布前继续跑模拟评测 |
| 6 | 试用用户 | **后面安排** | A5 挂起，其余阶段 A 项照做 |

据此执行顺序不变（第 8 节），B1/B4/A5 挂起，ROADMAP 已同步更新。
