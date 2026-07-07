import { describe, expect, it } from 'vitest';
import { analyzeSql } from '../rawsqlAdapter';
import { parseSchemaFactsFromDdl } from '../schemaFacts';

describe('source-references boundary', () => {
  it('source-references resolves qualified predicate references without adding display columns', () => {
    const { lineage } = analyzeSql(`
      SELECT c.name
      FROM customers c
      JOIN orders o ON o.customer_id = c.id
      WHERE o.status = 'open'
    `, { optimizeConditions: false });

    const customers = lineage.nodes.find((node) => node.id === 'table_customers');
    const orders = lineage.nodes.find((node) => node.id === 'table_orders');
    const scope = lineage.scopes.find((item) => item.nodeId === 'main_output');

    expect(scope?.joins?.[0].condition?.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'table_orders', columnName: 'customer_id' }),
      expect.objectContaining({ nodeId: 'table_customers', columnName: 'id' }),
    ]));
    expect(scope?.where?.[0].references).toEqual([
      expect.objectContaining({ nodeId: 'table_orders', columnName: 'status' }),
    ]);
    expect(customers?.columns.map((column) => column.name)).toEqual(['name']);
    expect(orders?.columns).toEqual([]);
  });

  it('source-references resolves unqualified references when schema facts make the source unambiguous', () => {
    const schemaFacts = parseSchemaFactsFromDdl([{
      sql: `
        CREATE TABLE customers (id int, name text);
        CREATE TABLE orders (customer_id int, status text);
      `,
    }]);

    const { lineage } = analyzeSql(`
      SELECT c.name
      FROM customers c
      JOIN orders o ON o.customer_id = c.id
      WHERE status = 'open'
    `, { schemaFacts });

    const scope = lineage.scopes.find((item) => item.nodeId === 'main_output');

    expect(scope?.where?.[0].references).toEqual([
      expect.objectContaining({ nodeId: 'table_orders', columnName: 'status' }),
    ]);
    expect(lineage.analysisWarnings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'deadlink_ambiguous_unqualified_column' }),
    ]));
  });

  it('source-references reports ambiguity when unqualified references match multiple sources', () => {
    const schemaFacts = parseSchemaFactsFromDdl([{
      sql: `
        CREATE TABLE customers (id int, name text);
        CREATE TABLE orders (id int, customer_id int);
      `,
    }]);

    const { lineage } = analyzeSql(`
      SELECT c.name
      FROM customers c
      JOIN orders o ON o.customer_id = c.id
      WHERE id > 0
    `, { schemaFacts });

    const scope = lineage.scopes.find((item) => item.nodeId === 'main_output');

    expect(scope?.where?.[0].references).toEqual([]);
    expect(lineage.analysisWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'deadlink_ambiguous_unqualified_column' }),
    ]));
  });
});
