# Contributing to Xiu

Xiu is currently Windows-first, but changes should remain portable unless a platform-specific boundary is explicit and tested.

## Development setup

Use Node.js 20.18.1 or newer:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:package
```

## Project rules

- Read `ROADMAP.zh-CN.md` before planning a release or major feature.
- Read `SECURITY.zh-CN.md` before changing trust, approval, credentials, permissions, recovery, logging, or destructive behavior.
- Preserve user changes and never weaken workspace trust, Plan-mode read-only enforcement, approval policy, checkpoints, or dangerous-action confirmation.
- Add failure, cancellation, and recovery tests for new side effects.
- Do not place credentials, prompts, source excerpts, or complete paths in audit and diagnostic records.
- Do not claim platform support or release stability without matching verification evidence.

## Pull requests

Keep a change focused and include:

- the user-visible problem and intended outcome;
- security and compatibility impact;
- tests added or updated;
- exact verification commands and results;
- limitations or external validation still required.

Pull-request CI is deterministic and does not receive model or publishing credentials. Real Provider evaluations and npm publishing remain explicitly controlled maintainer actions.
