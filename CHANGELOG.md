# Changelog

## Unreleased

- Docs: `README.md` and `README.zh-CN.md` are rewritten as short, parallel overviews (install, quick start, capabilities, safety model, platform status, documentation map, development, limitations). The previous per-version READMEs are archived under `docs/history/`. `QUICKSTART.md` no longer describes the zero-provider first run as an unreleased candidate.
- Providers: `/provider add` and the desktop "新增渠道" form offer vendor templates for DeepSeek, Qwen (DashScope compatible mode), Zhipu GLM, Kimi (Moonshot), Volcengine Ark, SiliconFlow and MiniMax. A template prefills the OpenAI-compatible base URL, a current default model and the usual key environment-variable name from the vendor's public documentation; every field stays editable, nothing is registered until saved, and no key ships with Xiu. The CLI flow now shows defaults in brackets (ID, name, environment variable) so a vendor channel needs only the key.

## 0.20.11 — 2026-10-15

0.20.11 已于 2026-10-15 发布至 [GitHub](https://github.com/andrewjr1991/xiu/releases/tag/v0.20.11) 与 npm。标签精确绑定 c0ba7fda8624bde8dcf4940ab1288d7f911db3d2；CI 38707383288 九作业及同提交 CodeQL 通过。五份原始 CI 附件的大小与 SHA256 上传后回读一致；Windows 安装器未签名。npm latest 为 0.20.11，npm 包与 CI 包的 420 个文件路径和内容完全一致，但 tarball 压缩摘要不同，npm gitHead 保留发布前旧提交记录。
- CLI: `/web configure managed` and the backend menu now select Xiu managed HTTPS search directly, without downloading or launching uv/free-search. The choice persists across restarts while retaining domain rules, timeout and proxy. Health-check HTTP 403 reports that device authentication has not started and points to enterprise gateway/proxy or server access rules; it does not reset credentials or bypass access controls.

## 0.20.10 — 2026-10-15

Published to npm by the maintainer.

- Provider configuration on Windows: saving channels no longer starts Windows PowerShell to apply and verify an owner-only ACL on `~/.xiu/providers.json`, its recovery directory, backups and locks. Machines whose PowerShell runs in Constrained Language mode, elevated terminals and domain policies that give new objects to the Administrators group could not add a provider at all (`Provider configuration storage is not a protected regular file/directory … stage: verify-owner`). The files now rely on the Windows user profile's default permissions, as git, npm and ssh credential files do; POSIX still requires 0600/0700 and the current owner. The Windows privacy preflight CI step and its tests are removed; an empty recovery directory left by an earlier failed attempt is used as is.
- Desktop: the Windows installer smoke (`desktop:smoke:installer:win`) now reads the Electron fuse wire of the installed `Xiu.exe` after a fresh install and again after an in-place upgrade, and fails unless RunAsNode, NODE_OPTIONS and `--inspect` are disabled and cookie encryption, embedded ASAR integrity validation and only-load-from-ASAR are enabled. Until now the fuses were flipped during packaging but never verified in the shipped artifact.
- Computer Use: a window whose PNG screenshot exceeds 6 MB is sent as JPEG (quality 80) at the same dimensions, so large or photographic 4K windows no longer fail with an incomplete-result error; a capture that still exceeds the budget reports `window-capture-too-large` with a clear message (0.20.8 review C7, second half).
- Computer Use: a screenshot upload to the vision model is sent exactly once; the SDK's automatic retries are off, so a failed upload no longer resends the same frame (0.20.8 review C7).
- Computer Use hardening (0.20.8 review C3–C6; Windows runtime behaviour still to be verified on a real machine): the sensitive-title, blocked-application and consequential-control patterns now live in one shared module that the C# bridge embeds verbatim (a test fails when the copies diverge), and the lists gain terminals, remote desktop, password managers, checkout and verification-code windows. The bridge refuses a click or Enter/Space whose target control it cannot read (UI Automation failure, focus owned by another process, or an unnamed button/link/menu item) with `control-uninspected`; the main process then asks the user for that single step and only a confirmed step is resent with `allowUninspected`, which automatic mode never sets. Typing into a focus the bridge cannot inspect is refused the same way instead of skipping the password check. Captures report how complete the control inspection was (`complete`, `partial`, `unavailable`); the model sees it and per-step dialogs warn when it is not complete. Every consent dialog now states that control names and the vision model's descriptions go back to the task model and into session history, and the manual-selection dialog no longer claims that any title change revokes the grant.
- Anthropic: works with current Claude models. The built-in default is now `claude-opus-5-5` (with `claude-sonnet-5-5` and `claude-haiku-5-5` as built-in candidates); the capability probe retries with `tool_choice: auto` when a model rejects a forced tool call; requests allow 32,000 output tokens so always-on reasoning no longer truncates answers, falling back once to 8,192 for models that cap lower; and tool-calling turns replay the opaque thinking state the API requires (empty-text signatures and encrypted blocks only, never readable reasoning), stripping it once if the API rejects it. Upgraded `@anthropic-ai/sdk` 0.57 → 0.133 (Dependabot #47).
- Dependencies: `openai` 5.23 → 6.49 (the 6.0 breaking change only touches Responses API output types Xiu does not use). `openai` 7 requires Node 22 and stays out while the CLI supports Node 20.18.1.

## 0.20.9 — 2026-10-15

Published to [GitHub](https://github.com/andrewjr1991/xiu/releases/tag/v0.20.9) from `961fd47e154b43747e3136843caea9ae368f0c44`; all nine exact-source CI jobs passed. Windows CLI: 1164 tests, 1155 passed, 9 skipped, no failures. Fixed the npm file list to include the current design and added a regression before publication; the earlier draft was never public. Five original CI assets and uploaded digests verified. Windows unsigned; npm 0.20.9 is published from the same tarball (latest and integrity verified).

Local keyless web search works out of the box (uv bundled in the desktop installer, downloaded and verified by the CLI on first use), plus security fixes from the first CodeQL scan, faster Windows settings saves and smaller desktop fixes. The maintainer accepted the main CI test build of `3c7ed92` on 2026-10-14.

- Local web search no longer needs uv installed by hand. The Windows desktop installer now includes uv 0.12.21, and the CLI, when no uv is on PATH, downloads that same version once into `~/.xiu/uv` on the first local search. Both use the official PyPI wheel (the CLI also tries the Tsinghua and Aliyun PyPI mirrors) and accept it only when its size and SHA-256 match the values pinned in the source; Linux uses the static musl build. The installer acceptance checks that the installed `uvx.exe` runs and reports the pinned version.
- CLI web results read like the desktop: a successful `web_search` shows "returned N results" and `web_open` shows the page title and URL, instead of the start of the English untrusted-content notice. The search and page-open budget messages are shown in plain words too. The model still receives the full notice, and `/details` still shows the raw output.
- Desktop: Settings → 对话与运行 now has a row that opens 工具与运行设置 (web search, model routing, Skills), which was previously only reachable from the gear icon in the workspace header.
- Desktop channel settings: when **保存渠道** is unavailable, the editor now says why (the missing fields, such as 标识, or that a task or another window holds the configuration) instead of only greying out the button. In Settings the channel manager now grows with the page instead of scrolling inside a fixed-height box, and the save bar stays visible at the bottom.
- Faster channel saves and model switches on Windows: each settings write used to start Windows PowerShell five times to check file permissions (about 0.5–1 s each). Checks made at the same moment now share one PowerShell process, so a save or switch starts it twice. Every object is still checked against its current ACL, in the same order; the first failure stops the batch, and a lock file created for a failed write is removed.
- CI speed on Windows: the full test suite no longer starts Windows PowerShell to re-verify the ACL of every provider settings file it reads. Files and directories it creates still get the real owner-only DACL, and the real checks keep running in the Windows privacy step and in the ACL tests that need them. Product behavior is unchanged; a test checks that only the test harness can swap the check.
- CI: a new commit on a pull request now cancels that pull request's older, still-running CI run, so only the latest commit is checked. Runs from pushes to `main` and `codex/**` are never cancelled and keep their exact-commit candidates.
- Managed search auth deploy: the image's `.dockerignore` only allowed `server.py`, so upgrading with the installer failed at `COPY migrate_database.py` ever since the migration tool was added (the old service kept running). It now allows both files, and a test checks that every file the Dockerfile copies is both allowed into the build context and copied by the installer. Upgrades also ran the database check in the still-running old image (`compose images` reports the container's image, not the fresh build), which has no migration tool and so stopped the upgrade with a misleading "diverged database" error; the installer now tags its build as `xiu-search-auth:local` and runs the check in that image.
- Security hardening from the first GitHub CodeQL scan: the desktop confirmation dialog now renders its title and detail as escaped static HTML instead of injecting them through generated script; the vision-probe change check compares its configuration snapshot in memory instead of hashing credential values; and the managed search auth server only echoes a well-formed device id into its `X-Xiu-Device` response header. No user-visible change.
- Security: command risk classification could hang on a crafted command. Tokenizing a double-quoted argument full of PowerShell backtick escapes without a closing quote backtracked exponentially (about 10 s at 44 characters, doubling with each few more), and classification runs before approval on model-produced commands. The tokenizer now treats a backtick as always escaping the next character and runs in linear time; well-formed commands classify as before. Found by a local CodeQL scan.
- Lint gate: `npm run lint` runs ESLint with error-level rules only (the recommended JavaScript and TypeScript sets, tuned for intentional patterns such as best-effort cleanup and control-byte matching). CI runs it once, in the Linux Verify job. Turning it on removed unused imports and variables, a dead interface and a never-read model lookup, and redundant regex/string escapes; no runtime behavior change.
- Desktop security: changing the approval mode is now bound to the idle context the window last saw, as Plan mode already was. A stale window (after a Plan change, provider reload or host replacement) can no longer switch the current host's mode, including turning Full Access back on without a dialog.
- Web search needs no API key by default: when [uv](https://docs.astral.sh/uv/) is installed, `web_search` runs a pinned [free-search-mcp](https://github.com/sweetcornna/free-search-mcp) 0.13.1 locally, with every dependency pinned, only its read-only `search` tool enabled, and none of Xiu's secrets passed to it. Without uv, or when local search finds nothing, it falls back to managed Xiu Search and says so. `web_open` and the evidence gates are unchanged. A managed preset saved by an earlier version moves to local-first once; explicit choices are kept. New `/web configure free-search`, a `/web doctor` test search, and a local mode in the desktop settings.
- Background jobs on Windows: replacing a job's state file now retries briefly when another process (such as a status poll) has it open, in the pre-loader bootstrap, the worker and the foreground manager alike. Previously a refused rename in the bootstrap could leave a failed launch stuck in `starting` until it was reported as `interrupted`, losing the real failure evidence. Only the metadata rename is retried; commands are never re-run.
- Tests now type-check: `npm run typecheck:test` (`tsconfig.test.json`) covers `src/` and `test/`, and CI runs it on all three Verify platforms. Fixture fixes only; no runtime change.
- Internal: `Agent` is constructed from one `AgentOptions` object instead of eleven positional parameters; every caller passes named fields. No behavior change.
- Internal: slash-command groups moved out of `src/cli.ts` into `src/commands/`, the desktop `App.tsx` split into focused components, and the roadmap reduced to current state, priorities and next step (history in `docs/history/`). No behavior change.

## 0.20.8 — 2026-10-13

Published to [GitHub](https://github.com/andrewjr1991/xiu/releases/tag/v0.20.8) from main `d36c488fc5706277562d3018a23907761440d124`; all nine exact-source CI jobs passed. Windows CLI: 1117 tests, 1109 passed, 8 skipped, no failures. Windows Computer Use preview, subagent tool details, waiting answers, inline channel management and individual/batch visual probes; command-chain approval/Plan hardening, task-bound computer allowances, process liveness fixes and MCP 2.3.1. Original CI assets and digests retained; Windows unsigned, paid-provider/enterprise validation pending. npm publication is a separate maintainer step. Older unpublished notes below describe development history.

Local unpublished Computer Use hardening: a merged Full Access grant now covers one 20-minute / 100-input automatic allowance per parent task; re-selecting a window continues that allowance, and once it is spent or expired the user must confirm again. Renderer-originated inputs always require per-step confirmation in automatic mode. Update the prompt test for the plan-freshness rule.

Local unpublished settings update: embed channel/model management directly in Settings, retaining existing trust, writer and approval guards. The chat picker selects existing models only, with no editing, credential or probe controls. Settings model selection stays inline; leaving management clears unsaved credential input and cancels visual probing.

Local unpublished batch visual probing: test all visual candidates in the current saved channel with one explicit potentially billable confirmation, serial bounded requests, progress, per-model outcomes and cancellation of remaining calls. No cross-channel expansion, automatic retries or model switching.

Local unpublished visual capability probing: explicit potentially billable confirmation, synthetic random-digit PNG verification, one request with SDK retries disabled, timeout/cancellation and context guards. Distinguish passed, incorrect, inconclusive and cancelled; no user screenshots or permanent capability claims. Real paid-provider validation is pending.

Local unpublished vision picker correction: keep unknown chat models as explicit candidates, distinguish API-declared/name-inferred/unknown evidence, interpret image input as vision rather than generation, and provide an unfiltered themed menu alongside manual model ID entry. No paid visual probes or authorization changes.

Local unpublished UI correction: fix dark-theme Computer Use human-acceptance buttons using the shared secondary-button palette; add light/dark contrast regression checks. Vision routing and authorization behavior remain unchanged.

Local unpublished Computer Use increment: separate per-round human acceptance from program verification without overriding failed checks; restricted Shift+Home / Shift+End editor selection and one-input replacement, with no arbitrary system chords or clipboard access.

0.20.8 最新电脑交互候选（2026-10-12，未发布）：新版完全访问确认合并电脑操作和实际视觉渠道说明，明确接受后同工作区/渠道的普通窗口不再额外确认；旧确认和其他渠道仍询问。授权弹窗先完成销毁，再自动交接目标前台；重试只取得焦点，不重放输入。新增不夺焦点的真实阶段悬浮条与暂停/继续/停止，暂停不撤回在途动作或延长时效；仍非后台并行操作。下方旧候选为历史。

0.20.8 最新本地增量（2026-10-12，未发布）：自然语言目标、窗口发现与 UIA 控件操作已接入；用户显式启用临时完全访问并确认窗口/视觉渠道范围后，自动模式最长 20 分钟 / 100 次输入，范围内不逐步弹窗。手动模式保留单步确认及 10 分钟 / 30 次上限。每次输入默认等待 350 毫秒重新观察，可配置 0–3000 毫秒加载等待；取消和过期画面不继续提供可操作结果，未知输入不重放。维护者报告记事本任务通过，完整实玩仍待验收。下面单步候选段落为历史，不代表当前自动模式。

0.20.8 本地候选（未发布）：保留真实子智能体工具明细、计划滞后提醒、等待回答卡片和会话换行修复。Computer Use 已扩展为用户选择已打开的 Windows 应用窗口，不再以 HTML 文件为唯一目标；支持目标截图、单步点击、普通文本输入、受限按键和滚动，并接入桌面父任务的观察/输入工具。窗口授权、每步输入、每次向当前视觉渠道发送截图分别确认；统一使用 Xiu 深浅主题的隔离确认框，默认取消。截图不写历史、审计或文件；仅明确确认的单张画面发送模型。Plan、未信任工作区和子智能体不得获得此能力；授权最长 10 分钟 / 30 步，任务结束、窗口身份变化、切换工作区或停止撤销。未知输入结果不重放。不包含整个桌面自主控制、管理员、密码或支付流程；真实付费模型和完整实玩验收尚未完成。

Local unpublished fix: Security: classify shell commands per executed segment. Composed commands (`&&`, `||`, `&`, newlines, redirection, `$(...)`/backtick substitution) are never read-only, so a read-only prefix such as `git status && …` can no longer skip approval or Plan mode. `rm`-class programs are detected after control operators, inside `sh -c`/`cmd /c`/`powershell -Command`/`Invoke-Expression` scripts, behind wrappers (`sudo`, `env`, `xargs`, `timeout`, …) and in `find -delete`/`-exec`; uninspectable PowerShell `-EncodedCommand` and scripts piped into a shell are dangerous. `git -c`/`--config-env` and `--output` are no longer read-only, and read-only PowerShell pipelines require every element to be an allowlisted cmdlet.

Local unpublished fix: Background stop and liveness checks on Linux no longer treat zombie processes as running. Where no init reaps orphans (for example a container without `--init`), stopping a background job previously never confirmed. If `/proc` is unreadable, the process is still treated as alive.

Local unpublished fix: Security: upgrade `@modelcontextprotocol/client` from 2.0.0 to 2.3.1 for GHSA-6qxp-vccf-f47h. Before 2.2.0, the OAuth client could send credentials to an authorization server chosen by the MCP server. The SDK license changed from MIT to Apache-2.0 upstream. `npm audit --omit=dev` now reports 0 vulnerabilities.

## 0.20.7 — Task review corrections (2026-10-08)

- Published exact main-CI assets with explicit maintainer acceptance of one Windows background bootstrap lstat EPERM race (1010 passed, 7 skipped, 1 failed; five other jobs passed). Original failed CLI manifest retained. Windows unsigned; npm authentication pending.

- Compute bounded-work text diff statistics independently of preview truncation and persist them with task snapshots; retain both replacement sides in small hunks.
- Bind live attachment cards to their exact user event rather than every conversation round.
- Restore managed historical upload thumbnails on their original messages; retain missing-file placeholders and reject unsafe/link paths.
- Persist complete redacted text Diffs separately from bounded preview metadata; paginate both review surfaces without clipping long lines. Label old preview-only records and estimated counts explicitly; preserve existing source-read limits.
- Show program acceptance failures alongside model replies, distinguish failed/stale verification obligations, and avoid equating completed plan steps with acceptance.
- Disable unavailable workspace/staged comparisons for non-Git directories without initializing Git or staging files.

## 0.20.6 — Desktop settings release (2026-10-04)

- Add appearance, conversation/run, notification, model/channel and about settings with validated atomic persistence of non-sensitive preferences.
- Support system/light/dark themes, UI/code font sizing, density, reduced motion, follow/display preferences and send shortcuts; retain IME and authorization boundaries.
- Fix dark workspace headers, inspector tabs and translucent controls; use matte subagent avatar palettes.
- Keep notifications opt-in with fixed background-only messages; never persist credentials, workspace trust or Full Access grants.
- Maintainer explicitly waived remote CI for this version. Local builds and scoped checks only; full-suite/cross-platform checks were not run. Exact-source manifests accompany assets; no previous CI results are inherited. Windows remains unsigned and known build warnings remain disclosed. npm publication requires authentication (latest: 0.20.4).

## 0.20.5 — Released (2026-10-03)

GitHub release published from verified main CI artifacts. npm publication remains pending authentication; npm latest is 0.20.4. Windows installer remains unsigned.

- Preserve task continuation and model-switch context; remove model-invented child budgets while retaining explicit host limits.
- Separate first-body, stream-idle and complete-response deadlines; show safe public output and numeric transport progress. Only explicit continuation changes transport after a stream failure.
- Validate complete tool JSON, retain exact verification obligations, and avoid false loop detection during healthy child waits.
- Make stale task deletion idempotent without deleting project files.
- Follow growing output, pause on upward navigation, fold bounded error details, diversify vector avatars and generate stage-based summaries.
- Reduce nested blue cards and heavy process headings; compact headers and history titles while preserving controls and logs.
- Preserve trust, Plan, approval, checkpoints and ephemeral Full Access. Windows installer remains unsigned; upstream stalls and browser play are not certified by UI tests.

## 0.20.4 — GitHub Release (2026-10-03; npm publication pending)

- Add chronological child-agent status, consistent role avatars, inspectable results and independently confirmed cancellation without expanding permissions.
- Collapse intermediate activity into one elapsed-time entry per task round; keep final answers, failures, approval and recovery controls visible.
- Expand the task overview and group workspace settings, overview, terminal and sidebar controls at the top right.
- Preserve per-round history and current continuation results without borrowing stale task outputs or live workspace facts.
- Deduplicate search progress, provide trusted current-date context, and retain inspectable web evidence.
- Improve constrained-PowerShell privacy verification and explicit provider refresh without repairing existing unsafe ACLs automatically; bound transient Windows task-record rename retries without replaying tools.
- Maintainer local acceptance passed. All six jobs passed for merged main source `c4113de2bf11ad1f2136464c6c6450c73d6f4f45` in CI 37112569209; Windows full tests: 969 total, 962 passed, 7 skipped, zero failed. GitHub assets are the original CI artifacts with verified upload digests. Windows installer remains unsigned; prior build-only HTTP-cache advisory acceptance remains disclosed. npm 0.20.3 is confirmed published; 0.20.4 is delegated to the maintainer using the same CI tarball.


## 0.20.3 — GitHub Release (npm publication pending)

- Combine desktop managed-search lazy device registration/token renewal with confirmed local folder, SKILL.md and ZIP Skill imports; preserve trust, Plan, credentials, immutable permission preview and no-overwrite enforcement.
- Replace vulnerable fast-glob/braces matching with a bounded tinyglobby adapter and upgrade build-time sharp; CLI and both production audits are clean.
- Retain the unpatched build-only http-cache-semantics advisory (GHSA-ch52-4w7c-c8xp) with explicit maintainer risk acceptance. Normal builder downloads do not enable its HTTP response cache; the dependency is absent from shipped CLI/desktop artifacts. Do not downgrade the builder or suppress audit warnings.
- Manual Skill, real OS IME and external-device acceptance passed. All six jobs passed in CI 37099780173 for exact source `2ad7891d8756d98001e8d6a23dc4603ccddd998d`; GitHub Release assets and manifests were verified against their CI hashes before publication. npm publication is delegated to the maintainer using that unchanged CI tarball and is still pending. Desktop Windows x64 NSIS remains unsigned; other desktop platforms and Store signing are not newly claimed stable.

## 0.20.3-preview.13 — Local Skill import candidate (unreleased)

- Desktop local Skill preview now accepts folders, a standalone SKILL.md, or ZIP packages; single-file imports exclude unrelated siblings.
- Bound archive input/extraction, reject unsafe paths, aliases, links, encryption and unsupported compression, and verify actual sizes and CRC before confirmation.
- Retain permission preview, immutable staging, cancellation, single-use confirmation, Plan/trust enforcement and no-overwrite behavior. No bundled scripts run; remote commands and store management remain deferred.
- Replace fast-glob/braces with bounded tinyglobby searches, preserving ordinary brace/range matching and workspace/symlink guards; upgrade desktop build-time sharp to 0.35.5.
- Maintainer Skill import, real OS IME and external-device acceptance passed. CLI and both production dependency audits are clean; desktop development audit still reports the unpatched http-cache-semantics chain in electron-builder. Exact-commit CI and release authorization remain pending.

## 0.20.3-preview.12 — Local test candidate (unreleased)

- Desktop search reuses CLI lazy device enrollment and short-lived token renewal. Managed and custom search are explicit UI choices; saving does not enroll or test a service.
- Keep managed auth, independent proxy and domain/timeout policies when saving. Persist explicit selections so a legacy environment token cannot silently replace managed authentication.
- Maintainer live-service acceptance passed: automatic authentication and search work. Commit/push is authorized; publication is not. The previous release's CI does not validate this patch.

## 0.20.3-preview.11 — GitHub pre-release (2026-10-03)

- Exact source `cc49096f987309fa38baa7947694ff2398f1ccff` passed all six jobs in CI run `37094638003`. Windows full tests: 890 total, 883 passed, 7 skipped, zero failed. Installer, CLI tarball and verification manifests are published from that exact CI run.
- npm preview publication is authorized but not completed: browser authorization succeeded, while saving local login state was denied. Stable latest remains 0.20.2.

- Serialize background bootstrap claims, shell creation and cancellation; recover only proven-dead lifecycle lock owners.
- Share CLI/desktop provider routing, expose read-only native search, local staged Skills installation and bounded local reports.
- Add narrow-window and 125% zoom management UI coverage. Real OS IME and external-device acceptance remain pending; preview publication is authorized, without promoting stable latest.
- Synchronize the background output-cursor fixture explicitly before its second chunk; retain the incremental-output assertions instead of relying on a 500ms timing window.

This file summarizes released behavior and the next unreleased change. Detailed implementation history remains available in Git and `PUBLISHING.zh-CN.md`.

## 0.20.3-preview.10 — GitHub pre-release

- Exact source `c6d6ec5` passed all six jobs in CI run `37005365523`; GitHub assets and tag are published. npm preview publication is still awaiting browser confirmation; stable latest remains 0.20.2.

- Align sidebar utilities, Execute/Plan controls and model picker actions across wide and narrow windows.
- Collapse MCP details by default and explain Provider configuration recovery without changing authorization or recovery behavior.
- Add draggable/keyboard resizable split panes; fully hide the workbench on collapse and restore tabs, terminal state and pane ratio from a header control.
- Use an isolated, main-process-owned Xiu-styled Full Access confirmation; Cancel, close and Escape never authorize.
- Keep npm stable `latest` at 0.20.2; Windows x64 desktop installers remain unsigned previews.

## 0.20.3-preview.9 — Prior candidate history

- Require the focused Windows cleanup/current-recovery regressions after privacy preflight and before the full suite; preserve complete tests and record every gate in candidate metadata.

- Target only two Windows CLI regressions: tolerate ENOENT disappearance during background directory enumeration, preserving type checks and all other errors; initialize recovery-test write-lock ownership like production without weakening ACL policy. Diagnosis and regression evidence remain pending.
- Preview.8 CI 36993723905 finished with five of six jobs passing: Windows privacy preflight passed 9/9, while full Windows CLI had 859 passes, 7 skips and 2 failures out of 868 tests. Build/package/platform/eval checks passed; verified binaries do not make the candidate accepted.
- Preview.9 local validation, exact-commit CI and artifacts remain pending. New features and managed-web authentication remain paused; existing visual-capture gaps and bootstrap claim/cancel race remain open.

## 0.20.3-preview.8 — Unreleased candidate

- Limit this follow-up to the Windows privacy gate: remove inherited PSModulePath case-insensitively from the Windows PowerShell child environment, without mutating its parent. Preserve Get-Acl readback, direct .NET Owner/DACL persistence, owner-only rules and fail-closed behavior; do not simultaneously rewrite the production read API.
- Follow Microsoft's documented intermediate-process module-loading guidance; the historical root cause remains unconfirmed despite preview.8 passing the Windows privacy preflight. Add a fixed command-not-found category and correct the exception-wrapper fixture without changing outer-exception precedence.
- Preview.8 local validation passed (853 passes, 15 skips, no failures); exact Windows privacy checks passed, but full Windows CLI had two failures. CI and verified artifact details are recorded in development progress; this candidate remains unaccepted.
- Preserve the known bootstrap claim/cancel race and unsafe existing-recovery-directory limitation. Managed-web authentication remains paused.

## 0.20.3-preview.7 — Unreleased candidate

- Require validation/upload of six allowlisted synthetic UI PNGs after successful desktop runs on Windows, macOS and Linux, including wide/narrow recovery previews. Artifacts identify version/platform/full SHA/attempt and are retained 30 days; missing evidence cannot pass. Production UI is unchanged. Review of all 18 PNGs found Linux Chinese font gaps, a wrong macOS wide recovery capture, and menu captures without an open menu on all platforms; these are not a complete visual pass.

- Persist only modified Windows Owner/DACL sections through direct .NET APIs instead of Set-Acl; preserve owner-only readback, repeated validation and fail-closed behavior. Add fixed exception categories and a validated absolute SystemRoot PowerShell path; no permissive fallback or raw exception disclosure.
- Retry only background metadata replacement with bounded delays; never replay commands/output. Guard asynchronous output/state callbacks and retain write-once, fixed-code failure receipts when the main record is unavailable.
- Keep terminal state behind confirmed shutdown/output closure. Use OS-helper paths for Windows cleanup; an unconfirmed foreground stop retains active/unknown evidence and returns an explicit error.
- Preview.6 passed three desktop jobs and Linux/macOS CLI, but Windows privacy preflight failed with nonzero-exit at initialize-write (Set-Acl); full Windows CLI tests were skipped. Preview.5 Windows CLI was cancelled after 35 minutes with nine ACL failures and an outside-cwd background task interrupted after output. Neither candidate is accepted; the exact underlying historical errno/root cause is unproven.
- Preview.7 CI 36983872073 passed five jobs but failed Windows privacy preflight after successful .NET directory persistence, at Get-Acl verify-read (unknown). Full Windows CLI tests were skipped; package/platform/eval checks passed. Verified binaries remain unaccepted. Preview.3 is the last fully green candidate; real OS IME, paid Providers and external devices remain separate acceptance work. Paused managed-web authentication is outside this change.

## 0.20.3-preview.6 — Unreleased candidate

- Add a required Windows provider-privacy preflight and fixed, secret-free ACL failure stages/process categories. Preserve owner-only checks; typed PowerShell constructors/enums and suppressed progress output need exact Windows validation.
- Bound disposable CLI test shutdown and stop children before deleting their working directory; do not hide failed prompts or cleanup.
- Keep visible macOS smoke windows larger than the runner screen when needed, retaining exact viewport and native keyboard assertions.
- Preview.4 Windows CLI timed out with nine earlier ACL-check failures; preview.5 inherited that code. These candidates remain unaccepted for real channel configuration.

## 0.20.3-preview.5 — Unreleased candidate

- Give keyboard smoke a visible, focused BrowserWindow/WebContents and require an actual textarea focusin before exercising IME cleanup and native Shift+Enter. Preserve assertions and deadlines; production input logic is unchanged.
- Add deterministic focus readiness tests, per-path cleanup diagnostics and strictly scoped hidden-path diagnostic artifact upload.
- Preview.4 generated a verified unsigned installer but failed all three desktop UI jobs; exact candidate verification is required again.

## 0.20.3-preview.4 — Unreleased candidate

- Add a shared-runtime desktop Execute/Plan switch with idle/context guards, Full Access precedence, session-mode preservation and failure-safe logging/conversation boundaries.
- Prevent IME candidate-confirmation Enter and same-tick duplicate events from submitting tasks or steering messages.
- Protect provider schema upgrades with verified private backups, revision/transaction locks and explicit recovery in CLI and desktop, including malformed-startup diagnostics, native/typed confirmation and restart latches.
- Validate private Windows ACLs and preserve credentials/backups after uncertain writes; unknown recovery lock ownership remains blocked.
- Exact candidate CI, real Windows ACLs and synthetic Electron UI checks remain required; real OS IME and paid Provider acceptance are separate.

## 0.20.3-preview.3 — Unreleased candidate

- Resolve development worker loaders from the installation rather than caller working directory, preserve final pipe output before completion, and record bounded startup/spawn failures. Retain the immediate-launcher-exit regression and its existing deadline. Exact Windows CI verification remains required; no original root-cause claim yet.
- Update direct Undici to 7.29.1 and the Cheerio transitive copy to 6.29.0. Keep runtime dependency audit and full regressions separate from product/security acceptance.
- Preview.2 passed all three desktop jobs, including unsigned Windows installer lifecycle checks, but one Windows CLI background survival regression failed. Candidate remains unaccepted.

## 0.20.3-preview.2 — Unreleased candidate

- Make desktop UI smoke wait through rendering frames after viewport changes, preserving every assertion and timeout. Add deterministic ordering/late-size regressions and bounded layout/menu failure diagnostics.
- Preview.1 passed all three CLI jobs and macOS desktop, but Windows/Linux UI smoke failed. Its Windows installer checks passed; it remains an unaccepted candidate. Preview.2 requires a fresh exact-commit CI run and packages.
- No production UI behavior, permission policy, or dependency versions changed in this follow-up.

## 0.20.3-preview.1 — Unreleased candidate

Implementation and integrated verification are in progress. This entry describes the phase scope, not a passed release gate or an npm publication. Per-check status and the eventual exact commit/CI evidence are tracked in `docs/development-progress.md`.

- Reject completion with an unfinished executable plan using `failed / plan_incomplete`; preserve planning-only completion in read-only Plan mode.
- Refresh the shared project index at task boundaries and bound external-change rechecks to a five-second interval, including ctime changes while reusing unchanged ASTs.
- Require structured program-generated artifact verification for multi-agent integration; plain-text PASS is insufficient. The current read-only Tester checks `verify_output` assertions over the patch, not an executable test-suite result.
- Add Python migration and Electron browser-policy CI gates, with exact-commit CLI tarball and unsigned Windows x64 NSIS candidates, SHA-256 manifests, and per-job verification records. Failed or missing checks remain visible; later pushes do not cancel earlier runs.
- Keep workspace trust, explicit ephemeral Full Access consent, Plan read-only enforcement, independent integration confirmation, and unknown-side-effect recovery guards unchanged.

## 0.20.2 — 2026-10-02

- Replace fixed inspector buttons with selectively opened, closable tool tabs and split/full view. Share keyboard-accessible dropdown menus, align empty-state typography and show compact expandable process/tool/source/evidence rows. Add an isolated, human-operated ephemeral HTTPS web tab (no login submission/downloads/task bridge), plus real Electron offline browser-policy/lifecycle coverage.

- Polish inspector tabs and Diff controls: keep labels horizontal, keep split pane widths consistent across tool tabs, scroll only the tab list while add/refresh/full-view controls remain visible, style round/search inputs, preserve conversation width on narrow layouts, localize review warnings, inset Diff empty-state text from the divider, and tighten categorized-data spacing. Add wide/narrow visual-layout regressions.
- Add an independent desktop Diff workbench with a searchable file tree, bounded insertion/deletion counts, line numbers, and saved execution-round selection; missing historical snapshots never substitute current workspace changes.
- Wire the shared multi-agent coordinator into desktop tasks, with real child-task cards, elapsed time and bounded redacted results. Parent stop/exit cancels and drains children; Worktree integration retains independent confirmation and review evidence.
- Separate background processes, tools, task artifacts, read sources and verification evidence. Enable the shared background tools using a separately unpacked Node worker, not the interactive PTY.
- Resolve installed Node/npm for Electron MCP and background workers instead of launching Electron as Node. Add a backup-first user-PATH repair helper without modifying system PATH or user MCP configuration/grants.

- Fix native MCP button borders and modal/titlebar alignment; simplify desktop MCP copy. Add explicitly confirmed, ephemeral desktop Full Access (including dangerous task-tool approval, external files and local diagnostics), preserving Plan/trust/credentials/MCP grants/recovery guards and keeping external source out of workspace checkpoints and task Diff. Approve for me uses risk classification, not a reviewer model or OS sandbox.

- Start ordinary fresh installations with zero Providers in both CLI and desktop, even when environment keys exist. Vendor templates no longer register or reserve channel IDs.
- Migrate explicitly referenced legacy presets into editable user profiles, retaining credential references, model selections and routing; do not seed unused presets or clear existing user settings.
- Keep all user-added channels visible, add multi-vendor templates to both setup flows, support confirmed removal of the last channel, and block tasks until a channel is selected.
- Document actual CLI/desktop capability differences and prioritize shared services and paired entrypoint regressions.
- Share MCP manager composition between CLI and desktop. Add desktop configured-server connection, exact manifest confirmation, reconnect/disconnect and lifecycle cleanup.
- Add desktop basic user MCP configuration creation/editing/confirmed deletion, OAuth origin/scope confirmation, browser fallback/cancellation/logout, and bounded redacted read-only Resource/Prompt browsing. Keep project/advanced/explicit-permission configurations read-only, separate saving from grants/connections, and keep external content out of task instructions and audit records.
- Bind MCP permission confirmation to the previewed configuration fingerprint in both frontends, remove stale tools after failed reload, and inject MCP client metadata into the Electron bundle.

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
