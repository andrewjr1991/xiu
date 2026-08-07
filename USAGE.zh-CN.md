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

## 三、配置模型

Xiu 支持 Agnes、OpenAI 和 Anthropic。至少要配置一个服务的 API Key。

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

### 3.4 环境变量何时失效

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

从 v0.8.6 开始，内置工具活动说明、重试、恢复点和多 Agent 状态也会确定性本地化；中文任务计划拒绝纯英文自然语言标题。代码路径、命令、模型名与第三方命令原始输出仍保持原文。明确询问“你是谁”或“谁开发了 Xiu”时由程序级身份守卫回答，底层模型不能再把 Xiu 说成 Agnes 或归属于 Sapiens AI；Xiu 由静然开发。

Xiu 不显示模型私有思维链。“思考使用中文”指所有用户能够看到的计划、依据、推理摘要、说明和结论均使用中文。

### 6.2 任务运行时继续输入

Agent 工作时输入框不会消失，而是使用临时的补充提示：

```text
补充>
```

从 v0.7.2 开始，此时输入普通文字表示“补充当前任务”。Xiu 会在下一次模型调用前把它作为 steering 注入当前目标。例如当前正在生成在线表格时输入“同时生成 JSONL”，不会再被理解成一个独立的工具开发任务。

从 v0.7.3 开始，最初提交的任务会被固定为不可覆盖的主目标，运行中的普通输入只能增加要求，不能替换主目标。模型准备结束时，Xiu 还会执行一次任务契约审计；如果模型只回答了最新补充、尚未完成原始任务，它会被要求继续工作。

从 v0.7.4 开始，循环保护只判断近期连续、没有新进展的调用序列。长任务中经过其他调查后重新读取规则或源文件是允许的；上下文压缩和成功修改文件后，旧的循环证据会被清空。真正的连续重复调用和短周期调用循环仍会被阻断。

运行期输入框下方默认常驻紧凑任务进度，包括当前轮次、阶段、耗时、待注入补充、显式队列、步骤完成情况、“当前”动作、“下一步”以及最近成功的文件写入或修改。临时 `补充> ` 输入框完成后会被清除，不再作为 `xiu[working]>` 残留到永久滚动历史。

任务完成并切回普通 `xiu> ` 输入框后，键入内容会立即回显。Xiu 不会在两个输入框切换时暂停 PowerShell 的共享输入流，因此无需先盲输一行并按 Enter 才能恢复显示。

如果模型缺少一个关键决定而无法继续，终端会显示黄色高亮的“Xiu 需要你的回答”、单独的问题正文和“等待你的回答”状态，下一行提示会变为 `请回答> `。直接输入答案后，Xiu 会沿用当前会话上下文继续处理。该状态不会再显示成绿色“已完成”。

如果模型使用 `update_task_plan` 创建了正式计划，这里显示真实步骤，并用绿色 `√`、青色 `→`、灰色 `○`、红色 `!` 分别表示完成、进行中、等待和阻塞。如果模型尚未创建计划，Xiu 会显示“理解任务、检查文件、实施修改、验证结果、复核完成”五个自动阶段，因此不会再只剩下一行 `Thinking`。

从 v0.8.2 开始，模型在重要阶段切换时会给出一句简短进展说明，中文界面显示为“进展：”。它应说明刚确认了什么、当前正在做什么以及下一步是什么，不会逐条复述每个普通工具调用。

从 v0.8.5 开始，“文件变化”卡片在中文模式中完整本地化。创建文件只显示类型、大小和增删统计，不再打印 HTML 等模板开头；修改文件最多显示 4 行关键增删内容和 `@@` 位置；超过 1 MB 的文本及二进制文件只显示修改前后的字节规模。完整差异仍通过 `/diff` 查看。

“进展”回答“当前阶段在做什么”，“文件变化”回答“工作区实际改了什么”，“关键操作”永久保留重要执行和验证结果，`Ctrl+O` 则回答“具体调用过哪些工具”。完整工具日志不会在任务结束时倾倒。

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

按 `Ctrl+O` 可以在默认步骤摘要和最近八条详细工具活动之间切换，再按一次恢复摘要，不会提交或清空草稿。

只有明确输入 `/queue <任务>` 才会安排当前任务结束后运行的独立任务。

运行期间可立即使用：

| 操作 | 作用 |
| --- | --- |
| 普通文本 + Enter | 补充当前任务，在下一模型轮次注入 |
| `Ctrl+O` | 在默认步骤摘要和详细工具活动之间切换 |
| `Ctrl+V` | 粘贴普通文字，或导入 Windows 剪贴板图片/文件 |
| 鼠标右键 | 使用终端宿主的原生粘贴；可粘贴的内容取决于 Windows Terminal、PowerShell 或当前终端配置 |
| `/details` | 运行期间切换步骤摘要/详细活动 |
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
| Reviewer | 共享工作区，只读 | 检查正确性、安全、回归和测试缺口 |
| Tester | 共享工作区，只读 | 分析验证范围和报告证据；执行受安全模式限制 |
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

集成前 Xiu 会显示完整补丁并运行冲突检查。冲突时主工作区不会发生部分修改，Worktree 会保留在 `.xiu/worktrees/` 中用于人工处理。v0.6 不自动删除 Worktree 或分支。集成成功后仍要运行测试并人工审查。

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
项目/.claude/skills/<名称>/SKILL.md
用户目录/.xiu/skills/<名称>/SKILL.md
```

同名时，项目 Skill 优先于 Claude 兼容 Skill，再优先于全局 Skill。

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

安装后当前会话会刷新指令。只安装可信来源；Skill 会影响模型的工作方法。Xiu 启动时只加载 Skill 名称和描述，需要使用时才读取完整内容，以减少上下文占用。

## 十五、MCP Server

MCP 可以把外部工具接入 Xiu。用户级配置：

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
      }
    }
  }
}
```

查看连接情况：

```text
/mcp
```

修改配置后重新加载：

```text
/mcp reload
```

MCP 工具默认按 execute 风险处理并请求审批。只有确认工具不能修改文件或外部状态时，才应配置为 `read`。项目 MCP 只在工作区受信任后启动。

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

图片和视频通常会产生 API 费用，执行前查看审批内容和供应商计费规则。

## 十八、后台命令和开发服务器

Xiu 可以启动开发服务器等后台任务、查看输出并停止它们。可以直接要求：

```text
启动开发服务器，确认首页能正常访问；检查日志后停止服务器。
```

退出 Xiu 时，它管理的后台进程会被清理。不要让 Xiu 启动来源不明的可执行程序。

## 十九、所有交互命令速查

| 命令 | 作用 |
| --- | --- |
| `/resume` | 选择并恢复项目会话 |
| `/history` | 查看最近对话 |
| `/history sessions` | 列出项目会话 |
| `/compact [重点]` | 立即压缩上下文，可指定重点保留内容 |
| `/plan` | 查看任务计划和 Plan 模式 |
| `/plan on` | 开启只读 Plan 模式 |
| `/plan off` | 关闭 Plan 模式 |
| `/tasks` | 查看实时任务步骤 |
| `/diff` | 查看本次会话改动和 Git diff |
| `/checkpoints` | 列出文件恢复点 |
| `/rewind` | 选择恢复点还原 |
| `/models` | 发现并选择模型 |
| `/language [zh-CN|en-US]` | 设置并持久保存界面与模型会话语言 |
| `/skills` | 浏览 Skills |
| `/skills install ...` | 安装本地或 HTTPS Git Skill |
| `/mcp` | 查看 MCP 连接与工具数 |
| `/mcp reload` | 重载 MCP 配置 |
| `/agents` | 查看所有多 Agent 运行 |
| `/agents <运行ID>` | 查看一个运行的详细状态 |
| `/agents cancel <运行ID> <任务ID>` | 单独取消一个 Agent |
| `/agents retry <运行ID> <任务ID>` | 重试可恢复任务 |
| `/agents integrate <运行ID> <任务ID>` | 审查并集成 Worktree 修改 |
| `/details` | 浏览工具和 Agent 的完整活动输出 |
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

## 二十三、安全建议

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

## 二十四、推荐的新手工作流

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
