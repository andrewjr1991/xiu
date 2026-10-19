# Xiu user guide (English, condensed)

This is the short English guide. The complete reference is in Chinese: the [guide index](../../../USAGE.zh-CN.md) links one page per topic, and `xiu --help` always lists the flags of the installed version. The [README](../../../README.md) explains what Xiu is and where its boundaries are; the [quickstart](../../../QUICKSTART.md) gets a first task done in a few minutes.

## Install and check

Xiu needs Node.js 20.18.1 or newer (Node 20 is end of life; Xiu 0.22 will require Node 22.12).

```bash
npm install -g @xiu-ai/cli
xiu --version
xiu doctor
```

In Windows PowerShell, use `npm.cmd` when `npm.ps1` is blocked by the execution policy or ConstrainedLanguage mode. `xiu doctor` prints one read-only report covering the installation, providers, web search, proxy and certificate settings, the PowerShell language mode and the workspace's own records (how many run records and session logs are readable, which are not and why, and whether an interrupted task is waiting for `xiu recover`); keys and proxy passwords are redacted, so you can paste it into an issue. `xiu doctor json` prints the same report as one JSON document (`status`, and every section's items with their `level`) for scripts and CI; both forms exit 1 when the report has a failure. `xiu --check-update` asks the official npm registry for a newer version and never installs anything.

## Providers and keys

Xiu ships with no provider. Starting `xiu` in a terminal with none configured opens a three-step wizard: choose a provider (OpenAI, Anthropic, Agnes, local Ollama / LM Studio / vLLM, presets for DeepSeek, Qwen, Zhipu GLM, Kimi, Volcengine Ark, SiliconFlow and MiniMax, or a custom OpenAI-compatible endpoint), enter the key or the local server URL, and let Xiu test the connection and list the models. The profile is saved only after the test passes; Esc leaves nothing behind. An environment variable such as `OPENAI_API_KEY` that is already set is offered as the first choice, and choosing it stores only the variable name.

| Command | Purpose |
| --- | --- |
| `/providers` | Switch between configured providers (connection and capability probe first) |
| `/provider add` | Add a provider with the full form (ID, name, URL, model, key or variable, context window) |
| `/provider key` | Save a key locally for the current provider; input is hidden |
| `/provider edit`, `/provider remove` | Change or delete a custom provider |
| `/provider test`, `/provider capabilities` | Re-test the connection; re-probe tool and vision support |
| `/provider fallback [add\|remove\|clear]` | Failover chain used when the current provider fails |
| `/routing [on\|off\|set\|clear]` | Different providers for planning, implementation and verification |
| `/models` | Discover and pick the model for the current provider |
| `/credentials ...` | Inspect credential sources; on Windows, optionally migrate keys into Credential Manager |

Keys come from an environment variable, the local file `~/.xiu/providers.json`, or Windows Credential Manager. Xiu never writes keys into logs, sessions or reports. Local servers need no key.

## Working in a session

The first time Xiu enters a directory it asks whether to trust the workspace. Until you trust it, no project instructions (`AGENTS.md` / `XIU.md`), Skills or MCP servers are loaded and nothing is written or executed. The trust list lives in `~/.xiu/trusted-workspaces.json`.

Type a task in plain language, or pass it on the command line (`xiu "fix the failing tests"`). While a task runs you can type follow-up instructions; `/cancel` stops it. Attach images with `@path`, or paste them from the clipboard on Windows.

`xiu --help` lists the options, the commands that run without an interactive session (`xiu doctor`, `xiu report`, `xiu recover`, `xiu audit`) and the one-shot exit codes. For scripts and CI, `xiu --json --yes "task"` writes only JSON Lines to stdout (a `session.started` line, every redacted runtime event, and a final `result` line) and moves human-readable progress to stderr. The `result` exit code matches the process: 0 completed, 2 changed but unverified, 3 the model asked a question, 1 failed or not started; a plain one-shot `xiu "task"` exits with the same codes. `--json` never reads decisions from a pipe: an untrusted workspace returns `not_started` until you trust it interactively once, and dangerous actions stay denied. After a task, `xiu report [markdown|json|html] [summary|details] [path]` exports the latest task's execution report without entering the interactive mode (`xiu report runs` lists recent runs and `run:<number|id prefix>` picks one): stdout when no path is given, `--yes` to overwrite an existing file, trusted workspaces only. If a previous run was interrupted (closed terminal, crash), one-shot tasks return `not_started` until someone decides: `xiu recover` prints the interrupted task (exit 2 when one exists, 0 otherwise) and `xiu recover abandon <run id or a prefix of at least 4 characters>` abandons it explicitly without replaying anything; resuming still requires the interactive confirmation. `xiu audit [approvals|credentials] [json] [limit]` lists the workspace's local security-audit records read-only (the non-interactive `/audit`: fixed fields only, `json` for one JSON document). On a fresh CI checkout you control, `--trust-workspace` replaces the interactive trust prompt for that process only: nothing is written to the trust list, and only the command line can set it.

Tools are grouped by risk: reads run automatically; writes and command execution ask for approval; dangerous actions (deletes, hard resets, bulk changes) always ask, and `--yes` cannot skip them. Answer `y` to allow, Enter to refuse. Narrow "always allow for this session" grants exist for ordinary writes and specific programs and expire when Xiu exits.

`/plan on` switches to read-only Plan mode, enforced at the tool boundary: Xiu can read, search and design but cannot write or execute. `/plan` and `/tasks` show the current plan; `/plan off` returns to execution.

| Command | Purpose |
| --- | --- |
| `/status` | Model, tokens, calls, elapsed time |
| `/diff [task\|workspace\|staged]` | Changes made during this task, in the workspace, or staged |
| `/diff runs`, `/diff run:<number\|id prefix> [file]` | List recent runs; replay the change record saved when a run finished, or one file's complete diff |
| `/check [typecheck\|lint\|test\|build\|all]` | Discover the project's npm scripts; run them with approval |
| `/checkpoints`, `/rewind` | List file checkpoints; restore one |
| `/report` | Preview or export a redacted execution report |
| `/diagnostics` | Token, time, failure and stall diagnostics for the last task |
| `/details` | Full tool and sub-agent output |
| `/compact [focus]` | Compress the context now, optionally keeping a focus |
| `/history`, `/resume`, `/recover` | Recent messages; resume a session; handle an interrupted task |
| `/queue <task>`, `/clear-queue` | Run another task after the current one |
| `/language zh-CN\|en-US` | Interface and conversation language |
| `/clear`, `/help`, `/exit` | New session; command list; quit |

A lone slash word that is not a command (`/skils`, `/hepl`) is not sent to the model: the prompt answers with "Unknown command", the closest commands and `/help`. A command whose usage is not recognised (`/mcp premissions`, `/plan onn`) gets that command's usages and the closest one. While a task runs, the `steer>` prompt accepts only `/cancel`, `/exit`, `/queue`, `/clear-queue`, `/status`, `/diff`, `/check`, `/diagnostics`, `/details`, `/paste`, `/credentials`, `/web` and `/language`; any other command (`/mcp`) is answered with "not available while a task runs" instead of becoming steering text. A task that starts with a path (`/etc/hosts explain`) still goes to the model. `/help <command>` (`/help mcp`, `/help plan on`) lists one command's usages. Slash commands run only at the prompt: a one-shot `xiu /help` or `xiu /doctor` does not start and names the script form instead (`xiu doctor`, `xiu report`, `xiu recover`, `xiu audit`, `--check-update`, `--list-sessions`), exit code 1; with `--json` the `result` line says `not_started`.

Sessions are stored under the workspace's `.xiu/` directory; `xiu --resume` or `/resume` continues one. Checkpoints capture files before changes so `/rewind` can restore them.

## Background commands

`/background start <command>` runs a dev server or long command that survives closing the terminal. `/background` lists jobs in this workspace, `/background read <id>` reads output, `/background cancel <id>` stops one after confirmation.

## Extensions

- **Skills** are `SKILL.md` workflows discovered in `.xiu/skills`, `.agents/skills` or `.claude/skills` of the project, or installed globally with `/skills install`. Each declares the permissions it needs.
- **MCP servers** (stdio or Streamable HTTP) are added with `/mcp add`, tested with `/mcp test`, and must have their exact permission manifest approved with `/mcp permissions approve <name>` before the first connection. Resources and prompts from a server are treated as untrusted content.
- **Project instructions** in `AGENTS.md` or `XIU.md` are read after the workspace is trusted.
- **Plugins** bundle providers, Skills and MCP servers with digests and optional Ed25519 signatures; see the Chinese extensions guide for publisher trust and team policy.

## Web search

By default Xiu runs a pinned version of the open-source `free-search-mcp` locally (uv is downloaded and verified on first use by the CLI; the desktop installer bundles it) and falls back to Xiu's managed search when the local engine is unavailable. `/web` shows the status, `/web configure` switches between free-search, managed search, Tavily, Brave Search or your own SearXNG, `/web proxy set` sets a search-only proxy, and `/web doctor` performs a live search and device-authentication check. Citations must come from pages that were actually opened; with insufficient evidence a search fails instead of answering from memory.

## Troubleshooting

Errors are printed in up to four lines: the failing operation and its cause in plain words, a next step, the diagnostic command to run, and the error code with a redacted detail. The complete code table is in the Chinese [troubleshooting guide](../troubleshooting.zh-CN.md).

- `xiu` is not recognised after installing: reopen the terminal, then run `xiu doctor`; it shows where the command resolves and whether the npm prefix is on `PATH`.
- A provider rejects the key (`http/401`): check that the key and the base URL belong to the same service, then `/provider key`.
- DNS, connection refused or certificate errors: `xiu doctor` lists every proxy variable, flags inconsistent proxies and `NODE_TLS_REJECT_UNAUTHORIZED=0`, and points to `NODE_EXTRA_CA_CERTS` when a corporate gateway replaces certificates.
- Provider configuration cannot be loaded: `xiu --provider-config-diagnostics` lists the state and verified backups; `xiu --provider-config-recover <backup-id>` restores one only after you type `RECOVER` in an interactive terminal.

## Safety advice

Run Xiu only in workspaces you trust. Refuse approvals you do not understand and ask Xiu to explain. Commit before letting the agent make broad changes, start risky work in `/plan on`, keep API keys out of project files, install Skills and MCP servers only from trusted sources, check `/diff` and run the tests, and review the result yourself even after Xiu reports success. The full rules are in [Security and privacy boundaries](../../../SECURITY.zh-CN.md) (Chinese).
