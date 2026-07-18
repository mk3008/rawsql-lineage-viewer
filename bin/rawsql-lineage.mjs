#!/usr/bin/env node
import { cliFailure, runCli } from '../dist/package/cli.js';

await runCli().catch((error) => {
  process.stderr.write(`${JSON.stringify(cliFailure(error))}\n`);
  process.exitCode = 1;
});
