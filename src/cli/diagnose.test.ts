import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('rawsql-lineage diagnose CLI', () => {
  it('emits all output column packets with DDL file input', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-cli-'));
    try {
      const sqlPath = resolve(root, 'query.sql');
      const ddlPath = resolve(root, 'schema.sql');
      writeFileSync(sqlPath, 'select c.* from customers c');
      writeFileSync(ddlPath, 'create table customers (id int primary key, name text not null);');

      const stdout = execFileSync(process.execPath, [
        '--import',
        'tsx',
        resolve(process.cwd(), 'src/cli/diagnose.ts'),
        'diagnose',
        '--sql',
        sqlPath,
        '--ddl',
        ddlPath,
      ], { encoding: 'utf8' });
      const report = JSON.parse(stdout) as {
        kind: string;
        packets: Array<{ target: { columnName: string }; diagnostics: Array<{ code: string }> }>;
        schemaFacts: { kind: string; version: number };
      };

      expect(report.kind).toBe('sql-diagnostic-report');
      expect(report.schemaFacts).toMatchObject({ kind: 'schema-facts', version: 1 });
      expect(report.packets.map((packet) => packet.target.columnName)).toEqual(['id', 'name']);
      expect(report.packets[0].diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'lineage_metadata_added' }),
        expect.objectContaining({ code: 'schema_facts_used' }),
      ]));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('emits top-level diagnostics when SQL-only analysis cannot build packets', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-cli-'));
    try {
      const sqlPath = resolve(root, 'query.sql');
      writeFileSync(sqlPath, 'select c.* from customers c');

      const stdout = execFileSync(process.execPath, [
        '--import',
        'tsx',
        resolve(process.cwd(), 'src/cli/diagnose.ts'),
        'diagnose',
        '--sql',
        sqlPath,
      ], { encoding: 'utf8' });
      const report = JSON.parse(stdout) as { diagnostics: Array<{ code: string }>; packets: unknown[] };

      expect(report.packets).toEqual([]);
      expect(report.diagnostics).toEqual([
        expect.objectContaining({ code: 'wildcard_unresolved_without_schema' }),
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('accepts SchemaFacts JSON input', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-cli-'));
    try {
      const sqlPath = resolve(root, 'query.sql');
      const factsPath = resolve(root, 'schema-facts.json');
      writeFileSync(sqlPath, 'select c.* from customers c');
      writeFileSync(factsPath, JSON.stringify({
        tables: {
          customers: {
            columns: {
              id: { name: 'id', nullable: false, type: 'int' },
              name: { name: 'name', nullable: true, type: 'text' },
            },
            name: 'customers',
            primaryKey: ['id'],
          },
        },
      }));

      const stdout = execFileSync(process.execPath, [
        '--import',
        'tsx',
        resolve(process.cwd(), 'src/cli/diagnose.ts'),
        'diagnose',
        '--sql',
        sqlPath,
        '--schema-facts',
        factsPath,
      ], { encoding: 'utf8' });
      const report = JSON.parse(stdout) as { packets: Array<{ target: { columnName: string } }> };

      expect(report.packets.map((packet) => packet.target.columnName)).toEqual(['id', 'name']);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('accepts combined DDL directory and DDL file input', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-cli-'));
    try {
      const sqlPath = resolve(root, 'query.sql');
      const ddlDir = resolve(root, 'ddl');
      const extraDdlPath = resolve(root, 'extra.sql');
      writeFileSync(sqlPath, 'select c.name, o.order_id from customers c join orders o on o.customer_id = c.id');
      writeFileSync(extraDdlPath, 'create table orders (order_id int primary key, customer_id int);');
      mkdirSync(ddlDir);
      writeFileSync(resolve(ddlDir, 'customers.sql'), 'create table customers (id int primary key, name text);');

      const stdout = execFileSync(process.execPath, [
        '--import',
        'tsx',
        resolve(process.cwd(), 'src/cli/diagnose.ts'),
        'diagnose',
        '--sql',
        sqlPath,
        '--ddl-dir',
        ddlDir,
        '--ddl',
        extraDdlPath,
      ], { encoding: 'utf8' });
      const report = JSON.parse(stdout) as { packets: Array<{ target: { columnName: string }; columnLineage: { sourceLeaves: Array<{ nodeLabel: string }> } }> };

      expect(report.packets.map((packet) => packet.target.columnName)).toEqual(['name', 'order_id']);
      expect(report.packets.flatMap((packet) => packet.columnLineage.sourceLeaves.map((source) => source.nodeLabel))).toEqual([
        'customers',
        'orders',
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
