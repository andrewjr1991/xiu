---
name: hello-review
description: Read-only smoke test that summarizes the current project and suggests one safe improvement.
permissions: workspace:read
---

# Hello Review

Use this skill only as a read-only plugin smoke test.

1. Inspect the current project's top-level files and its main package or build manifest.
2. Summarize the detected technology stack in no more than three bullets.
3. Suggest exactly one small, safe improvement.
4. Do not create, modify, move, or delete files.
5. Do not run commands that change project or external state.
6. End with the exact marker: `XIU_PLUGIN_SMOKE_TEST_OK`.
