# Xiu 开发阶段记录

## 阶段一：0.20.3-preview.1

- 状态：本地代码与包验证已通过；等待本次精确提交的远端 CI 和 Windows 安装验收，尚未整体接受候选
- 开发基线：公开 npm 0.20.2 已核验；本候选未发布到 npm，不创建正式 Release 或 Store 发布
- 工作分支：`codex/jingran-phase-1-reliability`
- 精确提交：待完成验证并提交后填写，不预填提交号
- 远端推送 / CI 运行：待推送后回读精确提交和六作业结果
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

- 提交 / 远端 SHA：待填
- 精确 CI 运行与六作业结果：待填
- CLI / Windows 候选文件与 SHA-256：待填
- 本地检查结果：Linux x64 / Node 24.19.0，732 项中 722 通过、10 Windows 专属跳过、0 失败；Python 9/9、模拟评测 10/10、CLI/桌面类型检查、CLI 构建、桌面主进程/Renderer 编译、静态 smoke、精确 tarball 安装和 Linux Unicode/后台进程 smoke、dry-pack、文档与 diff 检查通过。图形界面、Windows 安装和实际 Provider 尚未在本地执行。
- 下一阶段：桌面只读 Plan、中文输入法/重复提交，以及首次配置/迁移恢复；在第一阶段候选验收后继续，不把未验收事项写成已完成。
