import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const repository = process.cwd();
const root = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-package-smoke-'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is required for the package smoke test.');
const runNpm = (args, options) => execFileSync(process.execPath, [npmCli, ...args], options);
try {
  const packOutput = runNpm(['pack', '--json', '--pack-destination', root], { cwd: repository, encoding: 'utf8' });
  const packed = JSON.parse(packOutput)[0];
  const paths = packed.files.map((file) => file.path);
  const requiredPaths = [
    'LICENSE',
    'README.md',
    'bin/rawsql-lineage.mjs',
    'bin/rawsql-lineage-mcp.mjs',
    'dist/package/cli.js',
    'dist/package/mcp.js',
    'dist/package/public.js',
    'dist/package/types/domain/lineage.d.ts',
    'dist/package/types/lineage/columnDisplay.d.ts',
    'dist/package/types/lineage/diagnostics.d.ts',
    'dist/package/types/lineage/investigationPlan.d.ts',
    'dist/package/types/lineage/investigationTargetDiscovery.d.ts',
    'dist/package/types/lineage/nodeDependencyProfile.d.ts',
    'dist/package/types/lineage/population-origin/collectPopulationScope.d.ts',
    'dist/package/types/lineage/probePrerequisiteFacts.d.ts',
    'dist/package/types/lineage/problemIntent.d.ts',
    'dist/package/types/lineage/rawsqlAdapter.d.ts',
    'dist/package/types/lineage/schemaFacts.d.ts',
    'dist/package/types/lineage/source-references/mergeColumnRefs.d.ts',
    'dist/package/types/lineage/source-references/resolveColumnReferences.d.ts',
    'dist/package/types/lineage/source-references/sourceReferences.types.d.ts',
    'dist/package/types/mcp/investigationServer.d.ts',
    'dist/package/types/public.d.ts',
    'package.json',
  ];
  for (const required of requiredPaths) {
    if (!paths.includes(required)) throw new Error(`Packed artifact is missing ${required}`);
  }
  const allowedPath = (path) => requiredPaths.includes(path)
    || /^dist\/package\/investigationPlan-[A-Za-z0-9_-]+\.js$/.test(path);
  const unexpected = paths.filter((path) => !allowedPath(path));
  if (unexpected.length) throw new Error(`Packed artifact contains unexpected paths: ${unexpected.join(', ')}`);
  if (paths.some((path) => path === 'dist/package/favicon.svg' || path === 'dist/package/icons.svg')) {
    throw new Error('Packed artifact contains Viewer public assets.');
  }

  const installRoot = resolve(root, 'consumer');
  mkdirSync(installRoot);
  runNpm(['init', '-y'], { cwd: installRoot, stdio: 'ignore' });
  runNpm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--prefix', installRoot, resolve(root, packed.filename)], { cwd: root, stdio: 'inherit' });
  const sqlPath = resolve(root, 'query.sql');
  writeFileSync(sqlPath, 'select 1 as value');
  const cli = resolve(installRoot, 'node_modules/sql-lineage-viewer/bin/rawsql-lineage.mjs');
  const plan = JSON.parse(execFileSync(process.execPath, [cli, 'investigate', '--sql', sqlPath, '--target-node', 'main_output', '--target-column', 'value', '--contract-version', '1'], { encoding: 'utf8' }));
  if (plan.kind !== 'investigation-plan' || plan.version !== 1) throw new Error('Compiled CLI did not return InvestigationPlanV1.');

  let versionFailure;
  try {
    execFileSync(process.execPath, [cli, 'investigate', '--contract-version', '2'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    versionFailure = JSON.parse(String(error.stderr));
  }
  if (versionFailure?.code !== 'CONTRACT_VERSION_UNSUPPORTED') throw new Error('Compiled CLI did not return a deterministic version error.');

  const consumer = resolve(installRoot, 'consumer.mjs');
  writeFileSync(consumer, "import { createInvestigationPlan } from 'sql-lineage-viewer';\nif (typeof createInvestigationPlan !== 'function') process.exit(2);\n");
  execFileSync(process.execPath, [consumer], { cwd: installRoot, stdio: 'inherit' });
  writeFileSync(resolve(installRoot, 'consumer.ts'), "import type { InvestigationPlanV1, ProbePrerequisiteFactsV1 } from 'sql-lineage-viewer';\nconst versions: [InvestigationPlanV1['version'], ProbePrerequisiteFactsV1['version']] = [1, 1];\nvoid versions;\n");
  writeFileSync(resolve(installRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, skipLibCheck: true }, files: ['consumer.ts'] }));
  execFileSync(process.execPath, [resolve(repository, 'node_modules/typescript/bin/tsc'), '--project', resolve(installRoot, 'tsconfig.json')], { cwd: installRoot, stdio: 'inherit' });

  const mcp = resolve(installRoot, 'node_modules/sql-lineage-viewer/bin/rawsql-lineage-mcp.mjs');
  const server = spawn(process.execPath, [mcp, '--workspace', installRoot], { cwd: installRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { server.kill(); }, 250);
    server.once('exit', (code) => { clearTimeout(timer); code === null || code === 0 ? resolvePromise() : reject(new Error(`Compiled MCP entry exited with ${code}.`)); });
    server.once('error', reject);
  });
  process.stdout.write(`${JSON.stringify({ cli: 'passed', mcp: 'passed', packedFiles: paths.length, publicImport: 'passed' })}\n`);
} finally {
  rmSync(root, { force: true, recursive: true });
}
