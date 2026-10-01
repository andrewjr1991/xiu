# Changelog

This file summarizes released behavior and the next unreleased change. Detailed implementation history remains available in Git and `PUBLISHING.zh-CN.md`.

## 0.20.2 — Unreleased

- Start ordinary fresh installations with zero Providers in both CLI and desktop, even when environment keys exist. Vendor templates no longer register or reserve channel IDs.
- Migrate explicitly referenced legacy presets into editable user profiles, retaining credential references, model selections and routing; do not seed unused presets or clear existing user settings.
- Keep all user-added channels visible, add multi-vendor templates to both setup flows, support confirmed removal of the last channel, and block tasks until a channel is selected.
- Document actual CLI/desktop capability differences and prioritize shared services and paired entrypoint regressions.

## 0.20.1 — 2026-09-30

- Persist independently selected vision, image, video, and audio models for every built-in and custom Provider, and expose those selections to the desktop runtime.
- Apply the 250 MB download bound consistently to generated image, audio, and video assets.
- Preserve live background-process state when a new Windows foreground manager attaches.

## 0.20.0 — 2026-09-30

- Design a local-first desktop workbench with project/task navigation, a task conversation, a review inspector, explicit approvals, verification evidence, and safe recovery.
- Select an isolated Electron renderer and a shared headless runtime so the CLI and desktop client keep one source of truth for trust, permissions, checkpoints, and completion.
- Add the first shared `XiuRuntime` vertical slice with versioned snapshots, monotonic typed events, bounded replay/resync, task steering and cancellation, approval commands, recovery guards, and secret redaction; route the CLI's primary task path through an `Agent` adapter without changing terminal behavior.
- Add the G2 Electron/React desktop shell with an isolated sandboxed Renderer, a narrow typed Preload bridge, local-only CSP, blocked navigation and permissions, single-instance behavior, and hardened Electron fuses.
- Add the trusted-workspace slice: native directory selection, explicit trust confirmation before project reads, trusted recent projects, bounded task history, read-only writer-lock state, and fail-closed corrupt-history handling.
- Add the gray-white/light-blue Xiu visual system and abstract crossing-X app mark, plus a separate Windows x64 development package and packaged-app startup smoke; the desktop remains an unreleased development preview.
- Add the G3 desktop task loop backed by the real shared Agent: trusted-workspace task creation, bounded typed streaming events, steering, stop, live plans, core-enforced one-shot approvals, explicit dangerous confirmation, provider/system-credential reuse, and CLI/GUI single-writer blocking.
- Add the G4 review inspector with task/workspace/staged changes, bounded file browsing, source and sanitized Markdown/HTML previews, read-only command and verification evidence, checkpoint restore, and interrupted-task recovery.
- Keep G4 security decisions outside the renderer: confine preview paths, refuse links and credential-like files, redact text evidence, sandbox sanitized previews, create a safety checkpoint before restore, require native confirmation for destructive actions, and never replay unknown side effects automatically.
- Add the G5A desktop Provider/model manager backed by the shared Provider registry: create, edit, and delete custom channels; discover models, select the active model, test connectivity, and reload the idle workspace Agent without exposing secrets to the renderer.
- Keep the active Provider first and hide channels without real credentials or a previously discovered model catalog, including unused keyless local presets.
- Add a compact composer permission selector for per-action prompts, workspace-scoped automation, or broad non-dangerous automation; dangerous actions, workspace trust, and path boundaries remain mandatory core checks.
- Replace native task/workspace deletion alerts with an in-app confirmation sheet, while requiring an explicit confirmed request again in the main process.
- Give the active Provider/model control the remaining composer width and preserve the full model name in its accessible title instead of clipping the identifier behind a fixed percentage cap.
- Add confirmation-gated task-history deletion and recent-workspace removal; task deletion removes the conversation/run records but preserves project files and checkpoints, while workspace removal never deletes the directory.
- Keep discovered desktop model catalogs in a bounded non-secret cache per Provider, so refreshing or switching one catalog no longer empties the others and successful discovery survives restart.
- Render pasted, dropped, and selected attachments as compact file cards or bounded image thumbnails while keeping internal workspace references out of the visible composer.
- Persist the bounded runtime event stream for newly completed desktop tasks and reuse the live timeline when reopening history; reconstruct legacy task history only from retained evidence.
- Keep desktop credential changes fail-closed: report only credential source, require Windows Credential Manager for newly saved keys, reject environment-key replacement, redact Provider failures, and block reconfiguration while a task or external writer is active.
- Tighten the desktop density around a 1280×800 default window, narrower navigation and headers, smaller controls and spacing, and a task-column-bound Provider popover whose credential actions remain visible at compact sizes.
- Make desktop task submission optimistic: echo the user's request immediately, expose the current runtime phase while the model or a tool is working, follow live output without stealing a manually scrolled position, and remove blank or duplicate assistant/completion cards.
- Make recent desktop tasks resumable through a bounded, redacted transcript without replaying prior tools; add explicit new-task reset, native file/image selection, paste and drag/drop attachments, expandable factual runtime details, and session-scoped approval only when the core supplies an exact non-dangerous operation scope.
- Render the Provider's visible assistant text directly as a public summary, and give tool-only model turns a clearly labeled factual progress summary derived from plans, tool activity, workspace changes, and verification; hidden chain-of-thought remains neither requested nor exposed.
- Group public model progress, commands, edits, failures, and verification into compact expandable process sections; keep completed objectives and per-step states expandable, and color added/removed Diff lines distinctly.
- Persist a bounded, redacted workspace-local change report for completed desktop tasks, restore it into historical change summaries and the Changes / This task Diff view, clean it up with task deletion, and keep legacy tasks explicit when no snapshot exists.
- Show the same Codex-style change-summary card when a live task finishes, include per-file additions/deletions, and open each saved bounded Diff from either the card or the review inspector.
- Add the G5B controlled interactive terminal: the main process owns a trusted-workspace-bound PTY, while the sandboxed renderer receives only sessionized start/input/resize/stop events and renders them through xterm.
- Keep terminal activity separate from Agent approvals and evidence, reject startup while an Agent or detected external writer is active, block same-desktop Agent startup while the terminal runs, bound input/output/replay with backpressure, and terminate the child on workspace switches, window close, and application exit.

## 0.19.0 — 2026-09-28

- Move interactive `/update` routing, opt-in reminder lifecycle, and the `--check-update` / `--update-doctor` one-shot entry points into an independently tested command module without adding automatic installation behavior.
- Add packaged platform acceptance that installs the candidate tarball under a path containing spaces and Unicode, invokes the real npm launcher, checks update-command resolution, and runs the packaged background worker.
- Recognize Windows project-local `node_modules/.bin` PowerShell and CMD shims in update diagnostics instead of reporting a healthy local install as stale.
- Run the packaged platform acceptance on the Windows, Ubuntu, and macOS CI runners while retaining external-terminal and enterprise-device caveats.
- Normalize Windows and POSIX separators before comparing verified artifact identities, and keep detached-lifecycle tests independent of shell parsing for inline JavaScript.

## 0.18.2 — 2026-09-28

- Preserve passed verification across conservatively classified execute tools when a bounded post-command workspace and explicit-artifact fingerprint proves that no relevant file changed; fail closed when the fingerprint changes or cannot be captured.
- Let a successful, stricter `verify_output` for the same artifact safely supersede stale weaker evidence without allowing unrelated or weaker checks to hide failures.
- Clamp oversized structured-extraction value budgets to the safe maximum instead of spending another model turn on a deterministic parameter retry.
- Use the Windows system certificate store together with Node's bundled roots for direct and proxied OpenAI/Anthropic HTTPS connections, without weakening TLS verification.
- Report structured task failure reasons so verification, tool, web-evidence, model-protocol, and runtime failures are described accurately.
- Avoid no-output timer redraws that can leave repeated steering prompts in Windows ConPTY scrollback, and keep completion candidates within the tracked terminal width.
- Bound persistent tool/action summaries, reduce the live plan to completion/current/next progress, and omit redundant global workflow Skills from the model catalog while keeping explicit reads available.
- Re-read detached-worker state after observing process exit so a stale foreground snapshot cannot overwrite freshly completed terminal evidence.
- Keep the OAuth cancellation regression deterministic when a host allocates an ephemeral port that WHATWG Fetch blocks before network I/O.

## 0.18.1 — 2026-09-28

- Add bounded, path-confined retry cleanup for Windows evaluation temporary directories.
- Prevent the detached-process launcher from overwriting terminal evidence written by its worker, and make explicit stop wait boundedly for worker shutdown before cleanup.
- Re-check non-Git directory entries with `lstat` so Windows junctions are never traversed or captured.
- Upgrade `csv-parse` to 7.0.3 to address GHSA-8cw4-87c7-c6xx.
- Reconcile release documentation, the default branch, tags, Registry metadata, and verification evidence after the 0.18.0 release.

## 0.18.0 — 2026-09-16

- Reprioritize P0/P1 around daily coding quality and interaction.
- Add structured tool outcomes and error categories, result-aware loop protection, and conservative verification evidence. Informational commands do not count as checks; task edits invalidate earlier evidence and one passing check does not hide another failure.
- Add transient Chinese/English streamed previews with cross-chunk redaction and preserved code literals; drafts remain separate from completion verdicts and durable output.
- Add bounded task-start, workspace, and staged `/diff` views, including pre-existing changes and explicit unknown attribution. Task snapshots remain in memory only.
- Add `/check` discovery and approved execution of standard root npm scripts, with Plan-mode read-only enforcement, cancellation, and per-check results.
- Rebuild cross-Provider history from canonical visible text/tool calls, remove hidden reasoning from retained response fields, and treat truncated or unknown responses as incomplete rather than executing partial tools.
- Preserve the legacy evaluation harness and raw results. The last real run stopped at 14/30 records; it is not a complete product baseline and is not required to resume feature development.
- Add versioned task/result protocols, isolated scripted-Provider execution, deterministic assertions, sanitized reports, comparison gates, and the first 10 fixed tasks.
- Run the deterministic evaluation smoke in ordinary three-platform CI without network access, Provider credentials, or model spend.
- Add an explicit-confirmation real-baseline runner that pins and verifies the published v0.17.0 artifact, enforces finite global budgets, and preserves sanitized partial results.
- Add trial-boundary continuation with source-digest confirmation, immutable result lineage, cumulative budgets, fail-closed compatibility checks, and non-replayed recorded trials.
- Add a one-trial real canary, sanitized evaluation-tool failure codes, pre-execution write allowlists, and safe continuation after isolated task-budget terminals while retaining fail-closed global and infrastructure stops.

## 0.17.0 — 2026-08-20

- Establish reproducible package smoke testing and cross-platform CI foundations.
- Replace the version-first README with accurate English and Simplified Chinese product entry points.
- Add quickstart, contribution, platform-status, and permanent no-fabricated-chain-of-thought guidance.

## 0.16.5 — 2026-08-19

- Persist model turns, explicit user-facing summaries, tool activity, bounded results, file changes, verification, retries, and failures into terminal scrollback without disrupting the live steering editor.
- Keep streamed drafts transient until the complete assistant turn passes evidence and verification gates.

## 0.16.0–0.16.4 — 2026-08-18

- Added explicit update checks, opt-in cached reminders, read-only installation diagnostics, PATH/version-conflict diagnostics, and exact official npm release-metadata verification.
- Kept ordinary startup free of update-check networking unless reminders are explicitly enabled.

## 0.15.0–0.15.7 — 2026-08-13 to 2026-08-14

- Added native read-only web discovery and page opening with HTTPS/SSRF controls and evidence-gated citations.
- Added managed-search device enrollment, credential recovery, device observability, deployment hardening, and explicit database migration safety.

## 0.14.0–0.14.3 — 2026-08-13

- Added declarative plugin discovery, exact approval, recoverable lifecycle management, deterministic package digests, optional Ed25519 signatures, trusted publishers, and team policy.

## 0.13.0–0.13.8 — 2026-08-11 to 2026-08-13

- Added the local security audit ledger, task-run journals, crash recovery, replay-safe retries, budgets, detached background jobs, execution reports, trust/path hardening, first-run Provider setup, and review-gated multi-agent integration.

## 0.12.0–0.12.3 — 2026-08-10 to 2026-08-11

- Added MCP OAuth, Resources, Prompts, extension permission manifests, and reversible Provider/MCP credential-store migration.

## 0.11.0–0.11.4 — 2026-08-10

- Added Provider failover, media recovery, stage routing, cache diagnostics, and Streamable HTTP MCP.

## 0.10.0–0.10.2 — 2026-08-10

- Added persistent Provider profiles, model capability probing, and live Provider/model state.

## 0.8.0–0.9.10 — 2026-08-06 to 2026-08-10

- Built the terminal editor, structured extraction, project index, repository intelligence, diagnostics, direct process execution, approval controls, and resumable session foundations.

## 0.5.0–0.7.0 — 2026-08-05 to 2026-08-06

- Established the initial autonomous terminal task loop, tools, plans, sessions, checkpoints, Provider adapters, MCP, Skills, and multi-agent foundations.
