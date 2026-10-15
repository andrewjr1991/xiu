# Xiu 使用指南 · 后台命令和开发服务器

本文是[使用指南目录](../../USAGE.zh-CN.md)的一部分；上手请先看[快速上手](../../QUICKSTART.md)。

## 后台命令和开发服务器

从 `0.13.4` 起，Xiu 可以启动开发服务器、构建脚本或另一个 Xiu 长任务，并在当前终端关闭后继续运行。后台记录按工作区摘要隔离，包含稳定 ID、PID、状态、输出字节数和退出证据；实际命令只保留经过脱敏和截断的预览。

直接启动和管理：

```text
/background start npm.cmd run dev
/background
/background read <任务ID> 0
/background cancel <任务ID>
```

`read` 会返回下一游标。再次读取时带上该游标，只显示新增输出：

```text
/background read <任务ID> <下一游标>
```

也可以把完整 Xiu 任务放到后台：

```text
/background start xiu -y --budget-seconds 1800 "分析项目、完成修改并运行测试"
```

后台启动前仍需明确确认；危险命令必须输入 `BACKGROUND`。后台 Xiu 使用同一工作区和本机 Provider/凭证配置，并继续遵守任务恢复边界；任务预算应在后台命令中显式传入或通过 `XIU_BUDGET_*` 环境变量配置。`-y` 也不会批准危险操作。无法在无交互状态取得的新审批不会被绕过，相应任务会留下可恢复证据。

模型也可以通过后台工具启动开发服务器等任务、查看增量输出并停止它们。例如可以直接要求：

```text
启动开发服务器，确认首页能正常访问；检查日志后停止服务器。
```

退出 Xiu 不会取消后台任务。请用 `/background cancel <任务ID>` 显式停止；不要让 Xiu 启动来源不明的可执行程序。
