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

const recursiveEmployeeSql = `WITH RECURSIVE employee_tree AS (
    SELECT
        e.id,
        e.name,
        e.manager_id,
        0 AS depth,
        CAST(e.name AS VARCHAR(1000)) AS path
    FROM
        employees e
    WHERE
        e.manager_id IS NULL

    UNION ALL

    SELECT
        e.id,
        e.name,
        e.manager_id,
        et.depth + 1 AS depth,
        CAST(et.path || ' / ' || e.name AS VARCHAR(1000)) AS path
    FROM
        employees e
        INNER JOIN employee_tree et
            ON e.manager_id = et.id
)
SELECT
    id,
    name,
    manager_id,
    depth,
    path
FROM
    employee_tree
ORDER BY
    path`;

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
        'table_customer_favorites',
      ]),
    );
  });

  it('analyzes CREATE TABLE AS SELECT using only the AS SELECT query', () => {
    const { lineage } = analyzeSql(`
      create table mart.customer_sales as
      select
        c.id as customer_id,
        c.name as customer_name,
        sum(o.amount) as total_amount
      from customers c
      join orders o on o.customer_id = c.id
      group by c.id, c.name
    `);
    const nodeById = new Map(lineage.nodes.map((node) => [node.id, node]));

    expect(nodeById.has('table_customer_sales')).toBe(false);
    expect(nodeById.has('table_mart.customer_sales')).toBe(false);
    expect(nodeById.get('main_output')?.columns.map((column) => column.name)).toEqual(['customer_id', 'customer_name', 'total_amount']);
    expect(nodeById.get('table_customers')?.columns.map((column) => column.name)).toEqual(expect.arrayContaining(['id', 'name']));
    expect(nodeById.get('table_orders')?.columns.map((column) => column.name)).toEqual(expect.arrayContaining(['customer_id', 'amount']));
    expect(nodeById.get('main_output')?.columns.find((column) => column.name === 'total_amount')?.upstream).toEqual([
      { nodeId: 'table_orders', columnName: 'amount' },
    ]);
  });

  it('rejects CREATE TABLE statements without AS SELECT', () => {
    expect(() => analyzeSql('create table customer_sales (customer_id int, total_amount numeric)')).toThrow(
      'CREATE TABLE lineage requires an AS SELECT query.',
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
        'table_customer_favorites-main_output',
      ]),
    );

    const dataFlowEdges = lineage.edges.filter((edge) => edge.type === 'dataFlow');

    expect(dataFlowEdges).toHaveLength(8);
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
    expect(dataFlowEdges.find((edge) => edge.id === 'table_customer_favorites-main_output')).toMatchObject({
      sourceAlias: 'cf',
      confidence: 'medium',
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
      'condition 1',
      'condition 2',
    ]);
    expect(columnsByNodeId.get('table_orders')).toEqual(['id', 'customer_id', 'order_date']);
    expect(columnsByNodeId.get('table_order_items')).toEqual(['product_id', 'quantity', 'unit_price', 'order_id']);
    expect(columnsByNodeId.get('table_payments')).toEqual(['customer_id', 'amount', 'paid_at', 'status']);
    expect(columnsByNodeId.get('table_customer_favorites')).toEqual(['customer_id', 'is_active']);
    expect(columnsByNodeId.get('main_output')).toEqual([
      'customer_id',
      'customer_name',
      'email',
      'order_count',
      'total_amount',
      'paid_amount',
      'payment_status',
      'condition 1',
    ]);
    expect(lineage.nodes.find((node) => node.id === 'main_output')?.columns.find((column) => column.name === 'condition 1')).toMatchObject({
      expressionSql: expect.stringContaining('exists'),
      usage: { role: 'filter', reasons: ['where'] },
      upstream: expect.arrayContaining([
        { nodeId: 'table_customers', columnName: 'id' },
        { nodeId: 'table_customer_favorites', columnName: 'customer_id' },
        { nodeId: 'table_customer_favorites', columnName: 'is_active' },
      ]),
    });
  });

  it('preserves column lineage through UNION queries', () => {
    const { lineage } = analyzeSql(`
      SELECT customer_id, amount
      FROM online_orders
      UNION ALL
      SELECT customer_id, amount
      FROM store_orders
    `);
    const output = lineage.nodes.find((node) => node.id === 'main_output');
    const customerId = output?.columns.find((column) => column.name === 'customer_id');
    const amount = output?.columns.find((column) => column.name === 'amount');

    expect(output?.columns.map((column) => column.name)).toEqual(['customer_id', 'amount']);
    expect(customerId?.upstream).toEqual([
      { nodeId: 'derived_union_all_left_1', columnName: 'customer_id' },
      { nodeId: 'derived_union_all_right_2', columnName: 'customer_id' },
    ]);
    expect(amount?.upstream).toEqual([
      { nodeId: 'derived_union_all_left_1', columnName: 'amount' },
      { nodeId: 'derived_union_all_right_2', columnName: 'amount' },
    ]);
    expect(lineage.nodes.find((node) => node.id === 'derived_union_all_left_1')?.columns.find((column) => column.name === 'customer_id')?.upstream).toEqual([
      { nodeId: 'table_online_orders', columnName: 'customer_id' },
    ]);
    expect(lineage.nodes.find((node) => node.id === 'derived_union_all_right_2')?.columns.find((column) => column.name === 'customer_id')?.upstream).toEqual([
      { nodeId: 'table_store_orders', columnName: 'customer_id' },
    ]);
  });

  it('flattens same-operator UNION chains into sibling graph parts', () => {
    const { lineage } = analyzeSql(`
      SELECT customer_id, amount
      FROM online_orders
      UNION ALL
      SELECT customer_id, amount
      FROM store_orders
      UNION ALL
      SELECT customer_id, amount
      FROM partner_orders
    `);
    const output = lineage.nodes.find((node) => node.id === 'main_output');
    const unionPartNodes = lineage.nodes.filter((node) => node.id.startsWith('derived_union_all_part_'));

    expect(unionPartNodes.map((node) => node.id)).toEqual([
      'derived_union_all_part_1_1',
      'derived_union_all_part_2_2',
      'derived_union_all_part_3_3',
    ]);
    expect(lineage.nodes.some((node) => node.id.includes('left'))).toBe(false);
    expect(lineage.nodes.some((node) => node.id.includes('right'))).toBe(false);
    expect(output?.columns.find((column) => column.name === 'customer_id')?.upstream).toEqual([
      { nodeId: 'derived_union_all_part_1_1', columnName: 'customer_id' },
      { nodeId: 'derived_union_all_part_2_2', columnName: 'customer_id' },
      { nodeId: 'derived_union_all_part_3_3', columnName: 'customer_id' },
    ]);
    expect(lineage.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'derived_union_all_part_1_1', target: 'main_output' }),
        expect.objectContaining({ source: 'derived_union_all_part_2_2', target: 'main_output' }),
        expect.objectContaining({ source: 'derived_union_all_part_3_3', target: 'main_output' }),
      ]),
    );
  });

  it('preserves CTE output column lineage through UNION queries', () => {
    const { lineage } = analyzeSql(`
      WITH combined_orders AS (
        SELECT customer_id, amount
        FROM online_orders
        UNION
        SELECT customer_id, amount
        FROM store_orders
      )
      SELECT customer_id, amount
      FROM combined_orders
    `);
    const cte = lineage.nodes.find((node) => node.id === 'cte_combined_orders');
    const output = lineage.nodes.find((node) => node.id === 'main_output');

    expect(cte?.columns.map((column) => column.name)).toEqual(['customer_id', 'amount']);
    expect(output?.columns.find((column) => column.name === 'customer_id')?.upstream).toEqual([
      { nodeId: 'cte_combined_orders', columnName: 'customer_id' },
    ]);
    expect(cte?.columns.find((column) => column.name === 'customer_id')?.upstream).toEqual([
      { nodeId: 'derived_union_left_1', columnName: 'customer_id' },
      { nodeId: 'derived_union_right_2', columnName: 'customer_id' },
    ]);
  });

  it('marks recursive CTE self references without losing source lineage', () => {
    const { lineage } = analyzeSql(recursiveEmployeeSql);
    const employeeTree = lineage.nodes.find((node) => node.id === 'cte_employee_tree');
    const recursiveEdges = lineage.edges.filter((edge) => edge.recursive?.reason === 'cteSelfReference');

    expect(employeeTree?.recursive).toBe(true);
    expect(employeeTree?.columns.map((column) => column.name)).toEqual(expect.arrayContaining(['id', 'name', 'manager_id', 'depth', 'path']));
    expect(recursiveEdges).toHaveLength(1);
    expect(recursiveEdges[0]).toMatchObject({
      source: 'cte_employee_tree',
      target: 'derived_union_all_right_2',
      sourceAlias: 'et',
    });
    expect(lineage.edges.find((edge) => edge.source === 'table_employees' && edge.target === 'derived_union_all_left_1')?.recursive).toBeUndefined();
    expect(lineage.edges.find((edge) => edge.source === 'table_employees' && edge.target === 'derived_union_all_right_2')?.recursive).toBeUndefined();
    expect(lineage.edges.find((edge) => edge.source === 'cte_employee_tree' && edge.target === 'main_output')?.recursive).toBeUndefined();
  });

  it('expands wildcard columns from subqueries with known output columns', () => {
    const { lineage } = analyzeSql(`
      SELECT src.*
      FROM (
        SELECT id, name
        FROM customers
      ) src
    `);
    const derived = lineage.nodes.find((node) => node.type === 'derived' && node.label === 'src');
    const output = lineage.nodes.find((node) => node.id === 'main_output');

    expect(derived?.columns.map((column) => column.name)).toEqual(['id', 'name']);
    expect(output?.columns.map((column) => column.name)).toEqual(['id', 'name']);
    expect(output?.columns.find((column) => column.name === 'id')?.upstream).toEqual([
      { nodeId: derived?.id, columnName: 'id' },
    ]);
    expect(output?.columns.find((column) => column.name === 'name')?.upstream).toEqual([
      { nodeId: derived?.id, columnName: 'name' },
    ]);
  });

  it('expands unqualified wildcard columns from known derived sources', () => {
    const { lineage } = analyzeSql(`
      SELECT *
      FROM (
        SELECT customer_id, amount
        FROM orders
      ) order_summary
    `);
    const output = lineage.nodes.find((node) => node.id === 'main_output');

    expect(output?.columns.map((column) => column.name)).toEqual(['customer_id', 'amount']);
  });

  it('resolves unqualified columns when exactly one source exposes the column', () => {
    const { lineage } = analyzeSql(`
      WITH customer_orders AS (
        SELECT customer_id, order_count
        FROM orders_by_customer
      ),
      customer_profiles AS (
        SELECT customer_id, customer_name
        FROM customers
      )
      SELECT customer_name, order_count
      FROM customer_orders co
      JOIN customer_profiles cp ON cp.customer_id = co.customer_id
    `);
    const output = lineage.nodes.find((node) => node.id === 'main_output');

    expect(output?.columns.find((column) => column.name === 'customer_name')?.upstream).toEqual([
      { nodeId: 'cte_customer_profiles', columnName: 'customer_name' },
    ]);
    expect(output?.columns.find((column) => column.name === 'order_count')?.upstream).toEqual([
      { nodeId: 'cte_customer_orders', columnName: 'order_count' },
    ]);
  });

  it('does not guess unqualified columns when multiple sources expose the column', () => {
    const { lineage } = analyzeSql(`
      WITH customer_orders AS (
        SELECT customer_id, order_count
        FROM orders_by_customer
      ),
      customer_profiles AS (
        SELECT customer_id, customer_name
        FROM customers
      )
      SELECT customer_id
      FROM customer_orders co
      JOIN customer_profiles cp ON cp.customer_id = co.customer_id
    `);
    const output = lineage.nodes.find((node) => node.id === 'main_output');

    expect(output?.columns.find((column) => column.name === 'customer_id')?.upstream).toEqual([]);
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
      "\n  when ps.last_paid_at is null then\n    'unknown'",
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
      expressionSql: "p.last_paid_at is null then 'unknown'",
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
      expressionSql: 'else p.customer_id',
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
    expect(compositeCase?.[1]).toMatchObject({
      caseLabel: 'case 2',
      conditionUpstream: [],
      resultUpstream: [{ nodeId: 'table_payments', columnName: 'name' }],
    });
    expect(doubleCase?.map((rule) => rule.caseLabel)).toEqual(['case 1', 'case 2']);
  });

  it('records composite non-CASE expression trees when multiple columns are referenced', () => {
    const { lineage } = analyzeSql(`
      SELECT a.id + b.id AS combined_id
      FROM accounts a
      JOIN branches b ON b.account_id = a.id
    `);
    const outputNode = lineage.nodes.find((node) => node.id === 'main_output');
    const combinedId = outputNode?.columns.find((column) => column.name === 'combined_id');

    expect(combinedId?.caseRules).toBeUndefined();
    expect(combinedId?.expressionTree).toEqual({
      children: [
        { kind: 'column', ref: { nodeId: 'table_accounts', columnName: 'id' }, sql: 'a.id' },
        { kind: 'column', ref: { nodeId: 'table_branches', columnName: 'id' }, sql: 'b.id' },
      ],
      kind: 'operator',
      operator: '+',
      sql: 'a.id + b.id',
      upstream: [
        { nodeId: 'table_accounts', columnName: 'id' },
        { nodeId: 'table_branches', columnName: 'id' },
      ],
    });
    expect(combinedId?.upstream).toEqual([
      { nodeId: 'table_accounts', columnName: 'id' },
      { nodeId: 'table_branches', columnName: 'id' },
    ]);
  });

  it('records CASE rules for a commented output CASE without AS alias', () => {
    const { lineage } = analyzeSql(`
      /* Monthly customer health report.
         Top-level header comment for comment export mode comparison. */
      with order_base as (
        /* Pull only order rows that affect monthly customer health.
           This CTE was originally copied from the billing report and has grown a few extra filters. */
        select o.id,o.customer_id,o.status,o.total_amount,o.created_at
        from orders o
        where o.created_at >= :report_from
          and o.status in (:paid_status,:shipped_status,:refunded_status)
      ),
      customer_order_summary as(
        /* Keep the lifetime-ish rollup separate because several downstream dashboards still compare these names. */
        select c.id customer_id,c.name,c.email,c.tier,
          count(ob.id) order_count,
          sum(case
            /* Refunds are operational noise for this score, but the row still proves the customer came back. */
            when ob.status = :refunded_status then 0
            /* Paid and shipped share the same business meaning here. */
            else ob.total_amount
          end) gross_amount,
          max(ob.created_at) last_order_at
        from customers c
        left join order_base ob on ob.customer_id = c.id
        where c.deleted_at is null
        group by c.id,c.name,c.email,c.tier
      ),
      support_pressure as (
        /* Old support model:
           any non-closed ticket should keep the account visible even when revenue is low. */
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
        rc.order_count,rc.gross_amount,rc.open_ticket_count,rc.last_order_at,
        (
          /* Kept as a subquery because the old export compared this value before joins were added. */
          select count(*)
          from orders o2
          where o2.customer_id = rc.customer_id
            and o2.created_at >= :recent_order_from
            and o2.status <> :refunded_status
        ) recent_order_count,
        p.name favorite_product
      from ranked_customers rc
      left join customer_favorites cf on cf.customer_id = rc.customer_id and cf.is_active = true
      left join products p on p.id = cf.product_id
      where rc.tier_rank <= :tier_rank_limit
        and (rc.gross_amount >= :minimum_amount or rc.open_ticket_count > :open_ticket_threshold)
        and exists(
          /* Product team only wants customers with at least one active favorite in this screen. */
          select 1 from customer_favorites cf2
          where cf2.customer_id = rc.customer_id and cf2.is_active = true
        )
      order by rc.tier asc, rc.gross_amount desc, rc.customer_id
    `);
    const outputNode = lineage.nodes.find((node) => node.id === 'main_output');
    const customerSegment = outputNode?.columns.find((column) => column.name === 'customer_segment');

    expect(outputNode?.comments).toEqual(['Monthly customer health report.', 'Top-level header comment for comment export mode comparison.']);
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

    const customerOrderSummary = lineage.nodes.find((node) => node.id === 'cte_customer_order_summary');
    const grossAmount = customerOrderSummary?.columns.find((column) => column.name === 'gross_amount');
    expect(grossAmount?.caseRules).toHaveLength(2);
    expect(grossAmount?.caseRules?.[0]).toMatchObject({
      conditionUpstream: [{ nodeId: 'cte_order_base', columnName: 'status' }],
      resultUpstream: [],
    });
    expect(grossAmount?.caseRules?.[1]).toMatchObject({
      conditionUpstream: [],
      resultUpstream: [{ nodeId: 'cte_order_base', columnName: 'total_amount' }],
    });

    const rankedCustomers = lineage.nodes.find((node) => node.id === 'cte_ranked_customers');
    const tierRank = rankedCustomers?.columns.find((column) => column.name === 'tier_rank');
    expect(tierRank?.caseRules).toBeUndefined();
    expect(tierRank?.expressionTree).toBeUndefined();
    expect(tierRank?.upstream).toEqual([
      { nodeId: 'cte_customer_order_summary', columnName: 'tier' },
      { nodeId: 'cte_customer_order_summary', columnName: 'gross_amount' },
      { nodeId: 'cte_customer_order_summary', columnName: 'customer_id' },
    ]);
    expect(tierRank?.expressionSql).toContain('row_number() over');
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

    expect(outputNode?.comments).toEqual(['Final output comment.']);
    expect(outputNode?.columns.find((column) => column.name === 'user_id')?.comments).toEqual(['Output id comment.']);
    expect(outputNode?.querySql).toContain('-- Final output comment.');
    expect(outputNode?.querySql).toContain('id as user_id -- Output id comment.');
    expect(derivedNode?.comments).toEqual(['Derived source comment.']);
    expect(derivedNode?.columns.find((column) => column.name === 'id')?.comments).toEqual(['Derived id comment.']);
    expect(derivedNode?.querySql).toContain('-- Derived source comment.');
    expect(derivedNode?.querySql).toContain('id -- Derived id comment.');
  });

  it('uses rawsql-ts formatting for long expression display SQL', () => {
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
    expect(expressionSql).toContain('then\n    q.total_tax - q.cumulative_adjustment_amount');
  });

  it('omits line comments from expression display SQL', () => {
    const { lineage } = analyzeSql(`
      SELECT
        CASE
          WHEN rc.open_ticket_count > :open_ticket_threshold THEN :attention_label -- Support wants open-ticket customers to stay visible even below revenue threshold.
          ELSE :standard_label
        END AS customer_segment
      FROM ranked_customers rc
    `);
    const outputNode = lineage.nodes.find((node) => node.id === 'main_output');
    const rule = outputNode?.columns.find((column) => column.name === 'customer_segment')?.caseRules?.[0];

    expect(rule?.resultSql).toBe(':attention_label');
    expect(rule?.resultSql).not.toContain('--');
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

  it('adds scalar subquery sources and columns to lineage', () => {
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
    expect(orders?.columns.every((column) => column.usage === undefined)).toBe(true);
    expect(recentOrderCount?.upstream).toEqual(
      expect.arrayContaining([
        { nodeId: 'table_orders', columnName: 'customer_id' },
        { nodeId: 'table_orders', columnName: 'created_at' },
        { nodeId: 'table_orders', columnName: 'status' },
      ]),
    );
  });

  it('adds WHERE EXISTS subquery sources as condition lineage', () => {
    const { lineage } = analyzeSql(`
      SELECT
          c.id,
          c.name
      FROM
          customers c
      WHERE
          NOT EXISTS (
              SELECT
                  1
              FROM
                  orders o
              WHERE
                  o.customer_id = c.id
          )
    `);
    const customers = lineage.nodes.find((node) => node.id === 'table_customers');
    const orders = lineage.nodes.find((node) => node.id === 'table_orders');
    const output = lineage.nodes.find((node) => node.id === 'main_output');

    expect(lineage.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'table_customers', target: 'main_output', sourceAlias: 'c' }),
        expect.objectContaining({ source: 'table_orders', target: 'main_output', sourceAlias: 'o' }),
      ]),
    );
    expect(output?.columns.find((column) => column.name === 'id')?.upstream).toEqual([{ nodeId: 'table_customers', columnName: 'id' }]);
    expect(output?.columns.find((column) => column.name === 'name')?.upstream).toEqual([{ nodeId: 'table_customers', columnName: 'name' }]);
    expect(output?.columns.find((column) => column.name === 'condition 1')).toMatchObject({
      expressionSql: expect.stringContaining('not exists'),
      upstream: expect.arrayContaining([
        { nodeId: 'table_customers', columnName: 'id' },
        { nodeId: 'table_orders', columnName: 'customer_id' },
      ]),
      usage: { role: 'filter', reasons: ['where'] },
    });
    expect(customers?.columns.find((column) => column.name === 'id')?.usage).toBeUndefined();
    expect(orders?.columns).toEqual([
      expect.objectContaining({
        name: 'customer_id',
        usage: undefined,
      }),
    ]);
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

    expect(recentOrdersSql).toMatch(/from\s+orders as o/);
    expect(orderTotalsSql).toMatch(/with\s+recent_orders as/);
    expect(orderTotalsSql).toContain('sum(amount) as total_amount');
    expect(paymentSummarySql).toMatch(/from\s+payments as p/);
    expect(nodeById.get('cte_order_totals')?.querySql).toBe(nodeById.get('cte_order_totals')?.cteExecutableSql);
  });

  it('keeps CTE comments in their owning CTE query when building executable SQL', () => {
    const { lineage } = analyzeSql(`
      /* Monthly customer health report.
         Top-level header comment for comment export mode comparison. */
      WITH order_base AS (
        /* Pull only order rows that affect monthly customer health.
           This CTE was originally copied from the billing report and has grown a few extra filters. */
        SELECT o.id, o.customer_id, o.status
        FROM orders o
        WHERE o.created_at >= :report_from
      ),
      customer_order_summary AS (
        /* Keep the lifetime-ish rollup separate because several downstream dashboards still compare these names. */
        SELECT ob.customer_id, count(ob.id) AS order_count
        FROM order_base ob
        GROUP BY ob.customer_id
      )
      SELECT customer_id, order_count
      FROM customer_order_summary
    `);
    const nodeById = new Map(lineage.nodes.map((node) => [node.id, node]));

    const orderBaseSql = nodeById.get('cte_order_base')?.cteExecutableSql ?? '';
    const customerOrderSummarySql = nodeById.get('cte_customer_order_summary')?.cteExecutableSql ?? '';

    expect(orderBaseSql).toContain('/*\n  Pull only order rows that affect monthly customer health.');
    expect(orderBaseSql).not.toContain('-- Pull only order rows');
    expect(customerOrderSummarySql).toMatch(/^with\s+order_base as \(/);
    expect(customerOrderSummarySql).toContain('/*\n      Pull only order rows that affect monthly customer health.');
    expect(customerOrderSummarySql).toContain(
      'Keep the lifetime-ish rollup separate because several downstream dashboards still compare these names.',
    );
    expect(customerOrderSummarySql).not.toMatch(/^-- Pull only order rows/);
    expect(customerOrderSummarySql.indexOf('Pull only order rows')).toBeGreaterThan(customerOrderSummarySql.indexOf('order_base as ('));
    expect(customerOrderSummarySql.indexOf('Keep the lifetime-ish')).toBeGreaterThan(customerOrderSummarySql.indexOf(')'));
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
