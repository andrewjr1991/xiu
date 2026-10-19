# Xiu 使用指南 · Skills、MCP、项目指令与插件

本文是[使用指南目录](../../USAGE.zh-CN.md)的一部分；上手请先看[快速上手](../../QUICKSTART.md)。

## Skills

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

安装后当前会话会刷新指令。v0.9.9 在每次打开 `/skills` 前重新扫描，并在任务结束后发现外部命令新安装的 Skill，因此无需重启；只有被实际扫描到并加载的 Skill 才会报告为可用。只安装可信来源；Skill 会影响模型的工作方法。Xiu 启动时只加载 Skill 名称、描述和权限摘要，需要使用时才读取完整内容，以减少上下文占用。从 0.18.2 起，`using-superpowers`、`brainstorming`、`writing-plans`、`verification-before-completion` 这类与 Xiu 内置计划和完成门禁重复的全局兼容流程不会进入模型自动目录，避免无关连锁加载；它们仍会出现在 `/skills` 中，用户明确点名时仍可通过 `read_skill` 读取。项目级和插件级同名 Skill 不受此自动过滤影响。

v0.12.2 起，Skill 可以在 `SKILL.md` frontmatter 中声明权限，例如：

```yaml
---
name: deploy
description: 部署工作流
permissions: workspace:read, network:access
---
```

可用权限包括 `instructions:load`、`workspace:read`、`workspace:write`、`process:execute`、`network:access`、`external:read`、`external:write` 和 `credentials:access`。未声明的旧 Skill 使用兼容的 `instructions:load` 基线；出现未知权限时安装会被阻止。首次安装或更新新增权限时，Xiu 会先展示差异并等待确认，拒绝后不会替换旧版本。Skill 声明只是风险说明和收紧依据，不能跳过工作区信任、Plan 模式或工具审批。

## MCP Server

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
/mcp read cloudflare <模板名> 变量=值 ...
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

v0.12.1 起可以显式浏览 MCP Resource、Resource Template 和 Prompt。`/mcp resources [名称]` 与 `/mcp prompts [名称]` 显示服务提供的目录；`/mcp read [名称] [URI]` 通过原 MCP 服务读取 Resource，Xiu 不会自行访问 URI；0.20.13 起 Resource Template 也能读：交互选择时模板和资源列在一起，或直接写模板名（或模板串）并用 `变量=值` 给参数，缺的变量逐项询问，展开后先打印要读的 URI 再请求。支持 RFC 6570 的 `{var}`、`{+var}`、`{#var}`、`{.var}`、`{/var}`、`{;var}`、`{?var}`、`{&var}`，不支持 `*` 与 `:n` 修饰符，每个变量都必须由你提供，Xiu 不代填；`/mcp prompt [名称] [Prompt] [JSON参数]` 获取并预览 Prompt，缺少必填参数时会逐项询问。

这些远端内容一律按“不可信内容”展示，不会自动注入当前任务或变成模型指令。列表最多读取 20 页、500 项；文本单块最多 32K 字符、单次最多 64K 字符；Blob、图片和音频只显示 MIME 与估算大小，不输出 Base64。要让模型使用其中信息，应由用户检查后明确转述或引用，避免第三方内容静默扩大权限。

## 项目级指令

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

## 插件（v0.14.3 阶段 D）

0.20.13 起，桌面工作台在已信任的工作区里复用同一份插件授权：CLI 里 `/plugin approve` 过的插件，其渠道、MCP 工具和 Skills 贡献在桌面任务中同样可用；桌面不提供新的授权入口，未授权插件不会被加载，插件声明的 MCP 服务仍需在桌面“扩展”里确认权限清单。

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
