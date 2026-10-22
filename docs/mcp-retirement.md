# MCP retirement and Pages distribution

MCP support is retired. Core, Viewer, and CLI remain supported. The MCP server,
command, package subpath, transport tests, and MCP workflow comparison harness
have been removed. The experimental fixture-extraction planner had no caller
outside MCP and was not exported by the public Core package, so it is removed
with that surface. Historical reports retain their earlier results with a
retirement notice.

## Distribution

- `npm run build:viewer` typechecks the application and builds `dist/viewer`.
- `npm run build:package` builds the local Core/CLI package in `dist/package`.
- `npm run build` builds both independently.
- The single Pages workflow builds and uploads only `dist/viewer`, after
  `npm run smoke:viewer` checks its file inventory and Node/MCP imports.
- The package remains `private: true`; no npm publishing is introduced.

Before retirement, both Pages workflows uploaded all of `dist`, including the
Node package. Serving `package/mcp.js` as a static file did not run an MCP server.
The browser HTML did not reference it. See the
[previous build configuration](https://github.com/mk3008/rawsql-lineage-viewer/blob/98259a0089d4590f1806473b51838fa46d6d16e6/package.json),
[MCP implementation](https://github.com/mk3008/rawsql-lineage-viewer/blob/98259a0089d4590f1806473b51838fa46d6d16e6/src/mcp/investigationServer.ts),
and [successful Pages run](https://github.com/mk3008/rawsql-lineage-viewer/actions/runs/31130059818).

## Dependency audit, 2026-10-22

`npm audit --json` before/after retirement reports 14 -> 7 affected packages,
and 47 -> 14 distinct advisory URLs. These are dependency-version matches,
not counts of exploitable browser vulnerabilities. No retained lockfile package
version changed. MCP SDK, AJV, fast-uri, and the MCP-only direct zod dependency
are absent from the resulting lock and clean installation.

js-yaml 4.3.0 remains through react-diff-viewer-continued 4.2.2. It is present in
the browser bundle; the current SQL string-diff UI does not select the YAML
parsing mode required by the YAML parser advisories. MCP removal does not fix
this separate dependency. Vite/Vitest and other remaining audit findings are
also outside this retirement change. Manifest production-dependency labels
must be distinguished from actual Pages execution paths.

## Verification

- Clean `npm ci --ignore-scripts --no-audit --no-fund`.
- `npm run build`, including application typechecking and package declarations.
- `npm test`: 293 passed, 5 skipped; 22 files passed, 1 skipped.
- Chromium E2E: 66 passed.
- Production preview at `/rawsql-lineage-viewer/`: sample graph rendered nine
  nodes with no page errors.
- `npm run smoke:package`: 22 packed files; Core import, consumer types, CLI
  discovery/planning, and deterministic CLI error checks passed.
- `npm run smoke:viewer`: six browser files only. Negative checks rejected an
  extra root JS file and an asset containing a `node:fs` import.
- With `VITE_BASE_PATH=/rawsql-lineage-viewer/`, the generated browser JS matches
  the previously published JS byte-for-byte: SHA-256
  `0506c981dfe7a251023ae6d2e7cdd947e840bf701169003be3fc1703ebbd2c97`.
- No separate lint script/config is defined; TypeScript's existing unused-code
  and fallthrough checks pass as part of the build. `git diff --check` passes.

The external PostgreSQL dogfooding executor was not run; its remaining helper
tests passed. Existing React/SVG console warnings and the bundle-size warning
remain outside scope. This change has not been merged or deployed to Pages.
