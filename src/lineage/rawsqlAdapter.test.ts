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

  it('records CASE expression rules with branch-level lineage', () => {
    const { lineage } = analyzeSql(`
      SELECT
        CASE
          WHEN p.last_paid_at IS NULL THEN 'unknown'
          WHEN p.last_paid_at < CURRENT_DATE THEN p.status
          ELSE p.customer_id
        END AS payment_status
      FROM payments p
    `);
    const outputNode = lineage.nodes.find((node) => node.id === 'main_output');
    const rules = outputNode?.columns.find((column) => column.name === 'payment_status')?.caseRules;

    expect(rules).toHaveLength(3);
    expect(rules?.[0]).toMatchObject({
      id: 'case_1_when_1',
      label: 'when p.last_paid_at is null',
      conditionUpstream: [{ nodeId: 'table_payments', columnName: 'last_paid_at' }],
      resultUpstream: [],
    });
    expect(rules?.[1]).toMatchObject({
      id: 'case_1_when_2',
      conditionUpstream: [{ nodeId: 'table_payments', columnName: 'last_paid_at' }],
      resultUpstream: [{ nodeId: 'table_payments', columnName: 'status' }],
    });
    expect(rules?.[2]).toMatchObject({
      id: 'case_1_else',
      label: 'else',
      conditionUpstream: [],
      resultUpstream: [{ nodeId: 'table_payments', columnName: 'customer_id' }],
    });
  });

  it('records simple and composite CASE expression rules', () => {
    const { lineage } = analyzeSql(`
      SELECT
        CASE p.status WHEN 'paid' THEN p.amount ELSE 0 END AS simple_case,
        p.customer_id || CASE WHEN p.is_active THEN p.email ELSE p.name END AS composite_case,
        CASE WHEN p.status = 'paid' THEN p.amount END || CASE WHEN p.status = 'failed' THEN p.customer_id END AS double_case
      FROM payments p
    `);
    const outputNode = lineage.nodes.find((node) => node.id === 'main_output');
    const simpleCase = outputNode?.columns.find((column) => column.name === 'simple_case')?.caseRules;
    const compositeCase = outputNode?.columns.find((column) => column.name === 'composite_case')?.caseRules;
    const doubleCase = outputNode?.columns.find((column) => column.name === 'double_case')?.caseRules;

    expect(simpleCase?.[0]).toMatchObject({
      label: "when p.status = 'paid'",
      conditionUpstream: [{ nodeId: 'table_payments', columnName: 'status' }],
      resultUpstream: [{ nodeId: 'table_payments', columnName: 'amount' }],
    });
    expect(compositeCase).toHaveLength(2);
    expect(compositeCase?.[0]).toMatchObject({
      caseLabel: 'case 1',
      conditionUpstream: [{ nodeId: 'table_payments', columnName: 'is_active' }],
      resultUpstream: [{ nodeId: 'table_payments', columnName: 'email' }],
    });
    expect(doubleCase?.map((rule) => rule.caseLabel)).toEqual(['case 1', 'case 2']);
  });

  it('records CASE rules for a commented output CASE without AS alias', () => {
    const { lineage } = analyzeSql(`
      /* Monthly customer health report. */
      with order_base as (
        select o.id,o.customer_id,o.status,o.total_amount,o.created_at
        from orders o
        where o.created_at >= :report_from
          and o.status in (:paid_status,:shipped_status,:refunded_status)
      ),
      customer_order_summary as(
        select c.id customer_id,c.name,c.email,c.tier,
          count(ob.id) order_count,
          sum(case
            when ob.status = :refunded_status then 0
            else ob.total_amount
          end) gross_amount,
          max(ob.created_at) last_order_at
        from customers c
        left join order_base ob on ob.customer_id = c.id
        where c.deleted_at is null
        group by c.id,c.name,c.email,c.tier
      ),
      support_pressure as (
        select st.customer_id, count(st.id) open_ticket_count
        from support_tickets st
        where st.status <> 'closed'
        group by st.customer_id
      ),
      ranked_customers as(
        select cos.customer_id,cos.name,cos.email,cos.tier,cos.order_count,cos.gross_amount,cos.last_order_at,
          coalesce(sp.open_ticket_count,0) open_ticket_count,
          row_number() over(partition by cos.tier order by cos.gross_amount desc,cos.customer_id) tier_rank
        from customer_order_summary cos
        left join support_pressure sp on sp.customer_id = cos.customer_id
        where cos.order_count > 0
      )
      select rc.customer_id,rc.name,rc.email,rc.tier,
        case
          /* Enterprise names asked for this bucket in 2023; do not merge with repeat yet. */
          when rc.tier = :enterprise_tier and rc.gross_amount >= :strategic_amount then :strategic_label
          /* Support wants open-ticket customers to stay visible even below revenue threshold. */
          when rc.open_ticket_count > :open_ticket_threshold then :attention_label
          /* Three or more orders is the old retention definition. Still used by exports. */
          when rc.order_count >= :repeat_order_count then :repeat_label
          else :standard_label
        end customer_segment,
        rc.order_count,rc.gross_amount,rc.open_ticket_count,rc.last_order_at
      from ranked_customers rc
    `);
    const outputNode = lineage.nodes.find((node) => node.id === 'main_output');
    const customerSegment = outputNode?.columns.find((column) => column.name === 'customer_segment');

    expect(customerSegment?.caseRules).toHaveLength(4);
    expect(customerSegment?.caseRules?.[0]).toMatchObject({
      conditionUpstream: [
        { nodeId: 'cte_ranked_customers', columnName: 'tier' },
        { nodeId: 'cte_ranked_customers', columnName: 'gross_amount' },
      ],
    });
    expect(customerSegment?.caseRules?.[0].label.replace(/\s+/g, ' ')).toBe(
      'when rc.tier = :enterprise_tier and rc.gross_amount >= :strategic_amount',
    );
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

  it('wraps long expression display SQL at token boundaries', () => {
    const { lineage } = analyzeSql(`
      SELECT
        CASE
          WHEN q.total_tax - q.cumulative_adjustment_amount > 0 THEN q.total_tax - q.cumulative_adjustment_amount
          ELSE 0
        END AS adjusted_tax
      FROM (
        SELECT 100 AS total_tax, 20 AS cumulative_adjustment_amount
      ) q
    `);
    const outputNode = lineage.nodes.find((node) => node.id === 'main_output');
    const expressionSql = outputNode?.columns.find((column) => column.name === 'adjusted_tax')?.expressionSql;

    expect(expressionSql).toContain('case\n');
    expect(expressionSql).toContain('q.cumulative_adjustment_amount');
    expect(expressionSql?.split('\n').every((line) => line.length <= 42)).toBe(true);
  });

  it('classifies condition-only and unused CTE columns', () => {
    const { lineage } = analyzeSql(`
      WITH recent_orders AS (
        SELECT id, customer_id, status, created_at
        FROM orders
      )
      SELECT ro.customer_id
      FROM recent_orders ro
      WHERE ro.status = 'open'
    `);
    const recentOrders = lineage.nodes.find((node) => node.id === 'cte_recent_orders');

    expect(recentOrders?.columns.find((column) => column.name === 'customer_id')?.usage).toBeUndefined();
    expect(recentOrders?.columns.find((column) => column.name === 'status')?.usage).toEqual({
      role: 'condition',
      reasons: ['where'],
    });
    expect(recentOrders?.columns.find((column) => column.name === 'id')?.usage).toEqual({ role: 'unused' });
    expect(recentOrders?.columns.find((column) => column.name === 'created_at')?.usage).toEqual({ role: 'unused' });
  });

  it('classifies grouped output columns as GROUP BY usage before downstream joins', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const orderTotals = lineage.nodes.find((node) => node.id === 'cte_order_totals');

    expect(orderTotals?.columns.find((column) => column.name === 'customer_id')?.usage).toEqual({
      role: 'condition',
      reasons: ['groupBy'],
    });
  });

  it('adds scalar subquery sources and condition columns to lineage', () => {
    const { lineage } = analyzeSql(`
      WITH ranked_customers AS (
        SELECT c.id AS customer_id
        FROM customers c
      )
      SELECT
        rc.customer_id,
        (
          SELECT count(*)
          FROM orders AS o2
          WHERE o2.customer_id = rc.customer_id
            AND o2.created_at >= :recent_order_from
            AND o2.status <> :refunded_status
        ) AS recent_order_count
      FROM ranked_customers rc
    `);
    const orders = lineage.nodes.find((node) => node.id === 'table_orders');
    const output = lineage.nodes.find((node) => node.id === 'main_output');
    const recentOrderCount = output?.columns.find((column) => column.name === 'recent_order_count');

    expect(lineage.edges).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'table_orders', target: 'main_output', sourceAlias: 'o2' })]));
    expect(orders?.columns.map((column) => column.name)).toEqual(['customer_id', 'created_at', 'status']);
    expect(orders?.columns.every((column) => column.usage?.role === 'condition')).toBe(true);
    expect(recentOrderCount?.upstream).toEqual(
      expect.arrayContaining([
        { nodeId: 'table_orders', columnName: 'customer_id' },
        { nodeId: 'table_orders', columnName: 'created_at' },
        { nodeId: 'table_orders', columnName: 'status' },
      ]),
    );
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
