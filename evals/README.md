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

The confirmed path installs exact `@xiu-ai/cli@0.17.0` into a temporary directory with lifecycle scripts and optional dependencies disabled, verifies the lock integrity, and deletes the installation afterward. Ctrl+C and suite-terminal stops preserve the latest sanitized partial result. Never run this command in PR CI.

Each tool event records only its name, status, and a bounded semantic reason code; tool arguments and full paths are not retained in the result. Writes outside the task's declared `allowedChanges` set are blocked before execution, recorded as `outside_allowlist` or `outside_workspace`, and cannot become a passing trial.

An isolated task-budget failure is a terminal result for that trial, not for the whole confirmed suite. After the temporary workspace has been cleaned successfully, the runner may continue to the next fresh trial under the already confirmed global limits. A global budget, timeout, interruption, Provider failure, harness failure, or cleanup failure still stops the run. The preflight prints this policy before asking for confirmation.

### One-trial real canary

Before restarting the full baseline after an evaluation-harness change, use the separately bounded canary profile:

```bash
npm run eval:real -- --config evals/configs/agnes-enterprise-v0.17.0-canary.json
```

It pins `single-trim-name` revision 3 for one trial, exact `@xiu-ai/cli@0.17.0`, Agnes Enterprise, and `agnes-2.5-flash`. Its global maximum is 12 model calls, 20 tool calls, 120,000 input tokens, 10,000 output tokens, and three minutes. The preflight makes no model calls and emits a confirmation token bound to this exact canary. A failed model outcome can still be a valid harness canary when it is correctly classified, bounded, cleaned up, and recorded without sensitive data; it is not a quality baseline.

### Resume a stopped run

Resume happens only at a trial boundary. The runner preserves every recorded success or failure and continues with the next unrecorded trial; it never replays a recorded trial or resumes inside an isolated workspace.

```bash
npm run eval:real -- --resume evals/results/real-<run-id>.json
```

The resume preflight makes no model call. It accepts only a direct, regular JSON file in `evals/results/` whose configuration hash, suite hash, execution hash, Registry artifact, Provider/model, ordered trial prefix, summary, and cumulative ledger all match the current evaluation. It prints the preserved trial count, next trial, source SHA-256, remaining budgets, and a new confirmation token bound to that exact source file. After review, run the same command with the printed token:

```bash
npm run eval:real -- --resume evals/results/real-<run-id>.json --confirm CONFIRM-REAL-EVAL-XXXXXXXXXXXXXXXX
```

The continuation writes a new result file and records immutable lineage; it never overwrites the source. Model calls, tool calls, Tokens, active duration, and estimated cost continue from the source ledger. A running, completed, damaged, reordered, modified-after-preview, incompatible, linked, or out-of-directory result fails closed. Results created before resume metadata was introduced are intentionally not resumable. Reports preserve the lineage and cumulative ledger, and the comparison command rejects partial reports whose state is not `completed`.

Any harness change covered by the execution SHA-256 intentionally invalidates older resume tokens and sources. Preserve those files as diagnostic evidence, then start a newly confirmed canary or baseline instead of weakening the digest check.

Fixtures must contain no secrets, external service dependencies, symlinks, or junctions. A task revision must change when its protocol or budget changes; `fixtureHash` must also change whenever its repository fixture changes.
