## 0.20.6 已发布（2026-10-04，本版本 CI 豁免）

[GitHub 0.20.6](https://github.com/andrewjr1991/xiu/releases/tag/v0.20.6) 已公开，源码/tag 固定为 `98787fdbbb7cdedc012da9585e2193f31553e120`，五份附件大小与服务端 SHA256 均回读一致；全部保存在标准 `apps/desktop/release`。本地 25 项专项、两端类型检查/构建、宽窄 UI、深浅授权窗口、355 文件 dry-pack、发布 tarball 隔离安装、asar 14 文件匹配/无测试桥和最终安装器全新安装/启动/覆盖升级/中断重启/卸载通过。远端 CI 未启动，全量/跨平台测试未运行。安装器为 `NotSigned`。

- CLI SHA256：`dfafa09e91acc956acf1775975d23aad669b8b9da3eb29834f2f3e6eb6a7d7c4`。
- Windows SHA256：`97c815b6ecfd8e2ba66b2d21704f1948836012e6355f6a154a64907b75551fd9`。
- npm integrity：`sha512-Dd2a3v586lq1WeA7fX6iwifCRwwLawuiNwwxYxCYtz2aa/WhCnhjKosZiyBrkKe7F4kuxwTksPyNtr1ZFEqCMQ==`。

旧版 0.20.5 安装器摘要保持 `b5555d8f1cea0511f4a90972e4761226ecfbed6f790364f7ab75fa4a17a2caea`。本节后续文档提交不移动 tag、不替换附件。npm 未登录，0.20.6 尚未发布，latest 为 0.20.4；维护者登录后先查版本是否存在，再发布原 tarball 并验证：

```powershell
npm login --registry=https://registry.npmjs.org
npm view @xiu-ai/cli@0.20.6 version --registry=https://registry.npmjs.org
# 仅在上一条明确返回版本不存在时继续；其他网络/权限错误不能视为未发布。
npm publish "apps/desktop/release/xiu-ai-cli-0.20.6-98787fdbbb7cdedc012da9585e2193f31553e120.tgz" --access public --tag latest --registry=https://registry.npmjs.org
npm view @xiu-ai/cli@0.20.6 version dist.integrity --registry=https://registry.npmjs.org
npm view @xiu-ai/cli dist-tags --json --registry=https://registry.npmjs.org
```

维护者明确授权提交、推送、发布，并因额度不足豁免本版本远端 CI。本次不修改工作流或保护分支；提交带 `[skip ci]`，使用精确清洁源码的本地 CLI tarball 与未签名 Windows x64 安装器，不继承历史 CI 绿灯，不覆盖旧 tag/附件/npm 版本。完整测试与跨平台验证未运行；本地专项、类型、构建、包及安装器验收按实际结果记录到附件 manifest。系统通知/声音仍待人工验收，构建期残留告警保留。

npm 当前 `ENEEDAUTH`，Registry latest 为 0.20.4。GitHub 发布不代表 npm 已更新；同源 tarball 交付到 `apps/desktop/release` 后，维护者登录并核对 0.20.6 未发布再执行 `npm publish <该同源包> --access public --tag latest`，回读版本、integrity 与 dist-tags。下方 0.20.5 设置候选和正式记录属于历史，不代表本次资产。

## 本地设置中心候选（历史）

后续深色表面补修已更新同名本地候选：清除顶栏、标签栏、半透明弹层等亮色遗漏，并收敛六组头像配色；新增工作台宽窄截图与样式回归、构建/文档检查通过。最新 SHA256：`e98fefdccdeaf4f66cdaf4cb0bde94f19c95fd6f5f071ec2ce6300fd23ff2b60`，包内 14 份 dist 匹配、无测试桥，`NotSigned`。此次纯样式补修未重复安装生命周期。下方 SHA256 与生命周期证据属于前一轮设置包，不代表此次补修安装器；正式资产不变。

设置中心、深浅主题和非敏感偏好属于本地增量，不纳入已有 0.20.5 tag 或正式资产。测试包使用 `apps/desktop/release/Xiu-0.20.5-local-settings-x64.exe`，解包位置保持 `apps/desktop/release/win-unpacked`；仍未签名。未经新的发布授权，不推送、合并或发布，不覆盖 npm 已发布版本。图形化等待时限和自动更新尚未实现。

验收：25 项专项、两端类型检查、桌面构建/文档、宽窄 UI 回归和深浅授权窗口通过；隔离全新安装、启动、覆盖升级、中断重启、卸载通过。包内 14 份 dist 文件与本地构建匹配，无测试桥。安装器 SHA256：`d2830af809120aecac7a625a912701653b82f4818ddb03b08aa5a43f6286c69b`，`NotSigned`。未重跑全量/远端 CI；系统通知与声音仍需人工验收。构建仍有大块体积告警和受限 PowerShell 的依赖收集 stderr，不把它们记作已解决。

## 0.20.5 正式发布记录（2026-10-03）

经 [PR #6](https://github.com/andrewjr1991/xiu/pull/6) 合并 main，[GitHub 正式版](https://github.com/andrewjr1991/xiu/releases/tag/v0.20.5) 已公开，不覆盖 0.20.4。正式源码固定为 `386157f389d9d27ecdd443c024955f198f01ffa6`。[候选 CI](https://github.com/andrewjr1991/xiu/actions/runs/37125149946)、PR CI 37125160325 和独立 [main CI 37126166861](https://github.com/andrewjr1991/xiu/actions/runs/37126166861) 各六作业通过。Windows 全量 1004 项：997 通过、7 跳过、0 失败；Ubuntu/macOS 各 987 通过、17 跳过、0 失败。Windows 安装生命周期验收通过。

五个附件仅取自该 main 的原始 CI 制品，核验源码、版本、清洁工作树、清单、大小与 SHA256 后上传，再回读核验。源目录 `apps/desktop/release` 保存 CLI tarball、未签名安装器、两份 manifest 与 `SHA256SUMS-0.20.5`，未覆盖旧版。上传使用现有代理；发布后文档提交不改变 tag 或制品来源。

- CLI SHA256：`28054cabbb3aab4b0f198b3fc4a710d902d9af2129fd70a7abc6fe33d761e1bf`。
- Windows 安装器 SHA256：`b5555d8f1cea0511f4a90972e4761226ecfbed6f790364f7ab75fa4a17a2caea`，签名状态 `NotSigned`。
- npm tarball integrity：`sha512-+tiZ6rf+iNCxfjZS+gBz58x7EDxYnSFNB3FJOZuDTrssgmhGxBrZvCMYZcTgybG+Uyb9MLO+DcZctXGnWgNGZQ==`。

本地全量尝试受宿主 PowerShell ConstrainedLanguage / ACL 夹具影响，出现 8 项既有 Provider 迁移权限测试失败，随后在远端 main 六作业通过后停止；不能称本地全量通过。未放宽权限或测试断言。构建期 HTTP-cache 已知告警、未签名风险继续披露；不宣称渠道停顿已消除或浏览器人工试玩通过。

npm 0.20.5 尚未发布：当前认证返回 `ENEEDAUTH`，Registry latest 为 0.20.4。登录后先确认 0.20.5 未被发布，再发布同一 CI tarball（绝不覆盖已发布版本），回读完整性及 latest：

```powershell
npm login --registry=https://registry.npmjs.org
npm view @xiu-ai/cli@0.20.5 version --registry=https://registry.npmjs.org
npm publish "apps/desktop/release/xiu-ai-cli-0.20.5-386157f389d9d27ecdd443c024955f198f01ffa6.tgz" --access public --tag latest --registry=https://registry.npmjs.org
npm view @xiu-ai/cli@0.20.5 version dist.integrity --registry=https://registry.npmjs.org
npm view @xiu-ai/cli dist-tags --json --registry=https://registry.npmjs.org
```

以下“不提交/不发布”、本地安装器摘要及旧 npm 待办均为历史阶段记录，不代表当前发布状态。

## 0.20.4 正式发布记录（历史）

最新本地视觉候选已更新原 release 目录：轻量运行记录、去除嵌套蓝卡与空进展占位、单行历史标题、压缩顶栏、浮动回到最新，保留日志与安全入口。23 项专项、桌面类型/构建/文档、1366×768 与 900×768 UI 回归及截图检查通过；包内主进程和 Renderer 匹配、无测试桥。安装器 SHA256 `8cb4d4c7811533d1b12671cb3fbc161a29dfec98d5dee5338dcf06cb1b5b3e34`，未签名；本轮未重跑安装生命周期或全量套件，未提交/推送/发布。下面 SHA256 属于上一轮阶段摘要包，不代表本次候选。未修改正式发布资产。

阶段摘要包已生成到原 release 目录，SHA256 `633864d42c5c4d4840254ecfd55c4e0ecad8a982994d1832972661cca83e3107`；包内主进程/Renderer 与构建匹配、无测试桥，仍未签名。15 项专项、桌面类型检查/构建、宽窄窗口和文档检查通过。本轮未重复安装生命周期验收，此前生命周期验收记录保留；未提交/推送/发布。

最新本地阶段摘要候选：不再以用户原文充当摘要；依据计划、公开说明与真实终态分阶段展示有界摘要，不新增付费调用。15 项摘要/时间线专项及宽窄桌面验收通过。用户反馈 Agnes 本次已完成，24 项测试通过、两位子智能体完成；这是用户实测反馈，不替代浏览器人工验收。用户已关闭旧包并要求更新原目录，继续使用 `release/win-unpacked` 与原本地候选安装器名称，不修改正式发布资产。

本次跟随补修交付已通过隔离全新安装、启动、覆盖升级、中断重启和卸载检查；未修改用户游戏与会话。

最新本地跟随补修：修复平滑滚动中间事件误停跟随，手动上翻可暂停并回到最新；八种 SVG 子智能体头像。流式超时记录纯数字计数，下一次用户主动继续改用完整响应，重启恢复保留；不执行残缺工具、不自动重放。本轮 106 项专项和宽窄桌面验收通过，未新增付费模型调用；用户最新日志确认最后请求未完整结束，但旧日志没有片段计数，不能据此定位上游停顿。安装包仍使用独立本地名称，正式发布资产保持不变。新包 SHA256：`7db9ab44221f8993e8aa0753dffff9d3d6cc9b3823d52ffb020f048484f60eb1`；包内构建匹配、无测试桥，仍未签名。下方运行提醒包 SHA256 属于上一轮候选。

最新本地运行提醒补修：警告默认折叠、详情限高纯文本、公开回复安全预览及工具参数数字进度；空角色片段保留首次正文长等待，健康子任务等待不再误触循环保护，严格 JSON 校验及完成门禁边界保持。经用户授权仅调用 Agnes：4 次协议请求与隔离实际任务 3 次模型请求成功；其中 9634 字符游戏参数约 40 秒完成，首段参数正文直到约 40 秒才返回。没有调用 Claude/GPT，未复现大型任务 180 秒停顿。仅更新独立命名本地候选，不变更正式 tag/npm/附件。

最新运行提醒候选 SHA256：`ef57e6e4827247b8e200efb7fa80f83cfcb1b6e779ef84da8ab6fefcae7891f7`。151 项专项全部通过，两端类型/构建、文档、宽窄窗口默认折叠/详情限高/数字进度通过；包内代码匹配、无测试桥。隔离全新安装/启动/覆盖升级/中断重启/卸载通过，实际游戏和任务记录未改动。仍未签名，未跑仓库全量或远端 CI，未提交/推送/发布。

本地维护候选另行交付 `release/win-unpacked/Xiu.exe` 与 `release/Xiu-0.20.4-local-task-repair-x64.exe`，包含真实任务历史续接、模型切换上下文、子任务预算和紧凑计划修复。它不是正式 0.20.4 的同源资产，未发布到 GitHub/npm；不覆盖原 CI 安装器或移动正式 tag。安装器仍未签名，真实 Provider 长任务表现待维护者复测。

已提交推送，经 [PR #5](https://github.com/andrewjr1991/xiu/pull/5) 合并 main，并发布 [GitHub 正式版 0.20.4](https://github.com/andrewjr1991/xiu/releases/tag/v0.20.4)。正式 tag 与附件源码固定为 `c4113de2bf11ad1f2136464c6c6450c73d6f4f45`；[CI 37112569209](https://github.com/andrewjr1991/xiu/actions/runs/37112569209) 六作业全绿，Windows 全量 969 项中 962 通过、7 跳过、0 失败。两份原始 manifest、CLI tarball、Windows x64 NSIS 和 SHA256SUMS-0.20.4 共五个附件已逐项核对上传摘要；不移动正式 tag，也不因后续文档补记重新打包。Windows 安装器仍未签名，保留构建期 HTTP-cache 残留风险披露。

本地企业 ConstrainedLanguage 后端专项通过；额外本地全量运行中的旧 .NET ACL 夹具受企业策略限制，运行后来停止，不能记作完整通过。发布使用上述精确源码 CI 的独立完整验证。下面“不提交/不发布”和旧 npm 待办是历史记录，不覆盖本节。

### 固定目录与 npm 交接

上一轮等待体验本地补修：固定输入框上方状态、600/180/900 秒分段等待、环境变量配置、桌面计划提示清理和超时去重。只作本地候选交付，不变更正式 0.20.4 tag/附件；该轮未调用真实付费模型，最新 Agnes 授权实测见本页开头。

上一轮等待体验候选 SHA256：`04dfd64d155b5fb3ce53b1ea2588a7e15c1072a85aa667fc0e4204f27815ee87`。109 项专项、两端类型/构建、宽窄窗口（含固定状态在过程折叠后仍可见）通过；包内代码匹配，无测试桥，仍未签名。下方 `828b...` 和 `ce105...` 属于历史本地包验收。

最新等待体验包隔离安装、安装后启动、覆盖升级、中断重启和卸载均通过；实际用户记录和游戏文件未改动，未跑全量或远端 CI。

本轮本地维护补修：残留会话删除与重复删除、缺少流式结束标记后用户继续时切换非流式、恢复会话保留兼容方式，以及 choice index 0 解析回归。未调用真实付费模型，未提交/推送/发布；正式资产不变。

上一轮删除补修安装器 SHA256：`828b1fbe8ea58786ebe87d028a9b5ef505aaaaaa0cec35ba288cc528f7bb4b50`。48 项专项、两端类型/构建、宽窄 Renderer 通过；包内主进程及前端匹配，无测试桥，未签名。

本轮隔离安装验收通过：全新安装、安装后启动、覆盖升级保留测试用户数据、中断重启、卸载。只读加载实际失败会话确认 `agnes/agnes-3.0-flash` 的缺失结束标记可恢复用于非流式续接；没有真实模型请求。

最新补修包隔离安装验收：全新安装、安装后启动、覆盖升级、中断重启、卸载均通过；使用测试用户目录，不修改实际用户数据。

最新复测补修安装器 SHA256：`ce10597cc86c975b1ea5879da2f59d531d61a1404b21a08dde45ea50b454f33f`。包含运行时默认展开、JSON 数组参数兼容和协议结束诊断；54 项专项（含长任务与未完成响应不执行）、宽窄 Renderer、两端类型/构建通过，包内入口和前端资产匹配。界面测试初次因 GUI 直接启动丢失输出管道而产生 EPIPE 弹窗，已修正启动和失败退出；旧折叠预期的测试适配后通过。首次打包遇文件短暂占用，重试成功。安装器未签名，未跑全量/远端 CI，无正式发布授权；真实渠道未知结束仍待复测。

- 未打包程序：`D:\QoderWork Project\AGENT\apps\desktop\release\win-unpacked\Xiu.exe`（本地构建，源码树与正式合并提交一致）。
- 正式 CI 安装器：`D:\QoderWork Project\AGENT\apps\desktop\release\Xiu-0.20.4-x64-c4113de2bf11ad1f2136464c6c6450c73d6f4f45-unsigned.exe`。
- 安装器 SHA256：`fa7010eb9cc481679223d6af7b3e98fd45c5492ce3b995f451f8cbc782e25b07`。
- 原始 CI tarball SHA256：`60503ccd95a789270faf82aee1534ce9d3daba119fa1a7f603f18ad0b7b7ee72`。

本机 npm 未登录；按维护者选择，npm 0.20.4 由维护者自行发布。Registry latest 最近核实为 0.20.3，GitHub 发布不代表 npm 已更新。在正常 PowerShell 中执行：

```powershell
npm.cmd login
npm.cmd view @xiu-ai/cli@0.20.4 version --registry=https://registry.npmjs.org/
```

仅当第二条明确返回该版本不存在的 E404 时继续；若已经存在，停止发布并核对来源，不覆盖。认证或网络错误不能视为版本不存在。先核对本地 tarball 摘要与上文一致，再发布原包：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath 'D:\QoderWork Project\AGENT\apps\desktop\release\xiu-ai-cli-0.20.4-c4113de2bf11ad1f2136464c6c6450c73d6f4f45.tgz'
npm.cmd publish 'D:\QoderWork Project\AGENT\apps\desktop\release\xiu-ai-cli-0.20.4-c4113de2bf11ad1f2136464c6c6450c73d6f4f45.tgz' --access public --tag latest --registry=https://registry.npmjs.org/
npm.cmd view @xiu-ai/cli@0.20.4 version dist.integrity --registry=https://registry.npmjs.org/
npm.cmd view @xiu-ai/cli dist-tags --json --registry=https://registry.npmjs.org/
```

完成后确认版本 0.20.4、latest 指向 0.20.4，并核对 Registry tarball integrity 与原包；不要执行重新 npm pack 或移动 tag。

> 当前正式版：0.20.3 两端一致，[GitHub Release](https://github.com/andrewjr1991/xiu/releases/tag/v0.20.3) 已发布。精确源码 `2ad7891d8756d98001e8d6a23dc4603ccddd998d` 的 [CI 37099780173](https://github.com/andrewjr1991/xiu/actions/runs/37099780173) 六作业全绿；原始 CLI tarball、未签名 Windows NSIS、两份 manifest 和 SHA256SUMS 上传后摘要匹配。维护者确认 Skill、真实输入法和外部设备验收通过。npm 按最新选择由维护者自行发布同一 CI 包，目前待完成；GitHub 发布不代表 npm latest 已更新。CLI 全依赖及两端生产依赖审计为 0；桌面开发依赖仍有 8 条 high 传播项，共同根因 GHSA-ch52-4w7c-c8xp 无补丁，已明确风险接受并披露。不降级构建器、不抑制告警，普通下载未启用 HTTP 响应缓存，最终包不含该依赖。CI 全绿不表示漏洞修复。不覆盖已发布版本，不放宽企业 ACL。下方旧版本状态为历史记录。

### 本地 Windows 产物位置

当前交互优化候选使用 `Xiu-0.20.3-local-interaction-x64.exe`，未打包版本仍写入 `apps/desktop/release/win-unpacked`，安装器直接写入 `apps/desktop/release`。仅本地测试，不覆盖正式资产、不提交或发布；安装器不自动修复 Provider 权限。

该候选本地验证：38 项专项测试、根目录/桌面类型检查、构建、文档检查、1366/900 宽窄界面测试，以及安装/启动/升级/中断重启/卸载检查通过。ASAR 主程序与渲染资源匹配本次构建，不含 UI 测试 preload；未跑全量测试或远端 CI。EXE 与安装包均为 NotSigned。安装包 SHA-256：`1fb4c024e1b98cfcaeacc0bda354930b544238e58303645b8d9053231a760947`。

企业环境模型切换兼容修正候选命名为 `Xiu-0.20.3-local-provider-fix-x64.exe`，只修受限 PowerShell 权限检查实现，不自动更改既有不安全 ACL。维护者后来明确授权单独收紧本机空恢复目录 ACL，Xiu 只读权限核验通过，未改配置内容或清锁；模型切换仍须维护者重启后实测。该候选不构成提交、推送或发布授权。

子任务实测修正测试包为 `Xiu-0.20.3-local-subagent-fix-x64.exe`，仍非正式版。Provider 存储测试在本机受企业 ACL 限制，最终 CI 必须覆盖真实多客户端刷新与恢复重启门禁；替身控制器和 UI 通过不代表存储测试通过。

0.20.4 子智能体状态交互目前只作本地验证，包内版本暂保留 0.20.3，测试安装器命名为 `Xiu-0.20.3-local-subagent-x64.exe`；不得据此重发已发布的 0.20.3。正式候选须另行升版本，完成精确提交 CI、产物核验及维护者验收后再发布。本地类型检查、专项或界面检查不能替代最终提交的 CI。

本地构建统一输出至 `apps/desktop/release`：未打包程序为 `apps/desktop/release/win-unpacked/Xiu.exe`，安装包直接放在 `apps/desktop/release`，不再为每次修正创建新输出子目录。未发布测试安装器使用带 `local` 标记的独立文件名，避免与正式发布资产混淆；该目录约定不代表提交、推送或发布授权。

### 0.20.3 维护者 npm 发布

使用已核验的 Windows CI tarball，不重新打包。SHA256：`ba23098b1df92fc09ef4430ca8349e7222e99baafc4693e554a2faa391a1f16c`。发布前查询该版本；若已存在，不覆盖，先核对其来源和完整性。

```powershell
npm.cmd publish "D:\QoderWork Project\AGENT\apps\desktop\release\v0.20.3-ci\cli\xiu-ai-cli-0.20.3-2ad7891d8756d98001e8d6a23dc4603ccddd998d.tgz" --access public --tag latest --registry=https://registry.npmjs.org/
npm.cmd view '@xiu-ai/cli@latest' version dist.integrity --registry=https://registry.npmjs.org/
```

该包也可从上方 GitHub Release 下载；下载后核对 SHA256SUMS。正式 tag 始终指向产物源码，后续仅文档提交不移动 tag。

2026-10-03 更新（覆盖以上候选状态）：[GitHub preview.11](https://github.com/andrewjr1991/xiu/releases/tag/v0.20.3-preview.11) 已发布，精确 tag/产物源码为 `cc49096f987309fa38baa7947694ff2398f1ccff`，[CI 37094638003](https://github.com/andrewjr1991/xiu/actions/runs/37094638003) 六作业全部通过。Windows 全量 890 项：883 通过、7 跳过、0 失败。资产直接从同一 CI 下载并逐项核验来源、版本、清洁工作树和 SHA256，上传后核验 GitHub digest 再公开草稿；包含未签名 NSIS、CLI tarball、两份 manifest 及 SHA256SUMS。npm 网页授权已完成，但保存登录状态 `.npmrc` 被系统拒绝，因此尚未发布 npm，需维护者在正常终端发布同一 CI tarball 至 preview 标签并回读版本/标签/完整性；不提升稳定 latest，不修改企业 ACL 策略。真实输入法/外部设备仍独立待验收。

本次本地完整回归 889 项：799 通过、83 失败、7 跳过。83 项失败为当前 ConstrainedLanguage PowerShell 的 Windows ACL 检查失败；不得放宽 ACL 或视为通过。后续新增管理安装/控制器专项 20/20 通过，两端类型检查和构建通过，1366/900px 及 125% 缩放界面、浏览器隔离、完全访问确认专项通过。代码提交 `51e818a96a5c4d4c0967d81ffea5ba0ca3735c6b` 的 [CI 37011734780](https://github.com/andrewjr1991/xiu/actions/runs/37011734780) 六作业全部通过，最终本地安装器安装/启动/升级/中断重启/卸载通过。安装器 SHA256 为 `c6b85435ec7d5ef813cbe79b49743f62b046b9f018b769bd6ae74c379368390b`，仍未签名。真实输入法/外部设备与本地环境失败仍须独立验收；当前未创建标签或发布，这些结果不构成稳定发布条件已满足。

preview.8（c7efc8de9f156ddda761c8393d37df4f0965efe5）的 CI 36993723905 已结束：六作业中五个通过，Windows 隐私预检 9/9 通过；完整 Windows CLI 868 项中 859 通过、7 跳过、2 失败，构建/包/平台/评测检查通过，整体仍未接受。preview.9 仅针对这两项 Windows 失败：后台目录枚举后对象消失时仅容忍 ENOENT，保留类型检查及其他错误；恢复入口测试夹具按生产流程初始化写锁所有者，不放宽 ACL 或恢复规则。具体诊断与回归证据待补齐，新功能继续暂停。本候选必须独立完成 Windows 隐私预检、全量 CLI、三平台桌面及安装生命周期门禁；本地/精确提交 CI 与产物待回填，最后完整通过仍为 preview.3。

preview.7 的三平台 18 张合成 PNG 已检查：Linux 中文缺字属于运行环境字体缺口，macOS 宽窗恢复图截取了错误状态，三平台菜单图均未显示展开菜单；来源详情中的 canary 是有意的活动预览，不是隐私泄漏证据。截图存在不等于视觉验收全部通过，截图修正排在 Windows 隐私门禁之后。既有成功运行六张 PNG 的验证/上传门禁不变，仅上传白名单，不上传临时用户资料/配置；制品名包含版本、平台、完整 SHA、run attempt，保留 30 天。

# Xiu 更新、发布与安装指南

0.20.2 工作台增量候选门禁：独立 Diff 的目录树/搜索/历史轮次/缺失快照；子智能体真实执行、权限不扩张、取消等待和整合独立确认；后台 Node worker 解包启动；桌面 npm/npx MCP 在 Electron 中不能以主程序当作 Node。`node apps/desktop/scripts/runtime-node-smoke.mjs` 验证真实 Electron、隔离 MCP 服务与后台 worker；可显式指定 `XIU_MCP_REAL_CONFIG` 核验已有授权的 everything 服务，不写真实清单或权限。正式包不能包含测试 harness/桥接；MSIX 仍需可信签名，仅在用户授权后发布。

0.20.2 未发布候选新增桌面 UI/权限修正：发布前必须验证完全访问首次确认、取消/异常拒绝、确认等待互斥、外部文件和本机命令执行、危险工具自动批准、权限撤回、工作区切换/重启不持久化、Plan 只读与外部文件不写入检查点/任务 Diff。此模式仅当前 OS 用户权限，不能声称实现 Codex OS 沙箱或模型审查器。发布需用户授权，MSIX 仍需可信签名。

2026-10-02 候选本机门禁：687 项测试（686 通过、1 项 Windows 符号链接跳过、0 失败），9 项新权限专项通过；两端类型检查/构建、文档、10/10 smoke eval、319 文件包检查、隔离安装和平台/桌面/UI smoke 通过。NSIS 的安装/启动/升级/中断重启/卸载和 MSIX 结构 smoke 通过。包检查曾因默认 npm 缓存不可写失败，MSIX 并行构建曾遇到临时文件占用，改隔离缓存并顺序重跑后通过。产物为 `apps/desktop/release/win-unpacked/Xiu.exe`、`Xiu-0.20.2-x64.exe` 和未签名 `Xiu-0.20.2-x64.msix`；普通部署仍需可信 MSIX 签名。本次没有真实计费模型调用、外部设备或原生确认弹窗人工验收，自动化结果不替代这些验收。

未发布 0.20.2 的 MCP 门禁包含：共享 Manager 组合、桌面连接/断开、基本用户配置新增/编辑/确认删除、配置指纹冲突拒绝、项目/高级/凭据配置只读、OAuth 来源与 Scope 确认/备用地址/取消/退出、真实本地 PKCE 回调与端口释放、Resource/Prompt 有界脱敏只读浏览，以及 Agent 危险审批/Plan 只读、失败工具撤销、退出清理和窄窗 UI smoke。测试只能使用隔离本地服务器与 Canary，不得操作维护者真实配置和凭据。2026-10-02 用户已授权提交、推送并发布 0.20.2；npm 需要登录授权，GitHub Release 与精确 tag 按通用门禁执行。

历史 0.20.2 候选阶段：修复 CLI/桌面默认渠道占位问题，当时公开版本仍为 `0.20.1`；当前开发源码为 `0.20.3-preview.9`，已核验公开 npm 基线为 `0.20.2`。候选使用版本 5 注册表，首次安装零渠道、旧设置一次性迁移；发布前必须完成隔离首次配置与两端回归，不得覆盖 0.20.1，也不得将候选构建成功当作正式发布。

0.20.2 迁移会更新共享渠道文件格式，旧版客户端不能读取版本 5。发布时必须一起提供 CLI 与桌面候选并提示配套升级；未获得发布授权前不要把它表述为公开 npm 最新版。验证不能访问、迁移或清理维护者真实用户目录中的配置和凭据。

此前公开产品基线为 `0.20.1`，该补丁版本补齐能力模型选择持久化、生成媒体下载边界与 Windows 后台进程交接；Windows 桌面预览独立打包，桌面设计要求见 `V0.20.2_DESIGN.zh-CN.md`。历史版本门禁保留用于追溯，不要求每次普通修复重新手工验收全部历史平台矩阵。任何后续发布仍需用户明确决定，先核对 Registry，不能覆盖已发布版本。

这份文档写给第一次维护或安装 npm 命令行工具的人。内容分为两部分：

- 开发者如何修改 Xiu、升级版本并发布到 npm。
- 普通用户如何安装、配置、升级和卸载 Xiu。

当前公开包名为 `@xiu-ai/cli`，安装后提供的终端命令是 `xiu`。

CLI 与桌面并非完整功能等价，发布说明必须按[能力盘点](./ROADMAP.zh-CN.md#4-后续工程化)分别标记已接入与待接入能力。0.20.1 的隐藏预设渠道占用 ID 问题已登记为下一修复项；0.20.2 已实现并验收默认零渠道。修复发布前须使用隔离用户数据验证两端零渠道启动、首个渠道添加、同名 Agnes 添加、删除最后一个渠道、重启与旧设置迁移；仅在已配置开发机上启动通过不算全新安装验收。

## 一、先理解三个名称

| 名称 | 含义 |
| --- | --- |
| `xiu-ai` | npm 组织名，也是 scope 名称 |
| `@xiu-ai/cli` | npm 上的完整包名 |
| `xiu` | 用户安装后在终端输入的命令 |

包名和命令名不同是正常的。用户安装 `@xiu-ai/cli` 后，只需要输入 `xiu`。

## 二、普通用户安装

### 2.1 安装 Node.js

Xiu 要求 Node.js 20.18.1 或更高版本。安装 Node.js 后，重新打开 PowerShell并检查：

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

从 `0.16.0` 起，也可以让 Xiu 执行只读版本检查：

```powershell
xiu --check-update
```

交互模式中可输入 `/update`。它们只比较本地版本和官方 `latest`，不会自动运行 npm、读取 npm Token 或修改全局安装。

从 `0.16.1` 起，用户可以执行 `/update notifications on` 显式开启非阻塞提醒，使用 `/update status` 查看缓存与状态，或用 `/update notifications off` 关闭。提醒默认关闭，启用后复用 24 小时缓存；过期刷新只在交互界面可用后于后台进行，结果只在安全输入边界显示。该功能仍不会自动安装或修改全局 npm。

从 `0.16.2` 起，`xiu --update-doctor` 与 `/update doctor` 提供只读分发诊断，检查 Node.js、必需包文件、更新代理、缓存与 npm 官方 Registry。诊断明确区分本地硬错误和外部网络警告，不运行 npm、不读取 npm Token、不修复安装，也不修改全局配置。

从 `0.16.3` 起，同一诊断还检查 PATH 首命中的 `xiu`、当前运行包、重复安装、旧或损坏 shim，以及显式 npm prefix 与 PATH 的一致性。同一 npm 安装生成的多个 shim 按真实包根目录归组；诊断只给出可复制建议，不自动修改 PATH、prefix、shim 或全局安装。

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

## 二十三、0.15.0 原生只读联网搜索发布门禁

发布 `0.15.0` 前除通用流程外，还必须验证：

1. 未配置或已执行 `/web disable` 时不注册联网工具，普通启动、编码任务、MCP 和 Provider 行为不退化。
2. Tavily、Brave Search 与 HTTPS SearXNG 均能返回有界结果和精确来源 URL；Tavily 使用有界 basic POST 请求，SearXNG 根地址及 `/search` 地址均不会形成重复路径。
3. 设置文件只保存 Tavily/Brave Key 或可选 SearXNG Token 的环境变量名，不保存凭证正文；错误、诊断、会话和日志不泄漏认证头，带认证的请求不得把凭证跨域重定向。
4. HTTP、URL 内嵌凭证、localhost、本机、私网地址和超限响应失败关闭；每次重定向重新验证目标。
5. 允许/阻止域名策略同时约束搜索结果和页面打开；被阻止结果不能借重定向绕过策略。
6. HTML 的脚本、样式、表单和主动内容被剥离，正文带有不可信外部内容提示且不能充当模型指令。
7. 限流、超时与服务端瞬时错误仅按安全读取语义有界重试；认证、权限、参数错误和用户取消不误重试。
8. 当前代理、超时和取消信号对搜索与页面打开均生效；工具不保存 Cookie、不登录、不提交表单、不执行外部写入。
9. 专项测试、完整测试、类型检查、构建、包预览和干净目录安装全部通过后，才允许发布并回读 Registry。

## 二十四、0.15.1 内测搜索预置发布门禁

发布 `0.15.1` 前除通用流程外，还必须验证：

1. npm 包只包含 `https://search.jingran.vip` 及其认证端点，不得包含共享 Bearer Token、邀请码、管理 Token、设备秘密、认证响应样本或其他可用秘密。
2. 新安装和升级用户在没有显式 `webSearch` 配置时自动注册联网工具，但设备登记和 Token 请求必须延迟到第一次搜索，不得拖慢启动。
3. 第一次搜索自动登记设备并申请短期 Token；设备凭证优先存入 Windows 凭证管理器，兼容文件只允许当前用户访问，短期 Token 只保存在内存并在到期前续签。
4. 已保存的 `/web configure` 和 `/web disable` 状态必须优先，预置不得覆盖用户选择。
5. `/web proxy set http://127.0.0.1:12334` 必须立即应用并在重启后保留；`/web proxy clear` 必须让当前会话恢复直连；两者都不得修改模型 Provider 代理。若父终端仍设置 `XIU_WEB_PROXY`，清除命令必须明确提示下次启动可能恢复该环境变量。
5. `~/.xiu/settings.json`、会话、诊断、报告和错误输出中不得出现 Token 正文。
6. 自动登记、缓存续签、并发合并、撤销后重新登记和旧环境变量迁移均须通过确定性测试，再执行完整测试、类型检查、构建、`npm pack --dry-run` 和压缩包秘密扫描。
7. 服务端必须限制每 IP 每日登记数，并同时实施每设备与每 IP 搜索限流；管理接口只允许 VPS 本机访问。
8. 短期 Token 服务端必须通过 Python 自检、HTTP 注册/签发/验证/鉴权转发/撤销闭环和真实 VPS 验收；服务只监听本机，管理 API 不得出现在公网 Nginx location 中，且不得要求宝塔 Nginx 编译可选模块。安装器还必须以 root 初始化命名卷所有权，再以非 root UID `10001` 启动服务。
9. 旧 Token 迁移只保存 SHA-256 摘要；安装器、`auth.env` 模板、日志、文档与 npm 包不得复制实际旧 Token。
10. 设备数据库目录必须由容器非 root 用户独占写入；容器移除 Linux capabilities 并设置 `no-new-privileges`。旧 CentOS/Docker 环境须使用已验证的 Debian slim Python 镜像和 Docker 命名卷，不得退回会触发 SQLite I/O 错误的 Alpine 组合。

## 二十五、0.15.3 搜索可靠性安全修复发布门禁

发布 `0.15.3` 前除通用流程外，还必须验证：

1. 托管搜索的设备注册、Token 签发、搜索和页面打开使用同一套独立联网代理；默认直连，不得继承当前模型 Provider 代理。显式配置联网代理时，认证和搜索不得出现一方直连、一方走代理的分裂行为。
2. 所有 `web_search` 调用失败时，模型生成的“最新事实”不得显示或写入最终答复，任务必须以失败结束并提供脱敏错误。
3. “最新/最近/当前/今日/明确时间范围”任务中，仅有搜索摘要时不得完成；最终答复里的每个 HTTP(S) 引用都必须在本次任务中成功通过 `web_open` 打开，未满足时任务必须失败。
3. Windows 企业环境必须验证系统信任库与 Node 内置根证书合并生效；不得设置 `NODE_TLS_REJECT_UNAUTHORIZED=0` 或实现忽略证书错误的开关。旧运行时只允许使用 `NODE_EXTRA_CA_CERTS` 显式补充管理员提供的 PEM 根证书。
4. `registration_not_allowed`、设备凭证拒绝和确定性 TLS 证书错误必须在首次失败后停止模型循环；验收中模型不得继续改搜其他站点来掩盖搜索不可用。
5. 发布前从公网检查 `/xiu-auth/healthz`，确认 `publicRegistration=true` 且每日 IP 登记配额非零；再以无旧 Key、无旧设备凭证的新用户完成首次自动登记与搜索。
6. 搜索恢复后获得至少一个可用结果时，证据门禁允许任务继续，且来源 URL 仍按现有安全边界输出。
7. `/report` 只有在存在成功的显式验证操作时才显示“已验证”；无验证证据的只读检索不得误标。
8. 定向搜索、认证、Agent 与报告测试，以及完整测试、类型检查、构建、包预览和秘密扫描全部通过后，才允许发布并回读 Registry。
9. 删除旧 `XIU_SEARXNG_TOKEN` 后，以保留旧设置的新用户场景启动并首次搜索，必须自动迁移到设备注册和短期 Token，不得继续提示缺少旧环境变量。

## 二十六、0.15.4 托管搜索自诊断与凭证恢复发布门禁

发布 `0.15.4` 前除通用流程外，还必须验证：

1. `/web` 与 `/web status` 不发起任何网络请求，不登记设备，并正确区分系统凭证、兼容文件、无凭证和系统后端不可用；输出不得包含设备秘密或短期 Token。
2. `/web doctor` 只在用户显式执行后检查健康与认证链路，使用与 `web_search` 相同的独立代理和 TLS 策略；无凭证时应明确告知可能登记设备。
3. `/web reset` 默认选项为取消；确认后仅删除托管搜索本机设备凭证和内存 Token，保留 installation ID、Provider 凭证及 Tavily/Brave/SearXNG 环境变量。
4. 系统凭证引用存在但系统凭证后端不可用时必须失败关闭，不能声称重置成功，也不能静默写入兼容文件覆盖该状态。
5. 重置后下一次 `/web doctor` 或真实搜索只重新登记一次，并能重新获得短期 Token；旧 Token 不得写入状态文件、会话、日志或报告。
6. 普通启动不得执行健康检查、设备登记或 Token 签发；启动速度不能因本功能退化。
7. 定向认证测试、完整测试、类型检查、构建、`npm pack --dry-run`、包内容检查和秘密扫描全部通过后，才允许发布并回读 Registry。

## 二十七、0.15.5 来源引用与搜索质量发布门禁

发布 `0.15.5` 前除通用流程外，还必须验证：

1. URL 片段和常见追踪参数被清理，剩余查询参数稳定排序；规范化后相同的 URL 只保留一条。
2. 每条搜索结果包含稳定 `WEB-xxxxxxxx`、精确 Citation URL 和来源域名；打开同一 URL 后显示相同标识。
3. Provider 标题、摘要和日期均有界，控制字符与异常空白不会污染终端或上下文。
4. 质量摘要只报告来源、域名、日期和去重覆盖，不得使用“可信”“权威”“已验证”等误导性结论。
5. “最新”等时效任务仍必须逐条打开最终引用 URL，稳定标识和质量摘要不得绕过证据门禁。
6. “最近/过去 N 天、周、月、年”按当前日期计算确定性滚动首选范围；要求日期时，来源提供可核验日期就必须保留真实日期，来源完全没有可核验日期则由程序确定性标注“日期：未知（来源未提供可核验日期）”。范围内结果不足时允许返回更早的已打开来源，但必须展示真实日期并说明其位于首选范围外；不能推断、伪造日期或让模型补足日期。
7. 同一任务真实执行的 `web_search` 不得超过 3 次；单个 `web_open` 页面只能真实尝试一次。尚无成功来源时，真实失败的页面打开最多 6 次；已有至少一个成功来源后，最多 4 次。达到上限后只能进行一次无工具最终作答，并向模型提供本次成功打开 URL 的精确允许列表，不能继续换站点、调用其他工具空转或声称未成功打开的来源已经验证。
8. 失败预算耗尽后的最终作答如果混合引用允许列表内外 URL，必须整块移除清单外 URL 对应的候选条目，并在仍有已核验来源且每条都有真实日期或明确“日期未知”标记时以较少结果完成；不能只删除 URL 而保留无来源陈述。无法安全裁剪、继续请求工具或剩余证据不足时，必须立即以当前界面语言失败；不得出现第二次纠正循环，也不得向中文界面泄漏内部英文门禁文本。
9. Brave、Tavily、SearXNG、托管认证、域名策略、SSRF、重定向和 HTML 清理测试全部通过。
10. 完整测试、类型检查、构建、`npm pack --dry-run`、包内容检查和秘密扫描全部通过后，才允许发布并回读 Registry。

## 二十八、0.15.7 托管搜索部署升级与数据库迁移发布门禁

发布 `0.15.7` 前除通用流程外，还必须验证：

1. 已安装服务没有显式 `--database` 时保留现有合法 `XIU_AUTH_DATABASE`；首次安装才默认使用 `/data/xiu-search-auth.sqlite3`。
2. 目标数据库为空或不存在、而命名卷中其他 `*.sqlite3` 含有设备记录时，安装器必须在启动服务前失败关闭，并且只显示候选文件名和设备数量。
3. `--migrate-database-from` 必须先输出只读预览；目标存在时先创建 SQLite 一致性备份且权限为 `600`，再开始事务写入。
4. 相同设备记录重复迁移必须幂等；同一设备 ID 对应不同凭证数据、schema 不兼容、符号链接、目录逃逸、备份失败或 SQLite 错误必须在覆盖任何设备前终止。停止旧授权服务失败时不得继续迁移。
5. 迁移输出、安装器日志、`admin.txt` 和错误不得包含设备 ID、secret hash、IP、Token、管理 Token 或数据库正文；源数据库和备份不得自动删除。
6. 命名卷初始化 helper 必须禁用网络、使用只读根文件系统并只临时恢复 `CHOWN`、`DAC_OVERRIDE`、`FOWNER`；迁移 helper 必须设置内存和进程上限；长期服务继续使用 UID/GID `10001`、`cap_drop: ALL` 与 `no-new-privileges`。
7. Python 迁移专项测试、Shell 语法检查、完整 TypeScript 测试、类型检查、构建、包预览和秘密/数据库文件清单检查全部通过。
8. 在真实目标 VPS 分别完成原路径升级、空目标分叉拦截、显式迁移、容器健康检查和 `/web devices` 数据连续性验收后，才允许发布并回读 Registry。

## 二十九、0.16.0 稳定分发与升级诊断发布门禁

发布 `0.16.0` 前除通用流程外，还必须验证：

1. `xiu --check-update` 与 `/update` 只访问 npm 官方 `@xiu-ai/cli/latest` 端点，拒绝重定向，且输出本地版本、官方版本和确定性的语义版本比较结果。
2. Registry 版本较新时只显示固定官方更新命令，不执行 npm，不读取 npm Token，不修改 npm 配置或全局安装。
3. 本地候选版本高于 Registry 时明确显示“本地版本高于 npm latest（可能是开发版）”，不得建议自动降级。
4. 普通 `xiu` 启动不得触发版本检查网络请求，也不得因 Registry、代理或 DNS 故障增加启动等待。
5. 更新检查代理仅使用 `XIU_UPDATE_PROXY`、npm HTTPS 代理或标准 HTTPS 代理变量，不继承模型 Provider 与 `XIU_WEB_PROXY`。
6. 超时、超大响应、非 2xx、无效 JSON、缺失版本和无效语义版本均失败关闭并输出脱敏错误。
7. 中英文输出、代理隔离、无自动执行、固定端点和普通启动无联网均有确定性测试。
8. 完整测试、类型检查、构建、`npm pack --dry-run` 和包内容检查全部通过；包内不得包含 `.xiu/`、凭证、本机配置或旧版设计稿。

## 三十、0.16.1 非阻塞更新提醒发布门禁

发布 `0.16.1` 前除通用流程外，还必须验证：

1. 更新提醒默认关闭；未显式开启时，普通 `xiu` 启动不得访问 npm Registry，也不得创建更新缓存。
2. `/update notifications on|off` 与 `/update status` 必须即时生效并持久化；关闭后不得显示仍在飞行中的后台检查结果。
3. 启用提醒后，有效期内只读取 24 小时缓存；缓存缺失或过期时只在交互界面已经可用后后台刷新，不阻塞启动和输入。
4. 后台结果只能在下一次安全输入边界显示，不得打断正在输入的文字、选择器、审批、模型问题或运行中的任务。
5. Registry、代理、DNS、超时、响应格式和缓存损坏失败必须静默降级；显式 `/update` 和 `xiu --check-update` 仍保留清晰错误。
6. 缓存只能保存 schema、官方 latest 版本、官方 Registry 与检查时间，不得保存代理、凭证、npm Token、当前项目路径或会话内容。
7. 缓存中的 latest 必须按当前正在运行的版本重新计算比较结果；损坏、未来时间、非官方 Registry 和无效版本必须忽略。
8. 提醒只显示固定官方更新命令，不执行 npm、不读取 npm Token、不安装、不降级、不修改 npm 配置或全局安装。
9. 定向缓存/设置/格式测试、完整测试、类型检查、构建与 `npm pack --dry-run --json` 全部通过；包内只保留 `V0.16.1_DESIGN.zh-CN.md`，不得包含 `.xiu/` 或旧版设计稿。

## 三十一、0.16.2 分发可靠性与更新诊断发布门禁

发布 `0.16.2` 前除通用流程外，还必须验证：

1. `xiu --update-doctor` 与 `/update doctor` 只执行运行时、包文件、更新代理、缓存和官方 Registry 的只读检查，不运行 npm、不读取 npm Token、不安装、不修复、不修改全局配置。
2. Node.js 低于 20、必需包文件缺失或更新代理无效属于本地硬错误；一次性命令必须返回非零退出码。
3. 离线、DNS、代理出口或 Registry 暂不可用属于外部警告；诊断必须说明 Xiu 仍可使用，且一次性命令不得因此返回失败。
4. 更新代理只按 `XIU_UPDATE_PROXY`、`npm_config_https_proxy`、`HTTPS_PROXY`、`https_proxy` 的顺序选择，输出来源和脱敏地址；带凭证的 URL 必须拒绝且不得泄露凭证。
5. 包完整性至少检查 `package.json`、`dist/cli.js`、`README.md` 与 `USAGE.zh-CN.md`；诊断不得扫描项目文件或用户会话。
6. 普通 `xiu` 启动继续保持零版本检查联网；诊断只能由用户显式触发。
7. 中英文输出、硬错误退出码、外部警告降级、代理隔离与不执行 npm 均有确定性测试。
8. 完整测试、类型检查、构建与 `npm pack --dry-run --json` 全部通过；包内只保留 `V0.16.2_DESIGN.zh-CN.md`，不得包含 `.xiu/` 或旧版设计稿。

## 三十二、0.16.3 安装路径与版本冲突诊断发布门禁

发布 `0.16.3` 前除通用流程外，还必须验证：

1. `xiu --update-doctor` 与 `/update doctor` 显示当前运行包、PATH 首命中启动器、可识别版本和真实包根目录，不运行 npm 或修改系统状态。
2. 同一 npm 安装生成的 `xiu.ps1`、`xiu.cmd` 等 shim 必须按真实包根目录归为一个安装，不得误报重复安装。
3. PATH 首命中旧版本、真正的多安装、无法解析的旧或损坏 shim，以及显式 npm prefix 的命令目录未进入 PATH 均有确定性测试。
4. 命令未进入 PATH 或存在版本冲突时只显示警告；Node.js 过低、当前包缺少必需文件或更新代理不安全仍保持硬失败和非零退出码。
5. PATH 检查最多读取 128 个直接目录，不递归扫描磁盘；单个启动器和 `package.json` 最多读取 64 KiB。
6. 诊断不得读取 npm Token、Provider Key、项目文件或会话，不得自动修改 PATH、npm prefix、shim 或全局安装。
7. 普通 `xiu` 启动不得执行 PATH 诊断或新增版本检查联网；所有检查仍由用户显式触发。
8. 中英文输出、PATH 顺序、shim 归组、重复安装、损坏启动器、prefix 不一致和警告退出码均有确定性测试。
9. 完整测试、类型检查、构建、`npm pack --dry-run --json` 与干净安装验收全部通过；包内只保留 `V0.16.3_DESIGN.zh-CN.md`，不得包含 `.xiu/` 或旧版设计稿。

## 三十三、0.16.4 官方发布元数据核验发布门禁

发布 `0.16.4` 前除通用流程外，还必须验证：

1. `xiu --update-doctor` 与 `/update doctor` 查询 `@xiu-ai/cli` 当前精确版本，而不只读取 npm `latest` 标签。
2. 返回包名和版本必须精确匹配；tarball 必须使用 HTTPS、不得含凭证，且主机名必须精确等于 `registry.npmjs.org`。
3. `dist.integrity` 必须是可解码为 64 字节摘要的规范 SHA-512 SRI；可选 `dist.shasum` 必须是 40 位十六进制值。
4. 诊断必须明确说明只核验官方 Registry 元数据，未下载发布包，也未对本地安装文件计算哈希，不得声称本地文件逐字节可信。
5. 精确版本未发布、外部网络不可用或元数据异常只产生警告；现有 Node.js、包文件和不安全代理硬失败语义保持不变。
6. 响应继续受 256 KiB 上限、禁用重定向、独立更新代理和有界超时保护；普通 `xiu` 启动不得新增联网。
7. 错误包名、版本错配、非官方 tarball、无效完整性值、HTTP 404 和中文诊断均有确定性测试。
8. 完整测试、类型检查、构建、`npm pack --dry-run --json` 与干净安装验收全部通过；包内只保留 `V0.16.4_DESIGN.zh-CN.md`，不得包含 `.xiu/` 或旧版设计稿。

## 三十四、0.16.5 运行过程持久可见发布门禁

发布 `0.16.5` 前除通用流程外，还必须验证：

1. 任务运行时模型轮次、用户可见思考摘要、工具开始、有界结果、文件 Diff、验证、重试与失败增量写入终端滚动区，同时 `补充> ` 编辑器保持可输入。
2. 刷新进度面板不得清空用户草稿、移动输入光标或重复打印同一批已消费过程输出。
3. 文件变化在操作发生后显示，不在任务结束时重复倾倒；最终回答和完成回执保持一次且顺序正确。
4. 未完成的流式草稿不得在证据门禁、语言规范化或来源裁剪前进入永久滚动历史；私有思维链不得写入终端日志、会话、报告或安全审计。
5. 工具结果和 Diff 保持有界；凭证与已知秘密继续经过现有脱敏边界，完整巨量输出不得直接倾倒。
6. `Ctrl+O` 和 `/details` 继续切换底部最近活动，不提交或清空正在输入的补充内容。
7. 中文与英文模式、窄终端换行、任务结束尾部刷新、用户输入期间刷新和 Windows PowerShell/ConPTY 均完成回归验证。
8. 完整测试、类型检查、构建、`npm pack --dry-run --json` 与干净安装验收全部通过；包内只保留 `V0.16.5_DESIGN.zh-CN.md`，不得包含 `.xiu/` 或旧版设计稿。

## 三十五、0.17.0 可验证产品基础发布门禁

发布 `0.17.0` 前除通用流程外，还必须验证：

1. Windows、Ubuntu、macOS 的 CI 均执行 Node.js 20.18.1 下的类型检查、完整测试、构建、打包预览和临时目录安装冒烟；失败不得以 `continue-on-error` 伪装通过。
2. Pull Request CI 不读取模型、npm 或其他外部服务密钥，不运行真实模型任务，也不执行发布、远端写入或全局安装。
3. `npm run smoke:package` 只在临时目录安装当前工作区生成的包，验证包名、包版本与 `xiu --version` 一致，并在成功或失败后清理临时目录。
4. `README.md`、`README.zh-CN.md`、`QUICKSTART.md`、`CHANGELOG.md`、`CONTRIBUTING.md` 的本地链接全部存在；中英文平台状态、安全边界和限制描述一致。
5. README 不得声称实时视图与 `/report` 使用同一持久账本，不得声称任务只向 `~/.xiu/` 与 `.xiu/` 写入，也不得将 CI 目标误报为真实平台验收。
6. `SECURITY.zh-CN.md` 明确禁止显示、保存或伪造 Provider API 未返回的隐藏思维链；实时输出只包含明确面向用户的摘要和程序可核验事件。
7. 包内只保留 `V0.17.0_DESIGN.zh-CN.md`，不得包含旧版设计稿、`.xiu/`、`.github/` 或开发者本地状态。
8. 发布仍由用户显式决定；发布后必须回读官方 Registry 的版本、latest、SHA-512 完整性和文件清单，再给精确发布提交打 `v0.17.0` tag。

## 三十六、0.18.1 稳定化与发布收束检查

`0.18.0` 已发布，但精确提交的 Windows CI 未通过，文档和默认分支也未完成收束。`0.18.1` 必须修复 Windows 临时目录清理、后台任务终态竞态、无 Git Junction 边界和已知生产依赖公告。开发中运行对应离线测试；候选代码固定后集中执行下列检查，通过且代码未变化的检查不重复运行。以下是要求，不是已经通过的结果：

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run check:docs
npm.cmd run eval:smoke
npm.cmd pack --dry-run --json
npm.cmd run smoke:package
```

Windows PowerShell 统一使用 `npm.cmd`，避免 `npm.ps1` 在 ConstrainedLanguage 环境中的方法调用错误。普通离线场景使用脚本化 Provider、真实临时文件和检查进程；不授予 CI 真实模型凭证，不触发模型费用。

候选检查重点：

1. 工具失败、拒绝、取消、超时和未知副作用有准确状态；换参数的连续同类失败有界停止，失败命令不算进展，未知副作用不重放。
2. `echo test`、帮助/版本与只收集测试不算验证；修改后旧证据过期，另一项检查通过不能盖掉失败；模型截断或未知结束不能宣告完成或执行部分工具调用。
3. 中文/英文草稿跨片段脱敏、代码保留原文，未闭合私钥不会泄漏；草稿只出现在临时运行视图，不写入永久历史，也不挤掉用户输入。
4. `/diff` 默认任务视图，另有 `workspace` 和 `staged`；覆盖新建、删除、暂存、原有修改与外部修改，来源未知和快照上限准确说明。任务起点只在内存，不能承诺重启后仍可还原。
5. `/check` 只发现根 npm 项目；单项与 `all` 展示实际脚本并复用审批。Plan 阻止执行，`Ctrl+C` 取消，缺脚本跳过，拒绝/取消后不启动后续脚本；退出成功不自动等于需求验证完成。
6. 跨 Provider 工具历史离线回放正确；保留响应不包含隐藏推理。包内没有真实评测结果、凭证或个人评估文件，只保留当前版本设计稿。

用户只对同一候选集中体验一次，建议约 10–15 分钟：完成一个小修复并运行 `/check test`；在已有修改和新文件的项目中查看三种 `/diff`；在中文任务运行中补充要求、取消并复查最终状态。复杂项目的模型和检查耗时另计。类型、测试、构建与打包检查由开发流程承担，不再逐项转交用户重复执行。

旧真实评测及原始结果继续保留。最近运行只有 14/30 条记录（1 通过、13 预算失败，文件状态仍为 `running`）；受限工具缺少文件发现能力，不能作为完整产品基线或能力排名。P0/P1 不补跑旧流程，不扩题，不宣称端到端闭环已通过，也不继承旧确认码启动新付费调用。后续真实测试只围绕已明确的问题另行确定范围。

候选体验与标准检查满足后，由用户决定合并和发布；发布时核对精确版本、包内容及对应提交，再执行本指南的 Registry 回读与精确 tag 流程。

## 三十七、0.18.2 完成判定与终端可用性热修检查

`0.18.2` 必须复现并修复真实 Excel 到 HTML 任务中“最终验证通过却显示任务失败”的回归，同时收敛 Windows 终端重复补充提示、超长命令和计划刷屏。除通用门禁外，还必须验证：

1. 同一产物先通过较弱 `verify_output`，再执行不算验证的内联只读进程，最后通过覆盖全部旧要求的更严格 `verify_output`，最终状态为 `completed`。
   内联进程未观察到相关工作区或显式产物变化时，原验证本身也必须保持有效；真实修改或指纹取证失败时仍必须使证据过期。
2. 更弱检查、不同产物或不同验证类型不能抹掉失败或过期的必要检查。
3. 最终失败原因准确区分验证失败、最后工具批次失败、联网证据不足、模型未正常结束与运行时错误。
4. 定时刷新在没有新持久输出时不重绘输入框；命令候选不超过终端宽度；工具描述和关键操作摘要有界。
5. 实时计划只显示完成数、当前与下一步，完整计划仍可由 `/tasks` 查看；完整工具输出仍可由 `/details` 查看。
6. 通用全局流程 Skill 不进入模型自动目录，不因其存在而逐个加载；`/skills` 仍可列出，用户明确点名时仍可读取，项目级和插件级 Skill 不被误过滤。
7. 候选包版本为 `0.18.2`，只包含 `V0.18.2_DESIGN.zh-CN.md`，不包含个人评估文件；用户完成真实 Windows PowerShell 复测后再决定是否发布。
8. 快速并发后台任务全部保留 `completed` 终态；前台持有的旧 `running` 快照不能覆盖 worker 刚写入的终态证据。
9. `extract_html`、`extract_json` 和 `extract_csv` 收到超过安全上限的 `max_value_characters` 时按上限执行，不产生一次可避免的失败重试。

真实产品验收记录（2026-09-28）：Windows PowerShell 下从 Excel 生成 HTML 看板和主管话术，共 9 轮模型调用、12 次工具调用、0 失败；两项 `verify_output` 通过，后续只读 Python 完整性检查未使验证过期；未调用 `read_skill`；最终显示“已完成、已验证”。相较前次失败复测的 17 轮、24 次工具调用和 471,717 tokens，本次为 9 轮、12 次工具调用和 169,220 tokens。

## 三十八、0.19.0 更新命令模块化与真实平台候选包验收

`0.19.0` 首先拆分 `/update` 命令域，并把现有三平台 CI 推进到候选包实际安装路径。除通用门禁外，还必须验证：

1. `/update`、`/update status`、`/update doctor` 和通知开关由独立控制器路由；未知子命令只显示用法，不进入普通任务。
2. `--check-update` 和 `--update-doctor` 复用命令模块，保留成功/失败退出码；不自动运行 npm、不读取 npm Token、不修改 npm 配置。
3. 24 小时缓存命中只提醒一次；关闭通知会取消飞行中刷新结果；后台刷新失败保持静默，显式检查仍给出清晰错误。
4. `npm run smoke:platform` 从当前 tarball 安装候选包，在含空格和 Unicode 的路径中调用实际 npm `xiu` shim，并核对精确版本。
5. 平台 smoke 通过安装包的更新诊断解析实际 shim，并从安装包启动后台 worker、等待 `completed` 终态和核对 Unicode 输出。
6. GitHub Actions 的 Windows、Ubuntu、macOS 真 runner 都必须通过平台 smoke；不得用模拟 `process.platform` 代替真实 runner，也不得把 CI 描述为企业设备或用户真实终端验收。
7. 候选包版本为 `0.19.0`，只包含 `V0.19.0_DESIGN.zh-CN.md`，不包含个人评估文件；官方 Registry 已有 `0.18.2`，不得覆盖。

本地 PowerShell 应使用：

```powershell
npm.cmd run check:docs
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run eval:smoke
npm.cmd pack --dry-run --json
npm.cmd run smoke:package
npm.cmd run smoke:platform
```

推送候选分支后读取三平台作业最终结果；任一平台未运行或失败时，状态只能写为“待验收”或“失败”。GUI 在该矩阵稳定后另行设计，不纳入本版本。

候选验收记录（2026-09-28）：GitHub Actions 运行 `36403307522` 在 Windows、Ubuntu、macOS 的 Node 20.18.1 真 runner 上全部通过；三项作业均完成 590 项测试、构建、离线评测、打包、基础安装 smoke 和候选包平台 smoke。该结果不替代 Windows ARM64、企业策略设备或 macOS/Linux 用户真实终端验收。

## 三十九、v0.20.0 桌面工作台设计与实现门禁

`0.20.0` 已完成 GUI 设计、共享运行时 G1、Electron 安全壳/可信工作区 G2、任务/审批闭环 G3、审查/证据/恢复 G4、Provider/模型配置 G5A、受控交互终端 G5B、G5C 本机 Windows x64 候选包验收与三平台自动化 CI，并由用户决定作为 Windows 桌面预览发布。开发包 smoke 不等于跨平台稳定桌面验收；未签名 MSIX 仍只能作为待签名候选，不能作为可直接部署产物。具体范围、非目标、架构和验收标准见 `V0.20.2_DESIGN.zh-CN.md`。除通用发布门禁外，还必须满足：

1. CLI 和 GUI 共享同一信任、审批、检查点、验证和恢复内核；不得复制一套仅在前端生效的安全判断。
2. Electron Renderer 无 Node 权限，Preload 只暴露经 schema 校验的白名单方法；不可信 Markdown/HTML 不能获得本机能力。
3. 未信任工作区不得读取项目指令、Skill/MCP、文件内容或运行 Git；一次性参数和模型文本不能绕过。
4. CLI/GUI 同时访问由单写者锁与显式交接处理，未知数据版本和未知副作用均失败关闭。
5. 桌面安装物与 `@xiu-ai/cli` 分离；GUI 未实现和未通过真实平台验收前，不得作为稳定能力发布。
6. Windows x64 完成真实安装、审批、取消、崩溃恢复和长任务验收；macOS/Linux 缺少真实验收时必须标注为预览状态。
7. 审查器必须拒绝路径穿越、绝对路径、链接、秘密文件和越界预览；Markdown/HTML 预览不得加载脚本、表单、嵌入内容、远程资源或获得 Renderer/IPC 能力。
8. 检查点还原前必须建立新的安全恢复点并由主进程确认；中断恢复只接受精确运行记录，未知副作用不得自动重放。
9. Provider/模型配置必须复用核心注册表和凭据解析；Renderer 不得读取已保存 Key 或 Base URL，任务运行和外部写锁期间禁止重配。
10. 桌面保存新 Provider Key 时必须使用系统凭据后端；后端不可用、迁移未验证或清理失败时均失败关闭，不得静默降级为明文文件。
11. Provider 选择器只显示当前渠道、具有真实凭据的渠道或已经成功发现并持久化模型目录的渠道；未连接的免 Key 本地预设不得占位。删除任务与移除最近项目必须由主进程精确确认，运行中的任务不可删除；前者不得删除项目文件或检查点，后者不得删除磁盘目录。
12. 交互终端作为 G5B 独立验收：主进程持有 PTY，Renderer 仅获得会话化输入/输出/尺寸/关闭 API；Shell 选择受控，输入、输出、背压和内存回放有界；启动前拒绝运行中的 Agent 或已检测到的外部写者，终端运行时禁止同一桌面进程启动/恢复 Agent；工作区切换、窗口关闭和应用退出必须清理子进程；终端活动不得写入审计或冒充 Agent 验证证据。
13. 桌面历史变更只保存工作区本地、版本化、有界且二次脱敏的 `TaskChangeReport`；不得保存临时 `TaskChangeSnapshot`、原始二进制、凭证或隐藏推理，也不得把源码 Diff 混入通用任务账本或安全审计。历史任务缺少快照时必须明确提示，删除任务必须同步清理对应快照。
14. 当前任务完成页与历史任务必须使用同一份有界 `TaskChangeReport` 显示变更摘要卡和逐文件统计；从摘要卡或右侧“本任务”打开的 Diff 只能来自保存的脱敏 preview，不能重新读取或冒充当前工作区内容。
15. 每轮模型进展必须区分 Provider 公开输出与程序归纳的可核验运行事实；没有公开文本时不得推测、伪造或持久化隐藏思维链。
16. Windows x64 NSIS 必须自动验证全新安装、安装物启动、保留用户数据的覆盖升级、异常中断后重启和卸载；验收目录同时包含空格与中文，桌面安装不得覆盖或暗改全局 CLI。
17. 自动化 UI smoke 必须驱动真实 Renderer 覆盖 1366×768、900px 窄窗、键盘提交、Provider/模型、审批、长事件流、停止、未知副作用门禁、检查点还原和终端生命周期；测试 Preload 不得进入正式包。
18. Windows x64 MSIX 必须通过 `MakeAppx.exe` 解包和清单/主程序/块映射结构检查；用于正常安装或企业分发前必须由 Microsoft Store 或目标设备信任的代码签名证书签名。无发布证书时只能标为“待签名候选”，不得宣称可直接安装；`CSC_LINK`、`CSC_KEY_PASSWORD`、PFX 私钥及密码不得提交或写入日志。

### 0.20.2 标签工作台追加门禁

候选需验收自定义菜单的键盘/鼠标、轮次选择与空状态字体；按需打开/关闭标签、终端关闭与页签切换生命周期、分屏/完整视图，以及紧凑数据展开。运行 `npm --prefix apps/desktop run smoke:browser` 离线检查真实 Electron 网页视图的公开 HTTPS/POST 门禁、无 Node/preload/任务桥、显隐与关闭；UI smoke 覆盖宽窄窗口和标签操作。网页会话不得共享桌面凭据或 Agent 工具，不支持登录提交/下载；正式包不含 smoke 桥。本轮不发布，MSIX 未签名的限制不变。
