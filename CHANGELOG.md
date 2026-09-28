# Changelog

This file summarizes released behavior and the next unreleased change. Detailed implementation history remains available in Git and `PUBLISHING.zh-CN.md`.

## 0.19.0 — Unreleased

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
