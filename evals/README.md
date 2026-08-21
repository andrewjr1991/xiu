# Xiu evaluations

`evals` contains versioned, deterministic fixtures and the v0.18 evaluation harness.

- `npm run eval:validate` validates task metadata, fixture hashes, suites, and safety budgets.
- `npm run eval:smoke` runs the scripted Provider suite from the current `dist/` build without network access or credentials.
- `npm run eval:report -- --input <run.json>` regenerates a sanitized summary.
- `npm run eval:compare -- --baseline <report.json> --candidate <report.json>` compares compatible reports.

The current runner intentionally accepts only `mode: "simulated"`. Real-model execution remains disabled until the v0.17.0 baseline configuration, Provider/model, and total spend are separately approved. Generated results go to `evals/results/`, which is ignored by Git.

Fixtures must contain no secrets, external service dependencies, symlinks, or junctions. A task revision and `fixtureHash` must change whenever its repository fixture changes.
