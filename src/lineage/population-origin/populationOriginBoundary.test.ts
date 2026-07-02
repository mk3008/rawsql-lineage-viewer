import { describe, expect, it } from 'vitest';
import { analyzeSql } from '../rawsqlAdapter';

describe('population-origin boundary', () => {
  it('population-origin keeps WHERE references in scopes without adding node columns', () => {
    const { lineage } = analyzeSql(`
      SELECT customer_id
      FROM orders
      WHERE status = 'open'
    `);

    const orders = lineage.nodes.find((node) => node.id === 'table_orders');
    const scope = lineage.scopes.find((item) => item.nodeId === 'main_output');

    expect(orders?.columns.map((column) => column.name)).toEqual(['customer_id']);
    expect(scope?.where?.[0]).toMatchObject({
      expressionSql: "status = 'open'",
      references: [expect.objectContaining({ nodeId: 'table_orders', columnName: 'status' })],
    });
  });

  it('population-origin keeps HAVING and ORDER BY references in scopes without adding node columns', () => {
    const { lineage } = analyzeSql(`
      SELECT customer_id, count(*) AS order_count
      FROM orders
      GROUP BY customer_id
      HAVING max(created_at) > :min_created_at
      ORDER BY max(created_at) DESC
    `);

    const orders = lineage.nodes.find((node) => node.id === 'table_orders');
    const output = lineage.nodes.find((node) => node.id === 'main_output');
    const scope = lineage.scopes.find((item) => item.nodeId === 'main_output');

    expect(output?.columns.map((column) => column.name)).toEqual(['customer_id', 'order_count']);
    expect(orders?.columns.map((column) => column.name)).toEqual(['customer_id']);
    expect(scope?.having?.[0]).toMatchObject({
      expressionSql: 'max(created_at) > :min_created_at',
      references: [expect.objectContaining({ nodeId: 'table_orders', columnName: 'created_at' })],
    });
    expect(scope?.orderBy?.[0]).toMatchObject({
      expressionSql: 'max(created_at) desc',
      references: [expect.objectContaining({ nodeId: 'table_orders', columnName: 'created_at' })],
    });
  });

  it('population-origin records LIMIT / row influence without adding node columns', () => {
    const { lineage } = analyzeSql(`
      SELECT customer_id
      FROM orders
      LIMIT 10
    `);

    const orders = lineage.nodes.find((node) => node.id === 'table_orders');
    const output = lineage.nodes.find((node) => node.id === 'main_output');
    const scope = lineage.scopes.find((item) => item.nodeId === 'main_output');

    expect(output?.columns.map((column) => column.name)).toEqual(['customer_id']);
    expect(orders?.columns.map((column) => column.name)).toEqual(['customer_id']);
    expect(scope?.limit).toMatchObject({
      expressionSql: expect.stringContaining('10'),
      kind: 'limit',
      references: [],
    });
  });

  it('records SELECT DISTINCT separately from GROUP BY and LIMIT without marking individual columns', () => {
    const { lineage } = analyzeSql(`
      SELECT DISTINCT a, b
      FROM t
    `);

    const output = lineage.nodes.find((node) => node.id === 'main_output');
    const scope = lineage.scopes.find((item) => item.nodeId === 'main_output');

    expect(output?.columns.map((column) => ({ name: column.name, usage: column.usage }))).toEqual([
      { name: 'a', usage: undefined },
      { name: 'b', usage: undefined },
    ]);
    expect(scope?.distinct).toMatchObject({
      expressionSql: 'select distinct',
      impact: ['may_deduplicate_rows'],
      kind: 'distinct',
      references: [],
    });
    expect(scope?.groupBy).toEqual([]);
    expect(scope?.limit).toBeUndefined();
  });

  it('records DISTINCT ON keys and keeps ORDER BY influence without GROUP BY or LIMIT substitution', () => {
    const { lineage } = analyzeSql(`
      SELECT DISTINCT ON (a) a, b
      FROM t
      ORDER BY a, b DESC
    `);

    const output = lineage.nodes.find((node) => node.id === 'main_output');
    const scope = lineage.scopes.find((item) => item.nodeId === 'main_output');

    expect(output?.columns.map((column) => ({ name: column.name, usage: column.usage }))).toEqual([
      { name: 'a', usage: undefined },
      { name: 'b', usage: undefined },
    ]);
    expect(scope?.distinctOn?.[0]).toMatchObject({
      expressionSql: 'a',
      impact: ['may_deduplicate_rows', 'may_change_order'],
      kind: 'distinct_on',
      references: [expect.objectContaining({ nodeId: 'table_t', columnName: 'a' })],
    });
    expect(scope?.orderBy?.map((item) => item.expressionSql)).toEqual(['a', 'b desc']);
    expect(scope?.groupBy).toEqual([]);
    expect(scope?.limit).toBeUndefined();
  });
});
