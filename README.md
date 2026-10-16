<div align="center">

# Xiu

**A terminal coding agent with reviewable changes and a Chinese-first UI, plus a Windows desktop preview.**

Give Xiu a goal. It inspects the repository, edits files, runs commands, verifies the result, and leaves bounded, reviewable evidence of what it did.

[![CI](https://github.com/andrewjr1991/xiu/actions/workflows/ci.yml/badge.svg)](https://github.com/andrewjr1991/xiu/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@xiu-ai/cli)](https://www.npmjs.com/package/@xiu-ai/cli)
[![license](https://img.shields.io/npm/l/@xiu-ai/cli)](./LICENSE)

English | [简体中文](./README.zh-CN.md)

</div>

Development version **0.20.12**, pending publication, includes the maintainer-accepted Computer Use editor fixes. Latest published version: **0.20.11** (2026-10-15): [GitHub Release](https://github.com/andrewjr1991/xiu/releases/tag/v0.20.11) · [npm](https://www.npmjs.com/package/@xiu-ai/cli) · [Changelog](./CHANGELOG.md). The CLI runs on Windows, macOS and Linux; the desktop app currently ships only as an unsigned Windows x64 preview installer.

## Install

The CLI requires Node.js 20.18.1 or later; Node.js 22 LTS is recommended. Node 20 reached end of life on 2026-04-30, 0.21 prints a one-line notice when started on it, and 0.22 will require Node.js 22.12 or later.

```bash
npm install -g @xiu-ai/cli
xiu --version
```

In Windows PowerShell, if `npm.ps1` is blocked by the execution policy or ConstrainedLanguage mode, use `npm.cmd` instead of `npm`. If `xiu` is not found after installing, reopen the terminal or run `xiu doctor` for a read-only report covering the installation, providers, web search, proxy and certificates; it is redacted and can be pasted to a maintainer.

Desktop preview: download `Xiu-<version>-x64-<commit>-unsigned.exe` from [Releases](https://github.com/andrewjr1991/xiu/releases/latest). The installer is per-user and needs no administrator rights. Because it is unsigned, Windows SmartScreen shows an "unknown publisher" warning.

## Quick start

Xiu ships with no preconfigured providers. Starting `xiu` in a terminal opens a three-step wizard: choose a provider (OpenAI, Anthropic, local Ollama, or presets such as DeepSeek and Qwen) → enter the key or server URL → Xiu tests the connection and lists the models, saving the profile only after the test passes; Esc leaves nothing behind. `/provider add` adds more later. You can also set an environment variable first; the wizard lists any it detects as the first choice:

```powershell
$env:OPENAI_API_KEY = "..."
xiu
```

```bash
export OPENAI_API_KEY="..."
xiu
```

OpenAI, Anthropic, Agnes, Ollama, LM Studio, vLLM and any OpenAI-compatible endpoint are supported, with templates for DeepSeek, Qwen (DashScope), Zhipu GLM, Kimi, Volcengine Ark, SiliconFlow and MiniMax that prefill only the address and model, never a key. Local models do not need an official API key.

Run it inside a Git repository:

```bash
xiu "Explain this project's entry points and how tests run, without editing files"
xiu "Fix the failing tests, run the relevant checks, and summarize the changes"
xiu            # interactive session
xiu --resume   # resume a session in this workspace
```

The first time Xiu enters a directory it asks whether to trust the workspace. Until you trust it, Xiu does not read project instructions, load project extensions, write files or run commands.

Type `/` in a session to open the command palette. Common commands:

| Command | Purpose |
| --- | --- |
| `/providers`, `/provider add`, `/models` | Manage providers, keys and models |
| `/plan on` | Read-only Plan mode: investigate before acting |
| `/diff`, `/check`, `/report` | Review changes, run project checks, generate an execution report |
| `/resume`, `/recover` | Resume sessions, handle interrupted tasks |
| `/background` | Start and inspect background commands that survive disconnects |
| `/web configure`, `/web doctor` | Configure and diagnose web search |
| `/status`, `/diagnostics`, `/help` | Status, diagnostics and the full command list |

The full command list and CLI flags are in the [command reference](./docs/guide/commands.zh-CN.md) (Chinese); feature descriptions are in the [usage guide index](./USAGE.zh-CN.md) and the condensed [English guide](./docs/guide/en/README.md).

## What it does

- **Autonomous coding loop**: reads the project, locates the problem, edits files, runs tests / typecheck / lint / build, and iterates on the results. It detects the stack and project scripts automatically (`/check`).
- **Reviewable**: each turn shows the model summary, tool activity, file changes and verification progress. `/report` produces a redacted execution report; `/diff` shows changes for the task, the workspace or the staging area.
- **Recoverable**: sessions, checkpoints, crash recovery, task budgets and stall diagnostics. Side effects with unknown outcomes are reported, never silently replayed.
- **Multiple providers**: capability probing, failover and staged routing; provider-neutral vision, image, video and audio model configuration; credentials can optionally live in Windows Credential Manager.
- **Keyless web search**: by default Xiu runs a pinned version of the open-source [free-search-mcp](https://github.com/sweetcornna/free-search-mcp) locally to aggregate several engines (uv is bundled in the desktop installer and downloaded and verified on first use by the CLI). When the local engine is unavailable it falls back to Xiu's managed search; where company policy forbids local subprocesses, `/web configure managed` selects managed search directly. Citations must come from pages that were actually opened; with insufficient evidence the search fails instead of guessing from memory.
- **Extensible**: Skills, MCP (stdio / Streamable HTTP, Resources, Prompts, OAuth, exact permission manifests) and declarative plugins with digests and optional signature verification.
- **Multi-agent**: Explorer / Implementer / Reviewer / Tester run in parallel in isolated Git worktrees; integration happens only after conflict detection, review evidence and explicit confirmation.
- **Background jobs**: dev servers and long commands can run across terminals, with output reading and explicit cancellation.
- **Desktop workbench (Windows preview)**: task stream, changes / files / terminal / sub-agent / evidence tabs, settings center, MCP management, provider configuration diagnostics and recovery. It also includes a controlled Windows Computer Use preview: the user authorizes each window, and continuous operation needs a separate, in-memory automatic grant (or Full Access).

## Safety model

Xiu reads files and runs commands as the current OS account. It is not a container sandbox, so use it only on projects you trust. The boundaries are enforced by code and cannot be lifted by model text:

- Before a workspace is trusted, no project instructions, Skills or MCP servers are loaded, and nothing is written or executed.
- Plan mode is read-only at the tool boundary. Writes and executions are tiered by risk; dangerous actions always require explicit confirmation, and `-y` cannot skip them.
- File access is constrained by real paths. Symlinks, junctions, reparse points and `..` / glob escapes are rejected.
- New or changed MCP and plugin permissions must be confirmed by the user. Web pages, MCP content and project files are untrusted content.
- Keys, tokens and other secrets are redacted from logs, sessions, reports and errors. Hidden model reasoning is neither stored nor fabricated.
- Nothing is uploaded by default: no code, sessions, audit or diagnostics. Only model calls and the Web / MCP services you explicitly configure go over the network.

The full rules are in [Security and privacy boundaries](./SECURITY.zh-CN.md) (Chinese).

## Platform status

| Capability | Windows | macOS | Linux |
| --- | --- | --- | --- |
| CLI and agent loop | Primary platform, verified on real machines | CI passes, external acceptance pending | CI passes, external acceptance pending |
| MCP, Skills, plugins | Primary platform, verified on real machines | CI passes | CI passes |
| System credential backend | Credential Manager (optional) | Not implemented | Not implemented |
| Desktop workbench | x64 preview, unsigned | Not available | Not available |
| Computer Use | Preview, per-window authorization | Not supported | Not supported |
| Clipboard image attachments | Supported | Use `@path` | Use `@path` |

## Configuration and storage

- User settings, sessions and local records live in `~/.xiu/`; project-level state lives in the workspace's `.xiu/`.
- Provider keys can come from environment variables, the local configuration file or Windows Credential Manager. Xiu stores only the references it needs and never writes keys to logs.
- `AGENTS.md` or `XIU.md` in the project root is used as project instructions, read only after the workspace is trusted.
- CLI flags (`--provider`, `--model`, `--proxy`, budget and context limits, and so on) are listed by `xiu --help` and in the [command reference](./docs/guide/commands.zh-CN.md).

## Documentation

| Document | Contents |
| --- | --- |
| [Quickstart](./QUICKSTART.md) | Install, configure and finish a first task |
| [Usage guide index](./USAGE.zh-CN.md) | One page per topic (Chinese): getting started, providers, permissions, sessions, extensions, media, background jobs, web search, command reference, troubleshooting, desktop |
| [English guide](./docs/guide/en/README.md) | Condensed English user guide |
| [Security and privacy boundaries](./SECURITY.zh-CN.md) | Long-lived security rules (Chinese) |
| [Roadmap](./ROADMAP.zh-CN.md) | Current state, priorities and next steps (Chinese) |
| [Changelog](./CHANGELOG.md) | Released version summaries |
| [Publishing guide](./PUBLISHING.zh-CN.md) | Maintainer release process and records (Chinese) |
| [Contributing](./CONTRIBUTING.md) | Development and pull request checks |

The per-version notes from the previous README are archived in [docs/history](./docs/history/README-before-2026-10-15.md).

## Development

```bash
npm ci
npm run typecheck
npm run typecheck:test
npm run lint
npm test
npm run build
npm run check:docs
npm run smoke:package
npm run smoke:platform
```

The desktop app is packaged separately. Developing and packaging it requires Node.js 22.12 or later (the released CLI still supports 20.18.1):

```bash
npm --prefix apps/desktop ci
npm run desktop:typecheck
npm run desktop:build
npm run desktop:smoke
npm run desktop:smoke:ui
npm run desktop:pack:win
npm run desktop:installer:win
npm run desktop:smoke:installer:win
```

CI runs the CLI and desktop jobs on Windows, Ubuntu and macOS, plus Node 22/24 compatibility jobs, a production dependency audit and CodeQL.

## Current limitations

- Not a container sandbox: commands run with the current account's permissions, constrained by the approval policy.
- Checkpoints cover only Xiu's file tools. Arbitrary commands and remote side effects need Git or system-level recovery.
- macOS Keychain, Linux Secret Service and MCP Sampling are not implemented.
- Multi-agent conflicts are detected and preserved, not resolved automatically.
- The desktop app is a Windows x64 preview with an unsigned installer. Computer Use does not support high-risk flows such as passwords, payments, deletion or publishing.
- There is no public evaluation baseline on real models yet.

## License

MIT © [静然](https://github.com/andrewjr1991)
