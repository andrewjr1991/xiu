# Xiu 开发阶段记录

## 阶段二：0.20.3-preview.4

- 状态：本地最终整合 823 项测试，811 通过、12 项平台专属跳过、0 失败；未推送、未接受，必须核验本候选精确 CI
- 范围：桌面共享 Plan 模式、输入法/重复提交保护、Provider 受保护备份与两端显式恢复
- 复查修正：最终任务日志失败释放活动标志，新对话/删除与模式切换互斥；只读恢复诊断不阻止停止/审批；凭据事务锁、Windows 私有 ACL、替换大小预检和不确定提交保护
- 验证边界：本地合成单元测试不等于真实系统 IME；Windows DACL/安装和 Electron UI 留待目标 CI。未知恢复锁保留数据并失败关闭，不提供强制清锁
- 本地通过：CLI/桌面类型检查、CLI 构建、桌面主进程/Renderer 编译及静态 smoke、文档、10/10 模拟评测、9/9 Python 迁移。独立复查用原始失败夹具验证了日志失败及同轮会话/模式竞态修复
- 本地 Electron 图形验收受限：无可用 DISPLAY/Xvfb，headless 初始化失败，临时显示服务未建立；不记为通过，新增 UI 场景由目标 CI 执行
- CLI 隔离包安装及 Linux Unicode/后台任务平台 smoke 通过；dry-pack 已核对新恢复和 bootstrap 模块、版本与排除 Electron/用户配置
- 待回填：精确提交、CI 与安装候选

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
