# Xiu 使用指南 · 权限、Plan 模式与安全建议

本文是[使用指南目录](../../USAGE.zh-CN.md)的一部分；上手请先看[快速上手](../../QUICKSTART.md)。

## 权限与审批

Xiu 将工具分成四类：

| 风险 | 示例 | 默认行为 |
| --- | --- | --- |
| read | 读取文件、搜索、Git 状态 | 自动执行 |
| write | 写文件、替换代码 | 请求确认 |
| execute | 运行命令、调用外部服务 | 请求确认 |
| dangerous | 删除、硬重置等高风险操作 | 始终请求确认 |

看到审批提示时：

- 输入 `y` 或 `yes` 并按 Enter：允许本次操作。
- 直接按 Enter：拒绝。
- 不理解命令的作用：先拒绝，再要求 Xiu 解释。

自动批准普通写入和执行：

```powershell
xiu --yes
```

`--yes` 不会自动批准 dangerous 操作。刚开始使用时不建议开启自动批准。

普通文件写入、精确编辑、某个直接执行程序以及项目验证支持“本次会话始终允许”的窄范围授权；它只在当前 Xiu 进程有效，重启后失效。危险操作不会使用会话授权，唯一例外是 CLI 中可能计费的媒体生成：`generate_image`、`generate_video`、`generate_audio` 各自构成一类（`billable-media:image|video|audio`），选择“本次会话始终允许”后同类请求在当前进程内不再询问，`force_new_generation` 仍每次单独确认（见媒体指南）；桌面端对危险级操作只提供“仅本次允许”。`/diagnostics` 中的“实际提示”才表示用户真正看到过审批菜单；自动放行、会话规则放行和内部策略检查分别统计。

## Plan 模式和任务计划

开启只读 Plan 模式：

```text
/plan on
```

此时 Xiu 可以阅读和分析，但 Agent 边界会阻止写入、执行和危险工具。适合：

- 第一次接触大型项目。
- 修改前先评估影响。
- 只需要设计方案。
- 审查第三方项目。

查看当前计划：

```text
/plan
```

或：

```text
/tasks
```

关闭 Plan 模式后再执行修改：

```text
/plan off
```

### 10.1 多 Agent 并行任务

遇到可以独立推进的调查、实现、审查或测试工作时，Xiu 的主 Agent 会按需要建立任务依赖图。不要为了一个简单问题强行使用多个 Agent；并行最适合三个以上互不依赖的代码区域、需要独立审查，或调查和实现可以明确分工的任务。

四种角色的默认行为：

| 角色 | 默认隔离 | 用途 |
| --- | --- | --- |
| Explorer | 共享工作区，只读 | 定位文件、理解架构、收集证据 |
| Reviewer | 目标实现 Worktree，只读 | 检查正确性、安全、回归和测试缺口；最终输出 `VERDICT: PASS/FAIL` |
| Tester | 目标实现 Worktree，只读 | 运行或分析验证并报告证据；最终输出 `VERDICT: PASS/FAIL` |
| Implementer | 独立 Git Worktree | 修改代码并运行相关验证 |

查看全部多 Agent 运行：

```text
/agents
```

查看一个运行的角色、状态、耗时、Token、错误和结果：

```text
/agents <运行ID>
```

只取消一个任务，不影响其他 Agent：

```text
/agents cancel <运行ID> <任务ID>
```

重试失败、取消、阻塞或终端关闭时中断的任务：

```text
/agents retry <运行ID> <任务ID>
```

Implementer 的改动不会自动进入主工作区。审查 Diff 并确认集成：

```text
/agents integrate <运行ID> <任务ID>
```

集成前 Xiu 会确认目标 Implementer 已完成，并寻找依赖于该实现的 Reviewer 与 Tester。两者必须在目标 Worktree 上以只读方式检查，并把 `VERDICT: PASS` 作为最终一行；缺失、失败或模糊证据都会阻止合并。

随后 Xiu 会显示有界补丁预览、主工作区未提交文件、审查/测试证据和阻断项，并检查双方是否同时修改同一文件、符号或依赖清单，再运行 Git 补丁预检。只有全部通过后才询问是否合并；实际应用前会再次分析。冲突时主工作区不会发生部分修改，完整补丁、运行记录和 `.xiu/worktrees/` 中的 Worktree 都会保留用于人工处理。Xiu 不自动删除 Worktree 或分支。集成成功后仍要在主工作区运行测试并人工审查。

默认最多同时运行 3 个 Agent，可在启动时设置 1 到 8：

```powershell
xiu --agent-concurrency 4
```

也可使用环境变量 `XIU_AGENT_CONCURRENCY`。所有子 Agent 继承主 Agent 的审批策略；只读 Agent 无法看到写入、执行、dangerous 或动态风险工具，`--yes` 仍不会自动批准 dangerous 操作。

## 安全建议

- 只在可信工作区运行 Xiu。
- 不理解的审批请求先拒绝。
- 重要项目先提交 Git，再让 Agent 大范围修改。
- 高风险任务先使用 `/plan on`。
- 不要在项目文件中保存 API Key。
- Skills 和 MCP Server 只安装可信来源。
- 使用 `--yes` 前先熟悉普通审批流程。
- 生成图片、视频和调用外部模型前关注费用。
- 用 `/diff` 检查修改，用测试和构建验证结果。
- Xiu 报告“完成”后仍应进行人工代码审查。
