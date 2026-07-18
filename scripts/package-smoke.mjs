import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
    || /^dist\/package\/investigation(?:Plan|TargetDiscovery)-[A-Za-z0-9_-]+\.js$/.test(path);
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
  const discovery = JSON.parse(execFileSync(process.execPath, [cli, 'discover', '--sql', sqlPath, '--contract-version', '1'], { encoding: 'utf8' }));
  const targetId = discovery.targets?.find((target) => target.selection?.status === 'selectable')?.id;
  if (discovery.kind !== 'investigation-target-discovery' || !targetId) throw new Error('Compiled CLI did not return selectable InvestigationTargetDiscoveryV1 output.');
  const plan = JSON.parse(execFileSync(process.execPath, [cli, 'investigate', '--sql', sqlPath, '--target-id', targetId, '--contract-version', '1'], { encoding: 'utf8' }));
  if (plan.kind !== 'investigation-plan' || plan.version !== 1) throw new Error('Compiled CLI did not return InvestigationPlanV1.');

  let versionFailure;
  try {
    execFileSync(process.execPath, [cli, 'investigate', '--contract-version', '2'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    versionFailure = JSON.parse(String(error.stderr));
  }
  if (versionFailure?.code !== 'CONTRACT_VERSION_UNSUPPORTED') throw new Error('Compiled CLI did not return a deterministic version error.');

  let pathFailure;
  try {
    execFileSync(process.execPath, [cli, 'discover', '--sql', resolve(root, 'missing.sql')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    pathFailure = JSON.parse(String(error.stderr));
  }
  if (pathFailure?.code !== 'PATH_NOT_FOUND') throw new Error('Compiled CLI did not normalize a missing path to PATH_NOT_FOUND.');

  const parametersPath = resolve(root, 'parameters.json');
  writeFileSync(parametersPath, JSON.stringify({ definitions: [{ name: 'status', origin: 'original_query_parameter' }, { name: 'status', origin: 'investigation_key' }] }));
  let typedCliFailure;
  try {
    execFileSync(process.execPath, [cli, 'investigate', '--sql', sqlPath, '--target-node', 'main_output', '--target-column', 'value', '--parameters', parametersPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    typedCliFailure = JSON.parse(String(error.stderr));
  }
  if (typedCliFailure?.code !== 'PARAMETER_NAME_COLLISION') throw new Error('Compiled CLI did not preserve the typed parameter collision code.');

  const consumer = resolve(installRoot, 'consumer.mjs');
  writeFileSync(consumer, "import { createInvestigationPlan, createInvestigationPlanForTarget, discoverInvestigationTargets, resolveInvestigationTarget } from 'sql-lineage-viewer';\nconst discovery = discoverInvestigationTargets({ sql: 'SELECT 1 AS value' });\nconst target = discovery.targets.find((item) => item.selection.status === 'selectable');\nif (typeof createInvestigationPlan !== 'function' || typeof createInvestigationPlanForTarget !== 'function' || !target || resolveInvestigationTarget(discovery, target.id).columnName !== 'value' || createInvestigationPlanForTarget({ sql: 'SELECT 1 AS value' }, target.id).kind !== 'investigation-plan') process.exit(2);\n");
  execFileSync(process.execPath, [consumer], { cwd: installRoot, stdio: 'inherit' });
  writeFileSync(resolve(installRoot, 'consumer.ts'), "import type { InvestigationPlanV1, InvestigationTargetDiscoveryV1, ProbePrerequisiteFactsV1 } from 'sql-lineage-viewer';\nconst versions: [InvestigationPlanV1['version'], InvestigationTargetDiscoveryV1['version'], ProbePrerequisiteFactsV1['version']] = [1, 1, 1];\nvoid versions;\n");
  writeFileSync(resolve(installRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, skipLibCheck: true }, files: ['consumer.ts'] }));
  execFileSync(process.execPath, [resolve(repository, 'node_modules/typescript/bin/tsc'), '--project', resolve(installRoot, 'tsconfig.json')], { cwd: installRoot, stdio: 'inherit' });

  const mcp = resolve(installRoot, 'node_modules/sql-lineage-viewer/bin/rawsql-lineage-mcp.mjs');
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp, '--workspace', installRoot], cwd: installRoot, stderr: 'pipe' });
  const client = new Client({ name: 'package-smoke', version: '1.0.0' });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    const expectedTools = ['analyze_investigation_sql', 'create_investigation_plan', 'discover_investigation_targets', 'prepare_sql_investigation'].sort();
    if (JSON.stringify(toolNames) !== JSON.stringify(expectedTools)) throw new Error(`Compiled MCP tool mismatch: ${toolNames.join(', ')}`);
    const request = { sql: 'select 1 as value' };
    const analysis = await client.callTool({ name: 'analyze_investigation_sql', arguments: request });
    const mcpDiscovery = await client.callTool({ name: 'discover_investigation_targets', arguments: request });
    if (analysis.isError || analysis.structuredContent?.kind !== 'investigation-analysis-summary') throw new Error('Compiled MCP analysis call failed.');
    if (mcpDiscovery.isError || mcpDiscovery.structuredContent?.kind !== 'investigation-target-discovery') throw new Error('Compiled MCP discovery call failed.');
    if (JSON.stringify((await client.callTool({ name: 'analyze_investigation_sql', arguments: request })).structuredContent) !== JSON.stringify(analysis.structuredContent)) throw new Error('Compiled MCP analysis output is not deterministic.');
    if (JSON.stringify((await client.callTool({ name: 'discover_investigation_targets', arguments: request })).structuredContent) !== JSON.stringify(mcpDiscovery.structuredContent)) throw new Error('Compiled MCP discovery output is not deterministic.');
    const typedMcpFailure = await client.callTool({ name: 'create_investigation_plan', arguments: { ...request, targetColumn: 'value', parameterDefinitions: [{ name: 'status', origin: 'original_query_parameter' }, { name: 'status', origin: 'investigation_key' }] } });
    const typedMcpCode = typedMcpFailure.isError ? JSON.parse(typedMcpFailure.content[0].text).code : undefined;
    if (typedMcpCode !== typedCliFailure.code) throw new Error('Compiled CLI and MCP typed error codes differ.');
  } finally {
    await client.close();
  }
  process.stdout.write(`${JSON.stringify({ cli: 'passed', cliDiscovery: 'passed', mcp: 'protocol-passed', packedFiles: paths.length, publicImport: 'passed', typedErrorParity: 'passed' })}\n`);
} finally {
  rmSync(root, { force: true, recursive: true });
}
