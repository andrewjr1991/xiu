# Xiu evaluations

`evals` contains versioned, deterministic fixtures and the v0.18 evaluation harness.

- `npm run eval:validate` validates task metadata, fixture hashes, suites, and safety budgets.
- `npm run eval:smoke` runs the scripted Provider suite from the current `dist/` build without network access or credentials.
- `npm run eval:report -- --input <run.json>` regenerates a sanitized summary.
- `npm run eval:compare -- --baseline <report.json> --candidate <report.json>` compares compatible reports.

`evals/run.mjs` intentionally accepts only `mode: "simulated"`; real execution is isolated in the separately confirmed runner below. Generated results go to `evals/results/`, which is ignored by Git.

## Approved v0.17.0 real baseline

The approved configuration is `evals/configs/agnes-enterprise-v0.17.0.json`: Agnes Enterprise, `agnes-2.5-flash`, three trials per task, model attested by the user as free, and a retained 100 USD authorization ceiling. The runner still enforces finite model-call, tool-call, Token, and duration limits.

First run the preflight without a credential or confirmation token:

```bash
npm run build
npm run eval:real
```

Preflight reads exact public Registry metadata and prints a confirmation token bound to the configuration, suite, task metadata, assertions, runner code, and artifact integrity. It makes no model call. After reviewing the version, SHA-512 integrity, evaluation SHA-256, 30-trial plan, and budgets, ensure `AGNES_API_KEY` is present without placing its value in shell history, then explicitly run:

```bash
npm run eval:real -- --confirm CONFIRM-REAL-EVAL-XXXXXXXXXXXXXXXX
```

The confirmed path installs exact `@xiu-ai/cli@0.17.0` into a temporary directory with lifecycle scripts and optional dependencies disabled, verifies the lock integrity, and deletes the installation afterward. Ctrl+C and budget stops preserve the latest sanitized partial result. Never run this command in PR CI.

Fixtures must contain no secrets, external service dependencies, symlinks, or junctions. A task revision must change when its protocol or budget changes; `fixtureHash` must also change whenever its repository fixture changes.
