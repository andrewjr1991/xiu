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
