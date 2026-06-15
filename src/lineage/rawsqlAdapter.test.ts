import { describe, expect, it } from 'vitest';
import { salesSummarySql } from '../examples/salesSummarySql';
import { analyzeSql } from './rawsqlAdapter';

const heavySelectSql = `with order_base as (
  select o.id, o.customer_id, o.status, o.total_amount, o.created_at
  from orders o
  where o.created_at >= :report_from
),
customer_order_summary as (
  select
    c.id customer_id,
    c.name,
    count(ob.id) order_count,
    sum(case when ob.status = :refunded_status then 0 else ob.total_amount end) gross_amount
  from customers c
  left join order_base ob on ob.customer_id = c.id
  where c.deleted_at is null
  group by c.id, c.name
),
support_pressure as (
  select st.customer_id, count(st.id) open_ticket_count
  from support_tickets st
  where st.status <> 'closed'
  group by st.customer_id
),
ranked_customers as (
  select
    cos.customer_id,
    cos.name,
    cos.order_count,
    cos.gross_amount,
    coalesce(sp.open_ticket_count, 0) open_ticket_count,
    row_number() over(partition by cos.name order by cos.gross_amount desc) tier_rank
  from customer_order_summary cos
  left join support_pressure sp on sp.customer_id = cos.customer_id
)
select
  rc.customer_id,
  rc.name,
  (
    select count(*)
    from orders o2
    where o2.customer_id = rc.customer_id
  ) recent_order_count,
  p.name favorite_product
from ranked_customers rc
left join customer_favorites cf on cf.customer_id = rc.customer_id and cf.is_active = true
left join products p on p.id = cf.product_id
where exists (
  select 1
  from customer_favorites cf2
  where cf2.customer_id = rc.customer_id and cf2.is_active = true
)
order by rc.customer_id`;

function edgesTargetingTables(sql: string) {
  const { lineage } = analyzeSql(sql);
  const tableNodeIds = new Set(lineage.nodes.filter((node) => node.type === 'table').map((node) => node.id));
  return lineage.edges.filter((edge) => tableNodeIds.has(edge.target));
}

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

  it('records source-to-result data flows with outer join nullability context', () => {
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

    const dataFlowEdges = lineage.edges.filter((edge) => edge.type === 'dataFlow');

    expect(dataFlowEdges).toHaveLength(7);
    expect(lineage.edges.every((edge) => edge.type === 'dataFlow')).toBe(true);
    expect(dataFlowEdges.find((edge) => edge.id === 'table_order_items-cte_recent_orders')).toMatchObject({
      label: 'JOIN',
      sourceAlias: 'oi',
    });
    expect(dataFlowEdges.find((edge) => edge.id === 'cte_order_totals-main_output')).toMatchObject({
      label: 'LEFT JOIN',
      sourceAlias: 'ot',
      joinNullability: {
        reason: 'outerJoin',
        joinType: 'left',
      },
    });
    expect(dataFlowEdges.find((edge) => edge.id === 'cte_payment_summary-main_output')).toMatchObject({
      label: 'LEFT JOIN',
      sourceAlias: 'ps',
      joinNullability: {
        reason: 'outerJoin',
        joinType: 'left',
      },
    });
    expect(dataFlowEdges.find((edge) => edge.id === 'table_customers-main_output')?.sourceAlias).toBe('c');
    expect(dataFlowEdges.find((edge) => edge.id === 'table_customers-main_output')?.joinNullability).toBeUndefined();
    expect(dataFlowEdges.find((edge) => edge.id === 'table_order_items-cte_recent_orders')?.joinNullability).toBeUndefined();
  });

  it('populates output and referenced source columns', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const columnsByNodeId = new Map(lineage.nodes.map((node) => [node.id, node.columns.map((column) => column.name)]));

    expect(columnsByNodeId.get('cte_recent_orders')).toEqual([
      'order_id',
      'customer_id',
      'order_date',
      'product_id',
      'quantity',
      'unit_price',
      'amount',
    ]);
    expect(columnsByNodeId.get('table_orders')).toEqual(['id', 'customer_id', 'order_date']);
    expect(columnsByNodeId.get('table_order_items')).toEqual(['product_id', 'quantity', 'unit_price', 'order_id']);
    expect(columnsByNodeId.get('table_payments')).toEqual(['customer_id', 'amount', 'paid_at', 'status']);
    expect(columnsByNodeId.get('main_output')).toEqual([
      'customer_id',
      'customer_name',
      'email',
      'order_count',
      'total_amount',
      'paid_amount',
      'payment_status',
    ]);
  });

  it('records upstream column lineage for output columns through CTEs', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const nodeById = new Map(lineage.nodes.map((node) => [node.id, node]));

    expect(nodeById.get('main_output')?.columns.find((column) => column.name === 'total_amount')?.upstream).toEqual([
      { nodeId: 'cte_order_totals', columnName: 'total_amount' },
    ]);
    expect(nodeById.get('cte_order_totals')?.columns.find((column) => column.name === 'total_amount')?.upstream).toEqual([
      { nodeId: 'cte_recent_orders', columnName: 'amount' },
    ]);
    expect(nodeById.get('cte_recent_orders')?.columns.find((column) => column.name === 'amount')?.upstream).toEqual([
      { nodeId: 'table_order_items', columnName: 'quantity' },
      { nodeId: 'table_order_items', columnName: 'unit_price' },
    ]);
  });

  it('records comments for CTEs and output columns', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const nodeById = new Map(lineage.nodes.map((node) => [node.id, node]));

    expect(nodeById.get('cte_recent_orders')?.comments).toEqual(['Recent order line items used as the base sales fact.']);
    expect(nodeById.get('cte_recent_orders')?.columns.find((column) => column.name === 'amount')?.comments).toEqual(['Extended line amount.']);
    expect(nodeById.get('cte_recent_orders')?.columns.find((column) => column.name === 'amount')?.expressionSql).toBe(
      'oi.quantity * oi.unit_price',
    );
    expect(nodeById.get('main_output')?.columns.find((column) => column.name === 'payment_status')?.expressionSql).toContain(
      "\n    when ps.last_paid_at is null then\n        'unknown'",
    );
    expect(nodeById.get('cte_order_totals')?.comments).toEqual(['Aggregates order metrics by customer.']);
    expect(nodeById.get('cte_order_totals')?.columns.find((column) => column.name === 'total_amount')?.comments).toEqual([
      'Total ordered amount per customer.',
    ]);
  });

  it('records title comments for output and derived nodes', () => {
    const { lineage } = analyzeSql(`
      -- Final output comment.
      SELECT src.id AS user_id -- Output id comment.
      FROM (
        -- Derived source comment.
        SELECT id -- Derived id comment.
        FROM users
      ) src
    `);
    const outputNode = lineage.nodes.find((node) => node.id === 'main_output');
    const derivedNode = lineage.nodes.find((node) => node.type === 'derived' && node.label === 'src');

    expect(outputNode?.comments).toEqual(expect.arrayContaining(['Final output comment.', 'Output id comment.']));
    expect(derivedNode?.comments).toEqual(expect.arrayContaining(['Derived source comment.', 'Derived id comment.']));
  });

  it('models nested FROM subqueries with repeated aliases as distinct derived nodes', () => {
    const { lineage } = analyzeSql(`
      SELECT q.customer_id, q.total_amount
      FROM (
        SELECT q.customer_id, q.total_amount
        FROM (
          SELECT o.customer_id, SUM(o.amount) AS total_amount
          FROM orders o
          GROUP BY o.customer_id
        ) q
      ) q
    `);
    const derivedNodes = lineage.nodes.filter((node) => node.type === 'derived' && node.label === 'q');

    expect(derivedNodes).toHaveLength(2);
    expect(new Set(derivedNodes.map((node) => node.id)).size).toBe(2);
    expect(lineage.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'table_orders', target: expect.stringMatching(/^derived_q_/) }),
        expect.objectContaining({ source: expect.stringMatching(/^derived_q_/), target: 'main_output' }),
      ]),
    );
  });

  it('records executable SQL for CTEs with required dependencies', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const nodeById = new Map(lineage.nodes.map((node) => [node.id, node]));
    const recentOrdersSql = nodeById.get('cte_recent_orders')?.cteExecutableSql?.toLowerCase();
    const orderTotalsSql = nodeById.get('cte_order_totals')?.cteExecutableSql?.toLowerCase();
    const paymentSummarySql = nodeById.get('cte_payment_summary')?.cteExecutableSql?.toLowerCase();

    expect(recentOrdersSql).toContain('-- recent order line items used as the base sales fact.');
    expect(recentOrdersSql).toContain('-- extended line amount.');
    expect(recentOrdersSql).toMatch(/from\s+orders as o/);
    expect(orderTotalsSql).toMatch(/with\s+recent_orders as/);
    expect(orderTotalsSql).toContain('-- aggregates order metrics by customer.');
    expect(orderTotalsSql).toContain('-- total ordered amount per customer.');
    expect(orderTotalsSql).toContain('sum(amount) as total_amount');
    expect(paymentSummarySql).toContain('-- captures succeeded payment totals by customer.');
    expect(paymentSummarySql).toMatch(/from\s+payments as p/);
  });

  it('uses comments before the inner CTE select query as CTE comments', () => {
    const { lineage } = analyzeSql(`
      WITH recent_orders AS (
        -- Inner select comment for the CTE.
        SELECT id AS order_id
        FROM orders
      )
      SELECT order_id FROM recent_orders
    `);

    expect(lineage.nodes.find((node) => node.id === 'cte_recent_orders')?.comments).toEqual(['Inner select comment for the CTE.']);
  });

  it('routes joined source data flows toward the query result instead of into joined sources', () => {
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
          id: 'cte_order_totals-main_output',
          source: 'cte_order_totals',
          target: 'main_output',
          type: 'dataFlow',
          joinNullability: {
            reason: 'outerJoin',
            joinType: 'left',
          },
        }),
        expect.objectContaining({
          id: 'cte_payment_summary-main_output',
          source: 'cte_payment_summary',
          target: 'main_output',
          type: 'dataFlow',
          joinNullability: {
            reason: 'outerJoin',
            joinType: 'left',
          },
        }),
      ]),
    );
  });

  it('does not target physical tables in SELECT lineage edges, even for heavy nested queries', () => {
    expect(edgesTargetingTables(heavySelectSql)).toEqual([]);
  });
});
