# Xiu 开发阶段记录

## 阶段二最小修正：0.20.3-preview.8

- 状态：本地 868 项测试，853 通过、15 项平台专属跳过、0 失败；两端类型检查、CLI 构建、桌面编译/静态 smoke、文档、10/10 模拟评测、9/9 Python 迁移、334 文件 dry-pack、preview.8 隔离包安装和 Linux 平台 smoke 均通过。窄范围独立复查无阻断问题；Windows 实际预检、精确提交/CI、CLI tarball 和 Windows 未签名 EXE 待回填。未发布 npm，暂停新功能，不能继承 preview.7 的五个通过作业
- 基线：preview.7 / 2464823d9c6bd181bf4fe55d4e0d1b535a3ed7b4，整体未接受，详见下一节
- 范围：preview.8 仅在 Windows PowerShell 子进程环境中按大小写不敏感方式移除继承的 PSModulePath，父进程环境不变；保留 Get-Acl 回读、.NET Owner/DACL 持久化和 owner-only 失败关闭规则。新增固定 command-not-found 类别，并修正异常包装测试夹具；不同时改写生产读取 API。
- 依据：[Microsoft 中间进程启动 Windows PowerShell 的模块路径说明](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath?view=powershell-7.6#starting-windows-powershell-from-powershell-7)。pwsh → Node → Windows PowerShell 的继承路径与文档场景相符，但实际失败仍须由精确 Windows 运行证明，不能反推所有旧版本的唯一根因
- 异常测试：旧包装夹具外层 ArgumentException 的 HRESULT 已对应 invalid-parameter，不能要求优先返回其内层类别；改用独立 .NET 夹具验证真正包装链，并保留外层类别优先规则
- 验收要求：子环境混合大小写键清理及父环境不变回归；Windows 实际 Get-Acl、秘密写入前保护、已有对象逐次校验、失败关闭、完整 CLI 与全部桌面/安装门禁。生产 Get-Acl API 和 ACL 判定不变
- 视觉证据：preview.7 的三平台 18 张合成 PNG 已检查：Linux 中文缺字属于运行环境字体缺口，macOS 宽窗恢复图截取了错误状态，三平台菜单图均未显示展开菜单；来源详情中的 canary 是有意的活动预览，不是隐私泄漏证据。截图存在不等于视觉验收全部通过，截图修正排在 Windows 隐私门禁之后。
- 已知限制：bootstrap 启动领取与无 PID 取消竞态未修复；不自动修复/删除旧不安全恢复目录。原生联网认证继续暂停，真实 OS IME、付费 Provider 和外部设备验收仍独立

## 阶段二后续修正：0.20.3-preview.7

- 状态：已推送 2464823d9c6bd181bf4fe55d4e0d1b535a3ed7b4，整体未接受。preview.7（2464823d9c6bd181bf4fe55d4e0d1b535a3ed7b4）的 CI 36983872073 已结束：三平台桌面与 Linux/macOS CLI 通过；Windows 隐私预检失败，全量 Windows CLI 跳过，包/平台/评测检查通过，整体未接受。目录 .NET 写入已通过，随后 Get-Acl 在 verify-read 阶段返回 unknown；比较探针首次 Get-Acl 也失败，不能把这一结果当作权限规则失效或旧根因已完全证明。 本地最终 867 项测试，852 通过、15 项平台专属跳过、0 失败；未发布 npm，最后完整六作业通过仍为 preview.3
- 基线：preview.6 / 17480422e1c58eaf18caedd34c193e2fc192c408，整体未接受；Windows 隐私预检 initialize-write（Set-Acl）失败，不据此推定原始系统错误或根因
- Provider：新对象改用 .NET 直接持久化已修改的 Owner/DACL，保留 Group/SACL，保留写入前 owner-only 回读及已有对象逐次验证；固定异常类别与经过校验的绝对 SystemRoot PowerShell 路径，不暴露原始异常/路径/账户，不放宽保护或失败重试
- 后台：仅本地元数据替换进行有界重试，固定阶段/代码的独立失败凭据、异步输出/状态回调保护；进程/管道关闭和终止确认后才报告终态。Windows 清理使用 OS-helper 路径；前台停止无法确认时保留活动/未知状态并返回明确错误，不重放命令或输出
- 合成 UI 证据：Windows/macOS/Linux 桌面成功运行后均须验证并上传精确白名单中的六张 PNG，包含 1366×768 与 900×768 的恢复预览。制品名包含桌面版本、平台、完整提交 SHA 与 run attempt，保留 30 天；缺少图片或上传失败不能记为门禁通过。白名单不包含临时用户资料或配置，既有失败上传路径不变；不修改生产 UI。preview.7 的三平台 18 张合成 PNG 已检查：Linux 中文缺字属于运行环境字体缺口，macOS 宽窗恢复图截取了错误状态，三平台菜单图均未显示展开菜单；来源详情中的 canary 是有意的活动预览，不是隐私泄漏证据。截图存在不等于视觉验收全部通过，截图修正排在 Windows 隐私门禁之后。
- 本地通过：两端 typecheck、最终全量测试、CLI 构建/桌面编译及静态 smoke、文档、10/10 模拟评测、9/9 Python 迁移、334 文件 dry-pack、隔离包安装/Linux 平台 smoke。默认 npm 缓存路径不可写导致初次 dry-pack 失败，使用可写隔离缓存重跑通过；依赖下载使用获准的官方 Registry 访问。精确提交六作业已经结束；上述 Windows 隐私预检失败及完整 CLI 跳过不由本地通过结果覆盖
- 独立复查发现并修正失败收尾的 SIGTERM 处理器安装顺序、重定向后代进程提前解除强杀计时、并发取消误报及最后半行输出丢失；复查子集 12/12，Node 20 后台 34 项及最后半行新增项分别通过。本地结果不能替代 Windows
- 已知既有缺口：bootstrap 启动领取与尚无 PID 时的取消没有跨进程串行协议，仍有旧快照覆盖取消的窄竞态；本轮未修改 bootstrap，下一步以共享领取/取消协议处理，不能以一次额外读取宣称消除竞态
- 精确 CI：[36983872073](https://github.com/andrewjr1991/xiu/actions/runs/36983872073)。[Windows 未接受 EXE](https://github.com/andrewjr1991/xiu/actions/runs/36983872073/artifacts/11216548709)：123409154 字节，SHA-256 `62e581da1df5e467224601d67f4b4ea5133ed75b1bf06e1dc37aa5b5f9bd6ea8`；[Windows 未接受 CLI tarball](https://github.com/andrewjr1991/xiu/actions/runs/36983872073/artifacts/11216985500)：776234 字节，SHA-256 `49bf1961dd32cd50ffa08702af21df7b7f8afbfc95f795ddab2e0c5d64446562`。链接、manifest 和实际文件摘要已核验并提供下载；构建成功不代表候选通过
- 不包含暂停中的原生联网认证，不宣称真实 OS IME、付费 Provider 或用户设备已验收。旧不安全恢复目录不会被静默修复，不应直接删除可能含原始备份的目录

## 阶段二后续修正：0.20.3-preview.6

- 状态：已推送 17480422e1c58eaf18caedd34c193e2fc192c408，整体未接受。本地 838 项测试，825 通过、13 项平台专属跳过、0 失败；精确 CI 三平台桌面与 Linux/macOS CLI 通过，Windows CLI 必需隐私预检 nonzero-exit，阶段 initialize-write（Set-Acl），全量测试跳过、其他检查通过
- 范围：Windows ACL 固定诊断与类型化/无进度输出脚本、必需隐私预检、CLI 测试退出有界化、macOS 测试壳精确视口
- Windows 旧失败根因仍须由新预检及固定阶段信息确认，不把推测或 Linux 跳过记为修复通过；不放宽权限、不缓存 ACL 验证、不绕过断言
- 不含暂停中的原生联网认证改动。CLI/桌面类型检查、CLI 构建、桌面编译与静态 smoke、文档、10/10 模拟评测、9/9 Python 迁移、334 文件 dry-pack、隔离包安装/Linux 平台 smoke 均通过
- 新增 Windows 隐私预检为必需独立门禁，失败时全量测试不启动且清单记录失败/跳过；不把 Linux 平台跳过当作 Windows 通过
- 既有恢复限制：首次 ACL 初始化失败可能留下不受保护的空恢复目录；后续客户端不静默修改已有目录权限。本候选不宣称自动修复所有旧安装，不能直接删除可能包含原始备份的目录
- 本地独立复查未发现新增阻断问题，但不覆盖其后 Windows CI 隐私预检失败；macOS 桌面本轮通过，不代表真实系统输入法通过
- 精确 CI：[36956274234](https://github.com/andrewjr1991/xiu/actions/runs/36956274234)；[Windows 未接受 EXE 候选](https://github.com/andrewjr1991/xiu/actions/runs/36956274234/artifacts/11206108131)，实际文件 SHA-256 `1e0417483c4a5ba098525d5ba9539809db81bb97bb0ac956aa9cba722967e553`
- [Windows 未接受 CLI tarball](https://github.com/andrewjr1991/xiu/actions/runs/36956274234/artifacts/11205443958)，实际文件 SHA-256 `8dc55aedfc16e9c3597bfd5ba58ed8e6b36dd173e211226a5143f8ae219f9860`；链接与实际摘要已核验。构建产物存在不等于 Windows CLI 门禁通过

## 阶段二后续修正：0.20.3-preview.5

- 状态：已推送 df22006f9da6cf7c5c6d2868e5e89e936871f3ff；整体未接受。Windows/Linux 桌面及 Linux/macOS CLI 通过，macOS 桌面在可见屏幕限制导致的视口检查失败，Windows CLI 在 35 分钟后取消，日志包含九项 ACL 失败及仓库外 cwd 后台用例在输出后成为 interrupted。本地 826 项，814 通过、12 跳过、0 失败
- 范围：仅修复键盘 UI 验收的真实窗口/WebContents 焦点前提；保留生产 IME guard、所有清理/Shift+Enter 断言与原时限
- 新增焦点就绪回归与分项诊断；修正严格合成诊断通配的隐藏路径上传
- CLI/桌面类型检查、构建/静态 smoke、文档、10/10 模拟评测、9/9 Python 迁移、334 文件 dry-pack、隔离包安装及 Linux 平台 smoke 通过。初次包安装受环境网络限制，离线缓存不足；获准访问后的独立包/平台重跑通过，未冒充初次成功
- preview.4 和 preview.5 的 Windows CLI 均已取消；各次失败独立保留，不由后续候选覆盖。preview.5 Windows CLI 制品 11205643983 仅有报告，没有可安装 tarball；取消不能记为全量通过
- 精确 CI：[36954185355](https://github.com/andrewjr1991/xiu/actions/runs/36954185355)；[Windows EXE 候选](https://github.com/andrewjr1991/xiu/actions/runs/36954185355/artifacts/11205435972)，实际文件 SHA-256 f549e54bca0b79117dd110688e78f1b1fb3aa38fe08557a2e29879bd376ed40e 已核对。已提供下载并明确整体仍未接受

## 阶段二：0.20.3-preview.4

- 状态：整体未接受。已推送 8f00c913e3cbd25acc13b2c6819d97febc1ba38f；三平台桌面 UI 均在新增 IME 清理断言失败。Linux/macOS CLI 通过；Windows CLI 在 35 分钟后取消，日志此前已出现九项 desktop-provider 权限检查失败，本地 823 项中 811 通过、12 项平台跳过、0 失败
- 范围：桌面共享 Plan 模式、输入法/重复提交保护、Provider 受保护备份与两端显式恢复
- 复查修正：最终任务日志失败释放活动标志，新对话/删除与模式切换互斥；只读恢复诊断不阻止停止/审批；凭据事务锁、Windows 私有 ACL、替换大小预检和不确定提交保护
- 验证边界：本地合成单元测试不等于真实系统 IME；Windows DACL/安装和 Electron UI 留待目标 CI。未知恢复锁保留数据并失败关闭，不提供强制清锁
- 本地通过：CLI/桌面类型检查、CLI 构建、桌面主进程/Renderer 编译及静态 smoke、文档、10/10 模拟评测、9/9 Python 迁移。独立复查用原始失败夹具验证了日志失败及同轮会话/模式竞态修复
- 本地 Electron 图形验收受限：无可用 DISPLAY/Xvfb，headless 初始化失败，临时显示服务未建立；不记为通过，新增 UI 场景由目标 CI 执行
- CLI 隔离包安装及 Linux Unicode/后台任务平台 smoke 通过；dry-pack 已核对新恢复和 bootstrap 模块、版本与排除 Electron/用户配置
- 精确 CI：[36951952316](https://github.com/andrewjr1991/xiu/actions/runs/36951952316)；[Windows 未接受 EXE 候选](https://github.com/andrewjr1991/xiu/actions/runs/36951952316/artifacts/11204786027)，安装/升级/重启/卸载通过但不覆盖 UI 失败
- 已核对实际 EXE 字节与摘要 03991de7695616be9bdac37033598bea105489615cb730303f8881eb50ed2d0a；已向用户提供链接并建议优先使用完整门禁通过的 preview.3
- Windows CLI 制品 11205896056 仅有进度/摘要报告，没有安装包；取消不能记为全量通过。最后输出停在第 386 项，另有测试子进程清理无界等待风险，正在独立修复

## 阶段一后续修正：0.20.3-preview.3

- 状态：自动化门禁通过；精确提交 8b7853ccfde1aac87be2d3dfc28a70b68a4d7850 的六个 CI 作业全部通过。Windows 742 项，741 通过、1 跳过、0 失败，包含此前失败的立即退出启动器用例；未发布 npm
- 范围：后台 worker 启动失败诊断/异步错误与输出收尾回归，保留立即退出启动器的原有断言及期限；运行时 Undici 依赖补丁升级
- 原 Windows 存活失败根因尚未由诊断证据确定，必须以精确新提交的远端 CI 复测，不把 Linux 通过当作 Windows 修复证明
- 已验证：CLI/桌面类型检查、CLI 构建、桌面主进程/Renderer 编译及静态 smoke、文档检查、10/10 模拟评测、9/9 Python 迁移测试；运行时依赖审计零已知漏洞，独立后台用例在 Node 20.18.1 和 24.19 通过
- 红/绿回归：源码 worker 从仓库外目录启动的 loader 解析、退出后的尾部输出，在旧 HEAD 失败、新实现通过。它们不等同已确定 Windows CI 原失败根因
- Python 首次通配 discovery 未发现测试，已改为直接执行测试文件并取得 9/9；未将零测试命令记为通过
- 包检查：328 文件 dry-pack，包含 bootstrap 模块，不包含 Electron/用户配置；CLI 隔离安装和 Linux Unicode/后台 worker 平台 smoke 通过，桌面独立 worker 通过。首次包命令默认 npm 缓存不可用，切换可写隔离缓存后通过
- 精确 CI：[36949835519](https://github.com/andrewjr1991/xiu/actions/runs/36949835519)；[Windows 未签名 EXE 包](https://github.com/andrewjr1991/xiu/actions/runs/36949835519/artifacts/11204055041)、[Windows CLI 包](https://github.com/andrewjr1991/xiu/actions/runs/36949835519/artifacts/11203343598)
- 已下载并核对 manifest、实际文件字节和 SHA-256；EXE 为 8ccb6a903b0fbb4d8dca6e0bd9a1754d171fbfe0f2a963eb94563756dd62bd25，CLI tarball 为 82598dbcdeb40867f10e9149e725d85f092124ffc3e9d462f810a0ce33a03eff。三平台自动化通过不代表真实模型质量、外部设备或成熟产品完全验收

## 阶段一后续修正：0.20.3-preview.2

- 状态：整体未接受，未发布 npm。本地 736 项测试中 726 通过、10 项 Windows 专属跳过、0 失败；远端三个桌面作业及 Linux/macOS CLI 通过，Windows CLI 的启动器退出后后台任务存活用例失败。Windows 安装器构建及安装/升级/中断重启/卸载通过，不覆盖该失败门禁
- 精确提交：[4b34b2f222441c2c76bed88a64d96edface46545](https://github.com/andrewjr1991/xiu/commit/4b34b2f222441c2c76bed88a64d96edface46545)；CI：[36939303801](https://github.com/andrewjr1991/xiu/actions/runs/36939303801)
- 可复测候选：[Windows x64 未签名 EXE](https://github.com/andrewjr1991/xiu/actions/runs/36939303801/artifacts/11199501651)、[Windows CLI tarball](https://github.com/andrewjr1991/xiu/actions/runs/36939303801/artifacts/11199243453)；解压后按内附 manifest 和 SHA256SUMS 核验。Artifacts 有保留期限，不能保证永久下载
- 修复范围：UI smoke 在窗口尺寸变化后等待两次渲染帧，并复核最终宽高；避免在排队的 resize/scroll 事件发送前打开下拉菜单。保留断言、原超时和单次点击，不用重试掩盖失败
- 新增四项确定性辅助测试；失败时记录有界布局/焦点/菜单诊断与截图
- 上一提交：9334a0ff10cc58687bb7f55b5b62a43dc906fc47；其 CI 及候选文件见下文。新精确提交与摘要以本次 Actions manifest 为准
- 本轮不改变生产 UI、权限或依赖，不把测试夹具修正称为已证明的用户界面故障修复；必须由 Windows/Linux/macOS 的 Electron 实际运行验证
- 新安装包与 CLI 包将在本次推送的 Actions Artifacts 中保留，结果如实区分失败、跳过与通过

## 阶段一：0.20.3-preview.1

- 状态：整体未接受。三平台 CLI 与 macOS 桌面通过，Windows/Linux UI smoke 失败；Windows 安装器构建与安装验收通过，保留未接受候选供复测
- 开发基线：公开 npm 0.20.2 已核验；本候选未发布到 npm，不创建正式 Release 或 Store 发布
- 工作分支：`codex/jingran-phase-1-reliability`
- 精确提交：[9334a0ff10cc58687bb7f55b5b62a43dc906fc47](https://github.com/andrewjr1991/xiu/commit/9334a0ff10cc58687bb7f55b5b62a43dc906fc47)
- 远端推送 / CI：[36934949911](https://github.com/andrewjr1991/xiu/actions/runs/36934949911)，三平台 CLI 和 macOS 桌面通过；Windows/Linux 桌面 UI smoke 失败，整体未接受
- 开发方式：云端工作区；不连接用户电脑，Windows 安装验收使用 CI 或用户自行测试

### 目标

修复误报完成、外部编辑后索引过期和自然语言验证证据不足；为每次推送留下可核对提交与摘要的 CLI 包及 Windows x64 安装候选。

### 非目标

不发布 npm，不签名/提交 Microsoft Store，不改动依赖解析，不发起真实计费 Provider 请求，不宣称 CLI/桌面完全等价或真实平台验收已完成。命令型 Tester 留待下一阶段。

### 验收矩阵

| 范围 | 接受标准 | 当前状态 |
| --- | --- | --- |
| 完成计划 | 未完成可执行计划返回 failed / plan_incomplete；只读 Plan 可完成规划交付 | 本地相关回归通过；远端待验收 |
| 索引 | 任务边界刷新，5 秒有界复查外部新增/修改/删除，ctime 与 AST 复用回归 | 本地相关回归通过；远端待验收 |
| 多 Agent | 拒绝纯文本 PASS、缺失/过期/覆盖不足证据；当前只读 verify_output 断言明确不等同测试套件 | 本地相关回归通过；远端待验收 |
| CLI | typecheck、完整测试、build、离线评测、dry-pack、隔离包与平台 smoke | 本地通过；732 项测试中 722 通过、10 项 Windows 专属跳过、0 失败；模拟评测 10/10 |
| Python | 迁移 unittest 与三平台 CI | 本地 9/9 通过；远端待验收 |
| 桌面 | typecheck、build、smoke、宽窄 UI 与浏览器隔离 smoke | 本地类型检查、主进程/Renderer 编译和静态 smoke 通过；未重新生成图标；图形 UI/browser 留待 CI |
| Windows x64 | 未签名 NSIS 构建、安装/启动/升级/中断重启/卸载 smoke | 待 Windows CI；用户本机未验收 |
| 产物可追溯 | 版本、完整提交 SHA、SHA256SUMS、manifest.json、progress.md 与逐项状态一致 | 待推送产物回读 |
| 文档/边界 | 唯一版本设计、版本一致、既有信任/审批/恢复回归 | 文档与 diff 检查通过；相关自动化回归通过，不等于完整安全审计 |

### 每次推送的候选获取与核验

在精确提交的 Actions CI 运行中下载 Artifacts，解压后先核对 `manifest.json` 的版本、提交、平台和检查结果，再用 `SHA256SUMS` 验证文件。作业包名为 `xiu-cli-<version>-<platform>-<full SHA>-attempt<run attempt>` 或对应的 `xiu-desktop-...`，保留 30 天。

- CLI：`xiu-ai-cli-<version>-<full SHA>.tgz`，核验后可用 `npm install -g ./<tarball>` 安装
- Windows x64：`Xiu-<version>-x64-<full SHA>-unsigned.exe`，这是未签名 NSIS 安装候选，可能显示“未知发布者”或信誉提示
- 每个作业包含 `manifest.json`、`SHA256SUMS`、`progress.md`；Linux/macOS 桌面包只提供报告
- 构建成功但门禁失败的二进制标为 `unaccepted-candidate`；没有生成二进制时只报告状态，不伪造可下载安装器
- 单作业通过不等于候选整体通过，必须回读同一提交全部六个 CI 作业；工作区有未提交修改的本地产物不得标为已通过作业门禁

### 仍待真实环境验证

未调用真实计费 Provider；真实模型质量、费用和外部 OAuth/凭据迁移仍需独立授权与证据。用户 Windows 设备、ARM64、企业策略设备和 macOS/Linux 完整用户桌面矩阵未在本阶段验收。MSIX 未签名，不能当作普通可部署安装物。CI 模拟与自动化不替代这些结果。

### 完成后回填

- 提交 / 远端 SHA：9334a0ff10cc58687bb7f55b5b62a43dc906fc47
- 精确 CI：36934949911，4 作业通过、2 桌面 UI 失败，整体未接受
- CLI / Windows 候选：本次 CI 的 Artifacts 已保留；每份 ZIP 内含文件 SHA256SUMS 与精确提交 manifest。Windows 安装验收通过但整体仍未接受
- 本地检查结果：Linux x64 / Node 24.19.0，732 项中 722 通过、10 Windows 专属跳过、0 失败；Python 9/9、模拟评测 10/10、CLI/桌面类型检查、CLI 构建、桌面主进程/Renderer 编译、静态 smoke、精确 tarball 安装和 Linux Unicode/后台进程 smoke、dry-pack、文档与 diff 检查通过。图形界面、Windows 安装和实际 Provider 尚未在本地执行。
- 下一阶段：桌面只读 Plan、中文输入法/重复提交，以及首次配置/迁移恢复；在第一阶段候选验收后继续，不把未验收事项写成已完成。
