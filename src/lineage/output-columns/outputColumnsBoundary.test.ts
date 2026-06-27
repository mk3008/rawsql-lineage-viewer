import { describe, expect, it } from 'vitest';
import { analyzeSql } from '../rawsqlAdapter';

describe('output-columns boundary', () => {
  it('output-columns keeps WHERE-only references out of display columns', () => {
    const { lineage } = analyzeSql(`
      SELECT customer_id
      FROM orders
      WHERE status = 'open'
    `);

    const orders = lineage.nodes.find((node) => node.id === 'table_orders');
    const output = lineage.nodes.find((node) => node.id === 'main_output');

    expect(output?.columns.map((column) => column.name)).toEqual(['customer_id']);
    expect(orders?.columns.map((column) => column.name)).toEqual(['customer_id']);
    expect(orders?.columns.some((column) => column.name === 'status')).toBe(false);
  });

  it('output-columns keeps JOIN ON-only references out of display columns', () => {
    const { lineage } = analyzeSql(`
      SELECT c.name
      FROM customers c
      JOIN orders o ON o.customer_id = c.id
    `);

    const customers = lineage.nodes.find((node) => node.id === 'table_customers');
    const orders = lineage.nodes.find((node) => node.id === 'table_orders');
    const output = lineage.nodes.find((node) => node.id === 'main_output');

    expect(output?.columns.map((column) => column.name)).toEqual(['name']);
    expect(customers?.columns.map((column) => column.name)).toEqual(['name']);
    expect(customers?.columns.some((column) => column.name === 'id')).toBe(false);
    expect(orders?.columns).toEqual([]);
  });

  it('output-columns keeps real SELECT aliases such as "condition 1" in display columns', () => {
    const { lineage } = analyzeSql(`
      SELECT status AS "condition 1"
      FROM orders
      WHERE created_at >= :from_date
    `);

    const orders = lineage.nodes.find((node) => node.id === 'table_orders');
    const output = lineage.nodes.find((node) => node.id === 'main_output');

    expect(output?.columns.map((column) => column.name)).toEqual(['condition 1']);
    expect(output?.columns.find((column) => column.name === 'condition 1')?.upstream).toEqual([
      { nodeId: 'table_orders', columnName: 'status' },
    ]);
    expect(orders?.columns.map((column) => column.name)).toEqual(['status']);
    expect(orders?.columns.some((column) => column.name === 'created_at')).toBe(false);
  });

  it('output-columns assigns unique ids to non-Latin SELECT aliases', () => {
    const { lineage } = analyzeSql(`
      SELECT
        c.id AS "顧客ID",
        c.account_code AS "顧客コード",
        c.legal_name AS "法人名",
        c.display_name AS "表示名"
      FROM customers c
    `);

    const output = lineage.nodes.find((node) => node.id === 'main_output');
    const outputColumns = output?.columns ?? [];

    expect(outputColumns.map((column) => column.name)).toEqual(['顧客ID', '顧客コード', '法人名', '表示名']);
    expect(new Set(outputColumns.map((column) => column.id)).size).toBe(outputColumns.length);
    expect(outputColumns.map((column) => column.selectItemId)).toEqual([
      'scope_main_output_output_1',
      'scope_main_output_output_2',
      'scope_main_output_output_3',
      'scope_main_output_output_4',
    ]);
  });
});
