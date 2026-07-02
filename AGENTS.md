# Repository Guidance

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
