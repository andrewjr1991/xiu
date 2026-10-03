# Xiu 快速上手 / Quickstart

## 1. 安装 / Install

需要 Node.js 20.18.1 或更高版本。

```bash
npm install -g @xiu-ai/cli
xiu --version
```

如果安装后仍运行旧版本，可执行只读诊断：

```bash
xiu --update-doctor
```

## 2. 配置 Provider / Configure a Provider

未发布 0.20.2 候选首次配置：安装后没有渠道。启动 CLI 后输入 `/provider add`，选择类型并填写 ID、模型、地址和可选 Key/环境变量；桌面打开“设置与模型 → 新增渠道”，选择类型后会填入可修改的模板建议。普通版不内置注册渠道，本地模型也需手动添加；未添加时仍可打开配置，但不能执行 Agent 任务。旧设置会兼容迁移，升级不清空用户数据。

以下环境变量与斜杠命令适用于已发布的 CLI 0.20.1。桌面通过“设置与模型 → 新增渠道”配置；当前预设 ID 即使被隐藏也不能重复添加，这是已知问题，不是必须使用环境变量的产品要求。普通版默认零渠道、由用户自行添加的统一首次配置尚待实现，详见[路线图](./ROADMAP.zh-CN.md#4-后续工程化)。

最快的方式是设置一个环境变量：

```powershell
$env:OPENAI_API_KEY = "..."
xiu
```

```bash
export OPENAI_API_KEY="..."
xiu
```

也可以启动 `xiu` 后使用 `/providers`、`/provider add`、`/provider key` 和 `/models`。本地 Ollama、LM Studio、vLLM 以及自定义 OpenAI 兼容端点不要求使用 OpenAI 官方 Key。

## 3. 完成第一个任务 / Finish a First Task

在 Git 仓库中运行：

```bash
xiu "解释这个项目的入口和测试方式，不要修改文件"
xiu "修复当前失败的测试，运行相关验证，并总结改动"
```

首次进入工作区时，Xiu 会要求确认工作区信任。拒绝信任后不会读取项目指令、加载项目扩展、修改文件或执行命令。

## 4. 交互式会话 / Interactive Sessions

```bash
xiu
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看完整命令入口 |
| `/status` | 当前 Provider、模型、任务和项目状态 |
| `/providers` | 测试和切换 Provider |
| `/models` | 查看或切换模型 |
| `/plan` | 进入只读规划模式 |
| `/diff` | 查看工作区差异 |
| `/checkpoint` | 查看文件检查点 |
| `/diagnostics` | 查看调用、预算、失败和停滞证据 |
| `/report` | 预览脱敏执行报告 |
| `/recover` | 处理异常中断任务 |
| `/background list` | 查看跨终端后台任务 |
| `/plugins` | 查看插件发现和激活状态 |
| `/mcp` | 查看 MCP 服务 |
| `/web status` | 只读查看联网检索配置 |
| `/credentials` | 查看凭证后端的非敏感状态 |
| `/language` | 切换简体中文或英文 |
| `/clear` | 清空当前对话上下文 |
| `/exit` | 退出 |

任务运行期间，可在 `补充> ` / `steer> ` 输入框追加要求；`Ctrl+O` 切换最近活动详情，`Ctrl+C` 取消当前调用。

## 5. 安全提示 / Safety Notes

- Xiu 不是容器沙箱；命令使用当前操作系统账户权限运行。
- Plan 模式只读，但普通任务可以在审批后修改受信任工作区。
- 危险操作、发布、删除、凭证清理和回退需要明确确认。
- 结果未知的副作用不会在恢复或重试时静默重放。
- 项目代码默认不上传到 Xiu 自己的服务，但模型 Provider 会收到完成请求所需的上下文；请按组织政策选择 Provider。

完整中文说明见 [USAGE.zh-CN.md](./USAGE.zh-CN.md)。
