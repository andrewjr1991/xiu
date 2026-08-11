# Xiu project instructions

- Before planning a new release or a major feature, read `ROADMAP.zh-CN.md` completely.
- Before changing trust, approval, credentials, MCP/Skill permissions, recovery, logging, or destructive behavior, read `SECURITY.zh-CN.md` completely.
- Keep only the current release design document at the repository root; completed design history belongs in Git and the roadmap summary.
- Treat the roadmap's "current state" and "next action" as persistent project context, but update them when work is completed or priorities change.
- Keep `README.md`, `USAGE.zh-CN.md`, `PUBLISHING.zh-CN.md`, and the roadmap consistent with shipped behavior.
- Never overwrite an npm version that has already been published. Bump the version, run typecheck/tests/build, inspect the package, publish, and verify the registry.
- Preserve the existing safety boundaries: workspace trust, risk-based approval, Plan-mode read-only enforcement, checkpoints, and explicit confirmation for dangerous actions.
