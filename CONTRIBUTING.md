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

## Deterministic evaluations

Validate all pinned task revisions and run the no-network scripted Provider suite with:

```bash
npm run eval:validate
npm run eval:smoke
```

Generated results are local-only under `evals/results/` and are ignored by Git. Ordinary pull requests must not add Provider credentials or enable real-model evaluation. A fixture change requires a task revision and content-hash update; hard pass/fail decisions must remain deterministic.

Maintainers may preview an approved real baseline with `npm run eval:real`. Preview performs no model call and prints a confirmation token bound to the exact configuration, suite hash, and Registry artifact integrity. Never commit the token, credential, or generated report; never add the confirmed command to CI.

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
