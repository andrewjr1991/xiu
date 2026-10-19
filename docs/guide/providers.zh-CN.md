# Xiu 使用指南 · 渠道与模型

本文是[使用指南目录](../../USAGE.zh-CN.md)的一部分；上手请先看[快速上手](../../QUICKSTART.md)。

## 配置 Provider 与模型

Xiu v0.10 支持 Agnes、OpenAI、Anthropic、Ollama、LM Studio、vLLM 和自定义 OpenAI-compatible 服务。云端服务需要各自的 API Key；本地服务不要求云端 Key。

从 v0.13.7 起，新安装如果尚未配置当前 Provider 的 API Key，Xiu 不会报错退出，而会保持在交互式配置模式。终端会提供“配置当前 Provider Key”“选择其他 Provider”“稍后配置”三种选择；即使选择稍后配置，也可以正常进入 `xiu>`，再使用 `/provider key` 或 `/providers` 完成设置。带任务参数的一次性命令无法交互配置，因此会给出明确提示并安全退出；请先单独运行一次 `xiu` 完成配置。

0.21 起，在终端里启动且一个渠道都没有时，Xiu 直接进入三步首次向导：第 1 步选择渠道（Agnes、OpenAI、Anthropic、本地 Ollama/LM Studio/vLLM、国内厂商模板、自定义 OpenAI 兼容服务，或“稍后配置”；检测到 `OPENAI_API_KEY` 一类环境变量时对应渠道会排在最前，选它只记录变量名、不保存 Key）；第 2 步填写 Key 或本地服务地址（Key 输入不回显，直接回车返回上一步）；第 3 步自动测试连接并拉取模型列表，本地服务会让你从返回的模型里选一个，模板默认模型不在列表里时也会让你确认。只有测试通过后才写入 `~/.xiu/providers.json` 并设为当前渠道；测试失败显示“原因 / 下一步 / 诊断”并可重新输入、换一个渠道或稍后配置，任何一步按 Esc 退出都不会留下半成品。管道或脚本方式运行（stdin 不是终端）时不弹向导，只打印一行 `/provider add` 提示。

启动后输入：

```text
/providers
```

即可查看全部内置和自定义 Provider，通过上下键选择。Xiu 会先验证文本请求，再探测当前模型的工具调用与视觉输入能力；成功后才切换，并把选择和探测结果保存到 `~/.xiu/providers.json`。

API Key 有两种配置方式：

- 使用环境变量，配置文件只记录环境变量名。
- 输入 `/provider key`，把 Key 直接保存在本机 `~/.xiu/providers.json`。

`/provider key` 的输入会用星号隐藏。配置文件使用原子写入，在支持 Unix 文件模式的平台上限制为当前用户读写；Key 不会写入项目会话日志或显示在状态界面。不过它仍然是本机明文凭证：不要提交、同步或发送整个 `providers.json`，同一系统账号、管理员或恶意软件仍可能读取它。

v0.12.3 阶段 A 起，Provider API Key、环境变量来源与 MCP OAuth 记录通过统一凭证接口读取，诊断、故障转移、OAuth 错误和会话持久化共享同一套脱敏规则。输入 `/credentials` 或 `/credentials status` 可查看 environment、Provider、MCP OAuth 和 Windows 后端的可用状态与条目数；命令永远不会显示、复制或散列 Key、Token 和 Client Secret。

从 v0.13.0 起，Xiu 在用户目录 `~/.xiu/security-audit.jsonl` 追加本机安全审计记录。输入 `/audit` 查看最近 50 条，或使用 `/audit approvals`、`/audit credentials` 按类别筛选。记录只包含时间、事件类型、结果、风险、决策来源和非秘密配置 ID；不会保存命令正文、工具参数、Prompt、模型回复、文件内容、完整工作区路径或任何凭证。日志写入失败不会改变既有审批决定，`/audit` 会显示本进程最近的写入错误。从 0.20.13 起，桌面工作台里任务工具的审批（人工决定与自动批准）也写入同一份账本，`/audit approvals` 与执行报告的“安全事件”因此同样覆盖桌面运行。

新添加的 MCP 在第一次连接前必须确认当前权限清单，即使它没有手写 `permissions` 字段也不会自动批准。使用 `/mcp permissions` 查看待确认项，再执行 `/mcp permissions approve <名称>` 并确认；后续权限扩张仍会再次阻断。此确认只批准清单，不会跳过具体工具的风险审批、Plan 只读边界或危险操作确认。

阶段 B 加入了可选的 Windows Credential Manager 后端。普通 `/credentials` 只检查原生模块能否加载，不会写入系统凭证库；`/credentials probe` 会先要求明确确认，再写入一个名称和内容均随机的临时 Canary，完成回读校验后立即删除，用来验证当前 Windows、Node.js、架构和企业策略是否真正允许使用该后端。探测不会迁移、覆盖或删除现有 Provider/MCP 凭证。若可选原生模块没有安装或被企业策略拦截，Xiu 会报告后端不可用，但现有 Legacy File 路径和普通启动不受影响。

阶段 E 起，Xiu 会把当前运行时实际使用的 Provider Key、MCP Access/Refresh/ID Token 和 Client Secret 作为脱敏词表，仅在内存中用于清理错误文本；它们不会被写入诊断、会话、故障转移回执或 MCP Resource/Prompt 错误。系统凭证损坏、缺失或无法读取时，`cleanup` 会拒绝删除旧副本；迁移中断后可重新执行相同迁移继续，不需要手工编辑配置。

阶段 C 只为 Provider API Key 提供显式迁移。输入 `/credentials migrate` 可选择一个 Key；`/credentials migrate --all` 会批量复制，但只有所有 Key 均写入并回读一致后才切换全部引用。迁移流程永远保留旧明文，不再连带提供删除选项；请先重启并确认系统凭证可用，再单独使用 `/credentials cleanup [Provider ID]` 删除。`cleanup` 和 `forget` 都要求再次输入完整 Provider ID，且不会被 `-y` 自动确认。`/credentials rollback [Provider ID]` 可显式切回；旧明文已经清理时，它会从仍然有效的系统凭据重新生成兼容文件副本后再切换。`/credentials forget [Provider ID]` 会在影响确认后删除系统与兼容文件中的所有本地副本，环境变量不受影响。

解析顺序保持为：Profile 明确配置的环境变量、已迁移的系统引用、尚未迁移的 Legacy File、Provider 默认环境变量。系统引用一旦生效，即使旧明文仍在，系统后端缺失、记录丢失或损坏时也不会静默退回明文。可重新启用系统后端、执行显式回退，或重新保存 Key。`providers.json` 现在只为已迁移项保存非秘密引用、revision 和迁移回执；Key 本身位于 Windows Credential Manager。迁移失败会保留原引用和旧 Key，错误与回执不包含秘密或秘密哈希。

阶段 D 将 MCP OAuth 拆成“秘密”和“公开元数据”两层：Access Token、Refresh Token、ID Token 与 Client Secret 作为一个原子记录进入 Windows Credential Manager；Scope、Token 类型、到期时间和 Client 注册元数据继续保存在 `mcp-auth.json`。这样 Cloudflare 一类超长 Scope 不会占用系统凭证单条 `2400` 字节安全上限，也不会被截断。`/mcp credentials migrate [名称]` 复制并回读校验后切换引用，默认保留旧明文；重启验证后使用 `cleanup` 并输入完整 MCP 名称删除旧副本；`rollback` 即使旧副本已清理，也能从有效系统凭证恢复兼容文件。刷新轮换始终整体替换秘密记录，退出登录同时清除系统和保留的旧 Token，避免以后回退时复活已注销凭证。

当前 Windows x64 已在 Node 22 和 Node 20.20.2 下完成真实读写删除探针；Windows ARM64 与另一台企业策略机器仍需外部验收。系统后端不是默认来源，只有成功的显式迁移引用才会选择它。

### 3.1 Agnes

```powershell
$env:XIU_PROVIDER = 'agnes'
$env:AGNES_API_KEY = '你的实际 API Key'
```

需要代理时再设置：

```powershell
$env:AGNES_PROXY = 'http://127.0.0.1:12334'
```

默认文本模型是 `agnes-2.5-flash`，同时配置 Agnes 图片和视频模型。

### 3.2 OpenAI

```powershell
$env:XIU_PROVIDER = 'openai'
$env:OPENAI_API_KEY = '你的实际 API Key'
```

默认模型是 `gpt-5`。使用 OpenAI 兼容网关时，可以在启动参数中指定：

```powershell
xiu --provider openai --base-url 'http://127.0.0.1:8000/v1' --model '你的模型名'
```

### 3.3 Anthropic Claude

```powershell
$env:XIU_PROVIDER = 'anthropic'
$env:ANTHROPIC_API_KEY = '你的实际 API Key'
```

默认模型是 `claude-opus-5-5`；内置候选还包括 `claude-sonnet-5-5` 和 `claude-haiku-5-5`，刷新模型会列出该 Key 可用的全部模型。

### 3.4 Ollama、LM Studio 和 vLLM

先启动本地模型服务，再在 Xiu 中输入 `/providers`，选择对应预设：

| Provider | 默认 OpenAI-compatible 地址 |
| --- | --- |
| Ollama | `http://127.0.0.1:11434/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |
| vLLM | `http://127.0.0.1:8000/v1` |

切换时 Xiu 会读取服务的模型列表。如果预设尚未指定真实模型，会选用发现到的第一个模型；随后可输入 `/models` 选择其他模型。是否支持工具调用或视觉仍取决于具体服务启动参数和模型，Xiu 不会仅凭模型名称自动宣称支持。

### 3.5 自定义 OpenAI-compatible 服务与国内厂商模板

输入 `/provider add`，先选择渠道类型或厂商模板，再依次填写 Provider ID、显示名称、Base URL、默认模型、密钥环境变量名、可选的本地 Key、上下文窗口和视觉能力；带方括号的默认值直接回车即可采用。

常见国内服务都提供 OpenAI 兼容接口，Xiu 内置以下模板（桌面端在“新增渠道 → 厂商模板”中选择）。模板只预填地址、一个当前常用的默认模型和惯用的环境变量名，来源是各厂商 2026-10 的公开 API 文档；每个字段都可以修改，Xiu 不内置任何 Key，也不会在你保存之前注册渠道。模型名以厂商控制台为准，保存后用 `/models` 刷新即可看到该 Key 可用的全部模型。

| 模板 | Base URL | 默认模型 | Key 环境变量 |
| --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| 通义千问（阿里云百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-coder-plus` | `DASHSCOPE_API_KEY` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6` | `ZHIPUAI_API_KEY` |
| Kimi（Moonshot） | `https://api.moonshot.cn/v1` | `kimi-k2-turbo-preview` | `MOONSHOT_API_KEY` |
| 火山方舟（豆包） | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-1-6-250615` | `ARK_API_KEY` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3.1` | `SILICONFLOW_API_KEY` |
| MiniMax | `https://api.minimaxi.com/v1` | `MiniMax-M2` | `MINIMAX_API_KEY` |

模板默认只声明文本与工具调用；是否真正支持工具和视觉仍由切换时的能力探测决定，火山方舟等要求使用接入点 ID 的服务请把默认模型改成控制台里的接入点。

示例环境变量：

```powershell
$env:OFFICE_MODEL_KEY = '你的实际 API Key'
```

如果选择环境变量方式，只填写 `OFFICE_MODEL_KEY` 这个名字；如果更重视配置方便，可以在隐藏输入提示中直接填写 Key。两者同时存在时，环境变量优先。其他命令：

```text
/provider test
/provider capabilities
/provider key
/provider edit
/provider remove
/models
```

`/provider edit` 用于修改已经保存的自定义 Provider。选择后会依次显示名称、Base URL、默认模型、密钥环境变量名、上下文窗口和视觉能力；直接回车保留当前值，环境变量名或上下文窗口输入 `-` 可清空。现有本地 Key 会保留，需要更换时使用 `/provider key`。

连接测试会尝试 OpenAI-compatible 模型列表接口，并且无论列表是否可用，都会发送一次最小聊天请求验证当前模型确实能够回复。如果服务没有实现模型列表接口，Xiu 会明确提示“模型列表接口不可用”，不会把它误判成 Provider 整体不可用。

v0.10.1 起，Provider 切换和模型切换还会分别探测工具与视觉能力：工具探测只要求模型调用一个不会执行任何操作的虚拟工具；先尝试强制指定该工具，若推理模型或兼容网关不支持强制选择，则自动改用 `tool_choice: auto`。只有 API 返回结构化 `tool_calls` 才算支持，模型输出的 `<tool_call>` 等普通文本不会被执行。视觉探测发送 Xiu 内置的纯色色块 PNG，并要求模型准确识别实际颜色；只有答案与像素内容一致才算支持，因此静默忽略图片的端点不会误报。它不会读取或上传项目文件。结果按“Provider ID + 模型 ID”缓存七天，同一供应商的不同模型互不混用；探测协议升级后旧缓存自动失效。网络错误或超时记为“未知”，不会误报为支持，也不会把对应能力暴露给模型。输入 `/provider test` 或 `/provider capabilities` 可强制刷新当前模型的探测结果。探测会产生少量模型 Token；图片和视频生成不会自动探测，以免产生付费资产。

`/providers`、`/models` 和 `/status` 会显示同一份能力状态。v0.11.3 起能力缓存带协议版本和 Provider 配置指纹；修改自定义 Provider 的地址、默认模型、代理、能力声明或 API Key 后，旧探测缓存会自动失效。0.20.1 使用版本 4 的 `providers.json`，兼容读取并迁移版本 1–3；缺少可信指纹的旧探测结果会按需重新探测。

“不支持工具”表示模型只能进行文本对话，不能让 Xiu 可靠地读取或修改文件、搜索代码、运行命令、调用 MCP、执行测试和完成验证，因此不适合作为完整编码 Agent。“不支持视觉”表示不能理解粘贴的截图或项目图片，但文本编程、文件操作和命令不受影响。图片生成和视频生成是另外两项能力，不等同于视觉输入。当前 Xiu 通过工具调用执行图片分析，所以若模型视觉探测成功但工具探测失败，有效运行能力仍会按“仅文本”处理。

上下文窗口不是 OpenAI-compatible `/models` 标准接口的必填字段，因此无法对所有供应商百分百自动识别。若服务返回 `context_window`、`context_length`、`max_model_len`、`max_context_length` 或 `input_token_limit`，Xiu 会自动读取并按模型缓存；否则使用 Provider 中手动填写的值。优先级为：启动参数 `--context-window`、Provider 手动配置、API 返回值、Xiu 已知的官方值、保守默认值。比如 1M 上下文应填写整数 `1000000`，自动压缩点默认是窗口的 80%，即 `800000`。

启动欢迎卡片属于当次启动的历史输出，切换 Provider 后不会回头改写终端滚动记录。v0.10.2 起该区域明确标为“启动时配置 · 实时状态见底栏”；输入框下方的实时状态栏会显示 `Provider ID/模型 ID` 并在切换后立即更新。切换成功回执和 `/status` 显示的也是当前模型实际使用的上下文窗口与压缩点。

### 3.1 配置 Provider 故障转移（v0.11）

Xiu 可以为当前主 Provider 保存一条有顺序的备用链：

```text
/provider fallback
/provider fallback add
/provider fallback remove
/provider fallback clear
```

`/provider fallback add` 每次把一个 Provider 追加到队尾；重复执行即可形成第一、第二等备用顺位。配置保存在本机 `~/.xiu/providers.json`，不同主 Provider 拥有各自的备用链。空链等同于关闭自动故障转移。

只有连接超时、连接重置、临时 DNS/网络错误、HTTP 408/425/429 和 5xx 等瞬时故障才会触发。认证失败、请求格式错误、模型不存在、用户取消等确定性错误不会通过换 Provider 掩盖。当前 Provider 会先进行最多三次有退避的本地重试，仍失败才按顺序检查备用链。

候选 Provider 必须满足当前请求的工具能力和安全上下文预算；已经在本任务中失败过、能力不足或上下文过小的候选会被跳过并显示原因。工具/视觉判断复用 v0.10.1 的按模型能力探测缓存，未探测时使用 Provider 声明；建议先手动切换并执行 `/provider capabilities`，再把重要模型加入生产备用链。

安全边界是硬约束：只有本轮模型尚未输出任何流式文字时才允许切换。文件修改、命令和其他工具调用完成后不会因为故障转移被自动重放；如果模型已经输出了部分回答，Xiu 会直接报告失败，让用户决定如何继续。切换回执会永久显示在终端，并写入会话日志与 `/diagnostics`。

自动故障转移只改变当前 Xiu 进程和任务后续使用的实时 Provider，不会覆盖你在 `/providers` 中保存的下次启动默认项。重新启动后仍从手动选择的主 Provider 开始。v0.11.0 的自动故障转移覆盖主 Agent 的文本/工具模型请求、上下文压缩请求和并行子 Agent。压缩始终禁用工具与流式输出；每个子 Agent 独立记录本次任务已尝试的 Provider，并继续遵守自己的 Worktree、角色工具白名单和审批策略。图片和视频生成暂不自动跨 Provider 重放，以避免重复计费或生成重复资产。

### 3.2 配置任务阶段模型路由（v0.11.2）

如果你希望规划、写代码和验证分别使用不同模型，可以把已经配置好的 Provider Profile 绑定到三个阶段：

```text
/routing
/routing set planning
/routing set implementation
/routing set verification
/routing on
```

`/routing set ...` 会打开 Provider 选择菜单。每个阶段使用该 Provider 最近选择的模型。`/routing` 显示总开关和三个阶段的当前绑定；`/routing off` 可立即停用；`/routing clear planning`、`/routing clear implementation` 或 `/routing clear verification` 可清除单个绑定。未绑定的阶段使用本次任务开始时用户手动选择的 Provider/模型。

Xiu 只在新一轮模型请求开始前切换。目标模型必须支持当前请求需要的工具能力，并能容纳当前上下文；不满足时不会冒险切换，而是保留当前模型并显示跳过原因。成功切换和跳过都会写入终端、会话日志与 `/diagnostics`。任务结束后会恢复手动选择，不改变下次启动默认值。

规划阶段包括任务第一轮和只读 Plan 模式；验证阶段包括正式计划中的验证、测试、检查、构建步骤，以及完成门禁要求补充验证后的请求；其余请求属于实现阶段。阶段由程序规则判断，不依赖模型自己的描述。

`/diagnostics` 会列出规划、实现、验证各自的模型调用次数和最近阶段变化。即使目标阶段使用的正好是当前模型、没有产生 Provider 切换，也会记录“首轮分析”“当前计划步骤属于验证”或“完成门禁要求验证”等判定依据。验证失败后回到实现再进入验证属于有原因的返工，不会只显示成无法解释的反复切换。

v0.11.2 只路由主 Agent 的文本/工具模型。并行子 Agent 继续沿用自己的安全工具集合和 v0.11 故障转移；图片和视频生成继续使用固定 Provider 与媒体恢复机制，不会因为阶段路由而跨供应商重放或重复计费。

### 3.3 Prompt Cache 与安全请求合并（v0.11.3）

Xiu 不会把 Agent 的最终回答保存在本地结果缓存中，也不会重放缓存中的工具调用。文件修改、命令、审批、流式回答和图片/视频生成每次仍遵守原有安全与幂等边界。

对于 Provider 自己提供的 Prompt Cache，Xiu 会尽量复用稳定前缀：原生 OpenAI 请求使用由“模型 + 系统提示”计算出的哈希缓存键，不包含提示原文；Anthropic 把稳定系统提示标记为 `ephemeral` 缓存边界；其他 OpenAI-compatible 服务由服务端自行决定是否支持缓存。只有 Provider usage 明确返回 cached token 时，Xiu 才会在 `/diagnostics` 中显示命中、读取 Token 和写入 Token，不会根据两次请求相似就猜测命中。

模型列表会在当前 Xiu 进程中缓存 60 秒，最多保存 100 个配置；完全相同的并发模型发现与能力探测只执行一次底层请求。失败请求不会被完成缓存压住，可以正常重试。缓存按 Provider、模型、端点、代理、鉴权配置和能力声明隔离，不跨用户配置或 Provider 复用。

命令行 `--provider` 和 `XIU_PROVIDER` 的值现在是 Profile ID。通过 `/providers` 和 `/models` 选中的 Provider 与模型会保存在 `~/.xiu/providers.json`，下次启动继续使用。优先级为：本次显式命令行参数、上次交互选择、环境变量、内置默认值。环境变量因此适合作为首次启动默认值；若要临时覆盖已保存选择，请使用 `xiu --provider <Profile-ID> --model <模型-ID>`。

### 3.6 环境变量何时失效

使用 `$env:名称 = '值'` 设置的变量只在当前 PowerShell 窗口有效。关闭窗口后需要重新设置。

不要把 API Key 写入项目代码、Git、README、截图或聊天记录。不要把真实 Key 发给其他用户，每个人应使用自己的账号和 Key。

## 模型选择

查看当前服务可用模型并用方向键选择：

```text
/models
```

切换结果会保存在当前会话中。`/model` 只会提示使用 `/models`，不再用于直接指定模型。

启动时指定模型：

```powershell
xiu --provider agnes --model 'agnes-2.5-flash'
```

为不同能力指定模型：

```powershell
xiu --provider agnes `
  --model 'agnes-2.5-flash' `
  --vision-model 'agnes-2.5-flash' `
  --image-model 'agnes-image-2.1-flash' `
  --video-model 'agnes-video-v2.0'
```

如果一个供应商模型确实支持全部能力，可以使用：

```powershell
xiu --unified-model '模型名'
```

统一模型选项不会让原本不支持图片或视频 API 的供应商凭空获得生成能力。
