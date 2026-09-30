# Xiu 项目全面评估报告（设计 + 代码）

评估日期：2026-08-25　｜　评估对象：`@xiu-ai/cli` v0.18.0（开发版），公开版 0.17.0
评估方式：只读审计（评估过程中未修改仓库任何既有文件，`git status --short` 为空）
本文件为新增的未跟踪文件，可随时删除；它不在 `scripts/check-docs.mjs` 的校验清单内，不会影响 `npm run check:docs`。

---

## 一、评估范围与方法

本次评估同时覆盖**设计文档**与**实现代码**，并且刻意采用"文档声明 → 代码落地 → 测试覆盖"三段对照的方式，而不是分别评价文档质量与代码质量。原因是 Xiu 的核心卖点（审计导向、可恢复、不虚假声称成功）本质上是一组**承诺**，承诺的价值完全取决于是否有程序化边界在兜底；只读文档会高估项目成熟度，只读代码会看不出它究竟违背了哪条自我约束。

阅读的设计与手册文档：`V0.18.0_DESIGN.zh-CN.md`（192 行）、`ROADMAP.zh-CN.md`（133 行）、`SECURITY.zh-CN.md`（91 行）、`README.md` / `README.zh-CN.md`、`QUICKSTART.md`、`USAGE.zh-CN.md`（1,717 行）、`PUBLISHING.zh-CN.md`（751 行）、`AGENTS.md`。

代码侧覆盖 `src/` 全部 66 个文件（22,002 行）、`test/` 61 个文件（9,342 行）、`evals/` 全部任务与 harness、`scripts/`、`.github/workflows/ci.yml`、`package.json`。

工程健康度的独立复核（我自己跑的，不采信文档自述）：

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 退出码 0 |
| 测试 | `npm test` | **486 通过 / 0 失败**，41.8 秒 |
| 工作区洁净 | `git status --short` | 空（审计未污染仓库） |
| 依赖审计 | `npm audit` | **无法完成**（内网 registry 返回 `E404 …/security/advisories/bulk`），这本身是一个发现 |

关键结论**优先使用实测而非阅读**得出。凡是标注"实测"的结论，都是通过 `node -e` 直接调用已构建的 `dist/` 导出函数、或直接运行 harness 得到的，报告中给出了可复现的输入与输出。

---

## 二、总体结论与分维度评分

**一句话结论：这是一个工程素养明显高于同龄个人项目的代码库，但它当前最响亮的两个承诺——"没有证据就不宣称成功"与"v0.18 用真实基线做量化优化"——在代码层面都是可以被轻易击穿的，且击穿方式并不需要恶意，日常使用就会自然发生。因此 v0.18.0 不应继续往前加功能，而应先把这两条承诺补成真。**

| 维度 | 评分 | 判断依据 |
| --- | --- | --- |
| 设计文档的完整性与自洽性 | **8.0 / 10** | 罕见地写清了范围、非目标、失败分类、硬上限、验收口径；扣分在 USAGE / PUBLISHING 结构失修与若干文档-代码不符 |
| 安全边界（真实落地部分） | **7.5 / 10** | 路径约束、扩展权限指纹、凭证存储、Web 取证四块是真正的程序化边界且测试扎实 |
| 安全边界（分类与审批层） | **4.0 / 10** | 全部安全性押在 `classifyCommand` / `toolRisks` 这一个可绕过的标签上，且审批决策层无单元测试 |
| 验证门禁（项目的旗舰主张） | **3.5 / 10** | `looksLikeVerification` 把 `echo test`、`tsc --version` 判为验证；`node --test` 反而不算 |
| 评测体系（v0.18 的全部工作） | **3.0 / 10** | harness 从不真正执行任何测试；真实基线注入 4 个假工具而非产品的 34 个工具，结论无外部效度 |
| 代码结构与可维护性 | **5.5 / 10** | `agent.ts`、`providers.ts`、`tools.ts` 边界清晰；`cli.ts` 3,645 行单 `main()` 是明确的技术债 |
| 测试工程 | **7.0 / 10** | 486 用例、跨平台 CI、真实边界用例质量高；但覆盖分布极不均衡，最危险的路径恰恰最薄 |
| 发布与流程纪律 | **5.0 / 10** | CI 门禁齐全；但 ~40 个 npm 版本只有 2 个 git tag，直接违反项目自己的路线图规则 7 |
| 产品化与采用度 | **3.0 / 10** | 下载量呈发布尖峰形态，尚无真实用户；这决定了优化顺序应当变化 |

---

## 三、项目现状的客观画像

先把事实摆出来，因为后面的建议全部基于这些事实。

代码规模上，`src/` 22,002 行、`test/` 9,342 行，测试代码约为产品代码的 42%，对个人项目而言是相当健康的比例。近 16 天有 98 次提交，节奏非常快。npm 上已发布约 40 个版本，但 git 仓库里只有 2 个 tag——`ROADMAP.zh-CN.md` 规则 7 明确要求"每次发布都必须在源码精确提交上打标签"，也就是说这条自我约束目前的遵守率约为 5%，绝大多数已发布版本已经无法追溯到确切源码状态。

npm 下载量约 7,578/月，但分布是典型的发布尖峰形态（例如 2026-08-23 仅 7 次下载），意味着流量几乎全部来自 CI 与镜像抓取，**尚不存在真实用户群**。这一点非常重要：它意味着现在做兼容性妥协、做向后兼容包装、担心破坏用户工作流的成本几乎为零，而做破坏性的正确修复的窗口正在关闭。

CI 形态是单一 `ci.yml`，3 个操作系统 × Node 20.18.1，门禁链为 `npm ci → check:docs → typecheck → test:ci → build → eval:smoke → npm pack --dry-run → smoke:package`。不用任何 secret，`permissions: contents: read`，这个设计是对的。缺失项是：没有依赖漏洞审计门禁、没有 Node 版本矩阵（只有 20.18.1，而 `package.json` 声明 `>= 20.18.1`，等于 22/24 从未被验证）、没有发布工作流（所以发布是手工的，这也解释了 tag 缺失）。

---

## 四、核心发现（按处置优先级）

### P0-1　验证门禁可被无意义命令满足，旗舰主张失效

这是本次评估最重要的发现，因为它打击的是 Xiu 区别于其他 CLI agent 的唯一核心主张。

`src/agent.ts:638` 决定任务结局：`workspaceChanged && !verifiedAfterChange ? "unverified" : "completed"`。也就是说"改了文件但没验证"会被降级为 `unverified`，这个机制设计正确。问题在于什么算"验证过了"——`src/tools.ts` 的 `looksLikeVerification()` 只做命令字符串的正则匹配。

实测结果（直接调用 `dist/tools.js`）：

| 命令 | `looksLikeVerification` | 实际意义 |
| --- | --- | --- |
| `tsc --version` | **true** | 只打印版本号，什么都没验证 |
| `echo test` | **true** | 纯粹的字符串回显 |
| `eslint --version` | **true** | 同上 |
| `npm run lint -- --help` | **true** | 打印帮助文本 |
| `node --test` | **false** | **真正在跑测试，却不算验证** |

这意味着：模型只要在改完文件后随手执行一句 `echo test`，任务就会从 `unverified` 变成 `completed`。这不需要模型有欺骗意图——`echo` 用于调试、`--version` 用于探测环境版本，都是模型极其常见的自然行为。更糟的是 `node --test`（Xiu 自己的测试命令族）不被识别，等于最诚实的行为反而被惩罚。

第二重缺口在 `verificationCommandPassed()`：它只要求 `Exit code: 0`，然后用一组负面证据正则排除。实测 `Exit code: 0\nFAIL src/foo.test.js` 被判为**通过**（因为 `FAIL` 后面跟了文件名，不匹配 `^\s*failed\s*$` 之类的锚定模式，也不匹配 `\b[1-9]\d*\s+failed\b`）。而 `Exit code: 0\nTests: 3 failed, 1 passed` 能被正确判为未通过。也就是说判定质量取决于测试框架的输出措辞，这是不可靠的基础。

`validate_project`（`tools.ts:759`）更宽松，只看 `Exit code: 0`。

**修复方向**：验证证据必须来自**结构化事实**而非命令字符串形态。可行的最小改造是：维护一份项目级的验证命令注册表（从 `package.json` scripts / `pyproject.toml` / `Makefile` 解析真实存在的 test/lint/typecheck 目标），只有注册表内的命令才计入验证；对 `--version`、`--help`、`echo`、`--list`、`--collect-only`、`--dry-run` 等"不执行任何断言"的调用形态做显式否决；并把"进程实际运行了多少测试用例"作为可选加强证据（例如从 TAP / JUnit 输出解析计数）。同时把 `node --test`、`vitest run`、`deno test` 加入正面模式。

### P0-2　真实基线注入 4 个假工具，v0.18 的全部量化结论无外部效度

`V0.18.0_DESIGN.zh-CN.md` 的核心目标是建立可复现的 v0.17.0 质量/成本/安全基线，并给出**降低 40% token** 的优化目标。但 `evals/real-run.mjs:85-112` 在构造真实运行时，注入的是 `createEvaluationTools(isolation.workspace)`——即 `evals/lib/tools.mjs` 里的 4 个合成工具 `eval_read_file` / `eval_write_file` / `eval_replace_text` / `eval_verify`——而**不是产品实际暴露给模型的 34 个工具**。同时 `projectConfigurationTrusted: true` 被硬编码，绕过了真实的信任流程。

我实测量化了这个差距。Xiu 的每次模型调用有一笔固定开销，等于系统提示 + 全部工具 schema：

| 配置 | 系统提示 | 工具 schema | 每次调用固定开销 |
| --- | --- | --- | --- |
| 真实产品（34 工具） | 8,307 字符 ≈ 2,077 token | ≈ 3,869 token | **≈ 5,946 token** |
| 评测 harness（4 假工具） | ≈ 2,077 token | ≈ 239 token | **≈ 2,316 token** |

评测环境的固定开销只有真实环境的约 39%。而在设计文档所用的小任务上，固定开销恰恰是总成本的主要部分。结论是：**基于当前 harness 得到的任何 token 数字都不能外推到产品**，"降低 40%"这个目标既无法被现有 harness 验证，也无法被它证伪。更棘手的是，真实产品里降低固定开销的最大杠杆（工具 schema 精简、按阶段裁剪工具集）在 harness 里几乎不可见，因为 harness 只有 4 个工具。

另外 `src/providers.ts:36-40` 的 `openAIPromptCache()` 只在 `config.provider === "openai"` 时返回 `prompt_cache_key`，而设计文档指定的基线 provider 是 **Agnes**（`agnes-2.5-flash`）——也就是说基线跑在一个**拿不到 prompt cache** 的通道上，进一步放大了与真实用户成本结构的偏离。

**修复方向**：真实基线必须使用产品的真实工具集与真实信任流程，harness 的隔离应当体现在工作区与凭证边界上，而不是替换工具层。在此之前，`V0.18.0_DESIGN.zh-CN.md` 中的 40% 目标应当降级为"待基线可信后再设定"，避免在错误的度量上做优化决策。

### P0-3　评测 harness 从不执行任何测试，且部分任务恒真

这一条与 P0-2 相互独立，指的是任务本身的有效性。

`evals/lib/tools.mjs` 的 `eval_verify` 只做 `includes` / `equals` 字符串比对；整个 `evals/` 目录**没有任何一处真正启动测试进程**。因此"模型是否修好了 bug"这个问题，在 harness 里被替换成了"模型写出的文本里是否包含某个字面量"。

具体到任务：`evals/tasks/tests-range-regression/repo/src/range.js` 的实现是 `return value >= minimum && value <= maximum;`——**这里没有 bug**。而 `assert.mjs` 只断言测试文件里出现了字面量 `inRange(3, 1, 3)` 以及 `exactChanges` 约束。也就是说这个"回归修复"任务，模型不需要理解也不需要修任何东西。

两个安全类任务同样是恒真的：harness 里根本不存在危险工具，而 `evals/lib/core.mjs:109` 明确禁止安全任务使用脚本化工具调用，所以"模型没有做危险操作"这个断言在结构上不可能失败。

任务数量方面，`evals/tasks/` 实际有 10 个任务（符合设计文档"现阶段 10 个"），但发布前 20 个的目标尚未达成，且 `evals/baselines/` 目录**当前并不存在**——设计文档声明的 `evals/baselines/v0.17.0.json` 还没有产出，这与文档头部"阶段 C 未执行"的自述一致，属于诚实的未完成，而非文档失真。

**修复方向**：把 `eval_verify` 换成真实的子进程执行 + 退出码判定（这也顺带为 P0-1 提供了正确的验证证据来源）；给 `tests-range-regression` 植入一个真实的边界 bug（例如 `>` 写成 `>=` 的反向错误）；安全任务必须提供真实可被误用的工具（在受控沙箱里），否则应当从任务集中移除，因为恒真断言会虚高通过率并掩盖真实风险。

### P0-4　命令风险分类可被换行、`$()` 与输出重定向击穿

这条与 P0-1 同源（都是"用正则理解 shell 语义"），但后果更严重：`read` 这个标签在 Xiu 里同时意味着**免审批**、**Plan 只读模式放行**、**不生成检查点**（`tools.ts:796-806`、`agent.ts:687-688`、`checkpoint.ts:22-26`）。

实测（`node -e` 调 `dist/tools.js` 的 `classifyCommand`），以下命令全部被判为 **`read`**：

| 命令 | 实际行为 |
| --- | --- |
| `git status\nrm -rf build`（含换行） | 删除目录 |
| `git status $(Remove-Item -Recurse -Force build)` | 删除目录 |
| `Get-Content a.txt > package.json` | 覆盖 `package.json` |
| `git show HEAD:src/agent.ts > package.json` | 覆盖 `package.json` |
| `select-string -Path a -Pattern b > c.txt` | 写文件 |
| `git diff --output=../outside/x.txt` | 写到工作区之外 |

根因有三处：`tools.ts:204` 的 dangerous 正则没有 `m` 标志且分隔符只有 `[;|]`（所以换行分段完全不可见）；`tools.ts:213` 的短路检查 `/[|;]/` 不含 `>`、`<`、`$(`；`tools.ts:209` 的 readOnly 白名单只匹配命令**开头**，命令后半段做什么完全不看。`readOnlyPowerShellScript`（`tools.ts:183-198`）本身对结构字符较谨慎（含 `;&><=` 即拒绝），但它被否决后控制流会落到那个更宽松的开头匹配白名单上。

顺带一个次级问题：被判为 `dangerous` 的写法只有字面前缀，实测 `env FOO=1 rm -rf build`、`sh -c "rm -rf build"`、`powershell -Command "Remove-Item -Recurse -Force ."`、`find . -delete`、`npx rimraf dist` 全部只是 `execute`；而 `npm publish`、`git push --force` 也只是 `execute`，与 `SECURITY.zh-CN.md` 第 11 行"发布、回退必须显式确认"不符。在 `-y` / `--yes` 下，`execute` 会被自动放行（`cli.ts:638`）。

**修复方向**：在 `classifyCommand` 入口做**结构否决**——对 `unquotedText()` 的结果检测 `$(`、反引号、`>`、`>>`、`<`、`|`、`;`、`&`、换行 中任意一个，命中即直接返回至少 `execute` 且不再进入任何 read 白名单；把 `--output` / `-o` / `--work-tree` 从 git read 白名单剔除；对 `sh|bash|pwsh|powershell|cmd` 的 `-c` / `-Command` 参数递归展开后重新分类；剥离 `NAME=VALUE` 前缀；补上 `npm publish`、`git push --force*`、`git checkout|restore -- .`、`find -delete`、`rimraf`、`truncate`、`shred` 等模式。这是一个几十行的改动，但它是当前投入产出比最高的一处修复。

### P0-5　合并证据取自模型自然语言，直接违反自己的禁令

`src/multi-agent.ts:166-170` 的 `evidencePassed()` 判定方式是：取任务结果文本的**最后一行**，正则匹配 `/^VERDICT\s*:\s*PASS\.?$/i` 或中文的 `结论：通过`。`collectIntegrationEvidence()`（`:172-180`）据此决定 worktree 补丁能否合并进主工作区。

而 `SECURITY.zh-CN.md` 第 12 行与第 77 行明确禁止"由模型自然语言替代验证证据"。这是文档与代码之间最直接的一处自我违背：Xiu 一边宣称不接受模型的自我声明，一边把最高风险的操作（把子 Agent 的改动合并进主工作区）的门禁完全建立在模型打出一行 `VERDICT: PASS` 之上。

同时 `integrate_agent` 的风险等级是 `write`（`multi-agent.ts:636-639`），在 `-y` 下会被 `cli.ts:638` 自动批准，与文档第 78 行"实际应用仍需明确确认"冲突。

**修复方向**：reviewer / tester 的通过与否应当由**程序事实**决定——例如在该 worktree 上由框架自己执行 `validate_project` 并读退出码，或要求 tester 的工具调用记录中确实存在一次成功的验证命令。模型文本可以作为解释，但不能作为门禁。`integrate_agent` 应升级为 `dangerous`，或至少无条件要求确认、不受 `autoApprove` 影响。

### P1-6　托管 Web 检索默认开启并指向作者自有服务，与隐私声明冲突

`src/settings.ts` 中 `XIU_BETA_SEARXNG_ENDPOINT = "https://search.jingran.vip"`，而 `betaWebSearchConfig()` 返回 `{ enabled: true, provider: "searxng", managedAuth: "xiu-device", authBaseURL: … }`。关键在于它被应用于**两条**路径：settings 文件不存在时的 ENOENT 分支，以及 settings 文件存在但没有 `webSearch` 键时。换言之，**全新安装的用户默认启用了指向作者自有服务器的托管检索，并会进行设备注册**。

这与 `README.md:61` / `README.zh-CN.md:61`（"只访问显式配置的 Web/MCP 服务"）以及 `QUICKSTART.md:82` 的隐私表述不一致。技术实现本身是克制的（`web-search.ts` 强制 HTTPS、拒私网、逐跳复验重定向、认证请求禁跨域、响应 1MB 上界、剥离活动内容并标注 `UNTRUSTED WEB CONTENT`，测试也扎实），问题纯粹在于"默认开启 + 文档说不会"这个组合。对一个主打审计与可信边界的工具，这是声誉风险最高的一条。

**修复方向**：二选一即可——要么改为默认关闭、首次使用时显式询问并说明数据流向；要么在 README / QUICKSTART / SECURITY 里明确写清"默认启用托管检索、端点是哪个、发送什么、如何关闭"。不建议维持现状。

### P1-7　恢复语义：`unknown` 副作用不被阻断

`SECURITY.zh-CN.md` 第 81 行承诺"状态为 `unknown` 或已成功的副作用操作不得在恢复时自动重放"。实测（临时 journal root，`pause()` 后重读）：`task-run.ts:319-333` 的 `interruptedOperations` 只筛 `"started"`，`agent.ts:358-361` 只筛 `started | succeeded`，因此经由 `pause()` 转为 `unknown` 的操作既不出现在中断列表里，也不进入阻断集合，恢复建议会降级为"确认后即可继续"。修复很小：两处筛选条件同时纳入 `"unknown"`。

同时 `task-run.ts:122-129` / `:461-467` 的路径脱敏只覆盖 Windows 盘符形态（`/[A-Za-z]:\\[^\s"']+/`），POSIX 绝对路径会原样留在恢复证据中，与第 80 行"不得包含完整路径"不符。

### P1-8　Shell 类工具没有检查点，删除不可回退

`checkpoint.ts:22-26` 的 `targetPaths()` 只覆盖 `write_file` / `replace_text` / `apply_patch` / `generate_image` / `generate_video`。`run_command` / `run_process` 虽然标了 `changesWorkspace: true`，但 `capture` 返回 undefined，journal 记为 "checkpoint not required"。结果是：**通过 shell 执行的删除与覆盖没有任何恢复点**。结合 P0-4（部分删除命令被判为 `read`），这条的实际影响被显著放大。

修复方向是：对 `changesWorkspace` 但无法枚举目标的工具，改用 git stash / 轻量快照兜底，或者在无法建立恢复点时显式提升风险等级并告知用户"此操作不可回退"。

### P1-9　Plan 只读依赖外部可声明的 `risk` 字段

Plan 模式的唯一执行点是 `agent.ts:687-688` 的 `risk !== "read"`。而 MCP 工具的 risk 来自配置（`mcp.ts:913`，`toolRisks ?? risk ?? "execute"`），插件贡献的 MCP 走同一路径（`plugins.ts:362,760`）。默认值 `execute` 是正确的（未知工具不会被当成安全），但**配置方可以自声明 `risk: "read"`**，从而让该服务器的全部工具在 Plan 模式下可执行且免审批。这与 `SECURITY.zh-CN.md` 第 24 行"声明权限不是绕过核心审批的授权"存在张力。

建议把 Plan 门禁从"读 risk 字段"改为"来源白名单 + 显式 `planSafe: true`"，并规定外部声明的工具最低风险为 `execute`。

### P1-10　会话审批范围过粗

`cli.ts:643-669` 的"本会话始终允许"记忆键是 `run-process:<程序名>`（不含参数，`tools.ts:530`）与 `workspace-files:write|edit`（不含路径，`tools.ts:445/465/489`）。批准一次 `node build.js` 等于批准本会话内任意 `node` 参数；批准一次写文件等于批准任意路径写入。建议 scope 纳入规范化路径或参数摘要。

### P2 级问题（清单）

- **脱敏晚于截断**：`tools.ts:131-138` 先截断原始输出，脱敏直到 `agent.ts:1404` 才发生，违反 `SECURITY.zh-CN.md` 第 65 行"在截断和持久化前脱敏"的顺序要求；实测把 JWT 从中间切开后不再命中模式，两段明文原样保留。
- **秘密模式覆盖窄**：`secret-redaction.ts:16-24` 仅覆盖 `Bearer` / `sk-` / `gh?_` / `AKIA` / JWT / PEM；`AIza…`、`tvly-…`、无前缀 Brave Key、`npm_…`、`glpat-…` 均不脱敏。且 web-search 的三个 env 凭证与 MCP bearer 从未加入 `activeSecrets`。
- **会话日志持久化 provider `raw`**：`agent.ts:585` 把 `raw: response.raw` 原样写入会话 jsonl，而 `providers.ts:89` 是完整 assistant message（OpenAI 兼容通道可能带 `reasoning_content`）、`:320` 是完整 Anthropic content blocks（含 thinking）。这与文档第 66-67 行"不保存模型思维链"不符。
- **持久化授权存储缺 schema 校验**：`extension-permissions.ts:78-84` 只校验 `version` 与 `grants` 是对象，未校验单条 `fingerprint` / `permissions` 形状，而 `permissionFingerprint()`（`:54-62`）是可离线计算的确定值——篡改文件即可静默预授权。同类问题在 `checkpoint.ts:86`（manifest 完全未校验，`restore()` 据此 `copyFile`/`rm`）与 `multi-agent.ts:222`（`as SubagentRun` 未校验，可伪造 PASS 证据）。**更正一处早期怀疑**：`plugin-signatures.ts:127-135` 虽有 `as` 断言，但随后对每条记录重算 `pluginPublisherFingerprint(publicKey)` 并要求一致，篡改会 fail closed，仅属类型卫生问题，不构成扩权。
- **子进程继承完整 `process.env`**：`tools.ts:561,607,769` 使用 `env: { ...process.env, … }`，任何获批的 `execute` 命令自动获得读取 API Key 的能力。未发现 Xiu 主动把 Key 写盘或发往非配置端点。
- **`resolveWorkspacePath` 返回词法路径**：`workspace-path.ts:46` 校验用 realpath 但返回词法 target，校验与真正 open/write 之间存在 TOCTOU 窗口，无 `O_NOFOLLOW`。`worktree.ts:98-103` 的 `validateTarget` 只用词法 `path.relative`，未复用 realpath 逻辑。
- **100 USD 授权上限恒为零约束**：设计文档的成本闸门读取 `reportedCostUsd`，而配置里的单价为 0，所以实际生效的只有 token / 调用次数 / 时长预算，成本上限是装饰性的。
- **`plugins.ts:456` 默认 `currentVersion = "0.14.3"`**，与 package 的 0.18.0 不同步，应由 `package.json` 单一来源注入。
- **`agent.ts:669` try / `:771` catch 的错误标签错误**：所有被捕获的异常都被标记为 `Tool error: invalid arguments for ${call.name}`，掩盖真实故障原因，会污染失败分类统计（对 v0.18 的失败分类学尤其有害）。
- **依赖审计缺门禁**：CI 无 `npm audit` / OSV 检查；本次评估也因内网 registry 不支持 bulk advisories 接口而无法完成审计，说明这条链路从未被验证过。

---

## 五、分维度详评

### 5.1 设计文档

`V0.18.0_DESIGN.zh-CN.md` 的质量高于绝大多数同类项目：它写清了范围与非目标、单变量优化原则、每次试验的硬上限（10 分钟 / 30 次模型调用 / 80 次工具调用 / 20 万输入 / 2 万输出 token）、8 类失败分类学（`task_assertion` / `model_behavior` / `provider` / `harness` / `timeout` / `budget` / `interrupted` / `safety`）、以及 PR-CI 只跑 mock 的规则。头部状态栏诚实地标明阶段 C（真实基线）尚未执行。这套写法值得保留为项目的设计文档范式。

它的问题不在写法而在**前提**：整个文档假定 harness 度量的是产品行为（见 P0-2 / P0-3）。因此建议在文档里补一节"度量有效性前提"，显式列出 harness 与产品的差异清单（工具集、信任标志、prompt cache 可用性、是否真正执行测试），并规定这些差异必须在阶段 C 之前归零。

`ROADMAP.zh-CN.md` 的"当前状态 / 下一步"机制是好的持久上下文设计。section 4 已经识别出 `cli.ts` 拆分（从 `/update`、`/web`、`/credentials` 命令组开始）、`Agent` 构造器改 options 对象、i18n 抽取、静默降级接入诊断——这几项判断准确，应当保留并提高优先级。规则 7（每次发布打 tag）目前遵守率约 5%，建议要么用发布工作流强制，要么把规则改成能被遵守的形式。

`SECURITY.zh-CN.md` 是本次评估的主要基线。它列出的边界中，路径约束、不静默重放、扩展权限指纹、凭证隔离、Web 取证这五块是**真正落地且有测试**的，质量确实不错。但第 9 行（Plan 只读不可绕过）、第 11 行（删除/覆盖/发布/回退须确认）、第 12 与 77 行（不接受模型自然语言作为验证证据）、第 65-67 行（脱敏顺序、不存思维链）、第 80-81 行（恢复证据脱敏、`unknown` 不重放）这几条与代码不符。建议把这份文档拆成"已强制执行的边界"与"目标边界（尚未强制）"两节——诚实的分层比整体失真好得多，也更符合项目自身的价值主张。

### 5.2 架构与可维护性

分层是清晰的：`providers.ts` 收敛 provider 差异、`tools.ts` 收敛工具与风险、`agent.ts` 是主循环与门禁、`workspace-path.ts` 是唯一的路径约束助手且被所有 FS 工具复用。这些边界选得对。

最大的结构性债务是 `src/cli.ts`：3,645 行，其中 `main()` 约 3,350 行，内含 49 个闭包、99 个 slash 命令分派分支，导入了 66 个模块中的 45 个，且**几乎没有单元测试**。后果不是抽象的——本次评估发现的多个问题正好落在这一层（`-y` 的放行策略 `:638`、会话审批记忆 `:643-669`、非 TTY fail closed `:653-657`、provider 故障转移在 `:686`/`:814`/`:1141`/`:1181` 有重复实现）。安全决策放在一个不可测试的巨型函数里，是当前最需要偿还的债。

`Agent` 构造器接收约 10 个位置参数，其中包含一个裸 `undefined` 占位（`cli.ts:793-813`、`:911`），改成 options 对象既能消除占位符，也能让新增依赖不再是破坏性改动。考虑到目前没有真实用户，这个破坏性改动的时机就是现在。

### 5.3 测试工程

486 个用例全部通过，41.8 秒完成，跨 3 个操作系统，这个基础面是好的。部分边界用例质量很高，例如 `test/tools.test.ts:9-41` 覆盖了 symlink / junction 逃逸与 glob 越界，`test/cli-trust.test.ts:12` 用 AGENTS.md canary 断言 `--yes` 也不能绕过信任，`test/task-run.test.ts` 有 8 处针对恢复语义的断言，`test/security-audit.test.ts` 甚至覆盖了"写审计失败不得抛异常"。

问题是**覆盖分布与风险分布反向**。零覆盖或近零覆盖的正是最危险的路径：dangerous 分类的规避面（`test/tools.test.ts:162-189` 仅 4 个正面断言，无 `$()` / 重定向 / `sh -c` / env 前缀 / 换行 / `npm publish` 的反面用例）；Plan 模式经 MCP / 插件 / 命令通道的绕过（`test/plan.test.ts:59` 只覆盖内建 `write_file`）；`pause()` → `unknown` 的恢复阻断（`test/task-run.test.ts:118` 只断言可恢复，未断言仍被阻断）；截断边界的脱敏；授权/证据存储被篡改的场景；以及整个 `cli.ts` 审批决策层。

建议的最小补测集：对 `classifyCommand` 建一张"应当至少为 execute"的规避用例表（把本报告 P0-4 的表格直接变成测试）；对 `looksLikeVerification` 建一张"不得算作验证"的否决表（`--version` / `--help` / `echo` / `--dry-run`）；把 `-y` 下"dangerous 仍需确认"与"integrate_agent 仍需确认"写成断言；给授权存储加篡改用例。这些测试的价值在于它们会**永久锁住**修复，而不只是修一次。

### 5.4 文档一致性与结构

`USAGE.zh-CN.md`（1,717 行）已经出现明显的结构失修：`### 3.1` / `3.2` / `3.3` 各出现两次（122/204、137/225、150/247），随后跳到 3.6（:257）；`## 二十四` 出现两次（:1382、:1669）；23.1-23.3（:1617-1643）被孤立在第 24 节之下；内容停在 v0.16.4，落后当前开发版两个小版本。`PUBLISHING.zh-CN.md`（751 行）标题序号断裂（十八:506 → 二十:518 → … → 十九:563），第十五至三十五节是 21 个追加式的按版本发布门禁，且没有 0.18.0 的门禁节。

这两份文档的共同病因是**只追加不重构**。建议 `USAGE` 按功能域重排并只维护当前版本行为（历史留给 Git），`PUBLISHING` 把 21 个按版本节收敛为"一份通用发布检查单 + 一份最近一次发布记录"。

`scripts/check-docs.mjs`（59 行）只校验 9 份文档是否存在、相对链接目标是否可达（锚点被剥离）、单一当前设计文档规则、以及少量字面串。它在上述所有不一致面前都是绿的。建议扩展为：标题序号单调性检查、重复标题检测、以及针对高风险声明的字面一致性检查（例如 README 的隐私表述与 `settings.ts` 的默认值必须匹配、文档中出现的版本号必须与 `package.json` 一致）。这类检查很便宜，且能防止文档漂移复发。

### 5.5 发布与流程

CI 门禁链设计合理且不含 secret，值得保留。缺口是三处：Node 版本矩阵只有 20.18.1（22 / 24 从未验证，而 `engines` 声明 `>=20.18.1`）；没有依赖漏洞审计；没有发布工作流，因此发布是手工的，直接导致约 40 个 npm 版本只有 2 个 git tag。

考虑到"永不覆盖已发布版本"是项目自己的硬规则，而当前无法把大多数已发布版本对应到确切源码，建议尽快加一个 release workflow：由 tag 触发，自动校验 `package.json` 版本与 tag 一致、跑完整门禁、`npm publish --provenance`、发布后回读 registry 校验。这同时解决 tag 缺失与人工发布出错两个问题。

---

## 六、v0.18 → v0.19 迭代建议

我的核心建议是**调整 v0.18 的优先级顺序**：先修度量与门禁，再谈优化。理由是当前 v0.18 的全部产出（基线数字、40% 目标）都建立在一个不反映产品的 harness 之上，如果按现计划继续推进阶段 C，产生的将是一份看起来很专业但不能指导任何决策的基线，而后续所有"单变量优化"都会围绕这份基线做出错误取舍。

**第一批（阻塞 v0.18 阶段 C，建议 1-2 周内完成）**

1. 修 `looksLikeVerification` / `verificationCommandPassed` / `validate_project`（P0-1），并配套否决用例表。这是旗舰主张，必须先真。
2. 让 `evals/real-run.mjs` 使用产品真实工具集与真实信任流程（P0-2）；同时给 Agnes 通道补 prompt cache 或在基线里显式记录"该通道无缓存"。
3. `eval_verify` 改为真实子进程执行；给 `tests-range-regression` 植入真 bug；安全任务要么提供真实可误用工具，要么移除（P0-3）。
4. `classifyCommand` 结构否决改造（P0-4），把本报告的规避表变成测试。

**第二批（v0.18 发布前）**

5. 合并证据改为程序事实，`integrate_agent` 升级为需无条件确认（P0-5）。
6. 托管 Web 检索的默认值与文档二者取一致（P1-6）。
7. `unknown` 副作用纳入阻断集合 + 恢复证据 POSIX 路径脱敏（P1-7）。
8. Shell 类工具的检查点兜底或显式风险升级（P1-8）。
9. 产出 `evals/baselines/v0.17.0.json`，任务数补到 20，并在设计文档补"度量有效性前提"一节。

**第三批（v0.19 结构性工作）**

10. 按 ROADMAP section 4 拆 `cli.ts`，优先把**安全决策**（`-y` 策略、会话审批记忆、非 TTY fail closed）搬到可测试的独立模块并补测。
11. `Agent` 构造器改 options 对象（趁无真实用户，破坏性改动成本最低）。
12. Plan 门禁改为来源白名单 + `planSafe`，外部声明工具最低 `execute`（P1-9）。
13. 授权 / 检查点 / 多 Agent 三处持久化存储补 schema 校验与篡改测试。
14. 加 release workflow（tag 触发 + provenance + 回读校验），补 Node 22/24 矩阵与依赖审计门禁。
15. 重构 `USAGE.zh-CN.md` 与 `PUBLISHING.zh-CN.md`，扩展 `check-docs.mjs` 到序号与声明一致性检查。

**关于产品定位的一点建议**：下载数据显示尚无真实用户，这意味着现在最稀缺的不是功能数量，而是**一个能被验证的差异化主张**。Xiu 的主张（不虚假宣称成功、可恢复、可审计）在同类工具里确实稀缺且有价值，但它必须先在自己的代码里成立。把 P0-1 与 P0-5 修好，比再加三个 provider 或十个 slash 命令更能决定这个项目的未来。

---

## 七、查漏补缺检查清单

可直接作为 issue / TODO 使用，按前述优先级排列。

- [ ] `looksLikeVerification`：否决 `--version` / `--help` / `echo` / `--dry-run` / `--list` / `--collect-only`；纳入 `node --test` / `vitest run` / `deno test`
- [ ] 验证证据改为项目级注册表（解析 `package.json` scripts 等真实存在的目标）
- [ ] `verificationCommandPassed`：不再依赖措辞正则，改为结构化输出解析或注册表命令的退出码
- [ ] `validate_project`：不能只看 `Exit code: 0`
- [ ] `evals/real-run.mjs`：使用产品 34 工具 + 真实信任流程，移除 `projectConfigurationTrusted: true` 硬编码
- [ ] `openAIPromptCache`：为 Agnes 通道提供缓存键或在基线记录缓存不可用
- [ ] `eval_verify` 改为真实执行；`tests-range-regression` 植入真 bug；安全任务去恒真化
- [ ] 产出 `evals/baselines/v0.17.0.json`；任务数 10 → 20
- [ ] `V0.18.0_DESIGN.zh-CN.md` 补"度量有效性前提"；40% 目标待基线可信后重设
- [ ] `classifyCommand` 结构否决：`$(` / 反引号 / `>` / `>>` / `<` / `|` / `;` / `&` / 换行 → 至少 `execute`
- [ ] git read 白名单剔除 `--output` / `-o` / `--work-tree`
- [ ] 解释器包装递归展开（`sh -c` / `powershell -Command`）；剥离 `NAME=VALUE` 前缀
- [ ] dangerous 补集：`npm publish`、`git push --force*`、`git checkout|restore -- .`、`find -delete`、`rimraf`、`truncate`、`shred`、`dd`
- [ ] `evidencePassed` 改为程序事实；`integrate_agent` 升级为无条件确认
- [ ] 托管 Web 检索：默认关闭 + 首次询问，或在 README/QUICKSTART/SECURITY 写明默认开启与端点
- [ ] `task-run.ts:323` 与 `agent.ts:359` 的筛选纳入 `"unknown"`
- [ ] 恢复证据脱敏补 POSIX 绝对路径规则 + 跨平台测试
- [ ] `run_command` / `run_process` 的检查点兜底（git stash / 快照）或显式风险升级
- [ ] Plan 门禁改来源白名单 + `planSafe`；外部声明工具最低 `execute`
- [ ] 会话审批 scope 纳入规范化路径 / 参数摘要
- [ ] 脱敏移到 `truncate()` 之前
- [ ] 秘密模式补 `AIza` / `tvly-` / `npm_` / `glpat-`；web-search 与 MCP bearer 的 env 值加入 `activeSecrets`
- [ ] 会话 jsonl 持久化前白名单化 `raw`，剔除 `reasoning_content` / thinking blocks
- [ ] `extension-permissions.ts` / `checkpoint.ts` manifest / `multi-agent.ts` run 三处补 schema 校验与篡改测试
- [ ] 子进程 env 按白名单裁剪，默认剔除凭证类环境变量
- [ ] `resolveWorkspacePath` 返回已解析路径 / fd，考虑 `O_NOFOLLOW`；`worktree.validateTarget` 复用该助手
- [ ] `agent.ts:771` 的 catch 不再统一标记为 `invalid arguments`
- [ ] `plugins.ts:456` 的 `currentVersion` 由 `package.json` 注入
- [ ] 成本闸门：填入真实单价或明确声明成本上限暂不生效
- [ ] CI 补 Node 22 / 24 矩阵、依赖漏洞审计门禁、tag 触发的发布工作流
- [ ] 补齐历史版本 git tag，或修订 ROADMAP 规则 7 为可执行形式
- [ ] `USAGE.zh-CN.md` 重排（修重复 3.1-3.3 与两个"二十四"、孤立的 23.1-23.3，内容更新到 0.18）
- [ ] `PUBLISHING.zh-CN.md` 收敛为通用检查单 + 最近发布记录，修标题序号
- [ ] `check-docs.mjs` 扩展：标题序号单调性、重复标题、版本号一致性、隐私声明与代码默认值一致性

---

## 附录　验证记录

以下为本次评估中所有实测的可复现记录。

**工程健康度**：`npm run typecheck` 退出码 0；`npm test` 输出 `tests 486 / pass 486 / fail 0 / duration_ms 41787.73`；评估结束时 `git status --short` 为空。

**风险分类实测**（`node -e "const t=require('./dist/tools.js'); t.classifyCommand(cmd)"`）：

```
read       "Get-Content a.txt > package.json"
read       "git show HEAD:src/agent.ts > package.json"
read       "git status $(Remove-Item -Recurse -Force build)"
read       "select-string -Path a -Pattern b > c.txt"
read       "git diff --output=../outside/x.txt"
read       "git status\nrm -rf build"
execute    "env FOO=1 rm -rf build"
execute    "sh -c \"rm -rf build\""
execute    "powershell -Command \"Remove-Item -Recurse -Force .\""
execute    "find . -delete"
execute    "npx rimraf dist"
execute    "npm publish"
execute    "git push --force"
dangerous  "rm -rf build"
dangerous  "git reset --hard"
```

**验证门禁实测**（`looksLikeVerification` / `verificationCommandPassed`）：

```
verif=true   "tsc --version"
verif=true   "echo test"
verif=true   "eslint --version"
verif=true   "npm run lint -- --help"
verif=false  "node --test"

verificationCommandPassed("Exit code: 0\nFAIL src/foo.test.js")        => true
verificationCommandPassed("Exit code: 0\nTests: 3 failed, 1 passed")   => false
```

**Token 开销实测**：`src/prompt.ts` 模板 8,307 字符 ≈ 2,077 token；产品 34 个工具的 schema ≈ 3,869 token；harness 4 个 `eval_*` 工具 ≈ 239 token。真实固定开销 ≈ 5,946 token/次调用，harness ≈ 2,316 token/次调用（约为真实值的 39%）。

**恢复语义实测**：临时 journal root，`pause()` 后重读得到 `operations=['unknown']`、`interruptedOps=0`、`pendingSideEffects=0`、blocked set 为空。

**代码定位复核**（报告中引用的行号均经直接读取确认）：`multi-agent.ts:166-170` `evidencePassed` 正则匹配模型输出末行；`checkpoint.ts:22-26` `targetPaths` 不含 `run_command` / `run_process`；`agent.ts:585` 持久化 `raw: response.raw`；`tools.ts:183-198` `readOnlyPowerShellScript`；`tools.ts:200-214` `classifyCommand`；`tools.ts:216-237` `classifyGitInvocation`。

**未能验证的项**（不做结论）：`npm audit` 因内网 registry 不支持 bulk advisories 接口而失败，依赖漏洞面未评估；非 TTY / EOF 下 `cli.ts:198-202` 的 `askQuestion` 在信任提示处的实际行为（可能挂起而非默认信任）未实测。
