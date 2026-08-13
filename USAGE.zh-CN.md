# Xiu 完整使用指南

Xiu 是由“静然”开发、运行在终端中的开源 AI 编码 Agent。你可以用自然语言告诉它要完成什么，它会检查项目、阅读代码、修改文件、执行命令、运行测试并汇报结果。

本手册面向第一次使用终端编码工具的用户。发布和升级 npm 包的流程请参阅 [Xiu 更新、发布与安装指南](./PUBLISHING.zh-CN.md)。

## 一、Xiu 可以做什么

常见用途包括：

- 阅读项目并解释目录结构。
- 查找 Bug 原因并修改代码。
- 根据需求增加一个功能。
- 创建文件、替换代码和应用结构化补丁。
- 自动识别项目技术栈、测试和构建命令。
- 运行测试、类型检查、Lint 和构建。
- 查看 Git 状态、日志和差异。
- 保留会话，关闭终端后继续任务。
- 在只读 Plan 模式中先调查和制定方案。
- 分析图片，或使用支持的模型生成图片和视频。
- 安装 Skills，为特定工作流增加指导。
- 接入 MCP Server，扩展外部工具。
- 把复杂目标拆给多个 Explorer、Implementer、Reviewer 和 Tester Agent 并行处理。

Xiu 不是完全隔离的云端沙箱。它使用当前操作系统账号访问文件和运行命令，因此必须认真阅读权限提示，只在可信项目中使用。

从 `0.13.6` 起，交互启动和一次性命令都会先执行同一套工作区信任确认；`-y` 只影响任务内的普通自动审批，不能代替工作区信任。确认前，Xiu 不读取 `AGENTS.md`、`XIU.md` 等项目指令，不加载项目 Skills 或项目 MCP，也不会修改或执行工作区内容。文件工具按真实文件系统路径校验边界，拒绝通过符号链接、Junction、重解析点、绝对 Glob 或 `..` Glob 访问工作区之外。

## 二、安装与检查

Xiu 要求 Node.js 20 或更高版本。先检查：

```powershell
node --version
npm.cmd --version
```

从 npm 官方源全局安装：

```powershell
npm.cmd install --global '@xiu-ai/cli' --registry='https://registry.npmjs.org/'
```

检查安装结果：

```powershell
xiu --version
Get-Command xiu
```

如果 `xiu` 无法识别，请关闭并重新打开 PowerShell，再试一次。

## 三、配置 Provider 与模型

Xiu v0.10 支持 Agnes、OpenAI、Anthropic、Ollama、LM Studio、vLLM 和自定义 OpenAI-compatible 服务。云端服务需要各自的 API Key；本地服务不要求云端 Key。

从 v0.13.7 起，新安装如果尚未配置当前 Provider 的 API Key，Xiu 不会报错退出，而会保持在交互式配置模式。终端会提供“配置当前 Provider Key”“选择其他 Provider”“稍后配置”三种选择；即使选择稍后配置，也可以正常进入 `xiu>`，再使用 `/provider key` 或 `/providers` 完成设置。带任务参数的一次性命令无法交互配置，因此会给出明确提示并安全退出；请先单独运行一次 `xiu` 完成配置。

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

从 v0.13.0 起，Xiu 在用户目录 `~/.xiu/security-audit.jsonl` 追加本机安全审计记录。输入 `/audit` 查看最近 50 条，或使用 `/audit approvals`、`/audit credentials` 按类别筛选。记录只包含时间、事件类型、结果、风险、决策来源和非秘密配置 ID；不会保存命令正文、工具参数、Prompt、模型回复、文件内容、完整工作区路径或任何凭证。日志写入失败不会改变既有审批决定，`/audit` 会显示本进程最近的写入错误。

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

默认模型是 `claude-sonnet-4-20250514`。

### 3.4 Ollama、LM Studio 和 vLLM

先启动本地模型服务，再在 Xiu 中输入 `/providers`，选择对应预设：

| Provider | 默认 OpenAI-compatible 地址 |
| --- | --- |
| Ollama | `http://127.0.0.1:11434/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |
| vLLM | `http://127.0.0.1:8000/v1` |

切换时 Xiu 会读取服务的模型列表。如果预设尚未指定真实模型，会选用发现到的第一个模型；随后可输入 `/models` 选择其他模型。是否支持工具调用或视觉仍取决于具体服务启动参数和模型，Xiu 不会仅凭模型名称自动宣称支持。

### 3.5 自定义 OpenAI-compatible 服务

输入 `/provider add`，依次填写 Provider ID、显示名称、Base URL、默认模型、密钥环境变量名、可选的本地 Key、上下文窗口和视觉能力。示例环境变量：

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

`/providers`、`/models` 和 `/status` 会显示同一份能力状态。v0.11.3 起能力缓存带协议版本和 Provider 配置指纹；修改自定义 Provider 的地址、默认模型、代理、能力声明或 API Key 后，旧探测缓存会自动失效。旧版 `providers.json` 会自动迁移为版本 2，缺少可信指纹的旧探测结果会按需重新探测。

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

## 四、从正确目录启动

先进入需要处理的项目：

```powershell
Set-Location -LiteralPath 'D:\QoderWork Project\my_project'
xiu
```

目录中有空格时，路径必须用单引号包住。不要直接在 `C:\Windows\System32` 中启动 Xiu。

也可以不切换目录，直接指定工作区：

```powershell
xiu --cwd 'D:\QoderWork Project\my_project'
```

## 五、第一次启动与工作区信任

首次进入一个工作区时，Xiu 会询问：

```text
Do you trust the files in this workspace?
1. Trust this workspace
2. Exit
Select [1]:
```

直接按 Enter 等同于选择 `1`。只有在以下情况才应该信任：

- 项目是你自己创建的。
- 来源可信，并且你已经检查过项目内容。
- 你理解项目可能包含 `AGENTS.md`、`XIU.md`、Skills 或 MCP 配置。

不可信项目可能通过本地指令或 MCP 配置影响 Agent 行为。无法确认时选择 `2` 退出。

信任记录保存在用户目录的 `~/.xiu/trusted-workspaces.json`，不写入项目仓库。

## 六、认识交互界面

启动后会看到：

- 左侧 Xiu Logo、版本号和工作区。
- 右侧“快速开始”、模型、授权方式和 Skills 数量。
- `xiu> ` 输入行。
- 输入行下方的模型、上下文占用、Plan 模式、Skills、MCP 和工作区状态栏。

在 `xiu> ` 后输入自然语言，然后按 Enter：

```text
xiu> 读取当前项目，概括架构并检查明显问题
```

输入 `/` 会弹出命令菜单。继续输入字符会自动筛选；使用上、下方向键移动，Tab 补全，Enter 选择，Esc 取消。

v0.7 输入编辑快捷键：

| 按键 | 作用 |
| --- | --- |
| `Ctrl+J` | 插入换行；Enter 仍用于提交 |
| 左/右方向键 | 按中文、英文或 Emoji 字符移动光标 |
| `Ctrl+左/右` | 按单词移动 |
| `Home` / `End` | 跳到当前行首/行尾 |
| `Backspace` / `Delete` | 删除光标前/后的字符 |
| `@路径片段` + `Tab` | 补全项目索引中的文件路径 |
| `Ctrl+R` | 搜索本次启动后的输入历史 |
| `Ctrl+O` | 任务运行时展开或收起实时进展 |
| `Esc` | 关闭候选或历史搜索，不清空草稿 |

尚未提交的输入会保存在项目的 `.xiu/draft.json`。终端意外关闭后重新启动 Xiu，会恢复这份草稿；正常提交后草稿自动清空。终端窗口改变大小时，输入行、候选和状态栏会重新排版。

### 6.1 设置界面与会话语言

输入 `/language` 后使用方向键选择“简体中文”或“English”。选择会保存到用户目录 `~/.xiu/settings.json`，以后在其他项目启动 Xiu 也会继续使用。也可以直接输入：

```text
/language zh-CN
/language en-US
```

选择完成后无需重启 Xiu：当前终端页面会立即按新语言重绘，命令菜单、状态栏、计划、运行中进度和后续模型回复同步切换。已经写入滚动历史的旧输出保持原文，不会被修改或伪造翻译。任务运行期间也可以在 `补充> ` 输入 `/language` 切换。

只想覆盖本次启动时可以使用：

```powershell
xiu --language zh-CN
$env:XIU_LANGUAGE = 'zh-CN'
```

优先级为：命令行 `--language`、环境变量 `XIU_LANGUAGE`、`~/.xiu/settings.json`、系统区域语言。中文模式会统一使用简体中文显示启动页、菜单、审批、状态、计划、进展、关键操作和完成摘要，并要求模型使用中文给出用户可见的分析摘要、阶段说明与最终回答。代码、命令、路径、工具名、模型名和外部原始输出保持原文。

从 v0.8.6 开始，内置工具活动说明、重试、恢复点和多 Agent 状态也会确定性本地化；中文任务计划拒绝纯英文自然语言标题。v0.9.9 进一步在模型回复显示前确定性转换自然语言中的繁体字，任务计划也会转为简体；围栏代码块和行内代码保持原文。代码路径、命令、模型名与第三方命令原始输出仍保持原文。明确询问“你是谁”或“谁开发了 Xiu”时由程序级身份守卫回答，底层模型不能再把 Xiu 说成 Agnes 或归属于 Sapiens AI；Xiu 由静然开发。

Xiu 不显示模型私有思维链。“思考使用中文”指所有用户能够看到的计划、依据、推理摘要、说明和结论均使用中文。

### 6.2 任务运行时继续输入

Agent 工作时输入框不会消失，而是使用临时的补充提示：

```text
补充>
```

从 v0.7.2 开始，此时输入普通文字表示“补充当前任务”。Xiu 会在下一次模型调用前把它作为 steering 注入当前目标。例如当前正在生成在线表格时输入“同时生成 JSONL”，不会再被理解成一个独立的工具开发任务。

从 v0.7.3 开始，最初提交的任务会被固定为不可覆盖的主目标，运行中的普通输入只能增加要求，不能替换主目标。模型准备结束时，Xiu 还会执行一次任务契约审计；如果模型只回答了最新补充、尚未完成原始任务，它会被要求继续工作。

从 v0.7.4 开始，循环保护只判断近期连续、没有新进展的调用序列。长任务中经过其他调查后重新读取规则或源文件是允许的；上下文压缩和成功修改文件后，旧的循环证据会被清空。真正的连续重复调用和短周期调用循环仍会被阻断。

运行期输入框下方默认常驻紧凑任务进度，包括当前轮次、阶段、耗时、待注入补充、显式队列、步骤完成情况、“当前”动作、“下一步”以及最近成功的文件写入或修改。临时 `补充> ` 输入框完成后会被清除，不再作为 `xiu[working]>` 残留到永久滚动历史。空白 Enter 会留在当前临时编辑器中，不会提交 steering，也不会因键盘重复信号不断生成新的 `补充>`。

任务完成并切回普通 `xiu> ` 输入框后，键入内容会立即回显。Xiu 不会在两个输入框切换时暂停 PowerShell 的共享输入流，因此无需先盲输一行并按 Enter 才能恢复显示。

如果模型缺少一个关键决定而无法继续，终端会显示黄色高亮的“Xiu 需要你的回答”、单独的问题正文和“等待你的回答”状态，下一行提示会变为 `请回答> `。直接输入答案后，Xiu 会沿用当前会话上下文继续处理。该状态不会再显示成绿色“已完成”。

如果模型使用 `update_task_plan` 创建了正式计划，这里显示真实步骤，并用绿色 `√`、青色 `→`、灰色 `○`、红色 `!` 分别表示完成、进行中、等待和阻塞。如果模型尚未创建计划，Xiu 会显示“理解任务、检查文件、实施修改、验证结果、复核完成”五个自动阶段，因此不会再只剩下一行 `Thinking`。

从 v0.8.2 开始，模型在重要阶段切换时会给出一句简短进展说明，中文界面显示为“进展：”。它应说明刚确认了什么、当前正在做什么以及下一步是什么，不会逐条复述每个普通工具调用。

从 v0.8.5 开始，“文件变化”卡片在中文模式中完整本地化。创建文件只显示类型、大小和增删统计，不再打印 HTML 等模板开头；修改文件最多显示 4 行关键增删内容和 `@@` 位置；超过 1 MB 的文本及二进制文件只显示修改前后的字节规模。完整差异仍通过 `/diff` 查看。

“进展”回答“当前阶段在做什么”，“文件变化”回答“工作区实际改了什么”，“关键操作”永久保留重要执行和验证结果，`Ctrl+O` 则回答“具体调用过哪些工具”。v0.9.9 会按终端宽度换行较长的状态内容，而不是从右侧截断；显式计划最多直接展示 12 步，详情模式展示最近 16 条活动并说明较早活动的省略数量。完整工具日志不会在任务结束时倾倒。

### 6.3 粘贴图片和文件

在 Windows 交互模式中按 `Ctrl+V`：

- 剪贴板是截图或位图时，Xiu 保存为 `.xiu/attachments/时间-clipboard.png`，并在光标处插入 `@.xiu/attachments/...`。
- 从资源管理器复制一个或多个文件时，外部文件会复制到 `.xiu/attachments/`；已经位于当前工作区内的文件直接引用，不重复复制。
- 剪贴板是普通文字时，保持普通文字粘贴，不创建附件。
- 如果 Windows Terminal 或其他终端拦截了快捷键，输入 `/paste` 可执行同样的操作，并把结果放入下一次输入草稿。

v0.9.1 起，在支持 SGR 鼠标上报的 Windows 终端中，Xiu 会在交互输入框存活期间临时接收右键事件。右键会主动读取剪贴板，因此普通文字、剪贴板图片和资源管理器复制的文件都会在当前光标处粘贴或插入附件引用。输入框提交、取消或切换后，Xiu 会立即关闭鼠标上报并恢复终端模式。输入期间如需选择终端文字，请使用 `Shift+拖动`。

v0.9.2 修复 Node.js 将鼠标报告拆成多个按键事件的问题；类似 `2;51;21M` 的坐标尾部不会再出现在输入框中。建议至少升级到 v0.9.2 后再使用右键附件粘贴。

部分旧版控制台、自定义终端右键菜单或会提前拦截右键的宿主无法把事件交给 Xiu；这类环境继续使用 `Ctrl+V` 或 `/paste`，功能完全相同。

v0.9.3 起，普通文字和资源管理器复制文件优先通过 Windows 自带的 PowerShell `Get-Clipboard` 读取，并用一次性 UTF-8 JSON 交给 Xiu，不再编译或运行 `clipboard helper`。这适用于禁止运行用户目录自生成 EXE 的企业环境。如果 `Get-Clipboard` 也被策略禁止，Xiu 不会接管鼠标右键，终端原生文字右键粘贴仍然可用。

v0.9.4 起，Xiu 在任何情况下都不再接管鼠标右键。右键粘贴完全由 Windows Terminal、PowerShell 或其他终端宿主处理，因此企业策略禁止程序读取剪贴板时，也不会破坏终端原有的文字或文件路径粘贴。`Ctrl+V` 与 `/paste` 仍用于增强附件读取；若系统拒绝访问，只显示简短说明，不再输出 PowerShell CLIXML，也不会因文字或文件读取失败而启动 helper。

附件单次最多 10 个，单文件最多 25 MB，总计最多 50 MB；目录和符号链接不会递归导入。图片由 `analyze_image` 和配置的视觉模型分析，文本/代码由文件工具读取。粘贴可执行文件只代表附加一个文件，Xiu 不会因为它被粘贴就自动执行。截图和资源管理器文件剪贴板导入目前以 Windows 为重点实现；其他平台仍可使用普通文字粘贴或把文件放进项目后通过 `@path` 引用。

剪贴板纯位图无法通过终端字符流或 `Get-Clipboard` 直接保存为 PNG，因此 Xiu 只在检测到位图时尝试可选的 `.NET clipboard helper`。如果集团策略禁止该 helper，请先把截图保存为图片文件，再复制该文件、拖入路径或使用 `@path` 引用。Xiu 不会绕过组织安全策略。

按 `Ctrl+O` 可以在默认步骤摘要和最近 16 条详细工具活动之间切换，再按一次恢复摘要，不会提交或清空草稿。使用 `/details` 可查看完整活动记录。

只有明确输入 `/queue <任务>` 才会安排当前任务结束后运行的独立任务。

运行期间可立即使用：

| 操作 | 作用 |
| --- | --- |
| 普通文本 + Enter | 补充当前任务，在下一模型轮次注入 |
| `Ctrl+O` | 在默认步骤摘要和详细工具活动之间切换 |
| `Ctrl+V` | 粘贴普通文字，或导入 Windows 剪贴板图片/文件 |
| 鼠标右键 | 使用终端宿主的原生粘贴；可粘贴的内容取决于 Windows Terminal、PowerShell 或当前终端配置 |
| `/details` | 运行期间切换步骤摘要/详细活动 |
| `/diagnostics` | 查看当前或最近任务的 Token、耗时、失败与停滞诊断 |
| `/queue <任务>` | 明确安排一项独立后续任务 |
| `/queue` | 查看明确安排的任务 |
| `/clear-queue` | 清空尚未开始的独立任务 |
| `/cancel` 或 `Ctrl+C` | 取消当前任务并打开后续处理选择 |
| `/status` | 查看 Turn、结果状态、阶段和调用统计 |
| `/paste` | 从剪贴板导入文字、截图或复制的文件 |
| `/exit` | 取消当前任务、清空队列并退出 |

需要写入、执行或危险操作审批时，Xiu 会先挂起运行期输入框，再显示审批菜单。审批默认仍是“拒绝”；审批结束后，未提交的草稿会恢复。

如果当前任务失败、取消、陷入重复工具循环，或修改文件后没有验证通过，Xiu 不会自动执行独立队列，而会让用户选择停止、基于已有证据重试或跳过当前任务。默认选项是停止。

从 v0.8.1 开始，除标准的 test、typecheck、lint 和 build 命令外，Xiu 也会识别项目自定义的验证脚本，例如 `verify_output.py`、`check-result.js`、`output_validate.py`。命令必须返回 `Exit code: 0`，且输出中不能包含“验证失败”、`Verification: false` 或非零失败计数等明确反证；脚本名包含验证含义但实际失败时，任务仍会标记为未验证。

v0.8.2 新增只读工具 `verify_output`，专门验收没有项目测试套件的 HTML、JSON、Markdown、CSV 等文本交付物。它会检查文件是否包含必需内容、不包含禁止内容，并可检查 UTF-8 字节数上下限；任一条件不满足就确定性返回失败。`Select-String` 数量、`Measure-Object` 结果或打印出来的 `True` 只能用于诊断，因为条件不满足时它们仍可能以退出码 0 结束，不能单独作为完成证据。

v0.8.2 也识别包含“验证”或“校验”的多行 `python -c` 等内联检查，但仍应用上述反证检测。任务结束时，运行期间隐藏的工具日志不会再全部打印到终端；默认只显示模型最终回答和 `Done/Stopped` 摘要。完整工具证据仍保存在活动详情和会话日志中。

显式队列只保存在当前 Xiu 进程中。强制关闭终端后，已经开始的会话可以恢复，未提交草稿也会恢复，但尚未开始的显式队列不会自动恢复。

## 七、怎样描述任务效果更好

一个好的任务通常包含四部分：目标、范围、限制和验收方式。

较模糊：

```text
修一下登录
```

更清楚：

```text
调查用户登录后偶尔返回 500 的原因，只修改认证模块；修复后运行相关测试和类型检查，并说明根因与改动文件。
```

推荐写法：

```text
目标：为订单列表增加按状态筛选。
范围：只修改前端订单页面和对应 API 调用。
限制：保持现有 UI 风格，不新增大型依赖。
验收：运行测试和构建，列出改动文件。
```

如果只想让它分析，不想修改文件，可以明确说“只调查并给方案，不要改代码”，或使用 `/plan on`。

## 八、常用任务示例

### 8.1 理解项目

```text
读取项目，说明技术栈、主要目录、启动方式、测试方式和核心数据流，不要修改文件。
```

### 8.2 修复 Bug

```text
定位保存用户资料时中文昵称失败的原因，补充回归测试并修复，最后运行相关测试。
```

### 8.3 新增功能

```text
为设置页面增加深色模式开关，沿用现有组件和状态管理方式，完成后运行测试和构建。
```

### 8.4 代码审查

```text
检查当前未提交改动，重点关注逻辑错误、安全问题和缺失测试；先报告问题，不要直接修改。
```

### 8.5 重构

```text
把重复的请求重试逻辑提取为公共模块，保持外部行为不变，并运行完整测试。
```

### 8.6 一次性命令

不进入交互模式，完成一个任务后退出：

```powershell
xiu '检查项目架构并列出最重要的三个问题'
```

### 8.7 Windows 复杂命令与参数

v0.9.0 起，Xiu 会优先使用参数化进程工具运行 Node、Python、Git、npm、测试器和项目脚本。程序名与参数数组分开传给操作系统，不再把整段内容拼成 PowerShell 字符串。因此路径空格、单双引号、`$`、`;`、`&`、`|`、JSON、正则表达式和中文不会被 PowerShell 再次解释。

`run_command` 仍然保留，但只用于 PowerShell cmdlet、变量、管道、重定向和命令组合。如果复杂 `python -c`、`node -e` 或 PowerShell 解析失败，工具结果会提示改用 `run_process`。Xiu 不会自动改写失败命令，避免静默改变原始语义。

参数化进程工具仍遵循风险审批、工作区限制、超时、取消、UTF-8 和验证门禁。它不接受 `powershell`、`pwsh`、`cmd`、`bash`、`sh` 或 `wsl` 作为包装器；确实需要 Shell 语法时必须使用受审批的 `run_command`。

在 Windows 上运行 package.json 的标准验证脚本时优先使用 `validate_project`。其他 npm 命令使用 `run_process`，例如 `program: npm, args: [test]` 或 `program: npm, args: [run, build]`；不要加入 `cmd`、`/c`、`/p` 或第二个程序名。v0.11.2 会通过 Node 附带的 npm/npx CLI 脚本启动，避免某些 Windows 环境直接执行 `.cmd` 时返回 `EINVAL`。

## 九、权限与审批

Xiu 将工具分成四类：

| 风险 | 示例 | 默认行为 |
| --- | --- | --- |
| read | 读取文件、搜索、Git 状态 | 自动执行 |
| write | 写文件、替换代码 | 请求确认 |
| execute | 运行命令、调用外部服务 | 请求确认 |
| dangerous | 删除、硬重置等高风险操作 | 始终请求确认 |

看到审批提示时：

- 输入 `y` 或 `yes` 并按 Enter：允许本次操作。
- 直接按 Enter：拒绝。
- 不理解命令的作用：先拒绝，再要求 Xiu 解释。

自动批准普通写入和执行：

```powershell
xiu --yes
```

`--yes` 不会自动批准 dangerous 操作。刚开始使用时不建议开启自动批准。

普通文件写入、精确编辑、某个直接执行程序以及项目验证支持“本次会话始终允许”的窄范围授权；它只在当前 Xiu 进程有效，重启后失效。危险操作不会使用会话授权。`/diagnostics` 中的“实际提示”才表示用户真正看到过审批菜单；自动放行、会话规则放行和内部策略检查分别统计。

## 十、Plan 模式和任务计划

开启只读 Plan 模式：

```text
/plan on
```

此时 Xiu 可以阅读和分析，但 Agent 边界会阻止写入、执行和危险工具。适合：

- 第一次接触大型项目。
- 修改前先评估影响。
- 只需要设计方案。
- 审查第三方项目。

查看当前计划：

```text
/plan
```

或：

```text
/tasks
```

关闭 Plan 模式后再执行修改：

```text
/plan off
```

### 10.1 多 Agent 并行任务

遇到可以独立推进的调查、实现、审查或测试工作时，Xiu 的主 Agent 会按需要建立任务依赖图。不要为了一个简单问题强行使用多个 Agent；并行最适合三个以上互不依赖的代码区域、需要独立审查，或调查和实现可以明确分工的任务。

四种角色的默认行为：

| 角色 | 默认隔离 | 用途 |
| --- | --- | --- |
| Explorer | 共享工作区，只读 | 定位文件、理解架构、收集证据 |
| Reviewer | 目标实现 Worktree，只读 | 检查正确性、安全、回归和测试缺口；最终输出 `VERDICT: PASS/FAIL` |
| Tester | 目标实现 Worktree，只读 | 运行或分析验证并报告证据；最终输出 `VERDICT: PASS/FAIL` |
| Implementer | 独立 Git Worktree | 修改代码并运行相关验证 |

查看全部多 Agent 运行：

```text
/agents
```

查看一个运行的角色、状态、耗时、Token、错误和结果：

```text
/agents <运行ID>
```

只取消一个任务，不影响其他 Agent：

```text
/agents cancel <运行ID> <任务ID>
```

重试失败、取消、阻塞或终端关闭时中断的任务：

```text
/agents retry <运行ID> <任务ID>
```

Implementer 的改动不会自动进入主工作区。审查 Diff 并确认集成：

```text
/agents integrate <运行ID> <任务ID>
```

集成前 Xiu 会确认目标 Implementer 已完成，并寻找依赖于该实现的 Reviewer 与 Tester。两者必须在目标 Worktree 上以只读方式检查，并把 `VERDICT: PASS` 作为最终一行；缺失、失败或模糊证据都会阻止合并。

随后 Xiu 会显示有界补丁预览、主工作区未提交文件、审查/测试证据和阻断项，并检查双方是否同时修改同一文件、符号或依赖清单，再运行 Git 补丁预检。只有全部通过后才询问是否合并；实际应用前会再次分析。冲突时主工作区不会发生部分修改，完整补丁、运行记录和 `.xiu/worktrees/` 中的 Worktree 都会保留用于人工处理。Xiu 不自动删除 Worktree 或分支。集成成功后仍要在主工作区运行测试并人工审查。

默认最多同时运行 3 个 Agent，可在启动时设置 1 到 8：

```powershell
xiu --agent-concurrency 4
```

也可使用环境变量 `XIU_AGENT_CONCURRENCY`。所有子 Agent 继承主 Agent 的审批策略；只读 Agent 无法看到写入、执行、dangerous 或动态风险工具，`--yes` 仍不会自动批准 dangerous 操作。

## 十一、会话、历史和上下文

Xiu 会把会话保存在当前项目的 `.xiu/sessions/` 中，不同项目互相隔离。

查看当前对话历史：

```text
/history
```

查看项目中的历史会话：

```text
/history sessions
```

在当前 Xiu 中选择并恢复会话：

```text
/resume
```

`/resume` 用于恢复正常保存的对话会话。`v0.13.1` 起，Xiu 还会在用户目录 `~/.xiu/task-runs/<工作区摘要>/` 保存版本化任务运行记录。若终端或进程在任务中异常终止，下次进入同一工作区时会显示任务摘要、最后安全恢复点和待核验副作用，并要求明确选择“确认恢复”“放弃旧任务”或“退出”。Xiu 不会自动继续，也不会自动重放已成功或状态未知的写文件、命令、远端写入等副作用。

在已经启动的交互会话中重新检查异常中断任务：

```text
/recover
```

确认恢复后会载入关联会话并建立新的 `runId`。恢复提示要求先核验工作区、Git、文件、进程或远端状态；程序还会阻止与中断记录中已成功或状态未知副作用完全相同的工具调用。运行记录只保存不可逆工作区摘要、稳定 ID、有界任务摘要、状态和证据摘要，不保存 API Key、Token、完整 Prompt、完整路径、源码或无界工具输出。记录损坏、版本未知或目录不可写时，Xiu 会在副作用执行前安全失败，不会假装任务可恢复。

从 `v0.13.2` 起，模型、工具、MCP 和媒体共用一套重试分类。只有限流、超时、临时网络错误和服务端 5xx，同时操作被明确标为可安全重放或幂等时，才会在最多三次尝试内退避恢复；服务端 `Retry-After` 会被采用但最长等待 30 秒。认证失败、权限不足、参数错误、用户取消、已经输出的流式回复、写入与命令、远端修改、付费媒体提交以及提交结果未知的操作均不会静默重试。只读 MCP、视频状态查询和已生成资源下载允许安全恢复；媒体生成请求本身仍依赖稳定请求 ID 和显式恢复，不会重复提交。

选择后会完整回放已保存的用户输入、Xiu 回复、文件变化、关键操作、等待回答和完成状态，并复用正常交互时的 Markdown、表格及颜色渲染。`/history` 使用同一套回放器，不再把内容压成单行，也不再只保留最近 12 条或把每条裁到 600 字。选择器支持上下方向键，也支持数字键直接选择，适配部分 Windows PowerShell/ConPTY 无法正确上报方向键名称的环境。

v0.9.10 之前的会话没有保存“终端语义快照”，Xiu 会从全部已有事件重建可见对话，因此正文和换行可以完整恢复，但当时没有写入日志的临时进度动画、已经丢弃的 UI 卡片无法凭空还原。从 v0.9.10 起，每轮结束会额外保存版本化的语义记录；它保存文本和卡片数据而不是 ANSI 控制码，所以在不同宽度、语言和终端中仍能用当前界面正确重排。

关闭终端后，从 PowerShell 恢复：

```powershell
Set-Location -LiteralPath 'D:\QoderWork Project\my_project'
xiu --resume
```

列出会话 ID：

```powershell
xiu --list-sessions
```

恢复指定会话：

```powershell
xiu --resume '会话ID'
```

长对话接近上下文限制时会自动压缩。手动压缩：

```text
/compact
```

也可以像 Claude Code 一样临时指定本次压缩重点：

```text
/compact 重点保留测试输出、代码修改、失败方法和下一步
```

`agnes-2.5-flash` 按官方 `512K` 上下文窗口计算，默认在 `409600` 个估算 Token（窗口的 80%）时自动压缩。剩余 20% 用于最大输出、系统提示、工具定义和估算误差。未知模型暂用标记为 `fallback` 的 `128K` 窗口；可以用 `--context-window` 或 `XIU_CONTEXT_WINDOW` 提供真实窗口。自定义自动压缩点不得超过窗口的 90%。

从 v0.8.0 开始，压缩结果不是一段无约束的普通摘要，而是“上下文检查点”。Xiu 会在程序层面保留以下信息：

- 最初提交的主任务；
- 运行中追加的 steering 要求；
- 当前任务计划；
- 最近最多六条、合计约 16000 Token 的真实用户要求原文；
- 用户通过 `/compact <重点>` 指定的压缩关注点；
- 已完成证据、关键决定、失败方法、下一步和验证状态。

压缩后的模型会被要求从记录的下一步继续，避免重新扫描已经确认的文件。若模型摘要遗漏主任务，程序保存的任务契约仍然是权威来源。

检查点还包含程序生成的工具证据账本，记录已经执行过的工具、主要参数、结果摘要和重复次数。它不会像普通对话那样在压缩后消失，模型应先复用这些证据，再决定是否确有理由重新读取或重新执行。

`read_file` 默认只返回 200 行，任何一次调用最多返回 500 行，并提示下一次应使用的 `start_line`。对于压缩成一行的 HTML、JSON 或其他超长文本，Xiu 会使用 `start_character` 和 `max_characters` 分段读取，单个字符窗口最多 20000 字符；每个结果都会标明当前字符范围和下一偏移量。这可以防止模型通过超大范围参数让单个文件一次占满上下文。

从 v0.9.5 开始，需要按结构查询 HTML、JSON、CSV 或 TSV 时，Xiu 会优先使用以下只读工具，而不是反复读取原文或临时编写解析脚本：

- `extract_html`：使用 CSS 选择器定位根记录，并从相对子元素提取文本、内部 HTML、外部 HTML 或属性；
- `extract_json`：使用 RFC 6901 JSON Pointer，例如 `/orders/0/items`；`~1` 表示 `/`，`~0` 表示 `~`；
- `extract_csv`：支持 CSV/TSV、表头或无表头、列选择、精确条件过滤、引号内逗号与换行。

三个工具统一返回 JSON，并包含 `matched_count`、`returned_count` 和 `next_offset`。当 `next_offset` 不是 `null` 时，下一次调用使用该值继续读取；不要重复请求同一偏移。单次最多 100 条、20 个字段，单文件最多 50 MB，单次输出最多 60000 字符。过长字段会明确标记，结果始终保持为完整有效 JSON。

编码默认自动识别 UTF-8、UTF-8 BOM、UTF-16 BOM；无法作为 UTF-8 解码的中文数据默认尝试 GB18030。也可以通过 `encoding` 显式指定 `iconv-lite` 支持的编码。三项工具均受工作区路径边界限制，并且属于只读操作，因此可以在 `/plan on` 中使用。

模型会自动选择这些工具。需要手动指导时，可以直接说：

```text
用 extract_html 提取 report.html 中 table tbody tr，每行读取商品名和 data-id。
用 extract_json 读取 data.json 的 /orders/items，按 20 条分页。
用 extract_csv 读取 result.csv，只保留 status 等于 pass 的 id、name 列。
```

工具的完整结果仍写入会话日志并可在 `/details` 查看，但发送回模型的单条结果最多保留 32000 字符，采用头尾保留和中间省略。Windows 下运行 Python 时，Xiu 会自动设置 UTF-8 输出环境，避免中文内容触发 `UnicodeEncodeError`。

开始一个新的独立会话：

```text
/clear
```

`/clear` 会清空当前内存上下文并创建新会话，不会删除磁盘上的旧会话文件。

## 十二、查看状态、差异和恢复点

查看 Token、调用次数、耗时、索引和 MCP 状态：

```text
/status
```

从 v0.9.6 开始，项目索引会跨进程增量复用 `.xiu/index.json`。启动时仍会枚举工作区内允许的文件，以发现新增和删除，但路径、大小和修改时间均未变化的文件不会重新读取或分词；只有新增或修改的文件会重建索引项。Xiu 自己修改文件、恢复检查点或集成 Agent 补丁后，会把索引标记为等待刷新，下一次相关代码检索前自动更新。

`/status` 会显示索引文件数、刷新模式和耗时：`全量构建` 表示没有可信缓存，`增量更新` 表示只处理了变化项，`缓存复用` 表示所有文件内容均未重读。缓存损坏、版本不兼容或包含工作区外路径时会自动重建；索引不会跟随符号链接，也不会写入完整文件内容。

从 v0.9.8 开始，可随时查看当前或最近一次任务诊断：

```text
/diagnostics
```

诊断会分别显示本任务累计输入/输出 Token、平均每次请求输入、模型请求尝试与重试、模型总耗时、工具总耗时与成功率、实际审批提示/自动放行/会话规则放行、失败数、最慢操作、阶段调用、压缩次数和最近失败摘要。这里的 Token 是所有模型请求累计量：同一段上下文被发送 10 次就会计入 10 次，它不是当前上下文占用；当前占用仍看底部状态栏或 `/status`。运行期底部会保留一行紧凑摘要，任务完成回执也会显示本任务 Token 和失败数；`/status` 则显示最近任务诊断概览。任务最终通过验证但中途出现过失败时，会明确标记为“已完成（过程中有可恢复失败）”，不会把过程失败隐藏成完全无异常。

健康状态包括“正常”“等待审批”“需要关注”和“可能停滞”。模型或工具仍在运行但超过一分钟时只标记为较慢；等待用户审批明确显示为等待，不算停滞。连续三次失败，或至少八次操作且两分钟没有获得新证据时，才会提示可能停滞。该提示只给出依据和策略建议，不会自动取消任务。

诊断快照随 `.xiu/sessions/*.jsonl` 保存，恢复会话后仍可查看。意外关闭终端时，未完成快照会标记为“已中断”。操作和失败只保留有界摘要，并脱敏常见 Key、Token、密码、Authorization 和 Cookie；完整工具输出不会复制进诊断报告，也不会上传到远端。

从 v0.9.7 开始，索引同时生成 Repository Map。JavaScript、TypeScript、JSX、TSX、MJS 和 CJS 使用 Xiu 自带的 TypeScript AST 解析器；其他语言仍会显示为文件模块，但不会伪造精确符号关系。可用只读工具包括：

- `repository_map`：按路径分页查看模块、主要符号、内部依赖和被依赖数量；
- `find_symbol`：查找函数、类、接口、类型、枚举、变量、方法和属性定义；
- `find_references`：查看明确符号定义的导入和静态引用；
- `find_callers`：查看直接调用、构造调用和标签调用。

同名符号存在多个定义时，引用和调用工具会返回 `ambiguous: true` 和候选定义。此时把目标定义的 `path` 作为 `defined_in` 再查询，不要猜测。所有结果都有 `returned_count` 和 `next_offset`，下一页使用返回的偏移继续。示例：

```text
先用 repository_map 查看 src，再用 find_symbol 查找 ProjectIndex。
查找 src/project-index.ts 中 initialize 的调用方。
查看 Calculator 在 src/math.ts 中定义对应的全部引用。
```

这些结果是静态导航证据；动态属性、反射和运行时重绑定可能无法解析。修改前仍应读取相关源码确认上下文。

工具输出默认显示短摘要，避免长日志淹没会话。查看完整工具或多 Agent 活动：

```text
/details
```

审批请求使用方向键菜单，默认选中 `No, deny`。只有主动移动到 `Yes, allow once` 并按 Enter 才允许本次操作；dangerous 和 `--yes` 的安全规则保持不变。

查看本次会话涉及的文件和 Git 差异：

```text
/diff
```

查看自动保存的文件恢复点：

```text
/checkpoints
```

选择恢复点并还原：

```text
/rewind
```

恢复前 Xiu 会再次请求确认。恢复点主要覆盖 Xiu 的文件写入和生成资源；任意 Shell 命令产生的外部副作用不保证可以自动还原，因此仍建议使用 Git。

## 十三、模型选择

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

## 十四、Skills

Skills 是写在 `SKILL.md` 中的可复用工作流程。Xiu 从以下位置发现：

```text
项目/.xiu/skills/<名称>/SKILL.md
项目/.agents/skills/<名称>/SKILL.md
项目/.claude/skills/<名称>/SKILL.md
用户目录/.xiu/skills/<名称>/SKILL.md
用户目录/.agents/skills/<名称>/SKILL.md
```

同名时按上面列出的扫描顺序保留第一个。`.agents/skills` 用于兼容 `npx skills` 等外部安装器。

浏览已安装 Skills：

```text
/skills
```

安装本地 Skill：

```text
/skills install D:\my-skills\code-review
```

从 HTTPS Git 仓库安装：

```text
/skills install https://github.com/obra/superpowers.git
```

安装后当前会话会刷新指令。v0.9.9 在每次打开 `/skills` 前重新扫描，并在任务结束后发现外部命令新安装的 Skill，因此无需重启；只有被实际扫描到并加载的 Skill 才会报告为可用。只安装可信来源；Skill 会影响模型的工作方法。Xiu 启动时只加载 Skill 名称、描述和权限摘要，需要使用时才读取完整内容，以减少上下文占用。

v0.12.2 起，Skill 可以在 `SKILL.md` frontmatter 中声明权限，例如：

```yaml
---
name: deploy
description: 部署工作流
permissions: workspace:read, network:access
---
```

可用权限包括 `instructions:load`、`workspace:read`、`workspace:write`、`process:execute`、`network:access`、`external:read`、`external:write` 和 `credentials:access`。未声明的旧 Skill 使用兼容的 `instructions:load` 基线；出现未知权限时安装会被阻止。首次安装或更新新增权限时，Xiu 会先展示差异并等待确认，拒绝后不会替换旧版本。Skill 声明只是风险说明和收紧依据，不能跳过工作区信任、Plan 模式或工具审批。

## 十五、MCP Server

MCP 可以把外部工具接入 Xiu。v0.11.4 同时支持本地 stdio 与远程 Streamable HTTP。交互方式启动时，输入框会先进入可用状态，所有已启用的 MCP 在后台并行连接；连接完成后工具会一次性挂载，不会用异步日志打断正在输入的内容。如果启动后立刻输入 `/mcp`，Xiu 会等待本轮后台连接结束再显示准确状态。使用 `xiu <任务>` 执行一次性任务时仍会先等待 MCP，保证第一轮任务能获得完整工具。用户级配置：

```text
~/.xiu/mcp.json
```

项目级配置：

```text
项目/.xiu/mcp.json
```

Windows 示例：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx.cmd",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "risk": "read",
      "toolRisks": {
        "write_file": "write",
        "edit_file": "write"
      },
      "toolChangesWorkspace": {
        "write_file": true,
        "edit_file": true
      },
      "permissions": ["process:execute", "external:read", "external:write", "workspace:write"]
    }
  }
}
```

远程 Streamable HTTP MCP 使用单一端点，凭证建议只写环境变量名：

```json
{
  "mcpServers": {
    "docs": {
      "transport": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_MCP_TOKEN}" },
      "risk": "execute",
      "permissions": ["network:access", "external:write", "credentials:access"]
    }
  }
}
```

可直接在 Xiu 中管理用户级远程服务：

```text
/mcp add
/mcp add docs https://example.com/mcp DOCS_MCP_TOKEN
/mcp login cloudflare
/mcp auth cloudflare
/mcp logout cloudflare
/mcp test docs
/mcp remove docs
/mcp reload
/mcp resources cloudflare
/mcp read cloudflare <resource-uri>
/mcp prompts cloudflare
/mcp prompt cloudflare <prompt-name> {"argument":"value"}
/mcp permissions
/mcp permissions approve cloudflare
```

`/mcp add` 会让用户选择无认证、Bearer 环境变量或 OAuth，并明确默认风险等级。OAuth 配置只保存认证方式、Client ID、Scope 和回调端口等非敏感信息；Token 独立保存在用户目录的 `~/.xiu/mcp-auth.json`，不会进入项目配置、会话或模型上下文。

OAuth MCP 保存后执行 `/mcp login [名称]`。Xiu 会展示 MCP、授权服务器、Scope 和回调地址，确认后使用 PKCE S256 请求系统浏览器打开授权页，并只在 `127.0.0.1` 等待回调；终端始终同时显示完整授权链接，因此浏览器未自动打开或被安全策略拦截时可以手动复制。等待最长 5 分钟，按 Ctrl+C 可以取消。`/mcp auth [名称]` 只显示登录状态、Issuer、Scope 和到期时间，不显示 Token。`/mcp logout [名称]` 会先尝试撤销 Refresh Token 和 Access Token，再清除本地 Token；即使远端没有撤销端点，本地退出仍会完成，可选择是否同时忘记动态 Client 注册。

Access Token 临近到期时会自动刷新，同一身份的并发刷新只执行一次。服务端明确返回 `403 insufficient_scope` 时，Xiu 会列出新增 Scope 并再次请求用户批准；批准并完成浏览器授权后，仅重试刚被明确拒绝的请求一次。超时、断网或结果不确定时不会自动重放可能产生副作用的 MCP 工具。`/mcp test` 只测试连接，未登录时提示运行 `/mcp login`，不会自动弹出浏览器。

公网地址必须使用 HTTPS，明文 HTTP 只允许 `localhost`、`127.0.0.1` 和 `::1`。OAuth 发现端点与每次重定向都经过 URL、DNS 和 SSRF 校验。Xiu 不允许配置覆盖保留 Header，也会在错误、状态和诊断中脱敏 Token、授权码和 Secret。

查看连接情况：

```text
/mcp
```

修改配置后重新加载：

```text
/mcp reload
```

MCP 工具默认按 execute 风险处理并请求审批。只有确认工具不能修改文件或外部状态时，才应配置为 `read`。项目 MCP 只在工作区受信任后启动。

v0.12.2 起，MCP 可声明 `process:execute`、`network:access`、`external:read`、`external:write`、`workspace:write` 和 `credentials:access`。Xiu 会根据 transport、认证、risk 和工作区变化配置推导最低权限；显式清单可以更严格，但不能少报。旧配置首次升级会建立兼容基线；新配置或权限扩大时保持断开，并提示使用 `/mcp permissions approve [名称]` 审批当前精确指纹。修改命令、端点、认证、风险、工作区副作用或权限都会使旧授权失效。授权摘要保存在 `~/.xiu/extension-permissions.json`，不会保存明文端点，也不会代替每次工具调用的核心安全审批。

OAuth 登录后可使用 `/mcp credentials [status] [名称]` 查看来源，但不会看到 Token。`/mcp credentials migrate [名称]` 将秘密复制到 Windows Credential Manager 并校验，`cleanup` 单独删除旧明文，`rollback` 显式切回兼容文件。迁移不会自动清理，`-y` 也不能跳过 cleanup 的完整 MCP 名称确认。系统引用生效后若后端不可用，Xiu 不会静默读取保留明文；应恢复系统后端或显式回退。

Windows stdio MCP 启动失败时，Xiu 会对 UTF-8、UTF-16LE 和常见 GB18030/GBK stderr 做有界解码，避免把本地中文错误显示为乱码；错误内容仍会截断并脱敏。

v0.12.1 起可以显式浏览 MCP Resource、Resource Template 和 Prompt。`/mcp resources [名称]` 与 `/mcp prompts [名称]` 显示服务提供的目录；`/mcp read [名称] [URI]` 通过原 MCP 服务读取 Resource，Xiu 不会自行访问 URI；`/mcp prompt [名称] [Prompt] [JSON参数]` 获取并预览 Prompt，缺少必填参数时会逐项询问。

这些远端内容一律按“不可信内容”展示，不会自动注入当前任务或变成模型指令。列表最多读取 20 页、500 项；文本单块最多 32K 字符、单次最多 64K 字符；Blob、图片和音频只显示 MIME 与估算大小，不输出 Base64。要让模型使用其中信息，应由用户检查后明确转述或引用，避免第三方内容静默扩大权限。

## 十六、项目级指令

可以在项目根目录创建以下文件，告诉 Xiu 项目的长期规则：

- `AGENTS.md`
- `XIU.md`
- `CLAUDE.md`

示例 `XIU.md`：

```markdown
# Project conventions

- 使用 TypeScript strict 模式。
- 不要修改 generated 目录。
- 修改后运行 npm test 和 npm run typecheck。
- 保持现有中文错误信息风格。
```

这些文件会进入系统提示，因此只加载可信项目中的指令。规则应具体、简短、可执行，不要把大量源代码复制进去。

## 十七、图片和视频

当模型配置支持相应能力时，可以直接用自然语言提出需求。

分析项目图片：

```text
分析 assets/login-error.png，指出界面布局问题，不要修改文件。
```

生成图片并保存到工作区：

```text
生成一个深色科技风的登录页背景图，16:9，保存为 assets/login-bg.png。
```

基于参考图编辑：

```text
参考 assets/logo.png 生成透明背景的高分辨率版本，保存为 assets/logo-clean.png。
```

生成视频：

```text
生成一个 5 秒的产品 Logo 动画，保存为 assets/intro.mp4。
```

图片输出必须位于工作区并使用 `.png`、`.jpg`、`.jpeg` 或 `.webp`。视频输出使用 `.mp4`。视频参考图片目前需要公网可访问的 HTTP(S) URL。

图片和视频通常会产生 API 费用，因此生成工具始终要求明确审批；即使使用 `xiu --yes`，第一次也不会静默创建可能收费的媒体任务。审批时可以选择“仅允许一次”，也可以选择“本次会话始终允许”。后者只放行当前 Xiu 进程中的同类媒体操作，退出后自动失效，图片与视频权限彼此隔离。由于提交结果不确定后的强制重新生成可能造成重复扣费，`force_new_generation=true` 永远要求单独确认，不会使用会话授权。执行前请查看审批内容和供应商计费规则。

v0.11 起，Xiu 会在工作区 `.xiu/media-operations.json` 保存媒体请求状态，并在 `.xiu/media-assets/` 缓存可恢复资产。相同 Provider、模型和生成参数会得到同一个幂等键：

- 已完成的相同请求直接复用已有资产，不再次调用生成 API。
- 生图已返回 URL 但下载中断时，再次提出相同请求只继续下载。
- 视频已获得任务 ID 后，轮询超时、断网或取消时，再次提出相同请求会继续查询原任务；任务完成但下载失败时只继续下载。
- 视频状态默认按较低频率查询；状态接口返回 429/503 时，Xiu 会在同一次工具调用中等待并继续查询原任务，不把错误交给模型改写提示词后重新生成。
- 如果付费提交本身断网或超时，无法判断服务端是否已经接受和计费，Xiu 会阻止自动重试并显示请求 ID。只有用户明确接受重复计费风险后，Agent 才可使用 `force_new_generation=true` 创建新请求。
- 如果新任务被服务端以 429/503 明确拒绝，Xiu 会启用该 Provider/模型的提交冷却；冷却结束前，即使模型改写提示词也不能创建另一项付费任务。`force_new_generation=true` 只能用于参数完全匹配的历史失败请求，不能用于新提示词。

v0.11.1 起可以直接输入 `/media` 查看最近 30 个媒体任务。每项会显示稳定请求 ID 的前 8 位、图片/视频类型、状态、Provider/模型、已有任务 ID 和保存路径。列表不会显示可能包含临时凭证的签名下载 URL。

要恢复指定任务，可以直接告诉 Xiu：

```text
恢复媒体请求 12ab34cd 到 assets/recovered.mp4
```

Xiu 会按稳定 ID 找到原记录，并且只允许三种恢复动作：复用本地缓存、继续轮询已有视频任务 ID、重新下载已有资产 URL。恢复工具本身不能调用生成接口，因此不会创建第二个收费任务。若请求正处于“提交结果未知”、歧义或终态失败状态，Xiu 会保持阻断；如果记录属于另一个 Provider，需要先切回该 Provider，不能跨供应商重放。

媒体工具失败或审批被拒绝时，不会写入绿色“已执行”回执。如果最后一次工具操作仍失败，任务状态显示“任务未完成”并进入正常的失败恢复流程，不再以“已完成、无文件变化”结束。

媒体状态仅保存在本项目中，不上传到其他服务。不要手工删除 `.xiu/media-operations.json` 来规避保护；删除后 Xiu 将无法识别已提交任务，也无法防止重复生成。

## 十八、后台命令和开发服务器

从 `0.13.4` 起，Xiu 可以启动开发服务器、构建脚本或另一个 Xiu 长任务，并在当前终端关闭后继续运行。后台记录按工作区摘要隔离，包含稳定 ID、PID、状态、输出字节数和退出证据；实际命令只保留经过脱敏和截断的预览。

直接启动和管理：

```text
/background start npm.cmd run dev
/background
/background read <任务ID> 0
/background cancel <任务ID>
```

`read` 会返回下一游标。再次读取时带上该游标，只显示新增输出：

```text
/background read <任务ID> <下一游标>
```

也可以把完整 Xiu 任务放到后台：

```text
/background start xiu -y --budget-seconds 1800 "分析项目、完成修改并运行测试"
```

后台启动前仍需明确确认；危险命令必须输入 `BACKGROUND`。后台 Xiu 使用同一工作区和本机 Provider/凭证配置，并继续遵守任务恢复边界；任务预算应在后台命令中显式传入或通过 `XIU_BUDGET_*` 环境变量配置。`-y` 也不会批准危险操作。无法在无交互状态取得的新审批不会被绕过，相应任务会留下可恢复证据。

模型也可以通过后台工具启动开发服务器等任务、查看增量输出并停止它们。例如可以直接要求：

```text
启动开发服务器，确认首页能正常访问；检查日志后停止服务器。
```

退出 Xiu 不会取消后台任务。请用 `/background cancel <任务ID>` 显式停止；不要让 Xiu 启动来源不明的可执行程序。

## 十九、所有交互命令速查

| 命令 | 作用 |
| --- | --- |
| `/resume` | 选择并恢复项目会话 |
| `/recover` | 检查并确认恢复或放弃异常中断任务 |
| `/background [list]` | 发现当前工作区跨终端运行的后台任务 |
| `/background start <命令>` | 确认后启动可断线续跑的后台命令或 Xiu 长任务 |
| `/background read <ID> [游标]` | 读取完整或增量后台输出和退出状态 |
| `/background cancel <ID>` | 再次确认后显式取消后台任务 |
| `/history` | 查看最近对话 |
| `/history sessions` | 列出项目会话 |
| `/compact [重点]` | 立即压缩上下文，可指定重点保留内容 |
| `/plan` | 查看任务计划和 Plan 模式 |
| `/plan on` | 开启只读 Plan 模式 |
| `/plan off` | 关闭 Plan 模式 |
| `/tasks` | 查看实时任务步骤 |
| `/diff` | 查看本次会话改动和 Git diff |
| `/media` | 查看媒体生成记录、稳定请求 ID 和可恢复状态 |
| `/checkpoints` | 列出文件恢复点 |
| `/rewind` | 选择恢复点还原 |
| `/models` | 发现并选择模型 |
| `/routing` | 查看阶段模型路由总开关与规划、实现、验证绑定 |
| `/routing on` / `/routing off` | 启用或停用阶段模型路由 |
| `/routing set <阶段>` | 为 `planning`、`implementation` 或 `verification` 选择 Provider |
| `/routing clear <阶段>` | 清除一个阶段的 Provider 绑定 |
| `/language [zh-CN|en-US]` | 设置并持久保存界面与模型会话语言 |
| `/skills` | 浏览 Skills |
| `/skills install ...` | 安装本地或 HTTPS Git Skill |
| `/mcp` | 查看 MCP 连接与工具数 |
| `/mcp add [name] [url] [TOKEN_ENV]` | 添加用户级 Streamable HTTP MCP |
| `/mcp remove [name]` | 删除用户级 MCP 配置 |
| `/mcp test [name]` | 重连并测试一个或全部 MCP |
| `/mcp reload` | 重载 MCP 配置 |
| `/mcp resources` / `/mcp read` | 浏览和读取不可信的远端 Resource |
| `/mcp prompts` / `/mcp prompt` | 浏览和预览不可信的远端 Prompt |
| `/mcp permissions` | 查看 MCP 权限清单、来源和待批准差异 |
| `/mcp permissions approve [name]` | 批准一个 MCP 当前精确权限指纹 |
| `/mcp credentials [status] [name]` | 查看 MCP OAuth 凭证来源和副本状态，不显示秘密 |
| `/mcp credentials migrate [name]` | 复制、回读校验并切换一个 MCP 的 OAuth Token 与 Client Secret，保留旧明文 |
| `/mcp credentials cleanup [name]` | 再次校验系统副本并输入完整 MCP 名称后删除旧明文 |
| `/mcp credentials rollback [name]` | 显式切回兼容文件；必要时从系统凭证恢复已清理副本 |
| `/credentials` / `/credentials status` | 查看凭证后端状态与条目数，不显示 Key 或 Token |
| `/credentials probe` | 经确认后使用随机临时 Canary 验证 Windows Credential Manager 写入、回读与清理 |
| `/credentials migrate [ID\|--all]` | 复制、回读验证并切换一个或显式批量 Provider Key；默认保留旧明文 |
| `/credentials cleanup [ID]` | 再次验证系统副本并输入完整 Provider ID 后，单独删除一个旧明文 Key |
| `/credentials rollback [ID]` | 切回 Legacy File；旧副本已清理时先从系统凭据显式恢复，再尝试删除系统副本 |
| `/credentials forget [ID]` | 经影响确认并输入完整 Provider ID 后，删除该 Provider 的全部本地 Key 副本 |
| `/agents` | 查看所有多 Agent 运行 |
| `/agents <运行ID>` | 查看一个运行的详细状态 |
| `/agents cancel <运行ID> <任务ID>` | 单独取消一个 Agent |
| `/agents retry <运行ID> <任务ID>` | 重试可恢复任务 |
| `/agents integrate <运行ID> <任务ID>` | 审查并集成 Worktree 修改 |
| `/details` | 浏览工具和 Agent 的完整活动输出 |
| `/diagnostics` | 查看当前或最近任务诊断 |
| `/status` | 查看模型、Token、调用和耗时 |
| `/queue` | 查看明确安排的后续任务 |
| `/queue <任务>` | 安排一项独立任务在当前任务之后运行 |
| `/clear-queue` | 清空尚未执行的独立任务 |
| `/cancel` | 取消当前任务并选择停止、重试或继续 |
| `/clear` | 开始新会话 |
| `/help` | 显示帮助 |
| `/exit` | 退出 Xiu |

## 二十、启动参数速查

| 参数 | 作用 |
| --- | --- |
| `-p, --provider <名称>` | `openai`、`anthropic` 或 `agnes` |
| `-m, --model <模型>` | 指定文本模型 |
| `-C, --cwd <目录>` | 指定工作区 |
| `--base-url <URL>` | OpenAI 兼容 API 地址 |
| `--media-base-url <URL>` | 多媒体生成 API 地址 |
| `--proxy <URL>` | HTTP(S) 代理 |
| `--vision-model <模型>` | 图片分析模型 |
| `--image-model <模型>` | 图片生成模型 |
| `--video-model <模型>` | 视频生成模型 |
| `--unified-model <模型>` | 一个模型承担可支持的全部能力 |
| `-r, --resume [会话]` | 选择或指定恢复会话 |
| `--list-sessions` | 列出工作区会话 |
| `--context-window <Token>` | Provider 元数据不可用时覆盖模型真实窗口 |
| `--context-limit <Token>` | 覆盖自动压缩阈值，最大为窗口的 90% |
| `--max-turns <次数>` | 可选的单任务轮数上限；默认不限制 |
| `--budget-tokens <数量>` | 单任务累计 Token 预算；默认不限制 |
| `--budget-model-calls <次数>` | 模型请求预算，重试也计入 |
| `--budget-tool-calls <次数>` | 已完成工具调用预算 |
| `--budget-failures <次数>` | 模型与工具失败总预算 |
| `--budget-seconds <秒>` | 墙钟时间预算，在安全操作边界生效 |
| `--budget-warning-percent <百分比>` | 预算预警阈值，默认 80 |
| `--stall-timeout-seconds <秒>` | 无新证据停滞阈值，默认 120 |
| `--agent-concurrency <数量>` | 并发子 Agent 上限，1 到 8，默认 3 |
| `--language <语言>` | 本次启动使用 `zh-CN` 或 `en-US` |
| `-y, --yes` | 自动批准非危险写入和执行 |
| `--version` | 显示版本 |
| `--help` | 显示命令行帮助 |

查看当前版本实际支持的参数：

```powershell
xiu --help
```

## 二十一、中断和退出

模型思考或工具执行过程中按 Ctrl+C，会立即显示“正在取消”，中止当前模型或工具调用，并打开恢复选择。v0.8.7 同时识别标准 Ctrl+C 键事件和部分 Windows PowerShell/ConPTY 直接送入的原始控制字符。Xiu 不会未经确认自动执行显式队列。需要直接取消、清空并退出可输入：

```text
/exit
```

不要通过直接关闭窗口来终止正在写文件的操作，优先使用 Ctrl+C，等待任务取消后再退出。

## 二十二、常见问题

### 22.1 `xiu` 不是内部或外部命令

重新打开 PowerShell，然后检查：

```powershell
npm.cmd install --global '@xiu-ai/cli' --registry='https://registry.npmjs.org/'
npm.cmd config get prefix
Get-Command xiu
```

npm 全局 bin 目录必须在系统 PATH 中。

### 22.2 `Cannot convert argument to a ByteString`

通常是把中文占位文字当成了真实 API Key，例如：

```powershell
$env:AGNES_API_KEY = '你的实际 API Key'
```

请换成供应商提供的真实 ASCII Key，不要把中文说明原样复制为 Key。

### 22.3 `Set-Location` 报路径参数错误

带空格的路径需要引号：

```powershell
Set-Location -LiteralPath 'D:\QoderWork Project\AGENT'
```

### 22.4 `Could not read package.json`

这是在普通项目目录执行 `npm run dev` 导致的。安装全局包后，普通项目中直接输入：

```powershell
xiu
```

只有开发 Xiu 自身时才在 Xiu 源码目录运行 `npm run dev`。

### 22.5 API 连接失败

检查当前窗口变量：

```powershell
$env:XIU_PROVIDER
$env:AGNES_PROXY
```

不要在截图或共享日志中输出 API Key。确认代理正在监听、URL 使用 `http://` 或 `https://`，并确认供应商服务可访问。

### 22.6 上下文越来越大

查看：

```text
/status
```

手动压缩：

```text
/compact
```

任务完全不同则使用 `/clear` 创建新会话。

### 22.7 Skill 或模型选择器按 Esc 后显示残留

先升级到最新版：

```powershell
npm.cmd install --global '@xiu-ai/cli@latest' --registry='https://registry.npmjs.org/'
```

新版会按终端宽度截断选择器内容，避免 PowerShell 自动换行导致清屏残留。

### 22.8 MCP 连接失败

输入：

```text
/mcp
```

检查配置中的 `command` 是否存在。Windows 通常使用 `npx.cmd`，macOS/Linux 使用 `npx`。修改后输入 `/mcp reload`。

### 22.9 离开一会后输入不显示，按 Enter 或 Esc 才恢复

v0.10.1 修复了输入框、任务补充框和选择菜单交接时的 Raw 模式竞态：旧输入的延迟清理不再关闭新输入，Windows 守护器也会重新应用被外部程序改变的 Raw 模式。

如果窗口标题同时出现“选择”或 `Select`，则是经典 Windows PowerShell 控制台进入了 QuickEdit/标记模式，宿主会暂停 Xiu 整个进程，因此程序无法在暂停期间自行恢复。按 Esc 或 Enter 可立即退出。若经常误触，可在 PowerShell 窗口标题栏右键进入“属性 → 选项”，取消“快速编辑模式”，或者改用 Windows Terminal。Xiu 不会擅自修改系统控制台设置，也不会接管鼠标右键，以免破坏原生文字和文件路径粘贴。

## 二十三、插件（v0.14.3 阶段 D）

Xiu 会发现以下位置的插件清单：

```text
项目/.xiu/plugins/<插件>/xiu.plugin.json   仅在工作区信任后扫描
用户目录/.xiu/plugins/<插件>/xiu.plugin.json
```

查看和重新扫描：

```text
/plugins
/plugins reload
/plugin inspect acme.example
/plugin policy
/plugin approve acme.example
/plugin install D:\trusted\xiu-plugin
/plugin install https://github.com/example/xiu-plugin.git
/plugin update acme.example
/plugin disable acme.example
/plugin enable acme.example
/plugin uninstall acme.example
/plugin recover acme.example global
/plugin publisher list
/plugin publisher trust acme.example
/plugin publisher revoke <完整 SHA-256 发布者指纹>
```

`ready` 表示清单有效，`active` 才表示当前清单指纹已被用户授权。授权指纹包含插件版本、权限、全部贡献路径和内容摘要；任意一项变化都会自动回到 `inactive`，必须重新确认。

阶段 B 只加载声明式数据：Provider 和 MCP Tool 使用有界 JSON，Skill 和工作流使用有界 Markdown。Xiu 不会执行插件 JavaScript、安装脚本或任意二进制入口。Provider JSON 不能包含明文 `apiKey`，只能用 `apiKeyEnv` 引用环境变量；MCP Tool 导入后仍受 MCP 权限清单和风险审批约束。`/plugins reload` 会重新扫描并刷新已授权贡献。

阶段 C 支持可信本地路径和无内嵌凭证的 HTTPS Git 来源。安装包会先复制到插件目录内的暂存位置，拒绝符号链接、Junction、非普通文件和超限内容，校验通过后才原子就位。Git 仅用于读取仓库，不执行 Hook、安装脚本或插件代码。

更新只使用安装时记录的来源，确认界面会显示版本变化和新增/移除权限。旧插件先移动到可恢复备份，新版本替换失败时恢复旧目录；即使权限没有变化，新内容摘要也会让旧授权失效。禁用只写本地标记，启用不会扩大权限。卸载只把插件包移入 `plugin-backups`，不会删除插件生成的项目文件、会话或其他用户数据；`/plugin recover` 可在卸载后恢复，也可在插件仍安装时回退到最近备份，回退前的当前版本同样会被保留。

清单示例：

```json
{
  "apiVersion": 1,
  "id": "acme.example",
  "name": "Example",
  "version": "1.0.0",
  "engines": { "xiu": { "min": "0.14.0", "maxExclusive": "0.15.0" } },
  "permissions": ["instructions:load"],
  "contributes": {
    "skills": [{ "id": "review", "path": "skills/review" }]
  }
}
```

### 联网搜索现状

Xiu 当前没有统一的内置 Web Search 工具。可以通过提供搜索工具的 MCP、模型供应商原生能力，或经审批的外部命令间接联网，但这些方式的引用、代理和隐私体验尚未统一。路线图安排在 v0.14 扩展安全闭环之后的 v0.15 增加原生只读联网搜索，并统一来源引用、域名策略、代理、超时和不可信内容隔离。

### 23.1 包完整性与来源锁定

从 v0.14.3 开始，Xiu 在安装时为整个插件包计算确定性的 SHA-256 摘要，并将摘要、原始安装来源和安装时间写入 `.xiu-install.json`。HTTPS Git 来源还会记录浅克隆实际解析到的完整提交 ID；安装仍然由用户显式触发，不会自动跟随远端分支更新。

执行 `/plugin inspect <id>` 可查看完整性状态、安装来源和源修订：

- `verified`：当前包与安装时锁定摘要一致。
- `legacy`：由旧版本安装，尚未建立完整包锁；下一次显式更新会迁移。
- `unmanaged`：手工放入插件目录，没有安装元数据。
- `mismatch`：安装后内容发生变化，插件会失败关闭并撤销激活。

`.xiu-disabled` 是 Xiu 的本地状态标记，不属于包摘要，因此正常禁用和启用不会被误判为篡改。修改插件内容、替换清单、增加未声明文件或删除包内文件都会改变摘要；应通过 `/plugin update` 安装新版本，而不是直接编辑已安装目录。

### 23.2 Ed25519 签名与发布者信任

插件可以在包根目录提供 `xiu.plugin.sig.json` 分离签名。Xiu 使用 Ed25519 验证签名是否覆盖当前插件 ID、版本和阶段 D1 计算出的完整包 SHA-256；签名文件本身不进入摘要，避免循环依赖。`/plugin inspect <id>` 和安装、更新确认页会显示以下状态：

- `unsigned`：没有签名，仍可在本机按当前精确清单审批。
- `valid-untrusted`：签名有效，但该公钥尚未被本机显式信任。
- `trusted`：签名有效，且完整 SHA-256 发布者指纹已记录在本机信任库。
- `invalid`：签名格式、元数据、算法、公钥或签名字节无效；插件失败关闭，不能安装或激活。

`/plugin publisher trust <插件 ID>` 只接受当前已通过签名验证的插件，显示发布者名称、完整公钥指纹并要求确认。`/plugin publisher revoke <完整指纹>` 删除本机信任记录。信任发布者只确认“是谁签的”，绝不等于允许插件权限：首次安装、内容变化、版本变化、权限变化或发布者换钥后，仍必须对当前精确内容执行 `/plugin approve <id>`。旧发布者私钥被替换时，发布者指纹也会进入授权指纹并使原授权失效。

信任库保存在用户目录 `.xiu/trusted-plugin-publishers.json`，仅包含公开密钥、指纹、可选名称和信任时间，不包含私钥。文件损坏、记录与指纹不匹配或签名被替换时均安全失败。阶段 D2 保持无签名插件兼容；阶段 D3 的团队策略可以选择禁止无签名来源，但不能替用户扩大信任或审批。

### 23.3 团队插件策略

受信任项目可在仓库根目录提交 `xiu.plugin-policy.json`。Xiu 只在工作区已信任后读取它；文件必须是非符号链接的有界普通 JSON 文件。策略无效时插件失败关闭，但不会影响 Xiu 的普通编码功能。使用 `/plugin policy` 查看当前策略、文件位置和确定性策略指纹。

```json
{
  "version": 1,
  "requireSignature": true,
  "allowedSources": [
    "project",
    "https://github.com/acme/xiu-review-plugin.git"
  ],
  "allowedPublishers": [
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  ],
  "deniedPermissions": ["process:execute", "credentials:access"]
}
```

- `requireSignature`：拒绝 `unsigned` 插件；签名存在但无效时无论策略如何都会失败关闭。
- `allowedSources`：精确允许来源。`project` 只匹配直接放入当前项目插件目录且没有安装来源元数据的项目插件；远程来源必须是无内嵌凭证的完整 HTTPS URL，按规范化后的 URL 精确匹配。本地路径安装不会匹配远程来源白名单。
- `allowedPublishers`：只接受完整 SHA-256 发布者公钥指纹，可带或不带 `sha256:` 前缀。
- `deniedPermissions`：阻止声明任一所列权限的插件。

团队策略只有限制能力：它不会写入本机发布者信任库，不会执行 `/plugin approve`，也不会放宽工作区信任、Plan 只读、MCP 权限或危险操作确认。即使来源和发布者均在白名单中，用户仍需在本机显式信任发布者（如需要显示 `trusted`）并对当前精确插件内容执行 `/plugin approve <id>`。安装预览到原子提交之间若策略变化，安装会取消；恢复备份前也会按最新策略、完整性和签名重新验证。

## 二十四、安全建议

- 只在可信工作区运行 Xiu。
- 不理解的审批请求先拒绝。
- 重要项目先提交 Git，再让 Agent 大范围修改。
- 高风险任务先使用 `/plan on`。
- 不要在项目文件中保存 API Key。
- Skills 和 MCP Server 只安装可信来源。
- 使用 `--yes` 前先熟悉普通审批流程。
- 生成图片、视频和调用外部模型前关注费用。
- 用 `/diff` 检查修改，用测试和构建验证结果。
- Xiu 报告“完成”后仍应进行人工代码审查。

## 二十五、推荐的新手工作流

第一次处理项目时，可以按以下顺序：

```text
1. 在项目目录启动 xiu。
2. 确认项目可信后按 Enter。
3. 输入 /plan on。
4. 要求 Xiu 解释架构并提出修改方案。
5. 输入 /plan 和 /tasks 检查计划。
6. 确认方案后输入 /plan off。
7. 要求 Xiu 实施并运行测试。
8. 对每个写入或执行请求阅读后再批准。
9. 输入 /diff 检查改动。
10. 输入 /status 查看调用和上下文。
11. 满意后在项目中提交 Git。
12. 输入 /exit 正常退出。
```

把目标说清楚、控制修改范围、保留 Git 恢复手段并认真查看验证结果，是安全高效使用 Xiu 的关键。

## 二十六、完整执行报告

任务结束后输入 `/report`，可以预览最近一次任务的有界、脱敏摘要。报告组合任务运行日志、终端会话回放、文件变化、验证操作、诊断和当前工作区的安全审计事实，回答任务做了什么、是否完成、如何验证、哪里失败以及能否继续。同一原始目标因未验证而产生的“继续未完成任务”运行会自动聚合为一条任务链：报告保留原始用户目标，并累计此前运行的文件变化和最终验证证据。

预览不会写入文件。导出时必须同时指定格式、工作区内路径和内容范围：

```text
/report export markdown reports/latest.md summary
/report export json reports/latest.json details
```

- `summary` 包含目标、阶段、相对文件路径与增删统计、验证、失败、预算、安全事件计数和恢复状态，不包含源码预览。
- `details` 只额外包含每个文件最多四行的脱敏预览；仍不会导出完整源码、Prompt、模型思维链、凭证或安全审计主体。
- 目标路径必须位于当前工作区内，不能穿过符号链接；覆盖已有文件时会再次确认。
- 正在运行或暂停的任务会明确显示可通过 `/recover` 继续；未知副作用只会列为待核验，不会自动重放。
