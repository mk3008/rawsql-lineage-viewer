#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = resolve(root, 'src/cli/diagnose.ts');
const result = spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: 'inherit',
});

process.exit(result.status ?? 1);

