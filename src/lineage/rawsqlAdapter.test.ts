import { describe, expect, it } from 'vitest';
import { salesSummarySql } from '../examples/salesSummarySql';
import { analyzeSql } from './rawsqlAdapter';

describe('rawsqlAdapter', () => {
  it('builds a lineage model from rawsql-ts AST without Mermaid parsing', () => {
    const { lineage } = analyzeSql(salesSummarySql);

    expect(lineage.raw.adapter).toBe('rawsql-ts-ast');
    expect(lineage.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        'main_output',
        'cte_recent_orders',
        'cte_order_totals',
        'cte_payment_summary',
        'table_customers',
        'table_orders',
        'table_order_items',
        'table_payments',
      ]),
    );
  });

  it('separates source-to-result data flow from source-to-source joins', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const edgeIds = lineage.edges.map((edge) => edge.id);

    expect(edgeIds).toEqual(
      expect.arrayContaining([
        'table_orders-cte_recent_orders',
        'table_order_items-cte_recent_orders',
        'cte_recent_orders-cte_order_totals',
        'table_payments-cte_payment_summary',
        'table_customers-main_output',
        'cte_order_totals-main_output',
        'cte_payment_summary-main_output',
      ]),
    );

    expect(edgeIds).toEqual(
      expect.arrayContaining([
        'table_orders-table_order_items-JOIN',
        'table_customers-cte_order_totals-LEFT_JOIN',
        'table_customers-cte_payment_summary-LEFT_JOIN',
      ]),
    );

    const dataFlowEdges = lineage.edges.filter((edge) => edge.type === 'dataFlow');
    const joinEdges = lineage.edges.filter((edge) => edge.type === 'join');

    expect(dataFlowEdges).toHaveLength(7);
    expect(joinEdges).toHaveLength(3);
    expect(joinEdges.find((edge) => edge.id === 'table_orders-table_order_items-JOIN')?.joinType).toBe('inner');
    expect(joinEdges.find((edge) => edge.id === 'table_customers-cte_order_totals-LEFT_JOIN')?.joinType).toBe('left');
  });

  it('uses join condition aliases to connect joins to the referenced base source', () => {
    const sql = `
      WITH order_totals AS (
        SELECT customer_id, SUM(amount) AS total_amount
        FROM orders
        GROUP BY customer_id
      ),
      payment_summary AS (
        SELECT customer_id, SUM(amount) AS paid_amount
        FROM payments
        GROUP BY customer_id
      )
      SELECT c.id, ot.total_amount, ps.paid_amount
      FROM customers c
      LEFT JOIN order_totals ot ON ot.customer_id = c.id
      LEFT JOIN payment_summary ps ON ps.customer_id = c.id
    `;

    const { lineage } = analyzeSql(sql);

    expect(lineage.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'table_customers-cte_order_totals-LEFT_JOIN',
          source: 'table_customers',
          target: 'cte_order_totals',
          type: 'join',
          joinType: 'left',
        }),
        expect.objectContaining({
          id: 'table_customers-cte_payment_summary-LEFT_JOIN',
          source: 'table_customers',
          target: 'cte_payment_summary',
          type: 'join',
          joinType: 'left',
        }),
      ]),
    );
  });
});
