import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('dist/viewer');
const files = [];
function visit(directory, prefix = '') {
  for (const name of readdirSync(directory)) {
    const relative = `${prefix}${name}`;
    const absolute = resolve(directory, name);
    if (statSync(absolute).isDirectory()) visit(absolute, `${relative}/`);
    else files.push(relative);
  }
}
visit(root);
const allowed = (file) => ['index.html', 'favicon.svg', 'icons.svg'].includes(file)
  || /^assets\/[^/]+\.(?:js|css|png|svg|webp|jpg|woff2?)$/.test(file);
const unexpected = files.filter((file) => !allowed(file));
if (unexpected.length) throw new Error(`Viewer artifact contains unexpected files: ${unexpected.join(', ')}`);
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const entries = [...html.matchAll(/(?:src|href)="[^"]*\/assets\/([^"/]+)"/g)].map((match) => `assets/${match[1]}`);
if (!entries.some((file) => file.endsWith('.js')) || entries.some((file) => !files.includes(file))) {
  throw new Error('Viewer HTML must reference generated browser assets.');
}
for (const file of files.filter((file) => file.endsWith('.js'))) {
  const code = readFileSync(resolve(root, file), 'utf8');
  if (/(?:from\s*|import\s*\(?\s*)["'](?:node:|@modelcontextprotocol\/)/.test(code)) {
    throw new Error(`Viewer artifact contains a Node/MCP import: ${file}`);
  }
}
process.stdout.write(`${JSON.stringify({ viewer: 'passed', files })}\n`);
