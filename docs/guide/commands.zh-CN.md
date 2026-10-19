# Xiu 使用指南 · 命令与启动参数速查

本文是[使用指南目录](../../USAGE.zh-CN.md)的一部分；上手请先看[快速上手](../../QUICKSTART.md)。

## 所有交互命令速查

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
| `/diff [task\|workspace\|staged]` | 0.18.0 起：本任务期间、工作区或暂存区差异；默认 task，来源不确定会标注 |
| `/diff runs` | 0.20.13 起：列出最近 50 次运行及各自保存的改动文件数 |
| `/diff run:<序号\|运行 ID 前缀> [文件]` | 0.20.13 起：回放某次运行结束时保存的改动记录；带文件路径时显示该文件的完整差异 |
| `/check [typecheck\|lint\|test\|build\|all]` | 0.18.0 起：不带参数只发现标准 npm 脚本，带参数经审批执行；Plan 只允许发现 |
| `/media` | 查看媒体生成记录、稳定请求 ID 和可恢复状态 |
| `/checkpoints` | 列出文件恢复点 |
| `/rewind` | 选择恢复点还原 |
| `/models` | 发现并选择模型 |
| `/routing` | 查看阶段模型路由总开关与规划、实现、验证绑定 |
| `/routing on` / `/routing off` | 启用或停用阶段模型路由 |
| `/routing set <阶段>` | 为 `planning`、`implementation` 或 `verification` 选择 Provider |
| `/routing clear <阶段>` | 清除一个阶段的 Provider 绑定 |
| `/language [zh-CN|en-US]` | 设置并持久保存界面与模型会话语言 |
| `/skills` | 浏览 Skills；找到但未列出的 Skill（无法读取、同名被更高优先级范围覆盖、超过大小或数量限制）会在列表前用一行说明 |
| `/skills install ...` | 安装本地或 HTTPS Git Skill |
| `/mcp` | 查看 MCP 连接与工具数 |
| `/mcp add [name] [url] [TOKEN_ENV]` | 添加用户级 Streamable HTTP MCP |
| `/mcp remove [name]` | 删除用户级 MCP 配置 |
| `/mcp test [name]` | 重连并测试一个或全部 MCP |
| `/mcp reload` | 重载 MCP 配置 |
| `/mcp resources` / `/mcp read` | 浏览和读取不可信的远端 Resource；0.20.13 起 `/mcp read <名称> <模板名> 变量=值` 可填参数读取 Resource Template |
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
| `/update` | 显式检查 npm 官方最新版并显示更新指导，不自动安装 |
| `/doctor` | 一份只读诊断报告：安装、渠道、联网搜索、代理与证书、PowerShell；已脱敏，可直接贴给维护者 |
| `/update doctor` | 只读诊断运行时、命令来源、npm prefix、包完整性、更新代理、缓存和官方 Registry |
| `/update status` | 查看更新提醒开关、24 小时缓存和行为边界 |
| `/update notifications on` | 显式开启非阻塞更新提醒 |
| `/update notifications off` | 关闭更新提醒（默认状态） |
| `/queue` | 查看明确安排的后续任务 |
| `/queue <任务>` | 安排一项独立任务在当前任务之后运行 |
| `/clear-queue` | 清空尚未执行的独立任务 |
| `/cancel` | 取消当前任务并选择停止、重试或继续 |
| `/clear` | 开始新会话 |
| `/help [命令]` | 显示全部命令，或只显示一个命令的用法 |
| `/exit` | 退出 Xiu |

在交互提示符里，以斜杠开头的单个词如果不是上表中的命令（例如 `/skils`、`/hepl`），Xiu 不会把它当作任务发给模型，而是提示“未知命令”、最接近的命令和 `/help`；命令对了但后面的用法没有被识别（`/mcp premissions`、`/plan onn`）时，列出该命令的全部用法和最接近的一项。任务运行中的“补充>”提示符同样处理，并且只接受 `/cancel`、`/exit`、`/queue`、`/clear-queue`、`/status`、`/diff`、`/check`、`/diagnostics`、`/details`、`/paste`、`/credentials`、`/web`、`/language`：输入其他命令（如 `/mcp`）会提示等任务结束后再用，而不会被当作对任务的补充发给模型。以路径开头的任务（`/etc/hosts 有什么问题`、`/tmp 下有什么`）不受影响；如果一行任务内容恰好以斜杠开头的单词开始，请换个写法，不要以斜杠开头。`/help <命令>`（如 `/help mcp`、`/help plan on`）只列出该命令的用法。斜杠命令只在交互模式可用：`xiu /help`、`xiu /doctor` 这样的一次性运行不会开始，也不会把它发给模型，而是提示进入交互模式或对应的脚本命令（`xiu doctor`、`xiu report`、`xiu recover`、`xiu audit`、`--check-update`、`--list-sessions` 等），退出码 1；`--json` 下 `result` 行的 `outcome` 为 `not_started`。脚本命令拼错时同样如此：`xiu doctr`、`xiu reprot json`、`xiu Doctor` 这类最多三个词、首词与 `doctor`/`report`/`recover`/`audit` 只差一个字母或大小写、其余词是该命令参数的一次性任务，不会进入信任询问或发给模型，而是提示“未知命令 … 你是想运行 xiu doctor 吗？”并退出码 1；更长的任务或带其他词的任务（`edit README`、`doctr 修一下测试`）仍按任务处理。

## 启动参数速查

`xiu --help` 除启动参数外，也列出下面不进入交互模式的命令（`xiu doctor`、`xiu report`、`xiu recover`、`xiu audit`）、一次性任务的退出码，以及“斜杠命令只在交互模式可用”的提示。

标准输出或标准错误接的管道被对端关闭时（`xiu report | head -1`、`xiu --json '任务' | jq -c . | head -1`、读取输出的程序先退出了），Xiu 不再因 `write EPIPE` 带着 Node 调用栈崩溃：没有任务在跑（`xiu doctor`、`xiu report`、`xiu audit`、`--help` 等）就按当时的退出码安静结束；一次性任务或交互会话中的任务正在运行时，像按下 Ctrl+C 一样取消它、等运行记录写完再退出，不会在任务运行日志里留下“运行中”的中断记录，队列里后面的任务也不再开始。

标准输入是管道的交互会话（`printf '/mcp\n' | xiu`、脚本把命令逐行喂给 Xiu）在输入结束时按 `/exit` 处理：提示符处读到输入结束就打印“输入已结束，退出 Xiu。”，关闭 MCP 服务器后以退出码 0 结束；之前已连接的 MCP 服务器会让进程停在 `xiu>` 永不退出，没有 MCP 时则跳过收尾直接消失。任务运行中输入结束不会打断任务：任务照常跑完（失败时的“下一步怎么做”菜单在无终端时仍按取消处理），回到提示符后再退出。

收到 `SIGTERM`（`timeout 300 xiu --json '任务'` 超时、`kill`、容器停止、CI 作业取消）或 `SIGHUP`（终端关闭）时，Xiu 像按下 Ctrl+C 一样处理，而不是像默认那样立刻死掉：正在运行的任务被取消并写完运行记录（状态为已取消，下一次启动不会报“异常中断任务”），一次性任务仍输出最后的 `result` 行（`outcome` 为 `cancelled`）并以退出码 1 结束，空闲的交互会话按 `/exit` 收尾退出；标准错误会打印一行“收到 SIGTERM，……”。直接关闭终端窗口也走这条路：窗口消失后对终端的写入会报 EIO，Xiu 把它和管道关闭同样对待，不会因此崩溃，仍然取消任务、写完记录再退出。收尾进行中再收到一次信号就立即退出（退出码 143 / SIGHUP 为 129）。Windows 上这两个信号由系统直接终止进程，不经过此处理。

| 参数 | 作用 |
| --- | --- |
| `-p, --provider <ID>` | 本次使用的渠道 Profile ID（`/providers` 可查看，插件提供的渠道在工作区信任后也可用）；已配置了渠道而 ID 不在其中时，启动即在标准错误列出已配置的渠道并退出码 1（`--json` 下 `result` 行为 `not_started`），不会连接 MCP 或进入配置模式；尚未配置任何渠道时仍进入首次向导 |
| `-m, --model <模型>` | 指定文本模型 |
| `-C, --cwd <目录>` | 指定工作区 |
| `--base-url <URL>` | OpenAI 兼容 API 地址 |
| `--media-base-url <URL>` | 多媒体生成 API 地址 |
| `--proxy <URL>` | HTTP(S) 代理 |
| `--vision-model <模型>` | 图片分析模型 |
| `--image-model <模型>` | 图片生成模型 |
| `--video-model <模型>` | 视频生成模型 |
| `--audio-model <模型>` | 音频或语音生成模型 |
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
| `--trust-workspace` | 只在本次运行里把工作区视为已信任，跳过信任询问；不写入信任列表，只能由命令行给出，供脚本与 CI 在自己掌控的检出目录上使用（没有可交互终端时信任询问不会出现，也不接受管道里的答案，所以脚本只能靠它） |
| `xiu '<任务>'` | 不进入交互模式，完成一个任务后退出；退出码 0 完成 / 2 未验证 / 3 模型等待回答 / 1 失败、取消、暂停或未开始（与 `--json` 一致）。工作区未信任且没有可交互终端（管道、CI）时不开始：不从管道读取信任答案，标准错误说明原因并退出码 1；在终端里回答“退出”同样退出码 1 |
| `--json` | 仅限一次性任务：标准输出改为 JSON Lines 运行时事件流并以 `result` 行结束，人读文字全部转到标准错误；退出码 0 完成 / 2 未验证 / 3 等待回答 / 1 失败 |
| `xiu report [markdown\|json\|html] [summary\|details] [run:<序号\|ID 前缀>] [路径]` | 不进入交互模式，导出最近一次（或 `run:` 指定的一次）任务的执行报告（同 `/report export`）；`xiu report runs` 列出最近运行；省略路径写到标准输出；已存在的文件需加 `--yes` 才覆盖；只在已信任的工作区可用 |
| `xiu recover [status]` / `xiu recover abandon <运行 ID 或 ≥4 位前缀>` | 不进入交互模式处理异常中断任务：`status` 打印中断任务摘要（任务、最后恢复点、待核验副作用），有中断任务时退出码 2、没有时 0；`abandon` 只在给出的 ID 与当前中断任务匹配时把它标记为已放弃，不重放任何操作；恢复只能在可交互终端里不带任务运行 `xiu` 确认；只在已信任的工作区可用，不能与 `--json` 同用 |
| `xiu audit [approvals\|credentials] [json] [条数]` | 不进入交互模式，只读列出当前工作区的本机安全审计记录（`/audit` 的脚本版）：默认最近 50 条、最多 500 条，`json` 输出一份 JSON 文档；只含时间、类别、动作、结果、风险、决策来源、作用域和非秘密主体，不含命令正文、路径或凭证；只在已信任的工作区可用，退出码 0 列出（含空）、1 参数错误/未信任/账本不可读，不能与 `--json` 同用 |
| `--version` | 显示版本 |
| `--check-update` | 显式检查 npm 官方最新版并安全退出 |
| `--update-doctor` | 执行只读分发、命令解析与更新诊断并安全退出；本地硬错误返回非零退出码 |
| `--doctor` / `xiu doctor [json]` | 输出合并的只读诊断报告（安装、渠道、联网搜索、代理与证书、PowerShell、工作区的运行记录/会话日志/中断任务）并退出；`json` 输出同一份报告的 JSON 文档（中英文都在内，供脚本与 CI 读取 `status` 与各项 `level`）；其他词视为用法错误；存在错误时两种形式都返回 1 |
| `--help` | 显示命令行帮助 |

查看当前版本实际支持的参数：

```powershell
xiu --help
```
