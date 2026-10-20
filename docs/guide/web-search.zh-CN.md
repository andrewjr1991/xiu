# Xiu 使用指南 · 联网搜索

本文是[使用指南目录](../../USAGE.zh-CN.md)的一部分；上手请先看[快速上手](../../QUICKSTART.md)。

## 原生只读联网搜索（v0.15.0）

v0.15.0 提供 `web_search` 和 `web_open` 两个内置只读工具。它们默认不启用；完成配置后，Xiu 才能在需要时搜索公开网页、打开结果并在回答中保留精确来源 URL。

常用命令：

```text
/web
/web status
/web doctor
/web reset
/web proxy
/web proxy set http://127.0.0.1:12334
/web proxy clear
/web configure free-search
/web configure tavily
/web configure brave
/web configure searxng
/web disable
```

### 本机免 Key 搜索：free-search（默认）

新安装默认使用本机运行的开源项目 [free-search-mcp](https://github.com/sweetcornna/free-search-mcp)（MIT）。它同时查询 DuckDuckGo、Bing、AnySearch、Mojeek 等引擎，按名次融合去重；遇到版本号、CVE、天气、汇率这类问题，还会直接从对应的官方数据源取记录。不需要申请任何 API Key，搜索请求从你自己的网络发出。

它通过 [uv](https://docs.astral.sh/uv/) 启动，不需要自己安装：桌面安装版自带固定版本的 uv（0.12.21）；CLI 优先用 PATH 里已有的 uv，没有时在第一次搜索时自动下载同一固定版本到 `~/.xiu/uv/`（依次尝试 PyPI 官方、清华、阿里云镜像，只接受与内置 SHA-256 完全一致的文件，代理沿用 `/web proxy` 或终端的 `HTTPS_PROXY`）。第一次搜索还会下载 Python 依赖，可能需要几十秒到几分钟，期间先用托管搜索；执行 `/web doctor` 可以提前准备并测试一次。

安全边界：

- Xiu 固定使用 free-search-mcp `0.13.1`，所有依赖都锁定到确切版本（0.13.1 未锁定的 `selectolax` 在 1.x 下无法启动）。
- 只开放它的 `search` 工具；抓取、下载、research 等工具不注册，登录类引擎和智能体后端保持关闭。
- 它在 `~/.xiu/free-search/` 下运行，使用独立的配置和缓存目录，不读取你自己为 free-search 准备的 `.env` 或项目目录里的 `.env`；Xiu 的模型 Key 等环境变量不会传给它。
- 打开网页仍由 Xiu 的 `web_open` 完成，HTTPS、内网拦截、重定向复核、域名策略和来源核验规则都不变；`/web proxy` 设置的联网代理同样用于 free-search。

uv 准备失败、启动失败或本机搜索没有可用结果时，`web_search` 会自动改用 Xiu 托管搜索，并在结果里注明使用了回退。国内网络下 DuckDuckGo 等引擎可能无法访问，主要依赖 Bing 和 360 搜索；结果偏少时可以配置 `/web proxy set`。

旧版本保存的「Xiu 托管搜索」预置会在升级后自动切换到 free-search（仍以托管搜索作回退）；之后明确选择的配置会被保留。只想用托管搜索时，在桌面「工具与运行设置 → 联网检索」选择「Xiu 托管搜索 · 自动认证」。「工具与运行设置」的入口是打开可信工作区后右上角的齿轮按钮，也可以从「设置 → 对话与运行 → 联网检索、模型路由与 Skills」点「打开」进入。

CLI 和桌面一样只显示检索结果的简短说明（「返回 N 条结果」「已读取网页：标题 · 网址」）；发给模型的「UNTRUSTED WEB CONTENT」安全提示不再显示在终端里，用 `/details` 仍可查看完整原文。

### Tavily

Tavily 面向 AI 检索，免费计划目前每月提供 1,000 credits，注册无需信用卡。到 Tavily 控制台创建 Key 后，先在当前 PowerShell 会话设置：

```powershell
$env:TAVILY_API_KEY = '你的实际 Tavily API Key'
```

然后执行 `/web configure tavily`，端点直接回车使用 `https://api.tavily.com/search`。Xiu 使用节省额度的 basic search，不请求答案、原始正文或图片；一次基础搜索通常消耗 1 credit。

### Brave Search

Brave Search 需要 API Key。Xiu 只保存环境变量名，不保存 Key 正文；例如先在当前 PowerShell 会话设置：

```powershell
$env:BRAVE_SEARCH_API_KEY = '你的实际 API Key'
```

然后执行 `/web configure brave`。也可以在向导中填写其他环境变量名。

### 自建 SearXNG

SearXNG 必须填写你自建或信任的 HTTPS 实例地址；既可填写实例根地址，也可填写以 `/search` 结尾的地址。`settings.yml` 必须显式允许 JSON 输出，否则搜索会返回 HTTP 403：

如果使用带 Docker 的宝塔 VPS，推荐直接运行仓库中的交互式安装脚本：

```bash
sudo bash scripts/install-searxng-vps.sh --domain search.example.com
```

脚本会自动生成随机密钥、创建 SearXNG 与 Valkey 容器、仅监听本机端口、通过 `/healthz` 检查服务状态，并生成宝塔 Nginx 配置和 Xiu 客户端 Token 说明。它不会修改宝塔或抢占 80/443；运行结束后只需按提示在宝塔添加域名、SSL，并粘贴生成的反向代理配置。已有安装会先备份，使用 `--help` 可查看端口和目录选项。

以下是需要手工部署或排障时使用的配置原理：

```yaml
use_default_settings: true

general:
  debug: false
  instance_name: "Xiu Search"

search:
  safe_search: 1
  formats:
    - html
    - json

server:
  secret_key: "请替换为足够长的随机值"
  # 私有 Xiu API 由前置 Nginx Bearer Token 保护。
  # limiter 会把 Xiu/curl 等 API 客户端识别为机器人，因此关闭。
  limiter: false
  image_proxy: false

valkey:
  url: valkey://valkey:6379/0
```

公网部署必须放在 HTTPS 反向代理后面，不要直接暴露容器端口。安装脚本生成的私有 API 使用 64 位随机 Bearer Token 保护全部路径，并关闭面向公共浏览器实例的 SearXNG limiter，避免误拦截 Xiu、curl 等自动客户端。不要在没有 Token 认证或其他等效访问控制时关闭 limiter；如需向公众开放网页搜索，应重新启用 limiter 并按官方文档配置可信代理和限流策略。在 Xiu 配置向导中填写保存该 Token 的环境变量名即可；Xiu 只保存变量名，发送搜索请求时才读取 Token。

最小验收：

```powershell
Invoke-RestMethod 'https://search.example.com/search?q=xiu&format=json'
```

安装脚本会用 `/healthz` 判断服务是否启动，仅额外执行一次真实 JSON 搜索。若健康检查返回 `OK`，但搜索检查提示 `429 Too Many Requests`，通常是上游搜索引擎临时限流，并不代表容器安装失败。不要反复执行真实搜索作为健康检查；先完成 HTTPS 反向代理，再通过公网端点做一次验收即可。

若启用了 Bearer Token：

```powershell
$env:XIU_SEARXNG_TOKEN = '你的长随机 Token'
Invoke-RestMethod 'https://search.example.com/search?q=xiu&format=json' -Headers @{ Authorization = "Bearer $env:XIU_SEARXNG_TOKEN" }
```

再运行 `/web configure searxng`，填写 HTTPS 域名和可选的 `XIU_SEARXNG_TOKEN`。不要使用 HTTP、localhost、内网 IP 或在 URL 中嵌入用户名密码；这些目标会被 Xiu 拒绝。

### Xiu 内测搜索预置（v0.15.1）

内测包预置了 `https://search.jingran.vip` 及其设备认证端点，但不包含共享 Token、邀请码、管理 Token 或其他可直接使用的秘密。新安装和从旧版本升级的用户无需设置环境变量：Xiu 启动时只注册 `web_search` 与 `web_open` 工具，第一次真正搜索时才自动登记本机并申请 15 分钟短期 Token，因此不会拖慢普通启动。

设备凭证优先保存到当前 Windows 账号的凭证管理器；企业策略或可选原生模块不可用时，降级保存到当前用户目录 `~/.xiu/search-auth.json`，文件权限收紧为仅当前用户可读写。该凭证仅属于这一台安装，可由服务器单独撤销；15 分钟访问 Token 只存在于当前进程内存，不写入设置、会话、报告或日志，并会在到期前自动续签。

优先级规则：

1. 用户通过 `/web configure` 保存的配置优先于内测预置。
2. `/web disable` 会保存明确的停用状态，后续启动不会被环境变量重新启用。
3. 删除用户配置后，下一次加载会恢复默认的本机 free-search，并以托管搜索作回退；旧版保存的 `XIU_BETA_SEARXNG_TOKEN` 引用会自动迁移。
4. 为兼容已设置旧环境变量的内测设备，变量存在时仍可继续使用；删除后会自动切换到设备认证。
5. Xiu 不把设备秘密或短期 Token 写入 `~/.xiu/settings.json`、会话、诊断或日志。

服务器管理员可以按设备撤销访问。设备被撤销后，旧设备凭证和已经签发的 Token 会立即失效；Xiu 下次搜索会尝试重新登记，并继续受服务器注册配额约束。

### 设备凭证与短期 Token 服务

仓库提供 `scripts/install-xiu-search-auth-vps.sh`，用于在现有 SearXNG 前增加独立设备注册、15 分钟短期 Token、设备撤销和每设备限流。该服务使用基于 glibc 的 Debian Python 容器运行，并把 SQLite 数据保存在 Docker 管理的 `xiu-search-auth-data` 命名卷中，避免旧版 CentOS/Docker 与 Alpine musl SQLite 的 I/O 兼容问题，以及 SELinux 标签和特殊宿主机挂载造成的写入问题。授权端口默认只监听 `127.0.0.1:8787`，管理接口不会由生成的 Nginx 配置暴露到公网。搜索请求由授权服务验证后转发到本机 SearXNG，因此兼容未编译 `http_auth_request_module` 的宝塔 Nginx。

先把整个 `scripts` 目录上传到 VPS，然后运行：

```bash
sudo bash scripts/install-xiu-search-auth-vps.sh \
  --domain search.jingran.vip \
  --searxng-port 8080
```

安装器默认开启受限的公开设备登记，每个公网 IP 每 24 小时最多登记 5 台设备，并同时启用每设备和每 IP 的搜索限流。若希望关闭公开登记，可在 `auth.env` 中设置 `XIU_AUTH_PUBLIC_REGISTRATION=false`，再使用邀请码或固定公司出口 IP：

```bash
sudo bash scripts/install-xiu-search-auth-vps.sh \
  --domain search.jingran.vip \
  --trusted-cidrs '203.0.113.10/32,198.51.100.0/24'
```

安装完成后：

1. 在宝塔站点配置中删除原来的 `location /` 区块。
2. 粘贴 `/opt/xiu-search-auth/bt-nginx-xiu-search.conf` 中的全部 `location` 配置。
3. 保存后访问 `https://search.jingran.vip/xiu-auth/healthz`，应返回 `{"status":"ok"}`。
4. 邀请码、管理 Token 和仅限 VPS 本机执行的设备管理命令保存在 `/opt/xiu-search-auth/admin.txt`。

安装器会读取现有 `/opt/xiu-searxng/searxng.env`，只把旧 Token 的 SHA-256 摘要交给网关。因此已配置旧 Token 的 Xiu 仍能使用，网关本身不复制旧 Token 正文。所有设备迁移后，可以从 `auth.env` 删除 `XIU_AUTH_LEGACY_TOKEN_SHA256` 的值并重启网关，正式关闭旧共享 Token。

从 v0.15.7 起，升级会保留现有 `auth.env` 中合法的 `XIU_AUTH_DATABASE`，不会自动切换数据库文件。启动前还会只读检查命名卷：如果目标数据库为空，但其他 `*.sqlite3` 文件包含设备记录，安装器会停止，不会启动一个看似健康但设备列表为空的服务。先根据输出核对候选文件，再显式迁移，例如：

```bash
sudo bash scripts/install-xiu-search-auth-vps.sh \
  --domain search.jingran.vip \
  --source-dir /root/xiu-search-auth-deploy/xiu-search-auth \
  --database /data/xiu-search-auth.sqlite3 \
  --migrate-database-from /data/xiu-search-auth-v3.sqlite3 \
  --yes
```

迁移会先执行只读预览；目标数据库已经存在时，再用 SQLite backup API 在同一命名卷创建权限为 `600` 的时间戳备份，然后通过单个事务导入缺失设备并追加 `restored` 审计事件。相同设备重复执行会跳过；同一设备 ID 对应不同凭证数据、schema 不兼容、路径不在 `/data`、符号链接或备份失败时均在服务启动前终止。安装器不会删除源数据库或迁移备份。

数据卷权限现在由一次性 helper 容器初始化。该容器禁用网络、使用只读根文件系统，并只临时获得 `CHOWN`、`DAC_OVERRIDE` 和 `FOWNER`；数据库迁移 helper 还限制为 128 MiB 内存和 64 个进程。长期授权服务仍以 UID/GID `10001`、无 Linux capabilities 和 `no-new-privileges` 运行。数据库参数只接受 `/data` 下的普通 `.sqlite3` 文件；检测到损坏或 schema 不兼容的历史凭证库时会停止升级，不会把异常库当成空库忽略。

安全注意事项：

- `auth.env` 与 `admin.txt` 权限为 `600`，不得上传、截图或提交 Git。
- 公开登记必须保留每日 IP 配额；关闭公开登记后，邀请码只用于设备首次登记并应定期轮换。
- 公司 IP 免邀请码注册只应填写可确认的公网出口地址，不要使用 `0.0.0.0/0`。
- 每台设备的长期凭证优先保存在 Windows 凭证管理器；兼容文件仅限当前用户访问。访问 Token 只保存在内存并在到期前续签。
- 真实宝塔 VPS 已完成无 Token 拒绝、设备登记、短期 Token、认证搜索、设备撤销及撤销后拒绝的闭环验收。

### 搜索失败与证据门禁（v0.15.3）

托管搜索的设备登记、短期 Token 签发、`web_search` 和 `web_open` 使用同一套独立联网代理，不再继承当前模型 Provider 的代理。默认直连；需要代理时执行 `/web proxy set http://127.0.0.1:12334`，执行 `/web proxy` 查看当前状态，执行 `/web proxy clear` 恢复直连。这三个命令会持久保存并立即重建联网工具，但不会修改当前模型 Provider 的代理。也可以在 `/web configure` 向导中填写代理，或通过 `XIU_WEB_PROXY` 提供启动默认值。

preview.12 起显式联网配置会完整保存，`/web proxy clear` 持久清除联网代理，重启仍使用该显式直连设置。`XIU_WEB_PROXY` 只在没有显式联网配置时提供默认代理；删除配置后仍可能再次从环境变量恢复。这样 Agnes 可以单独走 Provider 代理，而无需代理的其他模型和联网搜索仍可直连。

当任务要求“最新”“当前”或联网检索，而本次任务的所有 `web_search` 都失败或没有返回可用结果时，Xiu 会：

1. 阻止模型把记忆、无关页面或推测日期包装成搜索结果。
2. 允许一次采用不同安全方法的恢复尝试；仍失败时输出脱敏后的真实错误。
3. 把任务标记为失败，而不是显示为成功或已验证。
4. 仅在确有显式验证工具成功记录时，才在 `/report` 中显示“已验证”。

对于“最新”“最近”“当前”“今日”或明确限定时间范围的检索，成功返回搜索列表也不等于完成。搜索摘要只用于发现候选来源；Xiu 会要求模型通过 `web_open` 打开最终准备引用的每个 URL，按当前日期检查页面是否支持所述事件与日期，并剔除无法确认或超出时间范围的条目。最终答复中的每个 HTTP(S) 链接都必须在本次任务中成功打开，否则答复会被证据门禁拦截并标记失败。若只有少于用户要求数量的来源通过核验，应如实返回较少条目，不能靠记忆补足。

因此，看到“联网搜索未成功”表示 Xiu 没有取得足够证据；此时应检查代理、网络或服务状态，不应把模型生成的内容当成最新事实。

Windows 上使用支持系统证书读取的 Node.js 时，Xiu 会合并 Node 内置根证书与 Windows 系统信任库。集团 HTTPS 检查证书只要已经受 Windows 信任，通常无需额外设置，也绝不能通过关闭 TLS 校验解决。若旧版 Node 或企业策略仍导致 `SELF_SIGNED_CERT_IN_CHAIN`，应升级 Node，或在启动 Xiu 前通过 `NODE_EXTRA_CA_CERTS` 指向管理员提供的 PEM 根证书；仅当搜索网络本身必须经过代理时才设置 `XIU_WEB_PROXY`。

设备登记返回 `registration_not_allowed` 表示服务端关闭了自动登记，并非客户端没有发起注册。内测托管服务必须在 `/opt/xiu-search-auth/auth.env` 中保持 `XIU_AUTH_PUBLIC_REGISTRATION=true`，同时保留每 IP 每日登记配额。修改后应重建服务，并使用 `/xiu-auth/healthz` 确认 `publicRegistration` 为 `true`。认证、权限和证书链这类确定性错误会在第一次失败后立即结束任务，避免模型绕开搜索工具反复访问无关网页。

配置向导还支持：

- 允许域名和阻止域名清单；子域名会按所属域匹配。
- 1000 至 60000 毫秒的请求超时。
- 使用独立的联网搜索代理；默认直连，可通过 `/web proxy set`、`/web proxy clear`、`/web configure` 或 `XIU_WEB_PROXY` 显式管理。
- 对限流、超时和服务端瞬时错误进行最多三次安全重试；认证、权限和参数错误不会误重试。

安全边界：

- 只允许公开 HTTPS 地址；拒绝 URL 内嵌凭证、localhost、本机和私网地址。
- 每次跳转都重新检查协议、域名策略和目标地址。
- 页面响应有大小与文本长度上限，只接受可阅读文本、HTML 或 JSON；脚本、样式、表单和其他主动内容会被剥离。
- 搜索结果和页面正文始终标记为“不可信外部内容”，不能覆盖系统、项目或用户指令。
- 工具不会提交表单、保存 Cookie、登录账号或执行网页写入。需要账号、OAuth 或外部修改时，继续使用经过独立权限确认的 MCP。

`/web disable` 会立即移除本次会话中的联网工具并持久停用配置，但不会删除你自行设置的环境变量。

### 托管搜索状态、诊断与恢复（v0.15.4）

- `/web` 与 `/web status`：显示当前搜索后端、端点、独立代理以及托管设备凭证存储位置。该命令只检查本机状态，不联网，也不会自动登记设备。
- `/web doctor`：主动检查托管网关健康状态和认证链路。若本机还没有设备凭证，该命令会提示可能自动登记，然后执行一次登记与短期 Token 签发；结果只显示成功状态和耗时，不显示 Token 或设备秘密。
- `/web reset`：在明确确认后删除当前电脑的托管搜索设备凭证和内存 Token。下一次搜索或 `/web doctor` 会把这台电脑作为新设备重新登记。
- `/web proxy`：只读显示联网工具当前使用的独立代理；`/web proxy set [URL]` 保存并立即应用 HTTP(S) 代理，`/web proxy clear` 清除已保存代理并让当前会话改为直连。它们不会修改 Agnes、OpenAI、Anthropic 或其他模型 Provider 的代理。

`/web reset` 不会删除 Tavily、Brave 或自建 SearXNG 的 API Key 环境变量，也不会修改联网代理。若系统凭证引用仍存在但 Windows 凭证管理器不可用，Xiu 会拒绝重置并保留原状态，避免出现“界面说已删除、实际仍可使用”的不一致。普通启动不会自动执行 `/web doctor`，因此诊断功能不会重新引入启动等待。

### 托管搜索服务端设备只读观测（v0.15.6）

- `/web devices`：在用户明确调用后，使用现有设备凭证读取服务端设备列表和撤销审计；只允许 HTTPS GET 查询，不会自动登记、撤销、清理或恢复设备。这台设备尚未注册（还没有搜索过）时直接说明并不发送请求，首次联网搜索才会自动注册。
- 输出只显示脱敏设备标识、受限状态/时间字段和有限 request ID；不会显示设备秘密、短期 Token、响应正文或完整敏感 URL。
- 没有本地设备凭证、凭证被拒绝、服务端不可用、TLS/代理失败或响应格式异常时，命令失败关闭，不会清理本地凭证或自动重新登记。

### 来源标识与搜索质量摘要（v0.15.5）

`web_search` 会先规范化可用的 HTTPS 来源：移除 URL 片段和常见 `utm_*`、`fbclid`、`gclid` 等追踪参数，对查询参数排序，并折叠规范化后相同的链接。每条结果包含：

- `Source ID`：由规范化 URL 生成的稳定 `WEB-xxxxxxxx` 标识；
- `Citation URL`：最终应交给 `web_open` 并在答案中引用的精确 URL；
- `Source host`：来源域名；
- Provider 提供的日期与有界摘要（如有）。

`web_open` 会重复显示相同的 `Source ID`、`Citation URL` 和来源域名，便于确认搜索摘要与打开正文是否属于同一来源。搜索末尾还会显示唯一来源、域名覆盖、Provider 日期覆盖和去重数量，并提示域名过于集中或完全没有日期。

这些指标只说明“当前拿到了多少种来源”，不判断网页内容真伪，也不代表已经验证。尤其是“最新”“本周”“当前”等任务，仍需打开每个最终引用并核对正文和日期；不能用质量摘要绕过证据门禁。

对于“最近/过去 N 天、周、月、年”等请求，Xiu 会按当前本地日期计算滚动范围，并将它用于检索和排序，而不是作为任务完成的硬门禁。用户要求日期时，已打开来源若提供可核验日期，最终条目会保留该真实日期；来源完全没有可核验日期时，程序会确定性标注“日期：未知（来源未提供可核验日期）”，不会再让模型补齐日期。范围内可核验来源不足时，可以返回日期更早但已经成功打开并核验的来源，同时如实展示日期并说明它位于首选范围之外；不能推断、伪造日期或用记忆补足数量。

为避免反复换关键词和不可访问页面导致长时间空转，同一任务最多执行 3 次真实 `web_search` 搜索发现，每个 `web_open` 页面只尝试一次。尚无成功来源时最多允许 6 次真实页面打开失败；已有至少一个来源成功打开后，上限收紧为 4 次。达到上限后，Xiu 不再执行任何联网或其他工具，只给模型一次“仅作答”机会，并明确列出本次唯一允许引用的精确 URL；最终答复只能使用这些已经成功打开并通过精确 URL 来源门禁的来源，数量不足必须少答。无论是否已经达到失败上限，只要最终混合结果中同时存在已打开来源和未打开链接，Xiu 都会在证据门禁前删除未打开链接所在的完整候选条目，而不是只删链接留下无来源陈述；只要剩余内容仍包含已打开来源，并为每个引用条目保留真实日期或确定性“日期未知”标记，任务会以较少条目正常完成。无法安全保留核验结果、模型继续请求工具或剩余证据仍不足时，任务立即以本地化错误结束，不会再进入纠正循环。
