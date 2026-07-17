#!/usr/bin/env node
import { runCli } from '../dist/package/cli.js';

await runCli().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.startsWith('Unsupported contract version:') ? 'CONTRACT_VERSION_UNSUPPORTED'
    : /ENOENT|does not exist/i.test(message) ? 'PATH_NOT_FOUND' : 'INVALID_INPUT';
  process.stderr.write(`${JSON.stringify({ code, kind: 'invalid_input', message, version: 1 })}\n`);
  process.exitCode = 1;
});
