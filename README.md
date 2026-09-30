<div align="center">

# Xiu

**A terminal coding assistant for everyday development, with reviewable changes.**

Give Xiu an outcome. It inspects the repository, edits files, runs commands, verifies the result, and leaves bounded evidence you can review.

[![CI](https://github.com/andrewjr1991/xiu/actions/workflows/ci.yml/badge.svg)](https://github.com/andrewjr1991/xiu/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@xiu-ai/cli)](https://www.npmjs.com/package/@xiu-ai/cli)
[![license](https://img.shields.io/npm/l/@xiu-ai/cli)](./LICENSE)

English | [简体中文](./README.zh-CN.md)

</div>

The current release is `0.19.0`, which modularizes the update command and validates the packaged CLI through real npm launchers on Windows, Ubuntu, and macOS CI runners.

## Install

Requires Node.js 20.18.1 or newer.

```bash
npm install -g @xiu-ai/cli
xiu "Find the cause of the failing login test, fix it, and run the tests"
```

In Windows PowerShell, use `npm.cmd` instead of `npm` if the PowerShell shim is restricted by execution policy or ConstrainedLanguage.

For interactive work and resumable sessions:

```bash
xiu
xiu --resume
```

See the [two-page quickstart](./QUICKSTART.md) for Provider setup and common commands.

## Why Xiu

### Visible while it runs, reviewable afterward

During a task, Xiu writes model turns, explicit user-facing summaries, tool activity, bounded results, file changes, and verification progress above the live steering editor. It does not fabricate private reasoning that the Provider API did not return.

Afterward, `/report` assembles a redacted execution report from durable task records, exact session replay, diagnostics, verification evidence, and workspace-scoped security audit facts. The live view and report are different views with different retention boundaries; neither asks the model to remember what it did.

### Recovery without silent side-effect replay

If a process stops mid-task, Xiu records the last safe boundary and pending side effects. Operations whose result is unknown are reported and must be checked or confirmed; they are not silently replayed.

### Program-enforced safety boundaries

- Workspace trust is required before project instructions, project Skills, project MCP configuration, commands, or writes can affect a task.
- Plan mode is read-only at the tool boundary.
- Writes and execution are risk-classified; dangerous actions always require explicit confirmation.
- Real-path confinement rejects symlink, junction, reparse-point, parent-traversal, and glob escapes.
- Plugin content is hashed; optional Ed25519 signatures and exact local approval are independent gates.

### Evidence-gated web research

For current-information tasks, search snippets are discovery evidence only. Final citations must have been successfully opened, and Xiu fails rather than filling unsupported current facts from model memory.

### Local-first records

Xiu does not upload project code, sessions, audit records, or diagnostics by default. Model calls and explicitly configured web/MCP services still communicate with their configured endpoints. Update notifications are off by default, and ordinary startup performs no update check unless the user explicitly enabled that feature.

## Core capabilities

- Autonomous inspect/edit/verify task loop
- OpenAI, Anthropic, Agnes, Ollama, LM Studio, vLLM, and custom OpenAI-compatible profiles
- Capability-aware Provider failover and per-stage routing
- Repository map and TypeScript/JavaScript symbol, reference, and caller navigation
- MCP stdio and Streamable HTTP, Resources, Prompts, OAuth, and permission manifests
- Declarative plugins with digest, signature, publisher, and team-policy checks
- Background jobs, resumable sessions, task budgets, diagnostics, and execution reports
- Multi-agent roles with isolated Git worktrees and review-gated integration
- Simplified Chinese and English UI and model-output contracts

## Added in 0.18.0

- `/check` discovers the root npm project's `typecheck`, `lint`, `test`, and `build` scripts; `/check test` runs one and `/check all` runs the available checks in order. The actual scripts and lifecycle hooks are previewed through the existing approval path. Plan mode allows discovery only; `Ctrl+C` cancels active checks.
- `/diff` (or `/diff task`) shows changes since the current task's in-memory starting point, `/diff workspace` includes staged, unstaged, and untracked workspace changes against HEAD, and `/diff staged` compares the index with HEAD. Existing changes and uncertain attribution are labeled. Snapshots and previews are bounded; omitted files are reported, and task baselines do not survive a restart.
- Chinese and English streamed drafts appear temporarily while a response is arriving. Redaction precedes display, code literals retain their spelling, and a draft is not a completion verdict.
- Tool failures carry consistent status and error categories. Repeated failures can stop even when arguments change; a failed command is not progress. Verification rejects `echo test`, help/version output, and similar non-checks; another passing check cannot conceal a recorded failure, and subsequent task edits invalidate prior checks.
- Provider histories are rebuilt from visible text and tool calls. Truncated, filtered, or unknown endings cannot be reported as completed work or execute partial tool calls.

A successful script exit records an execution result, not proof that every requirement is correct. See the [usage guide](./USAGE.zh-CN.md) for command details and limits.

## Platform status

| Capability | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Core CLI and Agent loop | Primary, locally verified | CI target; external acceptance pending | CI target; external acceptance pending |
| MCP, Skills, plugins | Primary, locally verified | CI target | CI target |
| OS credential backend | Credential Manager, opt-in | Not yet supported | Not yet supported |
| Clipboard image attachment | Supported | Use `@path` | Use `@path` |
| Background shell | PowerShell | `/bin/sh` path, acceptance pending | `/bin/sh` path, acceptance pending |

Windows is currently the most thoroughly tested platform. CI coverage is not a substitute for real OS keyring, enterprise-policy, terminal, and OAuth migration acceptance.

## Configuration and storage

User settings and local records live under `~/.xiu/`; project-local Xiu state lives under `.xiu/`. Task execution can intentionally modify files inside the trusted workspace and can run explicitly approved commands, so Xiu is not a container sandbox.

Set a Provider key with an environment variable or use the interactive Provider commands:

```bash
export OPENAI_API_KEY="..."
xiu
```

```powershell
$env:OPENAI_API_KEY = "..."
xiu
```

Inside a session, type `/` to open the command palette. Useful starting points include `/providers`, `/models`, `/status`, `/diagnostics`, `/diff`, `/check`, `/report`, `/recover`, and `/help`.

## Documentation

| Document | Purpose |
| --- | --- |
| [Quickstart](./QUICKSTART.md) | Install, configure, and finish a first task |
| [完整使用指南](./USAGE.zh-CN.md) | Complete Simplified Chinese command reference |
| [Security boundaries](./SECURITY.zh-CN.md) | Permanent security and privacy rules |
| [Roadmap](./ROADMAP.zh-CN.md) | Current state, current release, and next actions |
| [Changelog](./CHANGELOG.md) | Unreleased work and released-version summary |
| [Publishing guide](./PUBLISHING.zh-CN.md) | Maintainer release and installation gates |
| [Contributing](./CONTRIBUTING.md) | Development and pull-request checks |

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run check:docs
npm run eval:smoke
npm pack --dry-run --json
npm run smoke:package
npm run smoke:platform
```

The unreleased v0.20.0 desktop preview is developed separately from the CLI package:

Desktop development and packaging require Node.js 22.12.0 or newer; the published CLI keeps its Node.js 20.18.1 baseline.

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

G5C adds a Windows x64 assisted NSIS installer plus deterministic fresh-install, installed-startup, in-place upgrade, interrupted-restart, and uninstall acceptance. An isolated Electron UI smoke drives the real renderer at 1366×768 and 900×768 through keyboard submission, Provider/model selection, approval, a 30-turn event stream, stop, unknown-side-effect recovery gating, checkpoint restore, and terminal lifecycle; the test bridge is not included in `Xiu.exe`. The desktop remains a preview until the pending cross-platform and external-device matrices are complete.

The preview runs the real shared Agent, provides the G4 review/recovery inspector, and lets an idle trusted workspace discover and select Provider models, test connectivity, and save new keys to Windows Credential Manager. The picker shows the active Provider first and hides channels that have neither a real credential nor a successfully discovered model catalog; unused keyless local presets no longer occupy the list. Discovered model catalogs are cached separately per Provider, so refreshing one Provider neither clears another nor disappears after restart. The compact composer keeps the full Provider/model identity visible and offers Ask every time, Workspace auto, and High access modes; the main process applies those modes, dangerous actions still require exact confirmation, and trust/path controls cannot be bypassed. Recent tasks can be resumed without replaying old tools; completed new tasks persist and reopen the same bounded runtime-event timeline plus a separate bounded, redacted workspace-local change report. Both live completions and historical conversations show a Codex-style change-summary card; selecting a file opens its saved bounded Diff, and Changes / This task uses the same report. Legacy tasks without a snapshot say so explicitly instead of substituting the current workspace Diff, and deleting a task removes its change snapshot without deleting project files or checkpoints. Tasks can be explicitly deleted from Xiu history, and recent workspaces can be removed without deleting their directories; both actions use an in-app confirmation sheet, require a second confirmed request at the main-process boundary, and are blocked while a task is running. Explicit new-task reset, native file/image selection, paste, and drag/drop attachments are available; the composer shows file cards and bounded image thumbnails instead of raw internal attachment paths. Each model turn shows progress: Provider-visible text is labeled as a public summary, while tool-only turns receive a clearly labeled factual summary derived only from plans, tool activity, workspace changes, and verification events. Xiu neither requests nor stores, fabricates, or exposes hidden chain-of-thought. The renderer receives credential-source status, never stored keys or Base URLs; active tasks and external writers block reconfiguration. The inspector has a real interactive Terminal backed by a main-process-owned PTY bound to the trusted workspace. Its sessionized input/output/resize API is separate from Agent command evidence, uses bounded in-memory replay and output backpressure, and is cleaned up when switching workspaces, closing the window, or quitting. Terminal activity is direct user control, does not bypass Agent approvals, and is never recorded as Agent validation evidence. Windows x64 local candidate acceptance is complete; stable cross-platform desktop validation is still pending, and the desktop is not included in the published CLI package.

## Current limitations

- Command execution is constrained by policy and OS account permissions, not by a container sandbox.
- Checkpoint restore covers Xiu file tools; arbitrary command and remote side effects need Git or system-specific recovery.
- macOS Keychain and Linux Secret Service are not implemented.
- MCP Sampling is not implemented.
- Multi-agent conflicts are detected and preserved, not automatically resolved.
- No public model-backed benchmark baseline has been published. The last legacy run contains 14/30 trials and remains incomplete; its constrained tool setup cannot establish product success rates. Raw results are retained, but completing that run is no longer a development gate. P0/P1 uses targeted offline scenarios and candidate checks; it does not authorize new model spend.

## License

MIT © [静然](https://github.com/andrewjr1991)
