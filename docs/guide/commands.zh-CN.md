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
| `/skills` | 浏览 Skills |
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
| `/help` | 显示帮助 |
| `/exit` | 退出 Xiu |

## 启动参数速查

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
| `--trust-workspace` | 只在本次运行里把工作区视为已信任，跳过信任询问；不写入信任列表，只能由命令行给出，供脚本与 CI 在自己掌控的检出目录上使用 |
| `xiu '<任务>'` | 不进入交互模式，完成一个任务后退出；退出码 0 完成 / 2 未验证 / 3 模型等待回答 / 1 失败、取消或暂停（与 `--json` 一致） |
| `--json` | 仅限一次性任务：标准输出改为 JSON Lines 运行时事件流并以 `result` 行结束，人读文字全部转到标准错误；退出码 0 完成 / 2 未验证 / 3 等待回答 / 1 失败 |
| `xiu report [markdown\|json\|html] [summary\|details] [run:<序号\|ID 前缀>] [路径]` | 不进入交互模式，导出最近一次（或 `run:` 指定的一次）任务的执行报告（同 `/report export`）；`xiu report runs` 列出最近运行；省略路径写到标准输出；已存在的文件需加 `--yes` 才覆盖；只在已信任的工作区可用 |
| `xiu recover [status]` / `xiu recover abandon <运行 ID 或 ≥4 位前缀>` | 不进入交互模式处理异常中断任务：`status` 打印中断任务摘要（任务、最后恢复点、待核验副作用），有中断任务时退出码 2、没有时 0；`abandon` 只在给出的 ID 与当前中断任务匹配时把它标记为已放弃，不重放任何操作；恢复只能在可交互终端里不带任务运行 `xiu` 确认；只在已信任的工作区可用，不能与 `--json` 同用 |
| `--version` | 显示版本 |
| `--check-update` | 显式检查 npm 官方最新版并安全退出 |
| `--update-doctor` | 执行只读分发、命令解析与更新诊断并安全退出；本地硬错误返回非零退出码 |
| `--doctor` / `xiu doctor` | 输出合并的只读诊断报告（安装、渠道、联网搜索、代理与证书、PowerShell）并退出；存在错误时返回 1 |
| `--help` | 显示命令行帮助 |

查看当前版本实际支持的参数：

```powershell
xiu --help
```
