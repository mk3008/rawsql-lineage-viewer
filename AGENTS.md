# Repository Guidance

## Codex Task Orchestration

For a delegated or multi-step task, read `docs/codex-orchestration.md` and use
the globally installed `$minimal-orchestration` skill. Keep lineage-slice
assessment in the control task and do not push, open a pull request, merge, or
deploy unless explicitly requested.

- Keep impact assessment and final reporting in the control task.
- Give implementation work an isolated task and start unrelated work from `origin/main`.
- State the owning lineage slice, acceptance criteria, and verification evidence in the worker brief.
- Use the durable manifest and worker-report contract in `docs/codex-orchestration.md`; chat is notification and correction only.

## Lineage Changes

Before changing lineage behavior, read `docs/lineage-maintenance-map.md` first.

For fix requests:

- Decide which lineage slice owns the change before opening large files.
- Read only the owning slice and directly connected tests first.
- Do not inspect unrelated slices, the whole UI, or the whole app unless the request explicitly crosses those boundaries.
- Keep changes scoped to the identified slice whenever possible.

## GitHub Pages Deployment

GitHub Pages deployment is protected and must go through `main`.

Use this route:

1. Commit the work on a feature branch.
2. Push the feature branch.
3. Open a pull request into `main`.
4. Merge the pull request.
5. Let the `Deploy GitHub Pages` workflow run from `main`.
6. Confirm that the workflow completed successfully.

Do not try to deploy Pages directly from a feature branch. The `github-pages` environment only allows deployment from `main`, and direct pushes to `main` are protected.
