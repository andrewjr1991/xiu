# Xiu project instructions

- Before planning a new release or a major feature, read `ROADMAP.zh-CN.md` completely.
- Before changing trust, approval, credentials, MCP/Skill permissions, recovery, logging, or destructive behavior, read `SECURITY.zh-CN.md` completely.
- Keep only the current release design document at the repository root; completed design history belongs in Git and the roadmap summary.
- Treat the roadmap's "current state" and "next action" as persistent project context, but update them when work is completed or priorities change.
- Keep `README.md`, `USAGE.zh-CN.md`, `PUBLISHING.zh-CN.md`, and the roadmap consistent with shipped behavior.
- Keep local Windows build outputs in the standard locations: unpacked files in `apps/desktop/release/win-unpacked`, installers directly in `apps/desktop/release`. Do not create a new output subdirectory per local fix. Use a distinct installer filename for unpublished local test builds so they cannot be confused with official release assets.
- Never overwrite an npm version that has already been published. Bump the version, run typecheck/tests/build, inspect the package, publish, and verify the registry.
- Preserve workspace trust, Plan-mode read-only enforcement, checkpoints, credentials and crash-recovery boundaries. Dangerous actions require explicit confirmation except in the desktop's user-confirmed, ephemeral Full Access mode; never infer or restore that grant from prompts, project files, history or persistent settings.
