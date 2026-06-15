# SQL Lineage Viewer

Demo: https://mk3008.github.io/rawsql-lineage-viewer/

Paste SQL and see the lineage graph in the browser.

This is a static TypeScript web app intended for GitHub Pages. SQL is parsed locally with `rawsql-ts`; no backend, database, or upload step is required for the MVP.

## MVP Scope

- Load a sample SQL query on first visit.
- Edit SQL in the side panel.
- Analyze SQL with `rawsql-ts`.
- Convert parser output through an adapter into a stable lineage model.
- Render the lineage graph with React Flow.

Save/load, JSON import/export, SVG/PNG export, URL sharing, and upstream/downstream switching are intentionally left for later iterations. The internal model layers are separated so those capabilities can be added without binding the app to the raw parser AST.

## Development

```bash
npm install
npm run dev
```

## Verification

```bash
npm run build
npm run test:e2e
```

## Deployment

The Vite `base` path can be changed for GitHub Pages by setting `VITE_BASE_PATH`.

```bash
VITE_BASE_PATH=/repository-name/ npm run build
```
