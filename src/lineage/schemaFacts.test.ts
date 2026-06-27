import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SelectOutputCollector, SqlParser } from 'rawsql-ts';
import { describe, expect, it } from 'vitest';
import { buildColumnDiagnosticPacket } from './diagnostics';
import { analyzeSql } from './rawsqlAdapter';
import { createTableColumnResolver, isUniqueKey, parseSchemaFactsFromDdl } from './schemaFacts';

describe('schema facts', () => {
  it('parses CREATE TABLE facts including columns, primary key, unique, nullable, and foreign keys', () => {
    const facts = parseSchemaFactsFromDdl([{
      sql: `
        create table customers (
          id int primary key,
          name text not null,
          email text,
          account_id int references accounts(id),
          unique(email)
        );
      `,
    }]);

    expect(facts).toMatchObject({
      kind: 'schema-facts',
      version: 1,
    });
    expect(facts.tables.customers).toMatchObject({
      columns: {
        account_id: { name: 'account_id', nullable: true, type: 'int' },
        email: { name: 'email', nullable: true, type: 'text' },
        id: { name: 'id', nullable: false, type: 'int' },
        name: { name: 'name', nullable: false, type: 'text' },
      },
      foreignKeys: [
        { columns: ['account_id'], refColumns: ['id'], refTable: 'accounts' },
      ],
      primaryKey: ['id'],
      uniqueKeys: [['email']],
    });
  });

  it('parses UNIQUE indexes and exposes a table column resolver', () => {
    const facts = parseSchemaFactsFromDdl([{
      sql: `
        create table public.orders (
          id int primary key,
          customer_id int not null,
          order_date date
        );
        create unique index orders_customer_uq on public.orders(customer_id);
      `,
    }]);
    const resolver = createTableColumnResolver(facts);

    expect(resolver('orders')).toEqual(['id', 'customer_id', 'order_date']);
    expect(resolver('public.orders')).toEqual(['id', 'customer_id', 'order_date']);
    expect(isUniqueKey(facts, 'orders', ['id'])).toBe(true);
    expect(isUniqueKey(facts, 'orders', ['customer_id'])).toBe(true);
  });

  it('returns parse warnings for unsupported or invalid DDL without failing the facts object', () => {
    const facts = parseSchemaFactsFromDdl([
      { filePath: 'bad.sql', sql: 'not valid ddl' },
    ]);

    expect(facts.diagnostics).toEqual([
      expect.objectContaining({
        code: 'ddl_parse_warning',
        filePath: 'bad.sql',
        severity: 'warning',
      }),
    ]);
  });

  it('uses schema facts to expand wildcard output columns and annotate diagnostics', () => {
    const facts = parseSchemaFactsFromDdl([{
      sql: `
        create table customers (
          id int primary key,
          name text not null,
          email text
        );
      `,
    }]);
    const { lineage } = analyzeSql('select c.* from customers c', { schemaFacts: facts });
    const output = lineage.nodes.find((node) => node.id === 'main_output');

    expect(output?.columns.map((column) => column.name)).toEqual(['id', 'name', 'email']);
    const packet = buildColumnDiagnosticPacket(lineage, {
      columnName: 'id',
      nodeId: 'main_output',
    }, { schemaFacts: facts });
    expect(packet.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'lineage_metadata_added',
        severity: 'info',
      }),
      expect.objectContaining({
        code: 'schema_facts_used',
        severity: 'info',
      }),
    ]));
  });

  it('keeps SQL-only wildcard unresolved as a warning instead of failing analysis', () => {
    const { lineage } = analyzeSql('select * from customers c');

    expect(lineage.nodes.find((node) => node.id === 'main_output')?.columns).toEqual([]);
    expect(lineage.analysisWarnings).toEqual([
      expect.objectContaining({
        code: 'wildcard_unresolved_without_schema',
      }),
    ]);
  });

  it('uses schema facts to resolve unqualified columns when only one source owns the column', () => {
    const facts = parseSchemaFactsFromDdl([{
      sql: `
        create table customers (id int primary key, name text);
        create table orders (order_id int primary key, customer_id int);
      `,
    }]);
    const { lineage } = analyzeSql(`
      select name
      from customers c
      join orders o on o.customer_id = c.id
    `, { schemaFacts: facts });
    const output = lineage.nodes.find((node) => node.id === 'main_output');

    expect(output?.columns.find((column) => column.name === 'name')?.upstream).toEqual([
      { nodeId: 'table_customers', columnName: 'name' },
    ]);
  });

  it('uses schema facts to lower join concern confidence when one join side is unique', () => {
    const facts = parseSchemaFactsFromDdl([{
      sql: `
        create table customers (id int primary key, name text);
        create table orders (id int primary key, customer_id int);
      `,
    }]);
    const { lineage } = analyzeSql(`
      select o.id
      from orders o
      join customers c on c.id = o.customer_id
    `, { schemaFacts: facts });
    const packet = buildColumnDiagnosticPacket(lineage, {
      columnName: 'id',
      nodeId: 'main_output',
    }, { schemaFacts: facts });

    expect(packet.candidateConcerns).toEqual([
      expect.objectContaining({
        confidence: 'low',
        kind: 'join_on',
      }),
    ]);
  });

  it('does not lower join concern confidence when only the preserved side is unique', () => {
    const facts = parseSchemaFactsFromDdl([{
      sql: `
        create table orders (id int primary key);
        create table order_items (id int primary key, order_id int);
      `,
    }]);
    const { lineage } = analyzeSql(`
      select o.id
      from orders o
      join order_items oi on o.id = oi.order_id
    `, { schemaFacts: facts });
    const packet = buildColumnDiagnosticPacket(lineage, {
      columnName: 'id',
      nodeId: 'main_output',
    }, { schemaFacts: facts });

    expect(packet.candidateConcerns).toEqual([
      expect.objectContaining({
        confidence: 'possible',
        kind: 'join_on',
      }),
    ]);
  });

  it('uses schema facts to promote nullable COALESCE as a candidate concern', () => {
    const facts = parseSchemaFactsFromDdl([{
      sql: `
        create table customers (id int primary key);
        create table payments (customer_id int, amount numeric);
      `,
    }]);
    const { lineage } = analyzeSql(`
      with payment_summary as (
        select customer_id, sum(amount) as paid_amount
        from payments
        group by customer_id
      )
      select coalesce(ps.paid_amount, 0) as paid_amount
      from customers c
      left join payment_summary ps on ps.customer_id = c.id
    `, { schemaFacts: facts });
    const packet = buildColumnDiagnosticPacket(lineage, {
      columnName: 'paid_amount',
      nodeId: 'main_output',
    }, { schemaFacts: facts });

    expect(packet.candidateConcerns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'null_replacement_expression',
          reason: expect.stringContaining('replace NULL values'),
        }),
      ]),
    );
  });

  it('matches rawsql-ts SelectOutputCollector wildcard names for representative sources', () => {
    const facts = parseSchemaFactsFromDdl([{
      sql: `
        create table public.customers (id int, name text);
        create table orders (order_id int, customer_id int);
      `,
    }]);
    const cases = [
      'select * from public.customers c',
      'select c.* from public.customers c',
      'select * from public.customers c join orders o on o.customer_id = c.id',
      'with x as (select id, name from public.customers) select x.* from x',
      'select q.* from (select id, name from public.customers) q',
    ];

    for (const sql of cases) {
      const rawsqlColumns = collectRawsqlSelectValueNames(sql, facts);
      const { lineage } = analyzeSql(sql, { schemaFacts: facts });
      const adapterColumns = lineage.nodes.find((node) => node.id === 'main_output')?.columns.map((column) => column.name);

      expect(adapterColumns).toEqual(rawsqlColumns);
    }
  });

  it('matches rawsql-ts expanded wildcard expressions for quoted identifiers', () => {
    const facts = parseSchemaFactsFromDdl([{
      sql: 'create table "Customers" ("ID" int, "Name" text);',
    }]);
    const sql = 'select c.* from "Customers" c';
    const rawsqlColumns = collectRawsqlSelectValues(sql, facts);
    const { lineage } = analyzeSql(sql, { schemaFacts: facts });
    const adapterColumns = lineage.nodes.find((node) => node.id === 'main_output')?.columns.map((column) => ({
      name: column.name,
      sql: column.expressionSql,
    }));

    expect(adapterColumns).toEqual(rawsqlColumns);
  });

  it('preserves rawsql-ts duplicate wildcard outputs while adding LineageModel metadata', () => {
    const facts = parseSchemaFactsFromDdl([{
      sql: `
        create table customers (id int, name text);
        create table orders (id int, customer_id int);
      `,
    }]);
    const sql = 'select * from customers c join orders o on o.customer_id = c.id';
    const rawsqlColumns = collectRawsqlSelectValues(sql, facts);
    const { lineage } = analyzeSql(sql, { schemaFacts: facts });
    const outputIds = lineage.nodes.find((node) => node.id === 'main_output')?.columns.filter((column) => column.name === 'id');
    const packet = buildColumnDiagnosticPacket(lineage, {
      columnName: 'id',
      nodeId: 'main_output',
      outputIndex: 0,
    }, { schemaFacts: facts });

    expect(rawsqlColumns.filter((column) => column.name === 'id')).toEqual([
      { name: 'id', sql: 'c.id' },
      { name: 'id', sql: 'o.id' },
    ]);
    expect(lineage.analysisWarnings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'rawsql_duplicate_output_columns_deduped',
      }),
    ]));
    expect(outputIds).toEqual([
      expect.objectContaining({
        name: 'id',
        outputIndex: 0,
        selectItemId: 'scope_main_output_output_1',
        scopeId: 'scope_main_output',
        upstream: [
          { columnName: 'id', nodeId: 'table_customers' },
        ],
      }),
      expect.objectContaining({
        name: 'id',
        outputIndex: 2,
        selectItemId: 'scope_main_output_output_3',
        scopeId: 'scope_main_output',
        upstream: [
          { columnName: 'id', nodeId: 'table_orders' },
        ],
      }),
    ]);
    expect(outputIds?.[0]?.upstream).not.toEqual(expect.arrayContaining([
      { columnName: 'id', nodeId: 'table_orders' },
    ]));
    expect(packet.target).toMatchObject({
      columnName: 'id',
      outputIndex: 0,
      selectItemId: 'scope_main_output_output_1',
    });
    expect(packet.columnLineage.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        columnName: 'id',
        nodeId: 'table_customers',
      }),
    ]));
    expect(packet.columnLineage.references).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        columnName: 'id',
        nodeId: 'table_orders',
      }),
    ]));
  });
});

function collectRawsqlSelectValueNames(sql: string, facts: ReturnType<typeof parseSchemaFactsFromDdl>): string[] {
  return collectRawsqlSelectValues(sql, facts).map((column) => column.name);
}

function collectRawsqlSelectValues(sql: string, facts: ReturnType<typeof parseSchemaFactsFromDdl>): Array<{ name: string; sql: string }> {
  const query = SqlParser.parse(sql);
  return new SelectOutputCollector(createTableColumnResolver(facts))
    .collect(query)
    .map((value) => ({
      name: value.name,
      sql: String(value.value),
    }));
}

describe('DDL file collection', () => {
  it('collects recursive SQL files in path order and excludes generated directories', async () => {
    const { collectDdlFiles } = await import('../cli/diagnose');
    const root = mkdtempSync(resolve(tmpdir(), 'rawsql-lineage-ddl-'));
    try {
      mkdirSync(resolve(root, 'nested'));
      mkdirSync(resolve(root, 'node_modules'));
      writeFileSync(resolve(root, 'z.sql'), 'create table z(id int);');
      writeFileSync(resolve(root, 'nested', 'a.sql'), 'create table a(id int);');
      writeFileSync(resolve(root, 'node_modules', 'ignored.sql'), 'create table ignored(id int);');
      writeFileSync(resolve(root, 'notes.txt'), 'nope');

      expect(collectDdlFiles(root).map((filePath) => filePath.replace(root, '').replace(/\\/g, '/'))).toEqual([
        '/nested/a.sql',
        '/z.sql',
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
