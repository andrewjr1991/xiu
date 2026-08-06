# Xiu

中文用户手册请参阅 [Xiu 完整使用指南](./USAGE.zh-CN.md)。维护者请参阅 [Xiu 更新、发布与安装指南](./PUBLISHING.zh-CN.md)。长期产品和工程规划记录在 [Xiu 路线图](./ROADMAP.zh-CN.md)。

Xiu is an open-source autonomous coding agent for the terminal, developed by 静然. Give it an outcome; it inspects the repository, reads and edits files, runs commands, checks the diff, and iterates until the model reports completion.

Version 0.8 starts Xiu's large-project intelligence work with a reliability-first context engine. Compaction now creates a structured checkpoint while deterministically preserving the authoritative primary goal, additive steering, and current plan. The next model resumes from recorded evidence and the next action instead of restarting discovery. Large text files are read in bounded line pages, while minified or giant single-line HTML/JSON can be paged by character offset with explicit continuation hints. It retains the professional terminal UI, multi-agent, MCP, planning, checkpoint, resumable-session, multimodal, and Skill systems from earlier releases.

Version 0.8.1 recognizes successful project-specific verifier scripts such as `verify_output.py`, `check-result.js`, and `output_validate.py` as completion evidence. Failed checks still cannot pass the completion gate. While a task runs, the input area now keeps a visible progress summary with completed/current/pending steps, the current and next action, and the latest changed file. `Ctrl+O` switches that summary to detailed tool activity.

Version 0.8.2 uses unambiguous `√`, `→`, and `○` progress symbols, surfaces concise model phase updates during long tasks, and keeps hidden tool logs hidden when a task ends. Its completion gate includes deterministic `verify_output` checks for generated HTML, JSON, Markdown, and CSV artifacts; a zero exit code containing explicit failure evidence is not accepted as a pass. It also recognizes Agnes 2.5 Flash's official 512K context window, compacts automatically at a model-aware 80% threshold, preserves recent user requirements verbatim beside the structured checkpoint, and estimates Chinese context more conservatively.

Version 0.8.3 makes successful file changes permanent terminal output instead of transient footer state. Each change card identifies created, modified, or deleted files, shows bounded `+added/-removed` line counts and a short colored preview, and falls back to byte-size summaries for large or binary files. The live input is safely redrawn after each card, and pending cards are flushed before the final answer.

Version 0.8.4 adds clipboard attachments. On Windows, `Ctrl+V` can import a clipboard screenshot as PNG or copied Explorer files into the trusted workspace and insert `@.xiu/attachments/...` references at the cursor; ordinary text remains ordinary pasted text. `/paste` provides a fallback when the terminal intercepts the shortcut. Attachments are bounded by count and size, directories and symbolic links are rejected, and pasted files are never executed automatically.

Version 0.8.5 refines the terminal conversation experience. Final responses render common Markdown, transient working prompts no longer leak into scrollback, each turn has a clear Xiu response and completion receipt, file cards show compact key hunks, important execution and verification actions remain visible, and the startup dashboard reserves safe terminal width for Chinese text. `/language` persists Simplified Chinese or English in `~/.xiu/settings.json`; the selected language governs the UI, plans, progress narration, visible reasoning summaries, and model answers while leaving code, paths, commands, and tool names unchanged.

## Features

- OpenAI, Anthropic, and Agnes model adapters
- Streaming text and tool-call assembly for OpenAI-compatible and Anthropic providers
- Live task plans with persistent step status and a read-only planning mode
- Session-scoped changed-file summaries, Git diffs, file checkpoints, and confirmed restore
- Automatic retry for transient model failures before output begins
- Structured context-checkpoint compaction that preserves the active task contract and continuation state
- Bounded line and character paging for large, minified, or single-line text files
- Cross-compaction tool evidence ledger plus bounded model-context tool results with complete session logs
- UTF-8 Python child-process output on Windows PowerShell
- Repeated tool-failure detection and error attribution
- Persistent live task progress with checked steps, current/next actions, and recent file changes
- Adaptive startup dashboard with quick-start tips, model, approval, workspace, and skill count
- Compact prompt footer with model, context usage, plan mode, skill count, and workspace
- Xiu-native project/global skills with Claude-compatible discovery and on-demand loading
- Safe local or HTTPS Git skill installation with limits, symlink rejection, and recoverable replacement backups
- Stdio MCP client with user/project configuration, tool discovery, live reload, cancellation, and clean shutdown
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
- Managed background commands for development servers, log inspection, and clean shutdown
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
- Windows clipboard screenshots and copied-file attachments through `Ctrl+V` or `/paste`
- Persistent `/language` selection for localized UI, progress, plans, and model responses
- Per-project draft recovery under `.xiu/draft.json` and responsive terminal Resize reflow
- Direction-key approval menus that default to deny
- Bounded tool/Agent summaries with full output available through `/details`
- Responsive status footer with current plan phase, agents, MCP tools, background tasks, and context
- Editable transient `↳` prompt that steers the active goal without polluting terminal history
- Live current Turn, elapsed-time, tool activity, and `Ctrl+O` expanded progress
- Explicit `/queue <task>` scheduling plus immediate `/queue`, `/clear-queue`, `/cancel`, and `/exit` controls
- Successful-call cycle detection that stops stagnant repeated reads/searches without relying on an arbitrary turn cap
- Explicit completed, unverified, failed, and cancelled outcomes with failure-paused scheduling

## Install

Requires Node.js 20 or newer.

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

Interactive commands include `/history`, `/compact`, `/models`, `/skills`, `/mcp`, `/plan`, `/agents`, `/tasks`, `/diff`, `/status`, `/queue`, `/cancel`, `/clear`, `/help`, and `/exit`. Supplying a task on the command line keeps the one-shot behavior for scripts and automation.

Open an interactive picker for saved sessions in the current project after closing the terminal:

```bash
xiu --resume
```

Inside Xiu, `/resume` opens the same picker. It shows each session's first task, last update, model, and ID; use Up/Down and Enter to choose. Legacy sessions from `.forge/sessions/` and `.forge_sessions/` are also discovered during the Xiu rename transition.

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
/skills             browse installed skills
/skills install ... install from a local path or HTTPS Git repository
/mcp                show MCP server connections and tool counts
/mcp reload         reload user and project MCP configuration
/agents             show all saved multi-agent runs
/agents <run>       show one run and every specialist task
/agents cancel ...  cancel one task without stopping unrelated agents
/agents retry ...   retry a failed, cancelled, blocked, or interrupted task
/agents integrate ... preview and integrate a completed Worktree task
/details            browse complete tool and Agent activity output
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

While an Agent is running, a transient `↳` prompt accepts additional requirements without writing a fake prompt into scrollback. A normal submission adds requirements to the active goal and is injected before the next model turn. The primary task remains mandatory, and a steered task receives a final task-contract audit so the model cannot silently finish after answering only the newest request. Use `/queue <task>` only when the text is a genuinely independent task that should run afterward. The footer shows the current Turn, phase, elapsed time, steering count, explicit queue length, and the latest activity; `Ctrl+O` expands or collapses the last eight activities without submitting the draft. Primary tasks have no Turn limit by default and continue until completion, cancellation, a genuine loop, or another explicit failure. `/details` performs the same toggle while working. If the current task fails, is cancelled, reaches a loop guard, or changes files without passing verification, Xiu pauses and asks whether to stop, retry from existing evidence, or explicitly skip to scheduled tasks. The safe default is stop. Approval still suspends the editor and defaults to deny. Pending scheduled tasks are process-local and do not yet claim crash recovery.

## Multi-agent orchestration

For goals with genuinely independent investigation, implementation, review, or test work, Xiu can create a dependency graph of specialist agents. Each agent receives a bounded task, its own conversation context, an optional explicit turn budget, elapsed-time counter, and Token statistics. Independent tasks run concurrently; dependent tasks start only after their prerequisites complete.

Explorer and Reviewer tasks use `shared_readonly` mode by default. Their tool registry contains only tools declared statically read-only, and Plan mode adds a second enforcement boundary. Implementer tasks use `worktree` mode by default. Xiu creates them under `.xiu/worktrees/` on a dedicated `xiu/agent-*` Git branch, so their edits cannot overwrite the main workspace or another agent.

Use `/agents` after or between tasks to inspect persisted runs. A completed implementation is not merged automatically. Xiu or the user must review its Diff and explicitly integrate it:

```text
/agents
/agents <run-id>
/agents integrate <run-id> <task-id>
```

Integration first runs `git apply --check`; conflicts leave the main workspace untouched and preserve the Worktree. Xiu never automatically deletes Agent Worktrees in v0.6. After integration, the parent Agent still reviews the result and runs normal project verification. If Xiu exits while agents are running, their persisted state becomes `interrupted`; use `/agents retry <run-id> <task-id>` to continue that task.

`/models` asks the active provider for its available model catalog, filters out obvious embedding, speech, image, video, and moderation-only endpoints, and opens a keyboard-driven picker. This works with OpenAI-compatible local gateways as well as cloud providers. If the provider does not implement model listing, Xiu falls back to its built-in default plus the model already active in the session. Model changes are persisted with the resumable session.

## Skills

Xiu discovers reusable workflows from three locations, with project definitions taking precedence over compatible and global definitions of the same name:

```text
<project>/.xiu/skills/<name>/SKILL.md     project
<project>/.claude/skills/<name>/SKILL.md compatible
~/.xiu/skills/<name>/SKILL.md            global
```

Only each skill's name and description enter the base prompt. When a workflow matches the task, the agent calls `read_skill` to load the complete `SKILL.md`, keeping startup context small even with many installed skills.

Browse or install skills interactively:

```text
/skills
/skills install D:\\my-skills\\code-review
/skills install https://github.com/example/xiu-skills.git
```

Remote sources must use HTTPS Git URLs. Packages are limited to 20 MB and 1,000 files, symbolic links are rejected, and replacing an existing global skill requires confirmation. The old version is renamed to a timestamped backup instead of being deleted. Skills are executable instructions for the model, so install only packages you trust.

## MCP servers

Xiu loads stdio MCP servers after the workspace trust check. User configuration lives at `~/.xiu/mcp.json`; a project can add or override servers in `<project>/.xiu/mcp.json`. Project configuration wins when both files contain the same server name, and `"enabled": false` disables an inherited server.

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
      }
    }
  }
}
```

On macOS or Linux, use `npx` instead of `npx.cmd`. Each server supports `command`, optional `args`, `cwd`, `env`, `enabled`, a default `risk`, per-tool `toolRisks`, and `changesWorkspace` / `toolChangesWorkspace` hints for diff and verification tracking. Environment values can reference existing variables as `${NAME}`, so secrets do not need to be committed. Valid risk levels are `read`, `write`, `execute`, and `dangerous`.

Discovered tools are exposed as `mcp__<server>__<tool>` to prevent collisions. The safe default is `execute`, which requires approval; mark a server or tool `read` only when it cannot change files or external state. Tool arguments are shown in the approval preview. Non-read MCP calls are blocked in Plan mode. Ctrl+C cancellation is forwarded to an active MCP request, binary result data is omitted from model context, text output is capped, and child processes are closed when Xiu exits. For one-shot use in a workspace that has never been trusted, user-level MCP servers still load but project-level MCP configuration is skipped.

Use `/mcp` to inspect connection failures and tool counts after launch. Edit either configuration file and run `/mcp reload` to reconnect without restarting Xiu.

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

The project index scans up to 8,000 source and configuration files while ignoring dependencies, build output, coverage, Git metadata, and Xiu state. It stores bounded search terms rather than entire file contents, and returns short source excerpts only for the highest-scoring files. Workspace changes invalidate the cache automatically.

## Development

```bash
npm test
npm run typecheck
npm run build
```

## Current limitations

- Shell commands rely on approval and the operating-system account rather than a container sandbox.
- Precise checkpoint restore currently covers Xiu's focused file tools and generated outputs; arbitrary shell-command side effects require Git or project-specific recovery.
- MCP v0.5 currently supports stdio transport; Streamable HTTP, OAuth discovery, resources, prompts, and sampling are future extensions.
- Session replay is resumable, but deterministic step-by-step replay and branch/fork controls are not yet exposed.
- Multi-agent status is streamed in the foreground and available through `/agents`; a fixed full-screen task panel is planned for the professional TUI milestone.
- v0.6 preserves Agent Worktrees for recovery and does not automatically solve merge conflicts or clean branches.
- v0.8.0 adds authoritative context checkpoints and bounded large-file windows. Incremental AST/symbol indexing, a scrollable full transcript viewer, fixed full-screen panels, interactive Diff hunks, persistent pending queues, and themes remain future work.

These are the natural next milestones after validating the core loop.
