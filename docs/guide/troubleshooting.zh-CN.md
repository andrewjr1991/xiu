# Xiu 使用指南 · 常见问题、错误码与配置恢复

本文是[使用指南目录](../../USAGE.zh-CN.md)的一部分；上手请先看[快速上手](../../QUICKSTART.md)。

## 常见问题

### 22.0 错误提示的格式与错误码

从 0.21 起，渠道配置、连接测试、联网搜索和后台任务的失败按统一格式显示（0.20.13 起启动时读到损坏的设置文件、信任名单或 MCP 配置，以及 `--cwd` 指向文件或不存在的目录也是），最多四行：第一行是出错的操作和一句人话原因，第二行“下一步”说明你可以做什么，第三行“诊断”给出一条只读命令（有的话），第四行“详情”保留错误码和脱敏后的原始信息，方便反馈给维护者。Key、Token 等秘密在任何一行都不会出现。

插件、Skill、MCP、凭据、报告、Diff 等其他命令以及交互模式里任务本身的失败，在 Xiu 能识别原因时（例如扩展授权记录损坏、网络或证书问题、服务拒绝 Key）也按同一格式显示，否则仍只有“操作：脱敏后的原始信息”一行，不附带泛泛的下一步。命令行参数或环境变量的值无效（例如 `--stall-timeout-seconds -1`、`--language xx`）始终只有一行 `Error: …`，不会因为消息里的字眼被当成网络超时或其他已编目的故障。

下表是全部错误码。`unknown` 表示 Xiu 没有识别出原因，此时第一行直接显示脱敏后的原始信息。

| 错误码 | 原因 | 下一步 |
| --- | --- | --- |
| `provider-config/unsafe` | 渠道配置文件或它所在的目录不是普通文件，可能被替换成链接、被其他程序占用，或所在目录不可写。 | 关闭其他 Xiu 窗口后重试；仍失败请运行诊断命令，并把输出发给维护者。（诊断：`xiu --provider-config-diagnostics`） |
| `provider-config/changed` | 另一个 Xiu 窗口或桌面端刚修改了渠道配置，本次改动没有保存。 | 重新打开渠道设置（CLI 为 /providers）核对最新配置后再操作。（诊断：`xiu --provider-config-diagnostics`） |
| `provider-config/busy` | 渠道配置正在被另一个 Xiu 进程写入，或上次写入中断后留下了锁。 | 关闭其他 Xiu 窗口后重试；如果没有其他窗口，运行诊断命令按提示处理中断的写入。（诊断：`xiu --provider-config-diagnostics`） |
| `provider-config/size-limit` | 渠道配置文件超过 4 MiB 的安全上限，没有写入。 | 检查是否有程序往 ~/.xiu/providers.json 里写了额外内容。（诊断：`xiu --provider-config-diagnostics`） |
| `provider-config/backup` | 要恢复的配置备份缺失、损坏或无法校验，配置没有改动。 | 运行诊断命令查看可用备份，再选择一个完好的备份恢复。（诊断：`xiu --provider-config-diagnostics`） |
| `provider-config/unsupported` | 渠道配置是更新版本的 Xiu 写入的格式，这个版本读不懂，配置没有改动。 | 把 CLI 和桌面端升级到同一版本后再试。（诊断：`xiu --provider-config-diagnostics`） |
| `provider-config/invalid` | 渠道配置文件内容无效，Xiu 没有改动它。 | 运行诊断命令查看问题；需要时从备份恢复。（诊断：`xiu --provider-config-diagnostics`） |
| `provider-config/confirmation` | 恢复操作需要先预览，再在有效期内明确确认。 | 重新运行恢复预览，然后按提示确认。（诊断：`xiu --provider-config-diagnostics`） |
| `provider-config/restart` | 渠道配置刚从备份恢复，这个 Xiu 进程还在用旧状态。 | 退出并重新打开 Xiu。 |
| `provider-config/reload` | 上一次保存渠道配置失败，或配置在别处被修改，Xiu 没有自动重试。 | 重新打开渠道设置（CLI 为 /providers）读取最新配置后再改。（诊断：`xiu --provider-config-diagnostics`） |
| `provider-config/write-unverified` | 渠道配置写入后没能回读确认，文件可能已更新也可能没有。 | 运行诊断命令确认当前内容后再决定是否重做。（诊断：`xiu --provider-config-diagnostics`） |
| `provider-config/io` | 读写渠道配置文件时出错，已有备份保留。 | 检查 ~/.xiu 是否可写、是否被安全软件拦截，然后运行诊断命令。（诊断：`xiu --provider-config-diagnostics`） |
| `config/settings` | Xiu 的设置文件（~/.xiu/settings.json）无法读取或不是有效的 JSON，Xiu 不会悄悄改用默认值。 | 修好它的 JSON，或把这个文件移走后重新启动；它只保存语言与联网搜索设置。（诊断：`xiu doctor`） |
| `config/trust-store` | 信任名单（~/.xiu/trusted-workspaces.json）无法读取，Xiu 无法判断任何工作区是否受信任，所以没有继续。 | 修好它的 JSON，或把这个文件移走；移走后每个工作区会重新询问一次是否信任。（诊断：`xiu doctor`） |
| `config/extension-permissions` | 扩展授权记录（~/.xiu/extension-permissions.json）无法读取，插件、Skill 与 MCP 都无法确认是否已获授权。 | 修好它的 JSON，或把这个文件移走；移走后已授权的插件、Skill 和 MCP 需要重新授权一次。（诊断：`xiu doctor`） |
| `config/mcp` | MCP 配置文件无法读取，或其中某个服务条目无效，这次没有连接任何 MCP 服务；其他功能照常可用。 | 按详情里的说明修正 ~/.xiu/mcp.json 或工作区的 .xiu/mcp.json，然后执行 /mcp reload 或重新启动。（诊断：`xiu doctor`） |
| `workspace/missing` | 工作区目录不存在：<路径>。 | 把 --cwd 指向一个已存在的项目目录，或先进入项目目录再运行 xiu。 |
| `workspace/not-directory` | 工作区路径是文件而不是目录：<路径>。工作区必须是目录。 | 把 --cwd 改成这个文件所在的项目目录。 |
| `workspace/unreadable` | 工作区目录存在但无法读取（权限不足或所在磁盘不可用）：<路径>。 | 检查这个目录的读取权限，或换一个你有权限读取的目录。 |
| `credential/missing` | 这个渠道还没有可用的 API Key。 | 在渠道设置里保存 Key（CLI 为 /provider key），或先设置渠道对应的环境变量。 |
| `http/401` | 服务拒绝了这个 API Key：Key 错误、已过期，或不属于这个地址。 | 核对 Key 和 Base URL 是否来自同一个服务商，然后重新保存 Key（CLI 为 /provider key）。 |
| `http/403` | 服务拒绝访问：账号没有这个模型的权限，或企业网关/代理拦截了请求。 | 在服务商控制台确认模型权限；公司网络请检查网关规则或用 --proxy 指定允许的代理。 |
| `http/404` | 地址或模型名不对：服务上没有这个接口或模型。 | 检查 Base URL 是否以 /v1 等正确路径结尾，再刷新模型列表（CLI 为 /models）选择一个存在的模型。 |
| `http/400` | 服务不接受这次请求的参数，常见原因是模型名拼错或模型不支持工具调用。 | 从刷新后的模型列表（CLI 为 /models）里选择服务返回的模型名；如果仍失败，换一个支持工具调用的模型。 |
| `http/409` | 服务报告请求与当前状态冲突。 | 稍后重试；持续出现请查看 /diagnostics。 |
| `http/429` | 请求过于频繁或额度用完，服务暂时限流。 | 等一会再试，或在服务商控制台检查余额与速率限制。 |
| `http/5xx` | 服务端出错，不是本机配置问题。 | 稍后重试；持续出现请查看服务商状态页。 |
| `network/dns` | 找不到这个服务器地址：域名拼写错误，或本机 DNS/代理无法解析它。 | 核对 Base URL 的域名；公司网络请用 --proxy 或 /web proxy set 指定代理。 |
| `network/refused` | 连接被拒绝：目标服务没有在这个地址和端口上运行。 | 本地模型请先启动 Ollama、LM Studio 或 vLLM，并核对端口。 |
| `network/tls` | HTTPS 证书不受信任，通常是公司网关替换了证书。Xiu 没有关闭证书校验。 | 把企业根证书加入系统信任或 NODE_EXTRA_CA_CERTS，或改用允许的代理。 |
| `network/proxy-auth` | 代理服务器要求认证（HTTP 407）。 | 在代理地址中带上账号密码，或换用不需要认证的代理。 |
| `network/timeout` | 连接或响应超时，服务没有在限定时间内回应。 | 检查网络和代理设置后重试；本地模型可能还在加载。 |
| `network/unreachable` | 无法建立网络连接。 | 检查网络、防火墙和代理设置后重试。 |
| `background/node-missing` | 后台任务需要本机安装的 Node.js，但没有找到。 | 安装 Node.js 22 或更高版本后重试。 |
| `background/stop-unconfirmed` | 后台任务的进程没能在限定时间内确认退出，任务仍标记为运行中。 | 用 /background list 查看进程号，必要时在任务管理器或 ps 中手动结束。（诊断：`/background list`） |
| `background/pid-reused` | 后台任务的进程早已退出，记录的进程号现在属于其他程序，Xiu 没有结束它们；任务已标记为中断。 | 用 /background list 确认状态；不需要手动处理。（诊断：`/background list`） |
| `cancelled` | 操作已取消。 | 需要时重新运行。 |

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

## 渠道配置诊断与恢复

preview.9 仅针对这两项 Windows 失败：后台目录枚举后对象消失时仅容忍 ENOENT，保留类型检查及其他错误；恢复入口测试夹具按生产流程初始化写锁所有者，不放宽 ACL 或恢复规则。具体诊断与回归证据待补齐，新功能继续暂停。继承 preview.8 的子 PowerShell 模块环境隔离；owner-only 回读与失败关闭不变。已有不安全恢复目录不会被静默修复或删除；不要直接删除可能包含原始配置备份的目录。

后台任务在输出或状态写入失败时保留固定代码的失败证据；只有本地元数据替换允许有界重试，命令及输出不重放。停止操作无法确认进程树结束时返回 XIU_BACKGROUND_STOP_UNCONFIRMED，保留活动/未知状态；请先核对进程状态，不要因为已有输出就重启同一操作。

- 正常渠道读取失败时，CLI 仍可运行 `xiu --provider-config-diagnostics`。这只显示格式版本、固定诊断代码和可验证的受保护备份元数据，不读取工作区或输出渠道、密钥、路径。
- 使用清单中的备份 ID 运行 `xiu --provider-config-preview <备份ID>`。此命令只预览，不写入配置。
- 需要恢复时运行 `xiu --provider-config-recover <备份ID>`，先关闭其他 Xiu 客户端，阅读预览后在交互式终端输入大写 `RECOVER`。空输入、其他输入、取消、`-y` 与管道输入不会授权恢复。预览过期、配置/备份/锁发生变化会拒绝恢复，必须重新诊断与预览。
- 桌面侧栏“Provider 配置诊断与恢复”不依赖 Provider 成功启动或工作区已受信任。点击备份预览，再点击“继续并确认”，最后在系统弹窗确认；取消预览、关闭面板或取消系统弹窗均不更改配置。任务、交互终端和 OAuth 未结束时不能恢复。
- `current` 是独立的“保留当前配置并清理中断写锁”操作，仅在诊断确认锁所属进程已退出、当前格式有效或配置尚不存在时可用。它不恢复备份、不复制配置；不能清理活动或未知来源的锁。锁里记录了持有进程的启动时间，所以即使系统把那个进程号重新分给了别的程序，Xiu 也能认出原进程已经退出。
- 备份恢复会替换当前设置，包括旧明文凭据与凭据引用；被替换文件先保存为受保护备份。系统凭据不恢复、不更改，旧引用可能已经失效。备份可能含旧凭据，应保持本机私密，不上传或分享。未来格式不得回退为当前格式。
- 成功后 CLI 退出，桌面阻止继续任务与配置操作直至重启。CLI 和桌面需配套升级；恢复旧备份后，新客户端可能再次升级格式。恢复不会重放任务或恢复工作区信任。
