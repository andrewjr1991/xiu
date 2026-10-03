<div align="center">

**0.20.3** is available as a [GitHub Release](https://github.com/andrewjr1991/xiu/releases/tag/v0.20.3), with an unsigned Windows x64 installer, CLI tarball, original CI manifests and SHA256SUMS from exact source `2ad7891d8756d98001e8d6a23dc4603ccddd998d`. All six jobs passed in [CI 37099780173](https://github.com/andrewjr1991/xiu/actions/runs/37099780173); uploaded asset digests match. Managed desktop-search authentication, safe folder/SKILL.md/ZIP imports and dependency hardening are included; manual Skill, real IME and external-device acceptance passed. The unpatched build-only HTTP-cache advisory is explicitly disclosed and accepted, not fixed. npm publication is delegated to the maintainer using the same CI tarball and remains pending; GitHub publication does not update npm latest. Earlier candidate notes below are historical.

Candidate **0.20.3-preview.13** adds desktop Skill imports from folders, standalone `SKILL.md`, and ZIP packages. Use Tools & Runtime Settings → Skills, preview the package and declared permissions, then explicitly confirm. Single-file import excludes siblings; use a folder or ZIP for resources. Imports never run bundled scripts or overwrite installed skills. Store discovery, remote installers and update management remain later work. Commit/push for exact-source CI is authorized; publication remains conditional on CI and the outstanding build-dependency risk decision.

Maintainer acceptance passed for Skill import, real OS IME and external devices. Dependency hardening replaces fast-glob/braces with bounded tinyglobby matching and upgrades build-time sharp. CLI and both production audits are clean; desktop development audit retains the unpatched electron-builder HTTP-cache dependency advisory. This is not an audit-clean stable release; exact-commit CI remains required.

Candidate **0.20.3-preview.12** adds desktop managed-search authentication using the CLI's lazy device registration and short-lived tokens. In Tools & Runtime Settings → Web Search, choose **Xiu managed search** and save; custom services still accept environment-variable references, not secrets. No enrollment occurs on startup or save. The maintainer confirmed live authentication and search work and authorized commit/push; publication is not authorized, and this patch needs its own exact-commit CI.

> **0.20.3-preview.11** is available as a [GitHub pre-release](https://github.com/andrewjr1991/xiu/releases/tag/v0.20.3-preview.11), with an unsigned Windows x64 installer, CLI tarball and verification manifests from exact source `cc49096`. All six jobs passed in [CI 37094638003](https://github.com/andrewjr1991/xiu/actions/runs/37094638003); Windows full tests: 890 total, 883 passed, 7 skipped, zero failed. npm preview publication is authorized but blocked by local login-state persistence; stable latest remains 0.20.2. Real OS IME and external-device acceptance are pending.

Local desktop UI corrections: compact bottom-aligned utility entries, consistent Execute/Plan controls, non-wrapping model action labels, a collapsible tool sidebar that retains tabs/terminal state, and a main-process-owned Xiu-styled Full Access confirmation. No permission or recovery policy is relaxed.

Development candidate: the desktop composer now has an idle-only Execute / Plan read-only switch backed by the shared runtime. Plan still blocks write/execute tools under Full access; continuing history or recovering a task keeps the mode you explicitly selected. A new conversation and Provider/model reconfiguration in the same open workspace keep that selection. Closing/reopening or switching workspaces starts in Execute mode; Full access still resets on reconfiguration. IME candidate-confirmation Enter no longer submits a task or steering message; normal Enter sends and Shift+Enter inserts a newline. Automated synthetic-event coverage does not replace testing with a real OS input method.

> **0.20.3-preview.10** is available as a [GitHub pre-release](https://github.com/andrewjr1991/xiu/releases/tag/v0.20.3-preview.10), with unsigned Windows x64 installer and CLI tarball. All six exact-commit CI jobs passed for `c6d6ec5` ([run](https://github.com/andrewjr1991/xiu/actions/runs/37005365523)). npm preview publication still awaits the maintainer's browser confirmation; stable `latest` remains 0.20.2. Earlier candidate descriptions below are historical. Real OS IME and external-device acceptance remain pending.

# Xiu

本地未发布 UI 修正：MCP 详情默认折叠，工作台支持拖动调宽，配置恢复增加分步说明，完全访问确认窗口使用无系统标题栏的 Xiu 样式；权限与凭证边界保持不变。

0.20.2 desktop preview: permission modes are Ask for approval, Approve for me (risk classification, not an AI reviewer), and Full access. Full access requires a native first-enable confirmation for each workspace opening, then automatically approves all task tools including dangerous operations and permits external file access/local troubleshooting. It is not persisted; reopening/reconfiguring or restarting resets permissions. Plan read-only, trust, MCP connection grants, credential protection and recovery replay guards remain independent. External file changes are not checkpointed or included in task Diff, and cannot be guaranteed reversible. MCP buttons, modal/titlebar alignment and desktop copy are also corrected.

**A terminal coding assistant for everyday development, with reviewable changes.**

Give Xiu an outcome. It inspects the repository, edits files, runs commands, verifies the result, and leaves bounded evidence you can review.

[![CI](https://github.com/andrewjr1991/xiu/actions/workflows/ci.yml/badge.svg)](https://github.com/andrewjr1991/xiu/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@xiu-ai/cli)](https://www.npmjs.com/package/@xiu-ai/cli)
[![license](https://img.shields.io/npm/l/@xiu-ai/cli)](./LICENSE)

English | [简体中文](./README.zh-CN.md)

</div>

This version is `0.20.2`. Fresh installations start with no preconfigured Providers. It adds desktop MCP management, a tabbed review workbench, child-task and categorized evidence views, and installed Node/npm compatibility. Upgrade CLI and desktop together because channel settings migrate to format 5. It adds the Windows desktop preview, persistent reviewable task changes, a controlled interactive terminal, and Provider-neutral vision, image, video, and audio model routing while preserving the cross-platform CLI. The patch release also persists capability-specific model selections, consistently bounds generated-media downloads, and fixes Windows background-process handoff.

Development candidate Provider recovery: run `xiu --provider-config-diagnostics` to list metadata-only diagnostics and verified protected backups, then `xiu --provider-config-preview <backup-id>` to review one. `xiu --provider-config-recover <backup-id>` requires an interactive terminal and typed `RECOVER`; `-y`, piped input, blank input and cancellation cannot restore. The desktop sidebar has **Provider 配置诊断与恢复**, including when normal Provider startup fails, with a separate native confirmation. Close other Xiu clients first and restart after recovery. `current` is only offered for a verifiably dead-owner write lock: it keeps current settings, not a backup restore. Future schemas cannot be downgraded; system credentials are not restored.

Preview.9 targets a background-directory enumeration race by tolerating only ENOENT disappearance, and corrects recovery-test write-lock owner initialization to match production. ACL policy, type checks, other errors and recovery boundaries remain unchanged. New features are paused; exact Windows proof remains pending. Existing unprotected recovery directories are not silently repaired or deleted. Background commands/output are never replayed; an unconfirmed stop retains active/unknown evidence.

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

The unreleased 0.20.2 candidate connects stdio / Streamable HTTP MCP servers to desktop tasks through the same manager as the CLI. Open **MCP 连接与权限** to add/edit basic user configurations, review the exact permission manifest, then explicitly connect/reload. OAuth shows authorization origins/scopes, browser fallback and cancellation; Resource/Prompt browsing is bounded, redacted and read-only. Project/advanced/secret-bearing configurations remain read-only in the desktop editor; use CLI/config files for them. Connections close on workspace changes and exit. These desktop MCP features are not part of the published 0.20.1 package.

The unreleased 0.20.2 candidate adds MCP, an independent searchable Diff/file-tree panel with saved execution rounds and bounded line counts, real specialist-agent task/status/result cards, and categorized background processes, tools, artifacts, source reads and verification. Children remain workspace/Worktree scoped; integration always requires confirmation and Reviewer/Tester evidence. Managed background commands and npm-based MCP servers require local Node.js, never Xiu.exe as Node. Native web research, plugins, and Provider failover/stage routing remain pending. See the [capability inventory](./ROADMAP.zh-CN.md#4-后续工程化).

- Autonomous inspect/edit/verify task loop
- OpenAI, Anthropic, Agnes, Ollama, LM Studio, vLLM, and custom OpenAI-compatible profiles
- Capability-aware Provider failover and per-stage routing
- Provider-neutral vision, image, video, and audio model routing with guarded billable-media recovery
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

The v0.20.1 Windows desktop preview is packaged separately from the CLI npm package:

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

G5C adds a Windows x64 assisted NSIS installer plus deterministic fresh-install, installed-startup, in-place upgrade, interrupted-restart, and uninstall acceptance. It also produces an x64 MSIX candidate and validates its package identity, full-trust manifest, executable, and block map with the Windows SDK. A normal MSIX deployment still requires Microsoft Store signing or a code-signing certificate trusted by the target devices; an unsigned local artifact is explicitly only a signing candidate. An isolated Electron UI smoke drives the real renderer at 1366×768 and 900×768 through keyboard submission, Provider/model selection, approval, a 30-turn event stream, stop, unknown-side-effect recovery gating, checkpoint restore, and terminal lifecycle; the test bridge is not included in `Xiu.exe`. Windows, Ubuntu, and macOS CLI/Desktop CI is green; the desktop remains a preview until the pending real-user and external-device matrices are complete.

Desktop Provider configuration keeps chat models separate from vision, image, video, and audio models. Compatible non-Agnes vendors use their own Base URL and credential for media endpoints; they are never silently rerouted to Agnes. Desktop tasks expose the guarded media tools, generated media stays inside the trusted workspace, and small image/audio/video outputs can be previewed locally. Potentially billable generation still requires dangerous-operation approval and uses the persistent media recovery ledger.

The preview runs the real shared Agent, provides the G4 review/recovery inspector, and lets an idle trusted workspace discover and select Provider models, test connectivity, and save new keys to Windows Credential Manager. The picker shows the active Provider first and hides channels that have neither a real credential nor a successfully discovered model catalog; unused keyless local presets no longer occupy the list. Discovered model catalogs are cached separately per Provider, so refreshing one Provider neither clears another nor disappears after restart. The compact composer keeps the full Provider/model identity visible and offers Ask every time, Workspace auto, and High access modes; the main process applies those modes, dangerous actions still require exact confirmation, and trust/path controls cannot be bypassed. Recent tasks can be resumed without replaying old tools; completed new tasks persist and reopen the same bounded runtime-event timeline plus a separate bounded, redacted workspace-local change report. Both live completions and historical conversations show a Codex-style change-summary card; selecting a file opens its saved bounded Diff, and Changes / This task uses the same report. Legacy tasks without a snapshot say so explicitly instead of substituting the current workspace Diff, and deleting a task removes its change snapshot without deleting project files or checkpoints. Tasks can be explicitly deleted from Xiu history, and recent workspaces can be removed without deleting their directories; both actions use an in-app confirmation sheet, require a second confirmed request at the main-process boundary, and are blocked while a task is running. Explicit new-task reset, native file/image selection, paste, and drag/drop attachments are available; the composer shows file cards and bounded image thumbnails instead of raw internal attachment paths. Each model turn shows progress: Provider-visible text is labeled as a public summary, while tool-only turns receive a clearly labeled factual summary derived only from plans, tool activity, workspace changes, and verification events. Xiu neither requests nor stores, fabricates, or exposes hidden chain-of-thought. The renderer receives credential-source status, never stored keys or Base URLs; active tasks and external writers block reconfiguration. The inspector has a real interactive Terminal backed by a main-process-owned PTY bound to the trusted workspace. Its sessionized input/output/resize API is separate from Agent command evidence, uses bounded in-memory replay and output backpressure, and is cleaned up when switching workspaces, closing the window, or quitting. Terminal activity is direct user control, does not bypass Agent approvals, and is never recorded as Agent validation evidence. Windows x64 local candidate acceptance is complete; stable cross-platform desktop validation is still pending, and the desktop is not included in the published CLI package.

## Current limitations

The unreleased `0.20.2` candidate fixes preset-ID collisions: fresh CLI/desktop installations start with zero channels, vendor templates require explicit addition, and referenced legacy settings migrate without clearing user data. All user-added channels remain visible; confirmed removal of the last channel returns to setup mode. Published `0.20.1` still has the behavior described below.

- In 0.20.1, preset Providers are registered even when hidden in the desktop picker, so adding an Agnes or other preset ID can fail as already present. The next priority is explicit user-added channels and zero channels on a fresh ordinary installation, including local models. This change is planned, not shipped; existing user settings must be preserved.
- Command execution is constrained by policy and OS account permissions, not by a container sandbox.
- Checkpoint restore covers Xiu file tools; arbitrary command and remote side effects need Git or system-specific recovery.
- macOS Keychain and Linux Secret Service are not implemented.
- MCP Sampling is not implemented.
- Multi-agent conflicts are detected and preserved, not automatically resolved.
- No public model-backed benchmark baseline has been published. The last legacy run contains 14/30 trials and remains incomplete; its constrained tool setup cannot establish product success rates. Raw results are retained, but completing that run is no longer a development gate. P0/P1 uses targeted offline scenarios and candidate checks; it does not authorize new model spend.

## License

MIT © [静然](https://github.com/andrewjr1991)

Desktop workbench (unreleased 0.20.2): use **＋** to open/close Changes, Files, Terminal, Agents, Data, Evidence and a Web tab; toggle split/full view. Dropdowns use a shared keyboard-accessible menu. Data rows show concise names/status/duration, with saved details on demand. The Web tab is a separate, human-operated, ephemeral public-HTTPS reader: no task bridge, shared credentials, login submission or downloads; it is not agent web search.
