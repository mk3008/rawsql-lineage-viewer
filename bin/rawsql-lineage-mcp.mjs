#!/usr/bin/env node
import { runInvestigationMcpServer } from '../dist/package/mcp.js';

await runInvestigationMcpServer().catch((error) => {
  process.stderr.write(`${JSON.stringify({ code: typeof error?.code === 'string' ? error.code : 'INVALID_INPUT', kind: 'invalid_input', message: error instanceof Error ? error.message : String(error), version: 1 })}\n`);
  process.exitCode = 1;
});
