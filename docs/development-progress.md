# Xiu 开发阶段记录

## 提交推送与生产审计反馈：2026-11-04（0.20.14 未发布）

- 用户明确授权提交、推送和跟踪 CI。主功能以 `f8a31eed58115a7eeb1e7f5200da17edf2f87476` 推送到 `codex/xiu-autonomous-reliability-20261104`，运行 [CI #452](https://github.com/andrewjr1991/xiu/actions/runs/41877236760)。本地 Node 20.18.1 和 22.23.4 额外验证初始候选：均 1625 项（1613 通过、12 跳过、0 失败）。
- 相同的 `npm audit --omit=dev --audit-level=high` 在本地复现 CLI 审计两项 high：直接依赖 undici 7.30.0 与 MCP client 的 Zod 4.4.3。定向升级 undici 7.30.1，并将 Zod 去重到已在 MCP core 使用的 4.6.7；CLI 与桌面生产审计均为 0。没有提高审计阈值、改变 Node 最低版本或批量升级 SDK。桌面锁文件同步此前过期的本地 CLI 元数据，并保留版本/完整性未变条目的 libc 平台约束。
- 更新后的锁文件经 Node 20.18.1 / npm 10.8.2 干净安装验证（禁用安装脚本）；Node 20 的网络/TLS/代理/MCP 专项 109 项，106 通过、3 跳过，Lint 通过。随后三类类型检查、Lint、两端构建及 Node 24 全量 1625 项（1613 通过、12 跳过、0 失败）通过。
- Git HTTPS 推送正常；GitHub API 目的地被运行环境规则拒绝，已在保留现有域名的配置草稿中加入 api.github.com，尚未应用。公共网页可读到候选和截图的精确提交名称，但作业状态仍显示初始占位且日志要求登录；不由截图/产物存在推断全部通过。继续以精确提交追踪 CI，完整回读前不标记远端接受。

## 真实启动与 UI 验收门禁：2026-11-04（0.20.14 未发布）

- 收口补查了仅剩压缩摘要的旧日志：原先“缺少来源字段”的兼容回退会把摘要重新装进用户要求段。恢复现明确区分“原始来源为空”和旧 API 未提供来源，最新原始任务独立保留；压缩快照只读缓存，不写回输入状态。新增失败夹具复现后，76 项 Agent/会话/压缩/状态专项通过，保留原模型摘要作为普通历史，不补造原始用户目标。

- 增加 `npm --prefix apps/desktop run smoke:startup`：真实 main、真实 preload 与原 `xiu-app` 资源协议/CSP，先把测试进程的 home 选择器与 Electron profile 隔离到私有临时目录，不读取真实用户配置。主窗口 snapshot 可用，未信任工作区拒绝渠道接口，另一个携带相同 preload 的窗口仍被 IPC 发送者校验拒绝，Renderer 没有 Node/process。Linux 实际执行通过；这不是安装器或其他平台真机结果。
- UI 过程日志/退出码不能单独当作完成证据。新增父进程 runner 要求本次子进程的完整 `passed: true` JSON、两个视口与调用轨迹；空输出、仅进度、截断 JSON、失败标记、缺少视口/轨迹均拒绝。执行最多 180 秒，使用父进程创建的专属 profile，并在结束后清理该 profile，截图保留。实际完整 UI 回归通过。
- 两项入口接入原有三平台 CI 的 UI 步骤，不新增可绕过的独立绿色门禁；保留截图验收和其他既有 UI 断言。最终全量 1625 项（1613 通过、12 跳过、0 失败），三类类型检查、Lint、文档、两端构建、模拟评测 10/10、隔离包/Linux 平台 smoke，以及重建后的真实启动、完整 UI、终端加载、浏览器隔离、权限/子任务取消对话框 smoke 全部通过。远端 CI 尚未运行。

## 恢复状态校验：2026-11-04（0.20.14 未发布）

- 先复现损坏 `plan_mode.enabled: null` 将先前 true 转换为 false，以及缺少 steps 的计划进入管理器后崩溃。已知模式/计划/统计载荷现逐项验证，列表/doctor 跳过并计数，恢复以 `SESSION_STATE_INVALID` 停止；两端错误说明提供 `session/state-invalid`、备份与 doctor 指引，不自动改写日志或建议清除模式继续执行。
- 校验计划的基本字段、状态、重复 ID 和多项进行中；统计仅恢复已知数值字段，未知扩展字段不进入运行时统计。保留旧计划可缺 updatedAt、部分合法统计、分数 activeMs 与未知事件类型的兼容性。
- 摘要升至 schema 2：旧缓存即使源文件 stamp 未变，也不能掩盖新的损坏检查；列表回退重扫但不隐式写缓存。回归覆盖旧缓存、追加损坏、日志不改写，以及真实 CLI 在拒绝前零模型请求/零工作区写入。
- 全量 1623 项（1611 通过、12 跳过、0 失败），CLI/测试/桌面类型检查、Lint、文档、两端构建、模拟评测 10/10、隔离包、Linux 平台和桌面构建 smoke 通过。真实模型、其他平台与安装器仍未在本轮验证，未发布。

## 连续压缩与控制器可靠性：2026-11-04（0.20.14 未发布）

- 离线失败夹具先复现两项缺陷：二次压缩的用户要求段失去第一次压缩前的原文，模型摘要遗漏后不再存在；运行中调用 `Agent.compact()` 没有拒绝，而是替换/清掉原取消控制器。
- 输入边界独立维护最多六条、有界原始用户任务/steering，压缩只读取快照，不用模型摘要重建。原日志的任务/steering 事件可为旧会话重建缓存；生成项目上下文、模型/工具文字不进入这份缓存。清空和切换会话重置对应状态，不恢复权限或当前验证权威。单条最长 24000 字符，超长保留首尾并标记；约 16000 Token 的选取预算沿用原来的“至少保留一条”行为，超长单条可能超过该预算。
- 补查自动压缩期间新 steering 的竞态，旧快照不覆盖新输入。API 在修改控制器前拒绝重叠任务/手动压缩，手动压缩不接收 steering；任务取消仍指向真实任务。
- 五项离线专项通过，覆盖连续压缩/模型故意遗漏、活跃补充、两条恢复入口、清空、旧日志输入来源、UTF-8/去重/预算、自动压缩期间的新输入及取消；全量 1617 项（1605 通过、12 跳过、0 失败）、CLI/测试/桌面类型检查、Lint、文档、两端构建、模拟评测 10/10、隔离包和 Linux 平台 smoke 通过。

## Skills、检查账本与终端加载：2026-11-04（0.20.14 未发布）

- 补可复验的 100/500 回合历史测量：`npm --prefix apps/desktop run measure:history`，离线合成事件、可见窗口、软件渲染，每种大小一个新 Renderer，每项输入取 9 次“两帧后”观测。先排除隐藏窗口动画帧节流造成的固定两秒误差，再定位每次输入重渲染整段历史与导航轨道。用 React 默认浅比较缓存稳定时间线，并稳定只依赖 ref/状态 setter 的回调；不忽略事件或附件变化。随后将折叠运行详情改为展开才创建子节点，日志与回合本身全部保留，重复展开可读取最新记录。
- 同机单次前后对照：100 回合输入中位 73 → 32 ms；500 回合 347 → 117 ms；DOM 6951 → 5251 / 34151 → 25651，所有回合和最终回复仍可访问，折叠详情可重复展开。500 回合首次展开 958 → 836 ms 的单次差异不能当作稳定改善，首次长历史渲染成本仍待后续治理。数字含两帧等待，不能当作真实键盘延迟、跨设备 P95 或发布门槛；后续若真实设备同样受影响，再考虑分页/虚拟化。

- 后续复查动态复现：会话目录中单个 FIFO `.jsonl` 使列表超过 3 秒仍不返回。扫描改用非阻塞/no-follow 打开、打开后的普通文件校验，列表先 lstat；目录、链接和管道逐条隔离。真实管道及普通文件检查后被换成管道的竞态回归通过；本轮完整测试增至 1612 项（1600 通过、12 跳过、0 失败）。新两端构建、模拟评测 10/10 通过，隔离包安装与 Linux 平台 smoke 通过。

- 两端 Skills 工作区启停完成。覆盖同名遮蔽、私有偏好/损坏/链接、旧指纹与旧 revision、权限授权不变、非 TTY/`--yes` 不自动确认；桌面确认保留用户最初看到的内容版本，取消不发修改请求。doctor 增加偏好诊断，已有历史文本不会因禁用而消失。
- `/status` 与桌面终态显示程序检查账本计数，明确区分未记录、未运行、通过、失败和过期。摘要不包含命令/断言/路径，不采信模型 PASS；恢复与新任务不补造现时权威，任务结束记录不保证后来文件新鲜。
- 全量测试 1610 项（1598 通过、12 跳过、0 失败），CLI/测试/桌面类型检查、Lint、两端构建、文档通过。真实 Electron UI 的宽窄 Skills 与账本摘要回归通过，既有输入法/审批/恢复/终端生命周期断言保留。
- 终端库改为首次打开才请求：Renderer 入口约 750.22 → 407.00 kB，新增共享块 8.26 kB、终端块 336.70 kB。同源协议与原 CSP 下验证延迟请求、缺块局部报错/保留会话、不自动启动 shell、显式启动及关闭，完整 UI 通过。`npm --prefix apps/desktop run smoke:terminal-loading` 可复验，接入现有三平台 CI UI 门禁；不把包体减少当作真实设备耗时改善结论。
- 本阶段仅 Linux x64 受控环境，未执行真实计费模型、Windows/macOS 原生或安装器验收，未发布。

## 会话摘要、分页与范围检索：2026-11-04（0.20.14 未发布）

- 在前一批逐行读取上加入私有、可丢弃的显示摘要。任务结束自动保存，旧日志可显式 `--refresh-session-index`；普通列表不写缓存，恢复/doctor 不依赖摘要。验证日志追加、同大小改写并恢复 mtime、摘要损坏/超限/未来版本、符号链接、写入竞争、删除清理及缓存失败不改变任务结果。
- CLI 增加 `--session-limit` / `--session-offset`，未分页时保留原输出；交互恢复每页 20 条，测试覆盖前进、后退、末页、取消。重建摘要的信任门禁和真实 CLI 分页均有端到端测试。
- `find_relevant_code` 增加字面文件/目录范围，不替换全局索引，能检索全局文件上限遗漏的业务目录；超限不再静默报告无结果。保留忽略规则与真实路径边界；大文件内容扫描最多 512 KiB 并给出提示。
- 同一约 32.1 MiB 合成日志，摘要有效时新进程列表单次观察为 7 ms / 峰值 RSS 41448 KiB（前一批逐行扫描 109 ms / 69592 KiB）。不是跨平台或 P95 结论。旧日志、变更日志和不可用摘要仍需流式扫描。
- 同类读取复查：Skills 的项目、全局、兼容目录与插件发现/加载改为有界读取，保留 120,000 字符上限；64 MiB 稀疏文件在分配内容前拒绝，中文 UTF-8 额度不缩水，发现后增长的文件也拒绝。技能安装和权限专项 42 项通过。
- 累计全量回归：1596 项（1584 通过、12 跳过、0 失败），默认 umask 077。CLI/测试/桌面类型检查、Lint、两端构建、文档、评测校验、10/10 模拟评测、隔离 npm 包安装/Linux 平台 smoke、桌面构建 smoke 均通过。
- 真实 Electron/Xvfb：UI smoke 的 `passed: true` 与本轮九张必需截图已核对，覆盖宽窄窗口、30 轮事件、输入法、审批、恢复等合成流程；权限确认框 smoke 通过。浏览器 smoke 初次暴露离线夹具依赖真实 DNS，固定夹具解析结果后保留全部 URL/POST/私网/权限/隔离断言通过，生产策略未改。初次 ozone headless 在容器中崩溃，改用签名/校验和验证的 Debian Xvfb 后通过；仅 Linux 受控测试，不能替代 Windows 真机与真实 Provider 计费验收。

## 会话可靠性增量：2026-11-04（0.20.14 未发布）

- 修复 JSONL 中 `null`、数组、原始值和无事件类型对象导致历史列表整体崩溃；有效事件继续读取，CLI 与 doctor 提示损坏计数，不修改源日志或中断任务恢复规则。
- 列表改为逐行读取，只保留摘要字段所需事件，消除全文字符串、事件数组和反转副本同时驻留。仍需扫描全部日志；持久摘要索引与分页未在本次实现。
- Linux/Node 24 单次对照：相同约 32.1 MiB、32768 条工具事件日志，原实现列表 157 ms / 进程峰值 RSS 227048 KiB，修改后 109 ms / 69592 KiB，标题与最终模型一致。属于合成夹具单次观测，不代表真实设备 P95 或其他平台结果。
- uv 测试遵守用户 umask，不再把安全的 0700 误判为失败；子进程覆盖 022/077 下 owner 可执行性，未修改产品提取权限或系统 umask。
- 本轮 Linux x64 / Node 24.22.1 验证：默认 umask 077 的完整测试 1576 项（1564 通过、12 跳过、0 失败），类型检查、测试类型检查、Lint、构建、文档检查、评测元数据校验、10/10 模拟评测、隔离 npm 包安装 smoke 和真实 npm 入口/Linux 平台 smoke 均通过。未执行真实模型计费请求、Windows/macOS 或桌面真机验收；尚未发布。

## 阶段二两项回归修正：0.20.3-preview.9

- Windows 新增必需的定点回归门禁：隐私预检通过后，先执行清理竞态/快速启动/保留当前配置恢复用例；两项前置门禁均通过才启动全量测试。失败、跳过和缺失进入候选清单，不能记为通过；原全量测试和断言不减少。

- 状态：本地 880 项测试，865 通过、15 项平台专属跳过、0 失败；两端类型检查、CLI 构建、桌面编译/静态 smoke、文档、10/10 模拟评测、9/9 Python 迁移、334 文件 dry-pack、preview.9 隔离包安装和 Linux 平台 smoke 通过。精确提交六作业与产物待回填，未发布 npm
- 基线：preview.8 / c7efc8de9f156ddda761c8393d37df4f0965efe5，Windows 隐私预检通过，但完整 CLI 两项失败，整体未接受
- 范围：preview.9 仅针对这两项 Windows 失败：后台目录枚举后对象消失时仅容忍 ENOENT，保留类型检查及其他错误；恢复入口测试夹具按生产流程初始化写锁所有者，不放宽 ACL 或恢复规则。确定性旧实现回归复现了四种真实 ENOENT 消失窗口，新实现通过；其他 I/O 错误及文件资格检查仍生效。写锁所有者解释有源码依据，原失败日志未给具体阶段，仍须 Windows 重跑确认。新功能继续暂停。
- 复查：三处修正及 CI 门禁独立只读复查无阻断问题；13 项定点回归和 11 项制品门禁测试通过，不能代替真实 Windows 验证
- 门禁：保留原失败断言；验证 ENOENT 消失、非 ENOENT 错误传播与类型检查，恢复锁夹具必须匹配生产初始化；同一提交重跑隐私/完整 CLI/桌面/安装门禁
- 限制：已有视觉捕获缺口与 bootstrap 领取/无 PID 取消竞态仍未修复；不自动修复/删除旧不安全恢复目录，原生联网认证继续暂停

## 阶段二最小修正：0.20.3-preview.8

- 状态：本地 868 项测试，853 通过、15 项平台专属跳过、0 失败；两端类型检查、CLI 构建、桌面编译/静态 smoke、文档、10/10 模拟评测、9/9 Python 迁移、334 文件 dry-pack、preview.8 隔离包安装和 Linux 平台 smoke 均通过。窄范围本地独立复查无阻断问题，但不覆盖其后 Windows 全量失败。preview.8（c7efc8de9f156ddda761c8393d37df4f0965efe5）的 CI 36993723905 已结束：六作业中五个通过，Windows 隐私预检 9/9 通过；完整 Windows CLI 868 项中 859 通过、7 跳过、2 失败，构建/包/平台/评测检查通过，整体仍未接受。未发布 npm，暂停新功能，最后完整六作业通过仍为 preview.3
- 精确 CI：[36993723905](https://github.com/andrewjr1991/xiu/actions/runs/36993723905)，提交 `c7efc8de9f156ddda761c8393d37df4f0965efe5`。两项失败分别涉及后台目录枚举时 bootstrap 消失与恢复入口写锁夹具；实际修正和诊断见 preview.9
- 已核验 [Windows 未接受 EXE](https://github.com/andrewjr1991/xiu/actions/runs/36993723905/artifacts/11221116372)：123409504 字节，SHA-256 `743147e36da95e214a900ebe2c022490ad35cd1354e0ccc8ea20820dce27f41a`，已提供下载；[Windows 未接受 CLI tarball](https://github.com/andrewjr1991/xiu/actions/runs/36993723905/artifacts/11221371589)：779172 字节，SHA-256 `da63edcf3269db7a400c1e193e07d42ab5a538336e3e93d82ef564077d8a5837`。实际文件字节和摘要已核验，构建成功不代表候选通过
- 基线：preview.7 / 2464823d9c6bd181bf4fe55d4e0d1b535a3ed7b4，整体未接受，详见下一节
- 范围：preview.8 仅在 Windows PowerShell 子进程环境中按大小写不敏感方式移除继承的 PSModulePath，父进程环境不变；保留 Get-Acl 回读、.NET Owner/DACL 持久化和 owner-only 失败关闭规则。新增固定 command-not-found 类别，并修正异常包装测试夹具；不同时改写生产读取 API。
- 依据：[Microsoft 中间进程启动 Windows PowerShell 的模块路径说明](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath?view=powershell-7.6#starting-windows-powershell-from-powershell-7)。pwsh → Node → Windows PowerShell 的继承路径与文档场景相符，preview.8 精确 Windows 隐私预检已通过，但不能反推所有旧版本的唯一根因
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


## 2026-11-04：远端反馈闭环与完整会话 ID 修正

依赖修复提交 `ebc2af49a277e1d555ef26d5acc7c92286286c07` 已推送开发分支，[CI #453](https://github.com/andrewjr1991/xiu/actions/runs/41880122746) 九项检查全部通过：Windows/Linux/macOS Verify 与 Desktop、Node 22/24 兼容、Dependency audit。通过公开提交检查页逐项确认，不以产物存在推断通过。

新增复现表明，按最新时间排列的历史会让完整 ID `exact` 误选较新的 `exact-newer`，也可能绕过不可读或状态损坏的精确目标。恢复现在先匹配完整 ID，再处理唯一前缀；完整目标不可读时保留原错误码，损坏状态仍返回 `SESSION_STATE_INVALID`。两项回归覆盖会话正文及模型渠道不串线、唯一/歧义前缀、目录占位与损坏 Plan 状态。专项 52/52、全量 1627 项（1615 通过、12 跳过、0 失败）、三类类型检查、Lint、两端构建通过；该增量需独立推送并检查新 CI，不能沿用 #453 的通过结果。


## 2026-11-04：摘要缓存竞争替换回归

继续检查发现，原日志读取已有非阻塞保护，但摘要缓存在 lstat 后被换成 FIFO 时仍会阻塞 open。独立进程回归用真实 mkfifo 在检查与打开之间替换，原实现以 10 秒超时失败；新增 O_NONBLOCK 后，打开文件描述符的普通文件检查拒绝 FIFO，列表立即回退原日志，专项 12/12 通过。回归子进程有明确超时并独立清理，Windows 跳过 POSIX FIFO 专项。完整 ID 修复已单独提交推送 `dffd88e4c931de7ba7c43821aa4b8bd202d4eb79`，[CI 运行](https://github.com/andrewjr1991/xiu/actions/runs/41883127767) 已启动；本缓存修复将继续独立推送验收。

该缓存修复最终本地门禁：全量 1628 项（1616 通过、12 跳过、0 失败）、最低 Node 20.18.1 相关 36/36、三类类型检查、Lint、两端构建、文档与隔离包安装通过。


## 2026-11-04：Skills 同类阻塞回归

检查新增 I/O 路径后，确认 Skills 有界正文读取与私有偏好也会在 FIFO 替换后等待写入者。两个独立进程真实 mkfifo 回归均先以 10 秒超时失败；非阻塞打开后，正文仍要求普通文件，偏好仍要求私有单链接普通文件，损坏偏好不能被清除或写入覆盖。未改变 Skill 链接兼容、内容长度、权限声明或审批语义。修复后 Skills 专项 18/18 通过，继续完成完整门禁、提交推送与独立 CI。

Skills 修复最终本地门禁：全量 1630 项（1618 通过、12 跳过、0 失败）、Node 20.18.1 相关 54/54、三类类型检查、Lint、两端构建、文档、模拟评测 10/10、隔离包安装通过。摘要修复已推送 `d6c65a88fddbb0917e7238424da43548920d8f50`，[独立 CI](https://github.com/andrewjr1991/xiu/actions/runs/41883946413) 已建立，当前仍需回读完整结果。


## 2026-11-04：macOS 托管容量反馈修复

后续三个修复提交的 Windows/Linux/兼容/审计各 7 项均通过，但会话恢复 CI #454 的 macOS 被托管服务取消。公开注解为 “The job was not acquired by Runner of type hosted even after multiple attempts”，同时注明 macOS ARM64 capacity constraints 与内部服务错误，不能记为全绿，也不能解释为代码回归。官方 runner-images 当前说明 `macos-latest` 为 macOS 26 ARM64，`macos-26-intel` 是同 OS 的 x64 标签。

默认 Verify/Desktop 切到显式 `macos-26-intel`，保留全部检查及原有失败可见性；手动 workflow_dispatch 提供 `macos_runner` 选择 `macos-26`，保留明确的 ARM64 复验入口。不引入 large runner、不隐藏失败、不把 x64 结果写成 ARM64 验收。继续在此工作流修复的精确提交上推送并回读独立 CI。源代码与本地 1630 项测试候选相同；此增量只调整 CI 与维护文档。

CI 调整本地验证：现有 CI 制品与失败可见性契约 11/11、文档检查、`git diff --check` 通过；使用官方 actionlint 1.7.12（发布 SHA-256 已核对）验证整个工作流，无语法/表达式错误。应用源码未变，不重复运行本地全量；新精确提交仍执行完整远端矩阵。
