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
- 右侧 Quick start、模型、授权方式和 Skills 数量。
- `xiu>` 输入行。
- 输入行下方的模型、上下文占用、Plan 模式、Skills、MCP 和工作区状态栏。

在 `xiu>` 后输入自然语言，然后按 Enter：

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

### 6.1 任务运行时继续输入

Agent 工作时输入框不会消失，而是变为：

```text
xiu[working]>
```

从 v0.7.2 开始，此时输入普通文字表示“补充当前任务”。Xiu 会在下一次模型调用前把它作为 steering 注入当前目标。例如当前正在生成在线表格时输入“同时生成 JSONL”，不会再被理解成一个独立的工具开发任务。

从 v0.7.3 开始，最初提交的任务会被固定为不可覆盖的主目标，运行中的普通输入只能增加要求，不能替换主目标。模型准备结束时，Xiu 还会执行一次任务契约审计；如果模型只回答了最新补充、尚未完成原始任务，它会被要求继续工作。

从 v0.7.4 开始，循环保护只判断近期连续、没有新进展的调用序列。长任务中经过其他调查后重新读取规则或源文件是允许的；上下文压缩和成功修改文件后，旧的循环证据会被清空。真正的连续重复调用和短周期调用循环仍会被阻断。

状态栏显示当前 Turn/最大轮数、阶段、耗时、待注入补充、显式队列和最近一条工具活动。按 `Ctrl+O` 可展开最近八条活动，再按一次收起，不会提交或清空草稿。

只有明确输入 `/queue <任务>` 才会安排当前任务结束后运行的独立任务。

运行期间可立即使用：

| 操作 | 作用 |
| --- | --- |
| 普通文本 + Enter | 补充当前任务，在下一模型轮次注入 |
| `Ctrl+O` | 展开或收起实时工具活动 |
| `/details` | 运行期间切换实时活动显示 |
| `/queue <任务>` | 明确安排一项独立后续任务 |
| `/queue` | 查看明确安排的任务 |
| `/clear-queue` | 清空尚未开始的独立任务 |
| `/cancel` 或 `Ctrl+C` | 取消当前任务并打开后续处理选择 |
| `/status` | 查看 Turn、结果状态、阶段和调用统计 |
| `/exit` | 取消当前任务、清空队列并退出 |

需要写入、执行或危险操作审批时，Xiu 会先挂起运行期输入框，再显示审批菜单。审批默认仍是“拒绝”；审批结束后，未提交的草稿会恢复。

如果当前任务失败、取消、陷入重复工具循环，或修改文件后没有验证通过，Xiu 不会自动执行独立队列，而会让用户选择停止、基于已有证据重试或跳过当前任务。默认选项是停止。

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

从 v0.8.0 开始，压缩结果不是一段无约束的普通摘要，而是“上下文检查点”。Xiu 会在程序层面保留以下信息：

- 最初提交的主任务；
- 运行中追加的 steering 要求；
- 当前任务计划；
- 已完成证据、关键决定、失败方法、下一步和验证状态。

压缩后的模型会被要求从记录的下一步继续，避免重新扫描已经确认的文件。若模型摘要遗漏主任务，程序保存的任务契约仍然是权威来源。

`read_file` 默认只返回 200 行，并提示下一次应使用的 `start_line`。对于压缩成一行的 HTML、JSON 或其他超长文本，Xiu 会使用 `start_character` 和 `max_characters` 分段读取；每个结果都会标明当前字符范围和下一偏移量。这可以防止单个大文件一次占满上下文。

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
| `/compact` | 立即压缩上下文 |
| `/plan` | 查看任务计划和 Plan 模式 |
| `/plan on` | 开启只读 Plan 模式 |
| `/plan off` | 关闭 Plan 模式 |
| `/tasks` | 查看实时任务步骤 |
| `/diff` | 查看本次会话改动和 Git diff |
| `/checkpoints` | 列出文件恢复点 |
| `/rewind` | 选择恢复点还原 |
| `/models` | 发现并选择模型 |
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
| `--context-limit <Token>` | 自动压缩阈值，默认 60000 |
| `--max-turns <次数>` | 单任务最大 Agent 轮数，默认 30 |
| `--agent-concurrency <数量>` | 并发子 Agent 上限，1 到 8，默认 3 |
| `-y, --yes` | 自动批准非危险写入和执行 |
| `--version` | 显示版本 |
| `--help` | 显示命令行帮助 |

查看当前版本实际支持的参数：

```powershell
xiu --help
```

## 二十一、中断和退出

模型思考或工具执行过程中按 Ctrl+C，会取消当前任务并打开恢复选择。Xiu 不会未经确认自动执行显式队列。需要直接取消、清空并退出可输入：

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
