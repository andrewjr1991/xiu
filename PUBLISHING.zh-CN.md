# Xiu 更新、发布与安装指南

这份文档写给第一次维护或安装 npm 命令行工具的人。内容分为两部分：

- 开发者如何修改 Xiu、升级版本并发布到 npm。
- 普通用户如何安装、配置、升级和卸载 Xiu。

当前公开包名为 `@xiu-ai/cli`，安装后提供的终端命令是 `xiu`。

## 一、先理解三个名称

| 名称 | 含义 |
| --- | --- |
| `xiu-ai` | npm 组织名，也是 scope 名称 |
| `@xiu-ai/cli` | npm 上的完整包名 |
| `xiu` | 用户安装后在终端输入的命令 |

包名和命令名不同是正常的。用户安装 `@xiu-ai/cli` 后，只需要输入 `xiu`。

## 二、普通用户安装

### 2.1 安装 Node.js

Xiu 要求 Node.js 20 或更高版本。安装 Node.js 后，重新打开 PowerShell并检查：

```powershell
node --version
npm.cmd --version
```

如果 `node --version` 低于 `v20`，请先升级 Node.js。

### 2.2 从 npm 安装 Xiu

大多数用户执行：

```powershell
npm.cmd install --global '@xiu-ai/cli'
```

如果电脑配置了公司镜像、淘宝镜像或其他 npm 源，建议明确使用官方 registry：

```powershell
npm.cmd install --global '@xiu-ai/cli' --registry='https://registry.npmjs.org/'
```

安装后检查：

```powershell
xiu --version
Get-Command xiu
```

### 2.3 从离线 `.tgz` 安装

维护者也可以把 `xiu-ai-cli-版本号.tgz` 发给用户。假设文件下载到了 `D:\Downloads`：

```powershell
npm.cmd install --global 'D:\Downloads\xiu-ai-cli-0.13.0.tgz'
xiu --version
```

路径中有空格时必须保留单引号。

### 2.4 进入项目再启动

不要在 `C:\Windows\System32` 中运行编码 Agent。先进入自己的项目：

```powershell
Set-Location -LiteralPath 'D:\My Projects\demo'
xiu
```

`-LiteralPath` 后面的路径要放在引号中，否则带空格的目录会被 PowerShell 拆成多个参数。

第一次进入某个项目时，Xiu 会询问是否信任该工作区。只信任自己创建或确认安全的项目。

## 三、配置模型服务

环境变量只对当前 PowerShell 窗口生效。关闭窗口后需要重新设置，除非使用 Windows 环境变量设置界面将其永久保存。

### 3.1 Agnes

```powershell
$env:XIU_PROVIDER = 'agnes'
$env:AGNES_API_KEY = '你的实际 API Key'
$env:AGNES_PROXY = 'http://127.0.0.1:12334'
xiu
```

只有确实需要本地代理时才设置 `AGNES_PROXY`。

### 3.2 OpenAI

```powershell
$env:XIU_PROVIDER = 'openai'
$env:OPENAI_API_KEY = '你的实际 API Key'
xiu
```

### 3.3 Anthropic Claude

```powershell
$env:XIU_PROVIDER = 'anthropic'
$env:ANTHROPIC_API_KEY = '你的实际 API Key'
xiu
```

不要把 API Key 写进项目代码、README、截图、聊天记录或提交到 Git。发布 npm 包前也要确认 `.env`、会话和本地配置没有进入安装包。

## 四、普通用户升级与卸载

查看 npm 上的最新版：

```powershell
npm.cmd view '@xiu-ai/cli' version --registry='https://registry.npmjs.org/'
```

升级到最新版：

```powershell
npm.cmd install --global '@xiu-ai/cli@latest' --registry='https://registry.npmjs.org/'
xiu --version
```

安装指定版本：

```powershell
npm.cmd install --global '@xiu-ai/cli@0.13.0' --registry='https://registry.npmjs.org/'
```

卸载：

```powershell
npm.cmd uninstall --global '@xiu-ai/cli'
```

卸载程序不会主动删除用户的 `~/.xiu` 数据目录。该目录可能包含全局 Skills、信任记录和 MCP 配置。不要在不确认内容的情况下删除它。

## 五、开发者发布前准备

以下命令都应在 Xiu 源码目录执行：

```powershell
Set-Location -LiteralPath 'D:\QoderWork Project\AGENT'
```

先确认 Node.js、npm 和当前目录：

```powershell
node --version
npm.cmd --version
Get-Location
```

安装依赖：

```powershell
npm.cmd install
```

完成代码修改后，依次运行：

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

任何一条失败都不要发布。先修复错误，再从头执行这三条命令。

## 六、选择正确的版本号

npm 版本通常使用 `主版本.次版本.补丁版本`，例如 `0.5.0`。

| 修改类型 | 示例 | 使用场景 |
| --- | --- | --- |
| patch | `0.5.0` → `0.5.1` | 修复 Bug、小幅改进，基本兼容旧用法 |
| minor | `0.5.1` → `0.6.0` | 新增一组功能，旧功能仍然兼容 |
| major | `1.2.0` → `2.0.0` | 有破坏性变化，需要用户调整配置或用法 |

已经发布到 npm 的版本不能覆盖。例如 `0.5.0` 发布后，即使代码只改了一行，也必须发布 `0.5.1` 或更高版本。

升级补丁版本：

```powershell
npm.cmd version patch --no-git-tag-version
```

升级次版本：

```powershell
npm.cmd version minor --no-git-tag-version
```

命令会同时更新 `package.json` 和 `package-lock.json`。Xiu 的运行时版本会自动从 `package.json` 读取，不需要在源代码中再手动修改版本号。

版本升级后，再次执行完整检查：

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

## 七、发布前检查安装包

先执行不会真正发布的预览：

```powershell
npm.cmd pack --dry-run
```

检查输出时应重点确认：

- 包名和版本号正确。
- 包含 `dist`、`README.md`、`USAGE.zh-CN.md`、`PUBLISHING.zh-CN.md`、`ROADMAP.zh-CN.md`、`SECURITY.zh-CN.md`、当前版本设计文档和 `package.json`。
- 不包含 `.env`、API Key、`.xiu/sessions`、测试项目、日志或个人文件。
- `dist/cli.js` 已生成。
- 如果版本新增可选原生依赖，应在真正位于项目目录之外的两个干净目录分别执行普通安装和 `--omit=optional` 安装；普通安装要验证对应能力，省略可选依赖时也必须能启动并给出可解释的降级状态。
- 涉及凭证迁移时，只能使用随机 Canary 或专用测试 Key/Token：Provider 要验证复制后回读、重启恢复、旧副本默认保留、单项清理、显式回退、全部遗忘和批量失败回滚；MCP OAuth 还要验证超长 Scope 不进入系统秘密、刷新轮换、Scope 升权、保留 Client 的注销、全部注销、清理后回退和系统后端不可用时不静默降级。不得用真实用户凭证做发布自动化，也不得把 `~/.xiu/providers.json`、`~/.xiu/mcp-auth.json` 或 Windows 凭证导出物放入安装包。
- 从 `0.13.1` 起，发布前还要在独立测试工作区分别于模型等待、只读工具、写工具、文件落盘后和验证进程中强制终止 Xiu；重启后必须显示恢复点和未知副作用、要求用户确认，并证明相同副作用不会自动重放。还要覆盖损坏/未知版本日志、并发 Xiu、工作区移动和不可写日志目录。测试生成的 `~/.xiu/task-runs/` 记录不得打入 npm 包。
- 从 `0.13.2` 起，发布前还要验证统一重试矩阵：401/403/400/422 和用户取消只调用一次；429、超时、临时网络错误和 5xx 仅对可安全重放操作进行最多三次尝试；流式输出后、写入/命令/远端修改/媒体提交后或结果未知时不得重放。只读 MCP、媒体状态轮询与已有资源下载应能在瞬时故障后恢复。
- 从 `0.13.3` 起，发布前还要分别验证 Token、模型调用、工具调用、失败和墙钟时间预算：接近阈值只预警一次；耗尽后必须在操作间安全暂停并可被 `/recover` 发现，不得继续执行下一项副作用或显示为完成。等待用户、审批、限流退避和后台操作不得被误判为停滞，`/diagnostics` 与状态栏必须显示同一预算事实。
- 从 `0.13.4` 起，发布前必须在独立工作区启动长后台命令，关闭原 Xiu 终端后从新进程发现同一稳定 ID，使用输出游标连续读取且不丢失内容，并分别验证正常退出、失败退出和显式取消。还要后台运行一个 `xiu -y` 长任务，确认不会重复副作用；遇到新的交互审批时必须在执行前暂停，并可被 `/recover` 发现。npm 包必须包含 `dist/background-worker.js`，不得包含本机后台状态、请求文件或日志。
- v0.12.3 及以后发布前还必须执行不规则 Canary 出口测试，覆盖 Provider/媒体错误、MCP 启动与工具调用、Resource/Prompt、OAuth 刷新/注销、诊断、故障转移和 Session；同时注入迁移中断与损坏系统记录，确认清理被拒绝且旧副本未被覆盖。完成 `typecheck`、全量测试、构建、`npm pack --dry-run --json` 包清单检查和指定 npm 官方 Registry 的隔离安装后，才可发布。

生成可以离线发送的真实安装包：

```powershell
npm.cmd pack
```

它会生成类似文件：

```text
xiu-ai-cli-0.5.1.tgz
```

可选：计算 SHA256，方便接收者确认文件完整性：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\xiu-ai-cli-0.5.1.tgz'
```

## 八、登录正确的 npm Registry

先检查当前 npm 源：

```powershell
npm.cmd config get registry
```

如果显示的不是 `https://registry.npmjs.org/`，不要直接执行普通的 `npm login`。使用：

```powershell
npm.cmd login --registry='https://registry.npmjs.org/' --auth-type=web
```

浏览器登录后检查当前账号：

```powershell
npm.cmd whoami --registry='https://registry.npmjs.org/'
```

为 Xiu 的 scope 单独绑定官方源，不影响其他公司内部包：

```powershell
npm.cmd config set '@xiu-ai:registry' 'https://registry.npmjs.org/' --location=user
```

如果看到 `registry.anpm.alibaba-inc.com`、淘宝源或公司源的登录 404，通常不是账号密码错误，而是登录到了不支持 npmjs.com 账号的 registry。

## 九、正式发布到 npm

发布前再次确认版本：

```powershell
node -p "require('./package.json').version"
```

确认账号：

```powershell
npm.cmd whoami --registry='https://registry.npmjs.org/'
```

正式发布公开包：

```powershell
npm.cmd publish --access public --registry='https://registry.npmjs.org/'
```

npm 可能显示一个认证网址，并提示按 Enter 打开浏览器。完成网页认证后回到 PowerShell。看到下面这种输出才表示成功：

```text
+ @xiu-ai/cli@0.5.1
```

不要仅凭 `npm notice` 判断成功；必须确认最后没有 `npm error`，并出现以 `+ @xiu-ai/cli@版本` 开头的成功行。

## 十、发布后验证

查询官方 registry：

```powershell
npm.cmd view '@xiu-ai/cli' version dist-tags --json --registry='https://registry.npmjs.org/'
```

正常情况下，`version` 和 `latest` 都应是刚发布的版本。

使用临时执行方式做冒烟测试：

```powershell
npx.cmd --yes --registry='https://registry.npmjs.org/' '@xiu-ai/cli@latest' --version
```

也可以在另一台电脑上全局安装并检查：

```powershell
npm.cmd install --global '@xiu-ai/cli@latest' --registry='https://registry.npmjs.org/'
xiu --version
```

公开页面：

```text
https://www.npmjs.com/package/@xiu-ai/cli
```

## 十一、发布 Beta 版本

尚未准备好给所有用户升级的版本，不要占用 `latest` 标签。假设当前版本是 `0.5.1`：

```powershell
npm.cmd version prerelease --preid=beta --no-git-tag-version
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd publish --access public --tag beta --registry='https://registry.npmjs.org/'
```

用户主动安装 Beta：

```powershell
npm.cmd install --global '@xiu-ai/cli@beta' --registry='https://registry.npmjs.org/'
```

普通的 `@latest` 用户不会自动拿到 Beta。

## 十二、发布出错后的处理

### 12.1 `E403 Forbidden`

检查：

- 当前账号是否是 `xiu-ai` 组织成员。
- 是否拥有发布包的权限。
- npm 邮箱是否已验证。
- 登录的是否是官方 registry。

```powershell
npm.cmd whoami --registry='https://registry.npmjs.org/'
```

### 12.2 `E404`，并出现阿里或其他 registry

明确指定官方源重新登录和发布：

```powershell
npm.cmd login --registry='https://registry.npmjs.org/' --auth-type=web
npm.cmd publish --access public --registry='https://registry.npmjs.org/'
```

### 12.3 `E402 Payment Required`

公开 scope 包需要：

```powershell
npm.cmd publish --access public
```

### 12.4 `EOTP` 或浏览器认证

这是 npm 的两步验证。按提示输入一次性验证码，或打开 npm 给出的认证网址完成验证。

### 12.5 `You cannot publish over the previously published versions`

该版本已经存在，不能覆盖。升级版本后重新构建发布：

```powershell
npm.cmd version patch --no-git-tag-version
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd publish --access public --registry='https://registry.npmjs.org/'
```

### 12.6 发布了有问题的版本

最安全的处理方式是立即修复并发布更高的 patch 版本，不要尝试覆盖旧版本。

如果必须阻止用户继续安装有问题的版本，可以添加弃用提示：

```powershell
npm.cmd deprecate '@xiu-ai/cli@0.5.1' 'This version has a known issue. Please upgrade.' --registry='https://registry.npmjs.org/'
```

如果需要临时把 `latest` 指回一个确认稳定的旧版本：

```powershell
npm.cmd dist-tag add '@xiu-ai/cli@0.5.0' latest --registry='https://registry.npmjs.org/'
```

修改 `latest` 会影响所有新安装和升级用户，执行前必须确认目标版本确实稳定。

## 十三、推荐的每次发布清单

可以在每次发布时逐项核对：

```text
[ ] 功能和 Bug 修复已经完成
[ ] 没有 API Key、.env、日志或个人文件
[ ] npm run typecheck 通过
[ ] npm test 全部通过
[ ] npm run build 通过
[ ] 已选择正确的 patch / minor / major 版本
[ ] package.json 与 package-lock.json 版本一致
[ ] npm pack --dry-run 内容正确
[ ] 可选原生依赖已完成普通安装与 --omit=optional 降级安装验证
[ ] npm whoami 是正确账号
[ ] npm publish 使用官方 registry 和 --access public
[ ] npm view 显示新版本与正确的 latest/beta 标签
[ ] 在干净环境完成安装和 xiu --version 冒烟测试
[ ] 更新发布说明，并通知测试用户
```

## 十四、最短发布流程速查

确认只是兼容性 Bug 修复时，可以按顺序执行：

```powershell
Set-Location -LiteralPath 'D:\QoderWork Project\AGENT'
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd version patch --no-git-tag-version
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd pack --dry-run
npm.cmd whoami --registry='https://registry.npmjs.org/'
npm.cmd publish --access public --registry='https://registry.npmjs.org/'
npm.cmd view '@xiu-ai/cli' version dist-tags --json --registry='https://registry.npmjs.org/'
```

即使使用速查流程，也不要跳过测试、安装包检查和发布后验证。

## 十五、0.13.5 执行报告发布门禁

发布 `0.13.5` 前除通用流程外，还必须验证：

1. `/report` 能在任务完成、失败、未验证和可恢复暂停后给出一致状态。
2. 未验证任务选择继续并最终验证通过后，报告仍显示原始用户目标和前一次运行的文件变化，不得暴露内部续跑提示。
3. `summary` 不包含文件内容；`details` 仅包含有界且脱敏的少量预览。
4. Markdown 与 JSON 导出都要求显式指定工作区内路径和范围，拒绝目录穿越与符号链接。
5. 报告只读取当前工作区安全审计记录，且只汇总计数，不输出审计主体、命令正文、Prompt 或凭证。
6. 交互任务和一次性命令任务都能保留文件变化事实；未知副作用不会被报告功能重放。
7. 在包含虚假 Key、Token、绝对路径和源码片段的夹具上运行脱敏回归测试。

## 十六、0.13.6 安全修复发布门禁

发布 `0.13.6` 前除通用流程外，还必须验证：

1. 新工作区执行一次性任务和 `-y` 时仍会要求信任；拒绝后不读取项目指令、不加载项目 Skills/MCP、不调用模型。
2. 文件读取、搜索、结构化提取、媒体和检查点路径均拒绝符号链接、Junction、重解析点、绝对 Glob 与 `..` Glob 越界。
3. 新 MCP 无论是否手写权限字段，首次连接都要求 `/mcp permissions approve <名称>`；权限扩张继续再次确认。
4. `cancel_agent` 和 `retry_agent` 经过执行风险审批，且不会被通用瞬时错误策略自动重放。
5. 会话日志使用本机私有文件权限（平台支持时），常见 Provider/OAuth、GitHub、Slack、AWS 与私钥样式不会进入持久日志。
6. 完整测试、构建、包预览和干净目录安装全部通过后，才允许发布并回读 Registry。

## 十七、0.13.7 首次启动修复发布门禁

发布 `0.13.7` 前除通用流程外，还必须在隔离用户目录中验证：

1. 没有当前 Provider API Key 时，单独运行 `xiu` 不显示未处理异常，也不会自动退出。
2. 交互终端提供“配置当前 Provider Key”“选择其他 Provider”“稍后配置”三种路径；取消或稍后配置仍能进入 `xiu>`。
3. `/provider key` 保存并验证 Key 后可在当前进程立即切换为可用 Provider。
4. 带任务参数的一次性命令缺少凭证时，输出明确的首次配置说明并以失败状态退出。
5. 回归测试、类型检查、构建、包预览和干净目录安装全部通过后，才允许发布并回读 Registry。

## 十八、0.13.8 多 Agent 安全合并发布门禁

发布 `0.13.8` 前除通用流程外，还必须验证：

1. Reviewer 和 Tester 依赖同一个 Implementer 时，读取的是该实现 Worktree，而不是主工作区，并且只能使用只读工具。
2. Reviewer 与 Tester 必须分别以最终一行 `VERDICT: PASS` 提供证据；缺少、失败或先通过后失败的结果都会阻止合并。
3. 主工作区和 Agent 同时修改同一普通文件、符号或依赖清单时，`/agents integrate` 在写入前阻断并明确列出冲突。
4. 主工作区存在不相干的未提交修改时可以继续安全合并，但这些修改必须出现在分析中且内容保持不变。
5. 预览有界，完整补丁保存到本机；合并失败不清理补丁、运行记录、用户修改或 Worktree，也不留下部分应用。
6. 合并成功后仍被视为需要在主工作区重新验证，不能仅凭子 Agent 证据直接宣称主任务完成。
7. 专项测试、完整测试、类型检查、构建、包预览和干净目录安装全部通过后，才允许发布并回读 Registry。

## 二十、0.14.1 声明式贡献发布门禁

发布 `0.14.1` 前除通用流程外，还必须验证：

1. 未授权插件保持 `inactive`；`/plugin approve <id>` 明确展示权限和贡献数量，拒绝后不加载任何贡献。
2. 授权只对应当前版本、权限、贡献路径和内容摘要；修改任一项后旧授权失效。
3. Provider/MCP 只读取不超过 512 KiB 的 JSON，Skill/工作流只读取有界 Markdown；任何 JavaScript 或安装脚本都不执行。
4. 插件 Provider 拒绝明文 `apiKey`、重复 ID 和缺失网络/凭证权限；MCP Tool 继续要求自己的精确权限清单。
5. 项目插件只在工作区信任后加载；Plan 只读、风险审批、危险操作确认和凭证脱敏不可被插件绕过。
6. 无插件环境启动、Provider 切换、Skill 刷新和 MCP 后台连接没有明显退化。

## 二十一、0.14.2 插件生命周期发布门禁

发布 `0.14.2` 前除通用流程外，还必须验证：

1. 可信本地路径与无内嵌凭证的 HTTPS Git 可以安装；HTTP、其他协议、URL 凭证、符号链接/Junction 和超限包失败关闭。
2. 安装先暂存校验再原子就位，不执行 Git Hook、插件 JavaScript、安装脚本或二进制入口。
3. 更新明确展示来源、版本变化、新增和移除权限；更新成功后旧精确授权失效并要求重新确认。
4. 更新前保留旧版本备份；损坏来源、校验失败或替换失败时原版本保持可用，不留下部分安装。
5. 禁用与启用不扩大权限；卸载只移动插件包，用户生成的数据不删除，`/plugin recover` 可以恢复最近备份。
6. 阶段 A/B 的工作区信任、路径边界、Provider/MCP 二次门禁和无插件启动回归不退化。

## 二十二、0.14.3 插件供应链发布门禁

发布 `0.14.3` 前除通用流程外，还必须验证：

1. 本地与 HTTPS Git 安装均生成版本 2 安装元数据和 64 位十六进制 SHA-256 包摘要。
2. HTTPS Git 安装记录实际解析到的完整提交 ID，不依赖可移动分支名作为已安装版本证据。
3. 修改、增加或删除已安装包中的任意普通文件后，`/plugins reload` 将插件标记为 `integrity: mismatch`、撤销激活且不加载贡献。
4. `/plugin disable` 与 `/plugin enable` 不改变包摘要，也不误报篡改。
5. 旧版安装元数据报告 `legacy` 而不是伪报 `verified`；下一次显式更新迁移到当前格式。
6. `/plugin inspect` 只显示脱敏来源、摘要前缀与公开提交 ID，不输出 URL 凭证或文件内容。
7. 有效 Ed25519 分离签名必须绑定插件 ID、版本和当前完整包摘要；无效格式、错误元数据、非 Ed25519 公钥、签名字节篡改均失败关闭。
8. `/plugin publisher trust <id>` 只接受已验证签名并要求确认完整 SHA-256 公钥指纹；`list` 和 `revoke` 不展示或保存私钥。
9. 发布者被信任后插件仍需当前精确 `/plugin approve`；发布者换钥、内容、版本、权限或贡献变化都会让旧授权失效。
10. 信任库损坏、指纹与公钥不匹配时不得激活签名插件；撤销发布者信任后状态回到 `valid-untrusted`，不得伪报 `trusted`。
11. 未签名插件保持兼容并显示 `unsigned`，不能伪报已验证；本地精确审批仍然有效。
12. 全量测试必须包含有效签名、摘要篡改、签名字节篡改、发布者换钥、信任撤销、损坏信任库和无签名兼容矩阵。
13. `xiu.plugin-policy.json` 只在工作区信任后读取；符号链接、超限、损坏 JSON、未知字段、未知权限和非 HTTPS 远程来源均失败关闭插件。
14. `/plugin policy` 必须展示策略状态、文件、指纹和限制项；不得展示私钥、凭证或把团队策略误报为本机信任/授权。
15. `requireSignature`、精确来源/发布者允许清单和禁止权限均在发现、授权、启用、安装、更新和恢复路径生效。
16. 团队策略不得写入发布者信任库或权限授权库；满足允许清单的插件仍保持 `inactive`，直到用户完成当前精确 `/plugin approve`。
17. 安装预览后修改团队策略必须让提交取消；损坏或不再满足策略的备份不得替换当前可用插件。
18. 攻击矩阵必须覆盖恶意路径/包、安装脚本与依赖混淆不执行、签名替换、策略越权尝试、策略竞态和回滚失败保留当前版本。

## 十九、0.14.0 插件清单发布门禁

发布 `0.14.0` 前除通用流程外，还必须验证：

1. 未信任工作区只发现用户级插件，不读取项目 `.xiu/plugins`。
2. 绝对路径、`..`、符号链接/Junction 逃逸、未知权限和不支持的 `apiVersion` 都显示为无效，且不执行任何插件代码。
3. 不兼容 Xiu 版本显示为 `incompatible`；项目级同 ID 插件显式遮蔽用户级声明并可复查。
4. `/plugins`、`/plugins reload` 和 `/plugin inspect <id>` 只展示有界元数据，不泄露凭证或把远端内容当成指令。
5. 无插件目录时启动和现有 Provider、Skill、MCP、Plan、审批流程不退化。
6. 清单状态 `ready` 明确表示“可进入后续授权阶段”，不能显示为已激活或已安装运行时。
7. 专项测试、完整测试、类型检查、构建、包预览和干净目录安装全部通过后，才允许发布并回读 Registry。
