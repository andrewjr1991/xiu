# Xiu

Version 0.16.4 extends the read-only update doctor with exact official release-metadata verification. It queries the installed `@xiu-ai/cli` version on the official npm Registry, requires an exact package and version match, accepts only credential-free HTTPS tarballs hosted by `registry.npmjs.org`, and validates the canonical SHA-512 SRI value. It does not download the package or hash local installation files, so it never overclaims byte-for-byte local integrity. Registry or metadata failures remain external warnings, and ordinary startup performs no additional network request.

Version 0.16.3 extends the read-only update doctor with installation-path and version-conflict diagnostics. It reports the currently running package, the first `xiu` launcher resolved from PATH, distinct duplicate installations, stale or broken shims, and an explicit npm prefix whose command directory is missing from PATH. npm-generated `.ps1` and `.cmd` shims that point to the same package are grouped as one installation. These findings are warnings rather than automatic repairs: Xiu never rewrites PATH, changes npm prefix, removes shims, or modifies a global installation, and ordinary startup performs no PATH scan.

Version 0.16.2 adds read-only distribution and update diagnostics. Run `xiu --update-doctor` or `/update doctor` to inspect the Node.js runtime, required package files, isolated update proxy, update cache, and official npm Registry connectivity. Local installation failures are separated from external network warnings; only hard local failures make the one-shot command exit nonzero. The diagnostic never runs npm, repairs files, installs packages, or changes global configuration, and ordinary startup still performs no update-network request.

Version 0.16.1 adds opt-in, cached, non-blocking update reminders. Reminders are disabled by default and can be controlled with `/update notifications on`, `/update notifications off`, and `/update status`. When enabled, Xiu reuses a 24-hour cache of public npm version metadata, refreshes stale data only after the interactive UI is ready, and displays an available update only at a safe input boundary. Failures stay silent, and Xiu still never installs, downgrades, or changes global npm automatically.

Version 0.16.0 adds explicit, read-only update diagnostics. Run `xiu --check-update` or `/update` to compare the local version with `@xiu-ai/cli@latest` on the official npm Registry and receive the exact upgrade command when needed. Xiu never performs the upgrade itself, never reads npm credentials, and ordinary startup performs no version-check network request. Update checks use a dedicated proxy path that is isolated from model providers and web search.

中文用户手册请参阅 [Xiu 完整使用指南](./USAGE.zh-CN.md)。维护者请参阅 [Xiu 更新、发布与安装指南](./PUBLISHING.zh-CN.md)。长期产品和工程规划记录在 [Xiu 路线图](./ROADMAP.zh-CN.md)，跨版本安全边界记录在 [安全与隐私边界](./SECURITY.zh-CN.md)。当前开发版本只保留一份 [v0.16.4 设计](./V0.16.4_DESIGN.zh-CN.md)。

Xiu is an open-source autonomous coding agent for the terminal, developed by 静然. Give it an outcome; it inspects the repository, reads and edits files, runs commands, checks the diff, and iterates until the model reports completion.

Version 0.15.0 introduces native read-only web research. `/web configure` enables Tavily, Brave Search, or a trusted HTTPS SearXNG instance, then exposes bounded `web_search` and `web_open` tools with exact source URLs. External pages remain untrusted data: Xiu rejects non-HTTPS URLs, embedded credentials, localhost and private-network targets, revalidates redirects, strips active HTML, enforces optional domain policies, and applies bounded timeout, cancellation, and safe retry boundaries. Web research uses its own optional proxy instead of inheriting the active model Provider proxy. Use `/web proxy set [URL]`, `/web proxy clear`, and `/web proxy` to persist, clear, and inspect it immediately; `XIU_WEB_PROXY` remains an optional startup default for managed search. Tavily and Brave credentials, plus an optional private SearXNG bearer token, are referenced by environment-variable name and are never stored in Xiu settings. Authenticated requests cannot redirect credentials to another origin. Login, account, and write operations remain outside these tools and must use an explicitly authorized MCP/OAuth integration.

Version 0.15.1 adds an internal-beta managed SearXNG preset. New and existing users need no shared secret or environment-variable setup: the first search lazily registers a revocable installation credential, stores it in Windows Credential Manager when available, obtains a 15-minute access token, and refreshes that token in memory. No shared token is bundled in npm, registration does not delay startup, and explicit `/web configure` or `/web disable` settings always take precedence. The bundled `scripts/install-xiu-search-auth-vps.sh` deploys the corresponding device gateway with public-registration quotas, per-device and per-IP search limits, local-only administration, revocation, and a migration bridge that accepts only the SHA-256 digest of the previous shared token.

Version 0.15.3 hardens current-information research. Managed device registration, token issuance, `web_search`, and `web_open` share one web-specific optional proxy without coupling search networking to the active model Provider. Legacy beta configurations referencing a removed `XIU_SEARXNG_TOKEN` automatically migrate to device enrollment on the first search. On Windows with a compatible Node.js runtime, web requests combine Node's bundled roots with the native Windows trust store so enterprise TLS inspection works without disabling certificate verification. Deterministic enrollment, credential, and certificate failures stop after the first failed search instead of consuming repeated model/tool calls. If every search attempt fails or returns no usable result, Xiu suppresses unsupported “latest” claims, reports the sanitized transport failure, and marks the task failed. For latest, recent, current, today, or explicitly time-bounded research, search snippets alone no longer satisfy completion: Xiu requires the model to open every cited URL and rejects final citations that were not successfully opened. Execution reports now use “verified” only when an explicit verification operation succeeded.

Version 0.15.4 adds explicit managed-search diagnostics and recovery. `/web status` inspects configuration and local credential storage without network access, `/web doctor` checks the managed gateway and authentication path on demand, and `/web reset` removes only the local managed device credential after confirmation so the next search can enroll again. Status and diagnostics never print device secrets or short-lived tokens, reset refuses to weaken an unavailable system credential backend, and ordinary startup remains network-free.

Version 0.15.5 makes web evidence easier to audit. Search results now canonicalize HTTPS source URLs, remove common tracking parameters and duplicate URLs, bound provider-supplied text, and assign a stable `WEB-xxxxxxxx` source ID that is repeated by `web_open`. Each search reports unique-source, domain-diversity, provider-date, and duplicate-removal coverage without claiming that a result is true or verified. Search snippets remain discovery-only. Time-sensitive answers must pass the exact-URL open gate. When dates are requested, Xiu preserves a verifiable publication or event date exposed by the opened source; if the source provides no verifiable date, Xiu deterministically labels that item `Date: Unknown` instead of asking the model to fill one. The requested date window guides search and ranking rather than hard-failing truthful older or undated evidence: if too few in-range sources survive, Xiu may return older opened sources with their real dates and a clear fallback note, but never invents dates or fills from memory. Discovery is bounded to three searches. Each inaccessible page is tried once; the failed-open limit is six when no evidence survives and four after at least one source has opened successfully. Finalization receives an exact URL allowlist and may cite only those opened sources. If a mixed final answer still contains an unsupported URL, Xiu removes that URL's complete result block and returns the remaining verified items; unsafe-to-prune answers, further tool calls, or insufficient surviving evidence still fail immediately.

Version 0.14.3 closes the plugin supply-chain boundary. Stage D1 records a deterministic SHA-256 digest for every installed package, pins HTTPS Git installs to the exact resolved commit, and rechecks installed content during discovery. Stage D2 verifies optional detached Ed25519 signatures over that package digest and manages trusted publisher fingerprints with explicit `/plugin publisher` commands. Invalid signatures fail closed; unsigned and merely trusted-signer packages still require an exact local `/plugin approve`, so publisher identity never bypasses permissions, workspace trust, Plan mode, or tool approval.

Version 0.14.2 completes the recoverable plugin lifecycle. Xiu can install declarative plugins from a trusted local path or credential-free HTTPS Git URL, preview version and permission changes before an update, disable without deleting data, recoverably uninstall, and roll back to the latest retained package. Remote repositories are shallow-cloned without a worktree and only regular Git blobs are materialized; links, submodules, oversized packages, plugin JavaScript, hooks, installers, and binary entrypoints are never run. Every changed package still requires exact `/plugin approve` authorization before its Provider, MCP, Skill, or workflow contributions activate.

Version 0.8 starts Xiu's large-project intelligence work with a reliability-first context engine. Compaction now creates a structured checkpoint while deterministically preserving the authoritative primary goal, additive steering, and current plan. The next model resumes from recorded evidence and the next action instead of restarting discovery. Large text files are read in bounded line pages, while minified or giant single-line HTML/JSON can be paged by character offset with explicit continuation hints. It retains the professional terminal UI, multi-agent, MCP, planning, checkpoint, resumable-session, multimodal, and Skill systems from earlier releases.

Version 0.8.1 recognizes successful project-specific verifier scripts such as `verify_output.py`, `check-result.js`, and `output_validate.py` as completion evidence. Failed checks still cannot pass the completion gate. While a task runs, the input area now keeps a visible progress summary with completed/current/pending steps, the current and next action, and the latest changed file. `Ctrl+O` switches that summary to detailed tool activity.

Version 0.8.2 uses unambiguous `√`, `→`, and `○` progress symbols, surfaces concise model phase updates during long tasks, and keeps hidden tool logs hidden when a task ends. Its completion gate includes deterministic `verify_output` checks for generated HTML, JSON, Markdown, and CSV artifacts; a zero exit code containing explicit failure evidence is not accepted as a pass. It also recognizes Agnes 2.5 Flash's official 512K context window, compacts automatically at a model-aware 80% threshold, preserves recent user requirements verbatim beside the structured checkpoint, and estimates Chinese context more conservatively.

Version 0.8.3 makes successful file changes permanent terminal output instead of transient footer state. Each change card identifies created, modified, or deleted files, shows bounded `+added/-removed` line counts and a short colored preview, and falls back to byte-size summaries for large or binary files. The live input is safely redrawn after each card, and pending cards are flushed before the final answer.

Version 0.8.4 adds clipboard attachments. On Windows, `Ctrl+V` can import a clipboard screenshot as PNG or copied Explorer files into the trusted workspace and insert `@.xiu/attachments/...` references at the cursor; ordinary text remains ordinary pasted text. `/paste` provides a fallback when the terminal intercepts the shortcut. Attachments are bounded by count and size, directories and symbolic links are rejected, and pasted files are never executed automatically.

Version 0.8.5 refines the terminal conversation experience. Final responses render common Markdown, transient working prompts no longer leak into scrollback, each turn has a clear Xiu response and completion receipt, file cards show compact key hunks, important execution and verification actions remain visible, and the startup dashboard reserves safe terminal width for Chinese text. `/language` persists Simplified Chinese or English in `~/.xiu/settings.json`; the selected language governs the UI, plans, progress narration, visible reasoning summaries, and model answers while leaving code, paths, commands, and tool names unchanged.

Version 0.8.6 makes that language and identity contract deterministic. Built-in activity descriptions, retries, checkpoints, plans, and multi-agent status no longer leak English labels in Chinese mode. `/language` now switches the live UI, active progress view, command palette, and next model request immediately without restarting; prior scrollback remains unchanged. Blocking model questions become a highlighted “Xiu 需要你的回答” state followed by a `请回答> ` prompt. ASCII-compatible `xiu> ` and `补充> ` prompts avoid missing-glyph squares on Windows terminals. Explicit identity questions are guarded at runtime, so the underlying provider cannot rename Xiu or attribute it to Sapiens AI: Xiu is developed by 静然.

Version 0.8.7 fixes Windows cancellation at the terminal-input boundary. Both parsed Ctrl+C events and the raw `0x03` byte emitted by some PowerShell/ConPTY combinations cancel the active model or tool call and immediately show a cancelling state. Text and Explorer files can still use terminal right-click paste; clipboard bitmap images use `Ctrl+V` or `/paste`, because Windows Terminal does not send image bytes or a paste event to a character-stream CLI on right-click. The startup panel uses connected box-drawing characters, a dedicated session divider, and absolute terminal-column positioning for mixed-language right borders.

Version 0.9.0 introduces reliable direct process execution. Xiu now prefers a native `program + args[]` tool for Node, Python, Git, npm, JSON, regex, inline code, and paths with spaces, so arguments do not pass through PowerShell quoting or interpolation. PowerShell remains available for cmdlets, variables, pipelines, and redirection; failed inline-interpreter or parser commands explain how to retry with direct arguments. Shell wrappers and workspace-escaping executable paths are rejected before approval.

Version 0.9.1 makes clipboard attachments available from terminal right-click in supported Windows terminals. While an interactive Xiu input is active, right-click reads the clipboard through the same bounded attachment path as `Ctrl+V`, so text, screenshots, and copied Explorer files can be inserted at the cursor. Mouse reporting is disabled as soon as the prompt ends; `Ctrl+V` and `/paste` remain compatible fallbacks for terminals that intercept right-click. Use Shift+drag when selecting terminal text while the Xiu prompt is active.

Version 0.9.2 fixes Node.js splitting SGR mouse reports into separate keypress events. Xiu now reassembles fragmented press and release sequences before they reach the editor, preventing coordinate tails such as `2;51;21M` from appearing as text while preserving one right-click clipboard import.

Version 0.9.3 removes the compiled clipboard helper dependency for text and copied files. On Windows, Xiu first uses the built-in PowerShell `Get-Clipboard` cmdlet and a temporary UTF-8 JSON response; enterprise application control no longer needs to permit a Xiu-generated EXE for these clipboard formats. A bitmap still requires an API capable of saving pixels, so the optional helper is attempted only for images. If no permitted backend is available, Xiu leaves terminal right-click untouched instead of swallowing native text paste.

Version 0.9.4 always leaves right-click to the terminal host. Xiu no longer enables mouse reporting for clipboard paste, so Windows Terminal and PowerShell retain their native text and Explorer-path paste behavior even when enterprise policy blocks programmatic clipboard APIs. `Ctrl+V` and `/paste` remain enhanced attachment actions; policy failures are concise and never expose PowerShell CLIXML diagnostics or launch the optional helper unless a bitmap was successfully detected.

Version 0.9.5 adds bounded, read-only `extract_html`, `extract_json`, and `extract_csv` tools. Xiu can query CSS-selected HTML records, RFC 6901 JSON Pointer values, and filtered CSV/TSV rows without repeatedly paging raw files or writing one-off parsing scripts. Every result is valid paginated JSON with explicit counts and continuation offsets; workspace confinement, 50 MB input limits, 60,000-character output limits, BOM/UTF-8/UTF-16/GB18030 decoding, and Plan-mode read-only enforcement remain deterministic.

Version 0.9.6 makes the project index persistent and incremental. A new Xiu process still enumerates allowed workspace files to detect additions and removals, but it reuses cached search terms whenever path, size, and modification time are unchanged; only added or modified files are read again. Cache structure and paths are validated, symbolic links are not followed, corrupt or incompatible indexes rebuild automatically, and `/status` reports full, incremental, or cache-reuse refreshes with elapsed time.

Version 0.9.7 builds a compact Repository Map on that incremental cache. JavaScript, TypeScript, JSX, TSX, MJS, and CJS files are parsed with the official TypeScript AST to index definitions, relative module dependencies, imports, references, direct calls, constructor uses, aliases, and namespace access. New read-only `repository_map`, `find_symbol`, `find_references`, and `find_callers` tools return bounded paginated JSON; same-name definitions require explicit file disambiguation rather than guesswork. Other languages remain visible as modules without fabricated symbol precision.

Version 0.9.8 adds deterministic per-task diagnostics. The live footer and `/diagnostics` distinguish model time, tool time, approval waiting, Token use, retries, failures, slow operations, repeated failure, and lack of new evidence. Diagnostic snapshots are bounded, redact credential-shaped input, persist with project sessions, and mark an unfinished restored task as interrupted. Slow active work and user approval are never mislabeled as stalls, and health warnings only explain evidence and recommend a strategy—they never cancel a task or bypass safety policy.

Version 0.9.9 focuses on long-session stability. Simplified Chinese output is normalized before display while code literals remain unchanged; successful verification enters an explicit final-summary phase; `.agents/skills` is discovered and `/skills` refreshes before opening; Windows selectors accept raw arrow sequences and number keys; long progress wraps instead of disappearing; and workspace changes no longer restart the steering prompt.

Version 0.9.10 replaces the lossy session preview with complete semantic terminal replay. `/resume`, `xiu --resume`, and `/history` now share the normal Markdown, file-change, key-action, question, and completion renderers. Older logs are reconstructed from every saved task and assistant event without the previous 12-message/600-character cap; new sessions persist a versioned semantic turn record so future restoration can reproduce the visible conversation structure without storing ANSI escape bytes.

Version 0.10.0 introduces persistent Provider profiles. Xiu includes OpenAI, Anthropic, Agnes, Ollama, LM Studio, and vLLM presets, plus user-defined OpenAI-compatible endpoints. `/providers` tests and switches profiles without discarding the session; `/provider add|edit|remove|test|key` manages them; `/models` reports the current Provider, declared capabilities, context window, and discovery source. Profile editing keeps existing values and local credentials unless explicitly changed. Connection probing always verifies a minimal text completion and tolerates compatible services without a model-list endpoint. `~/.xiu/providers.json` can store either an environment-variable name or a local plaintext credential. Secret input is hidden, the file is written atomically with owner-only mode where supported, and credential values are redacted from project session logs and UI output.

Version 0.10.1 adds runtime capability verification per Provider and model. Xiu probes text completion, requests one inert structured tool call, and asks the model to identify the pixels of a fixed built-in color image without reading project files. A non-empty reply alone is not enough, so compatible endpoints that silently ignore image input are not marked as vision-capable. Tool probing first uses a forced named function and then falls back to `tool_choice: auto` for thinking models and compatible gateways that reject forced selection. Only the API's structured `tool_calls` field counts as support; textual pseudo calls are never executed. Results are cached for seven days in `~/.xiu/providers.json`; `/provider test` and `/provider capabilities` force a refresh. The same file persists the last interactively selected Provider and model, which take precedence over legacy environment defaults on the next launch; explicit CLI flags still override them. Probe-protocol upgrades automatically invalidate older cached classifications. `/providers`, `/models`, and `/status` show the same supported, unsupported, unknown, or untested state. Unknown and explicitly unsupported tool or vision capabilities are not exposed to the model. Image and video generation remain adapter-declared because probing them would create paid assets.

Version 0.10.2 clarifies live model state in the scrollback-oriented terminal UI. The welcome card is labelled as a startup snapshot, while the live footer always shows `provider/model` and updates immediately after a switch without clearing terminal history.

Version 0.11.0 begins Xiu's resilient Provider-routing work. Each primary Provider can have an ordered fallback chain managed with `/provider fallback`, `add`, `remove`, and `clear`. Xiu retries only transient network, rate-limit, timeout, and server failures; after bounded retries it chooses the first fallback whose cached or declared tool capability and context budget satisfy the active request. A switch is allowed only before any response text has streamed, so Xiu never replays a partially visible answer or repeats completed tool side effects. The same safe boundary covers non-streaming context compaction and each parallel sub-agent. Media generation never fails over across providers: it uses a persistent request ledger and asset cache instead, so identical completed requests are reused, image downloads and video tasks resume safely, and an ambiguous potentially billed submission is never replayed without explicit duplicate-charge approval. Every Provider switch and skipped candidate is visible in the terminal, persisted in the session log, and included in `/diagnostics`.

Version 0.11.1 makes that media recovery state directly operable. `/media` lists the newest project-local image and video requests with stable request IDs, status, Provider/model, task ID, and saved path without exposing signed URLs. Xiu can resume a selected request by ID: it may reuse the cached asset, continue polling the existing video task, or retry the existing download, but this recovery tool has no code path that submits a new billable generation request. Unknown or ambiguous submissions remain blocked, and recovery refuses to cross Provider boundaries.

Version 0.11.2 adds explicit, explainable model routing for the main Agent's planning, implementation, and verification stages. `/routing set <stage>` assigns an existing Provider profile, while `/routing on|off` controls the feature. Xiu switches only before a new model request, rejects targets that lack the required tool capability or safe context budget, prints every switch or skip, records route events in the session and `/diagnostics`, and restores the user's manually selected Provider/model when the task ends. Unassigned stages use the task's original model. This release does not guess model price or quality and does not route billable image/video generation.

The v0.11.2 acceptance hardening also records every planning/implementation/verification call even when no Provider switch occurs, explains stage transitions, distinguishes cumulative request Tokens from current context occupancy, and reports recoverable failures plus tool success rate. Windows npm/npx direct execution avoids `.cmd` `EINVAL` failures, standard project checks prefer `validate_project`, and approval diagnostics distinguish actual prompts from `--yes` and remembered session decisions. Narrow session permissions are available for ordinary workspace writes, exact edits, direct programs, and project verification; dangerous actions remain explicitly confirmed.

Version 0.11.3 adds safe prompt-cache observability and request deduplication without caching Agent answers. OpenAI-compatible usage reports and Anthropic cache creation/read usage feed `/diagnostics`; native OpenAI requests receive a stable hashed prompt-cache key, and Anthropic marks the stable system prompt with an ephemeral cache boundary. Model discovery is cached briefly and identical concurrent metadata/capability probes are coalesced. Provider settings migrate to a fingerprinted version-2 capability cache, invalidating stale probes after endpoint, proxy, feature, model, authentication, or protocol changes. Tool calls, file changes, approvals, streamed answers, and billable media generation are never locally result-cached or replayed.

Version 0.11.4 adds official Streamable HTTP MCP transport alongside stdio. Remote servers support JSON or SSE responses, protocol sessions, cancellation, clean session termination, environment-backed bearer headers, and the same Xiu risk approvals and Plan-mode boundary as local tools. `/mcp add`, `/mcp remove`, and `/mcp test` manage user-level remote servers without restarting Xiu. Remote endpoints require HTTPS except for loopback development addresses; OAuth remains a later milestone.

Version 0.12.0 adds the complete secure OAuth lifecycle for remote MCP servers. Xiu uses the official MCP client for protected-resource and authorization-server discovery, public clients with PKCE S256, exact issuer/resource binding, pre-registered clients, configured Client ID Metadata Documents, and compatibility DCR. Tokens are stored separately in `~/.xiu/mcp-auth.json`, refreshed before expiry with per-identity single-flight coordination, and never shown by `/mcp auth`. A confirmed `403 insufficient_scope` presents the new scopes for explicit approval and retries that rejected request at most once; ambiguous network failures are never replayed. `/mcp logout` attempts standards-based refresh-token and access-token revocation before clearing local tokens. Login waits are bounded and cancellable with Ctrl+C; Xiu requests the platform URL handler to open the browser and always prints the complete authorization URL as an enterprise-policy fallback. OAuth URLs and redirects use SSRF protections, and diagnostics redact authorization codes, tokens, and secrets. OAuth authentication does not bypass workspace trust, Plan mode, risk approval, checkpoints, or dangerous-action confirmation.

Version 0.12.1 adds read-only MCP Resource and Prompt browsing over both stdio and Streamable HTTP. `/mcp resources`, `/mcp read`, `/mcp prompts`, and `/mcp prompt` use bounded pagination and output limits. Binary payloads are summarized instead of printing Base64, and all remote content is explicitly marked untrusted. Browsing never auto-injects remote content into the Agent or registers a new Agent tool.

Version 0.12.2 adds permission manifests for MCP servers and Skills. Xiu derives the minimum permissions implied by an MCP transport, authentication, risk and workspace-change settings, rejects manifests that under-declare those permissions, and requires explicit approval when a new or changed extension expands its permission set. Skill frontmatter can declare permissions such as `workspace:read` or `network:access`; unknown permissions block installation. Grants are fingerprinted and stored locally in `~/.xiu/extension-permissions.json`, without replacing workspace trust, Plan mode, risk approval, checkpoints, or dangerous-action confirmation. `/mcp permissions` shows each manifest and `/mcp permissions approve [name]` approves the exact current fingerprint. Windows stdio MCP failures now decode UTF-8, UTF-16LE and common GB18030/GBK stderr instead of exposing mojibake.

Version 0.12.3 phase A introduces a typed credential-store boundary for Provider API keys, environment credentials, and MCP OAuth records. It centralizes secret redaction before diagnostics, failover errors, OAuth errors, and session persistence, and invalidates capability-probe work with a non-secret credential revision instead of credential content. `/credentials` reports backend availability and entry counts without displaying keys or tokens. Phase B adds an optional Windows Credential Manager backend powered by `@napi-rs/keyring`; `/credentials probe` performs an explicitly confirmed random canary write/read/delete test and leaves existing credentials untouched. Phase C adds an explicit Provider API-key lifecycle with independently confirmed migration, cleanup, rollback, and forget operations. Phase D adds the same reversible lifecycle for MCP OAuth through `/mcp credentials`: only Access/Refresh/ID tokens and Client Secret are stored as one atomic bounded system record, while large non-secret Scope and registration metadata stay in `mcp-auth.json`. Refresh rotation updates that atomic secret record; logout clears active system and retained legacy copies. Migration never deletes plaintext, cleanup requires typing the full MCP name, a system reference never silently falls back, and rollback can restore a cleaned compatibility copy from the active system credential.

`@xiu-ai/cli@0.13.0` is published on the official npm registry. The Windows Credential Manager backend remains opt-in while Windows ARM64 and additional enterprise-policy environments complete compatibility validation.

Version 0.13.0 adds a privacy-preserving security audit ledger. `/audit`, `/audit approvals`, and `/audit credentials` show recent local approval and credential-lifecycle facts without storing command text, prompts, file contents, full workspace paths, or credentials. Version 0.13.1 adds versioned task-run journals, explicit interrupted-task recovery, and programmatic blocking of automatic side-effect replay.

Version 0.13.2 unifies retry classification and replay safety across model, tool, MCP, and media operations. Authentication, authorization, invalid requests, cancellation, streamed responses, completed effects, and unknown commit outcomes are never silently retried. Rate limits, timeouts, transport failures, and 5xx responses recover only within a bounded attempt budget and only for explicitly safe or idempotent work. MCP calls inherit replay safety from their configured risk; media submissions remain non-replayable while status polling and existing-asset downloads may recover safely.

Version 0.13.3 adds opt-in task budgets for cumulative Tokens, model calls, tool calls, failures, and elapsed wall time. Warnings appear before a configured limit; exhaustion pauses only between operations, writes a recoverable task-run record, and never reports completion. `/diagnostics` and the live footer share the same budget snapshot. User answers, approval waits, bounded retry backoff, and background waits are explicit states and are not classified as stalls.

Version 0.13.4 replaces process-local background commands with detached, workspace-isolated jobs. `/background start`, `list`, `read`, and `cancel` provide stable job IDs, persisted state, incremental output cursors, exit evidence, and explicit cancellation after the original terminal has closed. Starting a job remains an explicit, risk-aware user action; Xiu shutdown no longer cancels it. A long autonomous task can be launched as a background command such as `xiu -y --budget-seconds 1800 "<task>"`; operations that still require interactive approval are not silently authorized and remain recoverable through the normal task journal.

Version 0.13.5 adds bounded execution reports assembled from durable task-run events, exact terminal replay records, diagnostics, validation operations, and workspace-scoped security audit facts. Consecutive retry/continuation runs for the same original goal are folded into one task-chain report, preserving the original user goal and cumulative file evidence. `/report` previews a redacted summary without writing files. `/report export <markdown|json> <workspace-path> <summary|details>` requires the user to choose both the destination and content scope; `details` adds only a small redacted file preview. Reports never include model chain-of-thought, credentials, raw prompts, complete source files, or audit subjects.

Version 0.13.6 is a security hardening release. One-shot commands can no longer bypass first-use workspace trust, and project instructions, project Skills, and project MCP configuration stay unloaded until trust is confirmed. Workspace file access now verifies real filesystem containment and rejects symlink, junction, reparse-point, absolute-glob, and parent-traversal escapes. Every new MCP permission manifest requires explicit first-use approval. Multi-agent cancellation and retry are classified as side-effecting execute operations, session logs use owner-only permissions where supported, and common GitHub, Slack, AWS, private-key, Provider, and OAuth secrets are redacted before persistence.

Version 0.13.7 fixes first-run Provider setup. Fresh installs with no API key remain in interactive setup mode instead of exiting: users can enter the current Provider key, choose another Provider, or configure later with `/provider key` and `/providers`. One-shot tasks without credentials fail with a concise setup instruction instead of a stack trace.

Version 0.13.8 adds gated multi-agent integration. Reviewer and Tester tasks inspect the implementation Worktree read-only and must finish with `VERDICT: PASS`; Xiu then checks overlapping files, symbols, dependency manifests, the Git patch, and dirty main-workspace files before asking for explicit integration confirmation. Conflicts preserve the main workspace, patch, run record, and Worktree. The running-task editor now absorbs blank Enter/key-repeat events instead of recreating empty steering prompts, and read-only Git commands against Agent Worktrees no longer invalidate already-passed verification.

The credential-hardening security gate redacts active Provider and OAuth credential values from model, media, MCP startup/tool/resource/prompt, refresh, logout, diagnostics, failover, and session error paths before truncation or persistence. Regression tests cover opaque canaries, interrupted migration recovery, corrupted system credentials, retained recovery copies, concurrent writes, package contents, and isolated installation. Windows Credential Manager remains opt-in until the external enterprise-policy, Windows ARM64, and real OAuth migration matrix is completed.

## Features

- Persistent OpenAI, Anthropic, Agnes, Ollama, LM Studio, vLLM, and custom OpenAI-compatible Provider profiles
- Interactive `/providers` management, connection testing, model discovery, per-model capability probing, and session-aware switching
- Streaming text and tool-call assembly for OpenAI-compatible and Anthropic providers
- Live task plans with persistent step status and a read-only planning mode
- Session-scoped changed-file summaries, Git diffs, file checkpoints, and confirmed restore
- Automatic retry for transient model failures before output begins
- Ordered, capability-aware Provider failover at side-effect-safe request boundaries
- Explainable planning, implementation, and verification routing across configured Provider profiles
- Structured context-checkpoint compaction that preserves the active task contract and continuation state
- Bounded line and character paging for large, minified, or single-line text files
- Bounded structured extraction for CSS-selected HTML, JSON Pointer values, and filtered CSV/TSV rows
- Incremental Repository Map plus JavaScript/TypeScript symbol, reference, dependency, and caller navigation
- Persisted per-task diagnostics for Token use, model/tool latency, approvals, failures, retries, and explainable stall signals
- Cross-compaction tool evidence ledger plus bounded model-context tool results with complete session logs
- UTF-8 Python child-process output on Windows PowerShell
- Native argument-array process execution without PowerShell re-parsing
- Repeated tool-failure detection and error attribution
- Persistent live task progress with checked steps, current/next actions, and recent file changes
- Adaptive startup dashboard with quick-start tips, model, approval, workspace, and skill count
- Compact prompt footer with model, context usage, plan mode, skill count, and workspace
- Xiu-native project/global skills with Claude-compatible discovery and on-demand loading
- Safe local or HTTPS Git skill installation with limits, symlink rejection, and recoverable replacement backups
- Stdio and Streamable HTTP MCP clients with user/project configuration, tool discovery, live reload, cancellation, and clean shutdown
- Namespaced MCP tools governed by the same read/write/execute/dangerous approvals and Plan-mode boundary
- Provider-aware capability routing for text, vision, image generation, and video generation
- Agnes Image 2.1 Flash text-to-image, image-to-image, and multi-image composition
- Agnes Video V2.0 text-to-video, image-to-video, keyframes, progress polling, and MP4 download
- Repository-aware system prompt with `AGENTS.md`, `XIU.md`, and `CLAUDE.md` support
- Risk-aware tools for files, structured patches, project detection, verification, shell commands, and native Git inspection
- Workspace path confinement to prevent file tools escaping the selected directory
- Four-level permission policy: read, write, execute, and dangerous
- Read-only operations run automatically; dangerous commands always require explicit approval
- Structured `apply_patch` previews before focused file edits
- Ctrl+C cancellation for active model and command work, plus clear command timeouts
- Detached background commands with persisted state, incremental logs, cross-terminal discovery, and explicit cancellation
- Completion gate that requests verification after workspace changes
- Tool loop with a configurable turn limit
- Resumable, project-isolated JSONL sessions under `.xiu/sessions/`
- Manual and automatic context compaction for long-running tasks
- Project file index with automatic relevant-code retrieval
- Automatic technology-stack, package-manager, test, lint, typecheck, and build detection
- Token, elapsed-time, model-call, tool-call, context, and compaction statistics
- Unit tests for workspace confinement, approvals, safe edits, and the agent loop
- Explorer, Implementer, Reviewer, and Tester specialist roles with independent context and budgets
- Dependency-aware scheduling with up to eight concurrent agents (three by default)
- Read-only shared-workspace agents that cannot access write, execute, dangerous, or dynamic-risk tools
- Git Worktree isolation for implementation agents, with Diff preview and `git apply --check` integration
- Persisted multi-agent state, interrupted-task recovery, individual cancellation/retry, elapsed time, and Token statistics
- Multiline input with `Ctrl+J`, Unicode-safe cursor editing, Home/End, Delete, and Backspace
- Project-index-backed `@path` completion plus `Ctrl+R` reverse history search
- Native terminal right-click for text/paths plus Windows clipboard attachments through `Ctrl+V` or `/paste`
- Persistent `/language` selection for localized UI, progress, plans, and model responses
- Per-project draft recovery under `.xiu/draft.json` and responsive terminal Resize reflow
- Direction-key approval menus that default to deny
- Versioned `xiu.plugin-policy.json` team policy that can require signatures, allowlist exact sources/publishers, and deny permissions without granting local trust or approval
- Bounded tool/Agent summaries with full output available through `/details`
- Responsive status footer with current plan phase, agents, MCP tools, background tasks, and context
- Editable transient `补充> ` / `steer> ` prompt that steers the active goal without polluting terminal history
- Live current Turn, elapsed-time, tool activity, and `Ctrl+O` expanded progress
- Explicit `/queue <task>` scheduling plus immediate `/queue`, `/clear-queue`, `/cancel`, and `/exit` controls
- Successful-call cycle detection that stops stagnant repeated reads/searches without relying on an arbitrary turn cap
- Explicit completed, unverified, failed, and cancelled outcomes with failure-paused scheduling

## Install

Requires Node.js 20.18.1 or newer.

```bash
npm install
npm run build
npm link
```

Set one provider key:

```bash
# PowerShell
$env:OPENAI_API_KEY = "..."
# or
$env:ANTHROPIC_API_KEY = "..."
```

For Agnes 2.5 Flash:

```bash
# PowerShell
$env:AGNES_API_KEY = "..."
$env:AGNES_PROXY = "http://127.0.0.1:12334" # only when a proxy is required
```

## Use

Run against the current repository:

```bash
xiu "Find the cause of the failing login test, fix it, and run the tests"
```

Start a persistent interactive session (conversation context is retained between prompts):

```bash
xiu
```

Interactive commands include `/history`, `/compact`, `/models`, `/plugins`, `/skills`, `/mcp`, `/plan`, `/agents`, `/tasks`, `/diff`, `/diagnostics`, `/status`, `/update`, `/update doctor`, `/queue`, `/cancel`, `/clear`, `/help`, and `/exit`. Supplying a task on the command line keeps the one-shot behavior for scripts and automation.

Open an interactive picker for saved sessions in the current project after closing the terminal:

```bash
xiu --resume
```

Inside Xiu, `/resume` opens the same picker. It shows each session's first task, last update, model, and ID; use Up/Down, number keys, and Enter to choose. After restoration, Xiu replays the complete saved conversation using the same terminal formatting as the original interaction. `/history` uses the same renderer. Legacy sessions from `.forge/sessions/` and `.forge_sessions/` are also discovered during the Xiu rename transition; their visible conversation is reconstructed from all available events.

List session IDs or resume a specific one:

```bash
xiu --list-sessions
xiu --resume 2026-08-05T12-00-00-000Z-ab12cd34
```

Sessions are stored inside each project's `.xiu/sessions/` directory, so histories from different projects cannot be selected by `--resume`.

Interactive session commands:

```text
/history           recent conversation history
/resume            choose and restore a project session
/history sessions  resumable sessions in this project
/compact [focus]   compact context and optionally name what to preserve
/plan               show task plan and plan-mode state
/plan on|off        toggle read-only plan mode
/tasks              show live task statuses
/diff               show session-touched files and Git diff
/checkpoints        list file restore points
/rewind             select and restore a file checkpoint
/models             discover and choose a model with Up/Down and Enter
/language           persist Simplified Chinese or English UI and model output
/paste              import clipboard text, image, or copied files
/plugins            inventory plugin manifests and activation state
/plugins reload     rescan and reload approved declarative contributions
/plugin inspect ID  inspect compatibility, permissions, contributions, and problems
/plugin approve ID  approve the exact current manifest and load JSON/Markdown contributions
/plugin install SRC install from a trusted local path or credential-free HTTPS Git URL
/plugin update ID   preview permissions and atomically update with a recoverable backup
/plugin enable ID   enable an installed plugin without expanding its permissions
/plugin disable ID  disable a plugin without deleting its package or user data
/plugin uninstall ID recoverably uninstall a plugin package
/plugin recover ID [global|project] restore the latest retained plugin backup
/skills             browse installed skills
/skills install ... install from a local path or HTTPS Git repository
/mcp                show MCP server connections and tool counts
/mcp add [name] [url] [TOKEN_ENV]  add a user-level Streamable HTTP server
/mcp remove [name]  remove a user-level MCP server
/mcp test [name]    reconnect and test one or all MCP servers
/mcp reload         reload user and project MCP configuration
/mcp resources|read browse untrusted MCP resources
/mcp prompts|prompt browse untrusted MCP prompts
/mcp permissions    inspect or approve MCP permission manifests
/mcp credentials [status|migrate|cleanup|rollback] [name]  manage MCP OAuth secure storage
/credentials        inspect credential backend status without revealing secrets
/credentials probe  explicitly test Windows Credential Manager with a temporary canary
/credentials migrate [id|--all]  copy, verify, and switch Provider keys to Windows secure storage
/credentials cleanup [id]        separately remove one verified legacy plaintext copy
/credentials rollback [id]       switch back, restoring plaintext from the active system key if needed
/credentials forget [id]         remove every local key copy after confirmation
/agents             show all saved multi-agent runs
/agents <run>       show one run and every specialist task
/agents cancel ...  cancel one task without stopping unrelated agents
/agents retry ...   retry a failed, cancelled, blocked, or interrupted task
/agents integrate ... preview and integrate a completed Worktree task
/details            browse complete tool and Agent activity output
/diagnostics        inspect the current or most recent task diagnosis
/report             preview a bounded, redacted report for the latest task
/report export markdown reports/latest.md summary
/report export json reports/latest.json details
/status             session id, context, tokens, calls, time, and index size
/queue              show explicitly scheduled next tasks
/queue <task>       schedule an independent task to run next
/clear-queue        clear scheduled tasks that have not started
/cancel             cancel the active task; choose what happens next
/clear              start a separate new session
/exit               close Xiu
```

Xiu estimates the active context continuously and compacts it into a continuation checkpoint before the model-aware limit. Agnes 2.5 Flash uses its official 512K window and an automatic 409,600-token threshold (80%), leaving room for output, system instructions, and tools. Unknown models use a clearly labelled 128K fallback until `--context-window` or `XIU_CONTEXT_WINDOW` supplies provider metadata. `--context-limit` remains an optional override capped at 90% of the effective window.

The interactive prompt has a slash-command palette: typing `/` opens all commands immediately, further characters filter the list, Up/Down changes the highlighted command, Tab completes it, and Enter selects it.

The v0.7 editor supports text insertion at the cursor, Left/Right, Ctrl+Left/Right, Home/End, Backspace/Delete, and `Ctrl+J` for a newline while Enter submits. Type `@` plus part of a project path and press Tab to accept a project-index candidate. `Ctrl+R` searches recent inputs. Esc closes a candidate list without erasing the draft. Unsubmitted text is restored after restarting Xiu.

While an Agent is running, a transient `补充> ` / `steer> ` prompt accepts additional requirements without writing a fake prompt into scrollback. A normal submission adds requirements to the active goal and is injected before the next model turn. The primary task remains mandatory, and a steered task receives a final task-contract audit so the model cannot silently finish after answering only the newest request. Use `/queue <task>` only when the text is a genuinely independent task that should run afterward. The footer shows the current Turn, phase, elapsed time, steering count, explicit queue length, and the latest activity; `Ctrl+O` expands or collapses the last eight activities without submitting the draft. Primary tasks have no Turn limit by default and continue until completion, cancellation, a genuine loop, or another explicit failure. `/details` performs the same toggle while working. If Xiu needs a blocking decision, it highlights the question and changes the next prompt to `请回答> ` / `answer> `. If the current task fails, is cancelled, reaches a loop guard, or changes files without passing verification, Xiu pauses and asks whether to stop, retry from existing evidence, or explicitly skip to scheduled tasks. The safe default is stop. Approval still suspends the editor and defaults to deny. Pending scheduled tasks are process-local and do not yet claim crash recovery.

## Multi-agent orchestration

For goals with genuinely independent investigation, implementation, review, or test work, Xiu can create a dependency graph of specialist agents. Each agent receives a bounded task, its own conversation context, an optional explicit turn budget, elapsed-time counter, and Token statistics. Independent tasks run concurrently; dependent tasks start only after their prerequisites complete.

Explorer, Reviewer, and Tester tasks use `shared_readonly` mode by default. Their tool registry contains only tools declared statically read-only, and Plan mode adds a second enforcement boundary. When Reviewer or Tester depends on one implementation, it reads that implementation's Worktree instead of the main workspace. Implementer tasks use `worktree` mode by default. Xiu creates them under `.xiu/worktrees/` on a dedicated `xiu/agent-*` Git branch, so their edits cannot overwrite the main workspace or another agent.

Use `/agents` after or between tasks to inspect persisted runs. A completed implementation is not merged automatically. Xiu or the user must review its Diff and explicitly integrate it:

```text
/agents
/agents <run-id>
/agents integrate <run-id> <task-id>
```

Integration requires completed Reviewer and Tester descendants whose final line is `VERDICT: PASS`. Xiu reports dirty main-workspace files, checks overlapping files, symbols and dependency manifests, saves a bounded patch preview, and runs `git apply --check` again immediately before applying. Conflicts leave the main workspace untouched and preserve the patch, run record, and Worktree. Xiu never automatically deletes Agent Worktrees. After integration, the parent Agent still reviews the merged result and runs normal project verification. If Xiu exits while agents are running, their persisted state becomes `interrupted`; use `/agents retry <run-id> <task-id>` to continue that task.

`/models` asks the active provider for its available model catalog, filters out obvious embedding, speech, image, video, and moderation-only endpoints, and opens a keyboard-driven picker. This works with OpenAI-compatible local gateways as well as cloud providers. If the provider does not implement model listing, Xiu falls back to its built-in default plus the model already active in the session. Model changes are persisted with the resumable session.

## Skills

Xiu discovers reusable workflows from three locations, with project definitions taking precedence over compatible and global definitions of the same name:

```text
<project>/.xiu/skills/<name>/SKILL.md     project
<project>/.agents/skills/<name>/SKILL.md  compatible
<project>/.claude/skills/<name>/SKILL.md compatible
~/.xiu/skills/<name>/SKILL.md            global
~/.agents/skills/<name>/SKILL.md         compatible
```

Only each skill's name and description enter the base prompt. When a workflow matches the task, the agent calls `read_skill` to load the complete `SKILL.md`, keeping startup context small even with many installed skills.

Browse or install skills interactively:

```text
/skills
/skills install D:\\my-skills\\code-review
/skills install https://github.com/example/xiu-skills.git
```

Remote sources must use HTTPS Git URLs. Packages are limited to 20 MB and 1,000 files, symbolic links are rejected, and replacing an existing global skill requires confirmation. The old version is renamed to a timestamped backup instead of being deleted. Skills are executable instructions for the model, so install only packages you trust.

A Skill may declare permissions in its frontmatter, for example `permissions: workspace:read, network:access`. Skills without a declaration retain the compatible `instructions:load` baseline. Installation displays new permissions before making changes; declining an update leaves the existing installation untouched, and unknown permission names block installation. The declaration describes requested capability but never bypasses Xiu's tool approvals.

## MCP servers

Xiu loads stdio and Streamable HTTP MCP servers after the workspace trust check. In interactive mode the prompt becomes usable immediately while enabled servers connect concurrently in the background; the discovered tools are attached atomically when startup completes, without printing over the active editor. An immediate `/mcp` command waits for that startup pass before reporting status. One-shot `xiu <task>` execution still waits for MCP discovery so the first task receives the complete tool set. User configuration lives at `~/.xiu/mcp.json`; a project can add or override servers in `<project>/.xiu/mcp.json`. Project configuration wins when both files contain the same server name, and `"enabled": false` disables an inherited server.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx.cmd",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "OPTIONAL_TOKEN": "${MY_MCP_TOKEN}" },
      "risk": "read",
      "toolRisks": {
        "write_file": "write",
        "edit_file": "write"
      },
      "toolChangesWorkspace": {
        "write_file": true,
        "edit_file": true
      },
      "permissions": ["process:execute", "external:read", "external:write", "workspace:write", "credentials:access"]
    }
  }
}
```

A remote Streamable HTTP server uses one endpoint. Keep credentials in an environment variable rather than the JSON file:

```json
{
  "mcpServers": {
    "docs": {
      "transport": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_MCP_TOKEN}" },
      "risk": "execute",
      "permissions": ["network:access", "external:write", "credentials:access"]
    }
  }
}
```

For OAuth, choose OAuth in `/mcp add`, then run `/mcp login [name]`. Use `/mcp auth [name]` to inspect the issuer, scopes, and expiry without exposing tokens, and `/mcp logout [name]` to revoke and clear authorization. `/mcp credentials` shows storage state; `migrate`, `cleanup`, and `rollback` move one server's secrets through a verified, reversible Windows Credential Manager flow. Large scopes remain non-secret metadata and therefore do not consume the 2400-byte system-secret budget. `/mcp test [name]` never opens a browser implicitly. Plain HTTP is accepted only for `localhost`, `127.0.0.1`, and `::1`. Xiu rejects reserved protocol-header overrides and never prints expanded credentials.

On macOS or Linux, use `npx` instead of `npx.cmd`. Each server supports `command`, optional `args`, `cwd`, `env`, `enabled`, a default `risk`, per-tool `toolRisks`, `changesWorkspace` / `toolChangesWorkspace` hints, and an optional `permissions` manifest. Environment values can reference existing variables as `${NAME}`, so secrets do not need to be committed. Valid risk levels are `read`, `write`, `execute`, and `dangerous`.

The MCP permission vocabulary is `process:execute`, `network:access`, `external:read`, `external:write`, `workspace:write`, and `credentials:access`. Xiu computes the required minimum from the configuration; an explicit list may be stricter but cannot omit an inferred permission. Existing pre-v0.12.2 configurations receive a compatibility baseline on first load. New explicit manifests and later permission expansion remain disconnected until approved with `/mcp permissions approve [name]`. An approval applies only to the exact manifest fingerprint; changing the endpoint, command, authentication, risk, workspace behavior, or permissions requires review again.

Discovered tools are exposed as `mcp__<server>__<tool>` to prevent collisions. The safe default is `execute`, which requires approval; mark a server or tool `read` only when it cannot change files or external state. Tool arguments are shown in the approval preview. Non-read MCP calls are blocked in Plan mode. Ctrl+C cancellation is forwarded to an active MCP request, binary result data is omitted from model context, text output is capped, and child processes are closed when Xiu exits. For one-shot use in a workspace that has never been trusted, user-level MCP servers still load but project-level MCP configuration is skipped.

Use `/mcp` to inspect connection failures and tool counts after launch. Use `/mcp permissions` to inspect permission sources and pending additions. Edit either configuration file and run `/mcp reload` to reconnect without restarting Xiu.

## Real-time execution and planning

Model text appears as it is generated instead of waiting for a full turn. Tool calls are assembled from streamed argument fragments and then pass through the same permission policy as before. A request that fails with a temporary network, rate-limit, or server error before emitting text is retried up to three times with exponential backoff; once text has appeared, Xiu never retries automatically and risk duplicating work.

For multi-step tasks, the agent maintains a visible plan with `pending`, `in_progress`, `completed`, and `blocked` states. Plans are written to the session log and restored by `/resume`. Enable read-only planning when you want investigation and a proposed approach without changes:

```text
/plan on
> Analyze the authentication architecture and propose a migration plan
/tasks
/plan off
```

In plan mode, the Agent boundary blocks every write, execution, and dangerous tool even if `--yes` is active.

Before focused file writes and generated-media outputs, Xiu stores the previous file state under `.xiu/checkpoints/<session>/`. Use `/rewind` to select a checkpoint and explicitly confirm restoration. Shell commands can affect arbitrary external state, so they are included in Git diff inspection but are not advertised as precisely reversible.

On the first interactive launch in a workspace, Xiu asks whether you trust that folder. Trusted workspace paths are stored outside the project in `~/.xiu/trusted-workspaces.json`.

Use the built-in Agnes preset (model and Base URL are selected automatically):

```bash
xiu -p agnes "Inspect this repository and summarize its architecture"
```

You can also pass a proxy for one invocation:

```bash
xiu -p agnes --proxy http://127.0.0.1:12334 "Reply with: connection successful"
```

Or without installing the global command:

```bash
npm run dev -- "Add input validation to the user creation endpoint"
```

Useful options:

```text
-p, --provider <provider>   openai, anthropic, or agnes
-m, --model <model>         model name
-C, --cwd <directory>       workspace directory
--base-url <url>            OpenAI-compatible endpoint
--media-base-url <url>      media generation endpoint
--proxy <url>               HTTP(S) proxy endpoint
--vision-model <model>      image understanding model
--image-model <model>       image generation/editing model
--video-model <model>       video generation model
--unified-model <model>     one model id for every capability
--resume [session]          resume latest or selected project session
--list-sessions             list sessions in this project
--context-window <tokens>   model window override when metadata is unavailable
--context-limit <tokens>    automatic compaction override (maximum: 90% of window)
--max-turns <number>        optional user-selected limit (unlimited by default)
--budget-tokens <number>    cumulative task Token budget
--budget-model-calls <n>    model-call budget, including retries
--budget-tool-calls <n>     completed tool-call budget
--budget-failures <n>       combined model/tool failure budget
--budget-seconds <n>        elapsed wall-time budget, enforced at safe boundaries
--budget-warning-percent <n> warning threshold percentage (default: 80)
--stall-timeout-seconds <n> no-evidence stall threshold (default: 120)
--agent-concurrency <n>     concurrent specialist limit, 1-8 (default: 3)
-y, --yes                   approve writes/execution except dangerous actions
```

Examples:

```bash
xiu -p openai -m gpt-5 -C ../my-app "Fix the build"
xiu -p anthropic -m claude-sonnet-4-20250514 "Review and improve error handling"
xiu --base-url http://localhost:11434/v1 -m my-model "Explain this project"
```

## Multimodal routing

Xiu reads the selected provider's capability profile automatically. No extra model-routing flag is needed for normal use:

```text
OpenAI     selected GPT model -> text + vision
Anthropic  selected Claude model -> text + vision
Agnes      selected text model + dedicated image/video models
```

Only supported tools are shown to the agent. For example, selecting Claude does not silently send an image-generation request to Agnes, and it does not advertise image/video generation APIs that the provider does not expose. New cloud or local providers can add their capability adapter without changing the Agent loop.

With the Agnes preset, Xiu uses these routes by default:

```text
text + vision  agnes-2.5-flash
image          agnes-image-2.1-flash
video          agnes-video-v2.0
```

The agent chooses the route from the requested operation. For example:

```bash
xiu -p agnes --yes "Create a 2K 16:9 hero image for this app and save it as assets/hero.png"
xiu -p agnes --yes "Analyze assets/hero.png, then use its generated URL to make a five-second video at assets/hero.mp4"
```

Override individual capability models when an API account exposes different names:

```bash
xiu -p agnes --vision-model vision-x --image-model image-x --video-model video-x
```

For an adapter whose API really exposes every capability through one model ID, it can be overridden explicitly (currently most useful for Agnes-compatible gateways):

```bash
xiu -p agnes --unified-model agnes-omni
```

The same settings are available as `XIU_VISION_MODEL`, `XIU_IMAGE_MODEL`, `XIU_VIDEO_MODEL`, and `XIU_UNIFIED_MODEL`. These are advanced adapter overrides, not normal requirements for Claude or GPT. `XIU_MEDIA_BASE_URL` can point media operations at a separate gateway. Local reference images are encoded as data URIs; video image inputs must currently be public HTTP(S) URLs as required by the Agnes video API.

Image and video generation requires explicit approval because it may be billable. The approval menu can allow one request or remember that exact media operation family for the current Xiu process; image and video permissions are separate and expire on exit. Xiu records a provider/model/request idempotency key in `.xiu/media-operations.json`: completed requests reuse the cached asset, interrupted image downloads resume from their URL, and video polling/download resumes from the saved task ID. If the initial paid submission has an unknown outcome, Xiu refuses to submit it again automatically; `force_new_generation=true` never inherits a remembered permission and is accepted only after explicit approval of the possible duplicate charge. Media requests are never replayed across Provider failover boundaries.

Video status polling is deliberately rate-limited and absorbs transient 429/503 responses inside the same tool call while preserving the original task ID. A rejected paid submission activates a provider/model cooldown that prompt rewrites cannot bypass, and `force_new_generation=true` is valid only for an exactly matching historical request. Failed or denied tools never produce a green execution receipt; a task whose final operation still failed is reported as incomplete instead of successful with no file changes.

When `--yes` is absent, Xiu asks before writes and project execution. Read-only operations run automatically. With `--yes`, normal writes and execution are approved, but dangerous commands still require explicit confirmation. In a non-interactive process, unapproved actions are denied.

## Architecture

```text
CLI -> Parent Agent -> task graph -> specialist Agents
          |                            |-- shared read-only workspace
          |                            `-- isolated Git Worktrees
       live plan                                |
          |                              reviewed integration
     Tool registry -> filesystem / shell / Git / MCP
          |                 |
     checkpoints       capability router
          |                 |
     JSONL session     vision / image / video
          |
   persisted Agent runs
```

Key extension points are `ModelProvider` and `AgentTool` in `src/types.ts`. A provider translates the common conversation into a model API; a tool publishes JSON Schema and executes against a constrained workspace context.

The project index scans up to 8,000 source and configuration files while ignoring dependencies, build output, coverage, Git metadata, Xiu state, and symbolic links. It stores bounded search terms rather than entire file contents, returns short source excerpts only for the highest-scoring files, and incrementally reuses unchanged entries across Xiu processes. Workspace changes mark the index dirty; the next search refreshes only affected entries. Invalid or unsafe caches rebuild automatically.

## Development

```bash
npm test
npm run typecheck
npm run build
```

## Current limitations

- Shell commands rely on approval and the operating-system account rather than a container sandbox.
- Precise checkpoint restore currently covers Xiu's focused file tools and generated outputs; arbitrary shell-command side effects require Git or project-specific recovery.
- MCP supports stdio, Streamable HTTP, interactive OAuth, and explicit read-only Resource/Prompt browsing. Sampling remains a future extension.
- Session replay is resumable, but deterministic step-by-step replay and branch/fork controls are not yet exposed.
- Multi-agent status is streamed in the foreground and available through `/agents`; a fixed full-screen task panel is planned for the professional TUI milestone.
- v0.6 preserves Agent Worktrees for recovery and does not automatically solve merge conflicts or clean branches.
- v0.8.0 adds authoritative context checkpoints and bounded large-file windows. Incremental AST/symbol indexing, a scrollable full transcript viewer, fixed full-screen panels, interactive Diff hunks, persistent pending queues, and themes remain future work.

These are the natural next milestones after validating the core loop.
