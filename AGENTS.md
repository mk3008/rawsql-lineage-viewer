# Repository Guidance

## Lineage Changes

Before changing lineage behavior, read `docs/lineage-maintenance-map.md` first.

For fix requests:

- Decide which lineage slice owns the change before opening large files.
- Read only the owning slice and directly connected tests first.
- Do not inspect unrelated slices, the whole UI, or the whole app unless the request explicitly crosses those boundaries.
- Keep changes scoped to the identified slice whenever possible.
