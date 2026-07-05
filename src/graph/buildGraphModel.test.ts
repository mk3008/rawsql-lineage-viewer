import { describe, expect, it } from 'vitest';
import { salesSummarySql } from '../examples/salesSummarySql';
import { analyzeSql } from '../lineage/rawsqlAdapter';
import { buildGraphModel } from './buildGraphModel';
import { collapseLineageGroups, collectDefaultCollapsedGroupRootIds } from './collapseGroups';

const recursiveEmployeeSql = `WITH RECURSIVE employee_tree AS (
    SELECT
        e.id,
        e.name,
        e.manager_id,
        0 AS depth,
        CAST(e.name AS VARCHAR(1000)) AS path
    FROM employees e
    WHERE e.manager_id IS NULL
    UNION ALL
    SELECT
        e.id,
        e.name,
        e.manager_id,
        et.depth + 1 AS depth,
        CAST(et.path || ' / ' || e.name AS VARCHAR(1000)) AS path
    FROM employees e
    INNER JOIN employee_tree et ON e.manager_id = et.id
)
SELECT id, name, manager_id, depth, path
FROM employee_tree
ORDER BY path`;

const rankedCustomerHealthSql = `with order_base as (
  select o.id, o.customer_id, o.status, o.total_amount, o.created_at
  from orders o
),
customer_order_summary as (
  select c.id customer_id, c.name, count(ob.id) order_count, sum(ob.total_amount) gross_amount
  from customers c
  left join order_base ob on ob.customer_id = c.id
  group by c.id, c.name
),
support_pressure as (
  select st.customer_id, count(st.id) open_ticket_count
  from support_tickets st
  group by st.customer_id
),
ranked_customers as (
  select cos.customer_id, cos.name, cos.order_count, cos.gross_amount, coalesce(sp.open_ticket_count, 0) open_ticket_count
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
)`;

describe('buildGraphModel', () => {
  it('renders only data flow edges', () => {
    const { lineage } = analyzeSql(salesSummarySql);

    const graph = buildGraphModel(lineage);

    expect(graph.edges).toHaveLength(lineage.edges.filter((edge) => edge.type === 'dataFlow').length);
    expect(graph.edges.every((edge) => edge.data?.lineageEdge.type === 'dataFlow')).toBe(true);
  });

  it('does not render CTEs that are not reachable from the final output', () => {
    const { lineage } = analyzeSql(`
      WITH used_orders AS (
        SELECT customer_id, amount
        FROM orders
      ),
      unused_payments AS (
        SELECT customer_id, amount
        FROM payments
      )
      SELECT customer_id, amount
      FROM used_orders
    `);

    const graph = buildGraphModel(lineage, 'upstream');
    const graphNodeIds = new Set(graph.nodes.map((node) => node.id));

    expect(lineage.nodes.some((node) => node.id === 'cte_unused_payments')).toBe(true);
    expect(graphNodeIds.has('cte_used_orders')).toBe(true);
    expect(graphNodeIds.has('table_orders')).toBe(true);
    expect(graphNodeIds.has('cte_unused_payments')).toBe(false);
    expect(graphNodeIds.has('table_payments')).toBe(false);
    expect(graph.edges.some((edge) => edge.source === 'cte_unused_payments' || edge.target === 'cte_unused_payments')).toBe(false);

    const graphWithUnusedCtes = buildGraphModel(lineage, 'upstream', lineage, { showUnreachableCtes: true });
    const graphWithUnusedCteNodeIds = new Set(graphWithUnusedCtes.nodes.map((node) => node.id));

    expect(graphWithUnusedCteNodeIds.has('cte_unused_payments')).toBe(true);
    expect(graphWithUnusedCteNodeIds.has('table_payments')).toBe(true);
    expect(graphWithUnusedCtes.edges.some((edge) => edge.source === 'cte_unused_payments' || edge.target === 'cte_unused_payments')).toBe(true);
  });

  it('renders data source aliases on data flows and preserves outer join context as a dashed line', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const graph = buildGraphModel(lineage);

    const preservedDataFlow = graph.edges.find((edge) => edge.id === 'table_customers-cte_customer_scope');
    const outerDataFlow = graph.edges.find((edge) => edge.id === 'cte_order_totals-main_output');
    const innerDataFlow = graph.edges.find((edge) => edge.id === 'table_order_items-cte_recent_orders');
    const unaliasedDataFlow = graph.edges.find((edge) => edge.id === 'cte_recent_orders-cte_order_totals');

    expect(preservedDataFlow?.label).toBe('c');
    expect(outerDataFlow?.label).toBe('ot');
    expect(innerDataFlow?.label).toBe('oi');
    expect(unaliasedDataFlow?.label).toBeUndefined();
    expect(preservedDataFlow?.style).toMatchObject({
      stroke: '#059669',
      strokeWidth: 1.5,
    });
    expect(preservedDataFlow?.markerEnd).toBeUndefined();
    expect(preservedDataFlow?.style?.strokeDasharray).toBeUndefined();
    expect(outerDataFlow?.style).toMatchObject({
      stroke: '#059669',
      strokeWidth: 1.5,
      strokeDasharray: '8 5',
    });
    expect(innerDataFlow?.style?.strokeDasharray).toBeUndefined();
  });

  it('uses curved edges and compact spacing for collapsed-first graph layout', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const graph = buildGraphModel(lineage);

    const orders = graph.nodes.find((node) => node.id === 'table_orders');
    const orderItems = graph.nodes.find((node) => node.id === 'table_order_items');
    const recentOrders = graph.nodes.find((node) => node.id === 'cte_recent_orders');

    expect(graph.edges.every((edge) => edge.type === 'lineageDataFlow')).toBe(true);
    expect(orders?.position.x).toBe(orderItems?.position.x);
    expect(Math.abs((orders?.position.y ?? 0) - (orderItems?.position.y ?? 0))).toBeLessThanOrEqual(190);
    expect((recentOrders?.position.x ?? 0) - (orders?.position.x ?? 0)).toBe(280);
  });

  it('can render upstream direction from output back to source tables', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const downstream = buildGraphModel(lineage, 'downstream');
    const upstream = buildGraphModel(lineage, 'upstream');

    const downstreamCustomers = downstream.nodes.find((node) => node.id === 'table_customers');
    const downstreamOutput = downstream.nodes.find((node) => node.id === 'main_output');
    const upstreamCustomers = upstream.nodes.find((node) => node.id === 'table_customers');
    const upstreamOutput = upstream.nodes.find((node) => node.id === 'main_output');
    const upstreamCustomerScopeEdge = upstream.edges.find((edge) => edge.id === 'cte_customer_scope-main_output');

    expect(downstreamCustomers?.position.x).toBeLessThan(downstreamOutput?.position.x ?? 0);
    expect(upstreamOutput?.position.x).toBeLessThan(upstreamCustomers?.position.x ?? 0);
    expect(upstreamCustomerScopeEdge).toMatchObject({
      source: 'main_output',
      target: 'cte_customer_scope',
    });
  });

  it('can render an explicit focused subgraph without output reachability', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const visibleNodeIds = new Set(['cte_order_totals', 'cte_recent_orders', 'table_order_items']);

    const graph = buildGraphModel(lineage, 'upstream', lineage, { visibleNodeIds });

    expect(new Set(graph.nodes.map((node) => node.id))).toEqual(visibleNodeIds);
    expect(graph.edges.map((edge) => edge.id).sort()).toEqual(['cte_recent_orders-cte_order_totals', 'table_order_items-cte_recent_orders']);
    expect(graph.nodes.every((node) => Number.isFinite(node.position.x) && Number.isFinite(node.position.y))).toBe(true);
  });

  it('renders scalar subqueries as graph nodes between output columns and their row sources', () => {
    const { lineage } = analyzeSql(`
      SELECT
        c.id,
        (
          SELECT SUM(oi.quantity * oi.unit_price)
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.customer_id = c.id
            AND o.order_date >= :from_date
        ) AS period_order_amount
      FROM customers c
    `);
    const graph = buildGraphModel(lineage, 'upstream');
    const scalar = graph.nodes.find((node) => node.id === 'scalar_subquery_period_order_amount_1');
    const outputToScalar = graph.edges.find((edge) => edge.id === 'scalar_subquery_period_order_amount_1-main_output');
    const scalarToOrders = graph.edges.find((edge) => edge.id === 'table_orders-scalar_subquery_period_order_amount_1');
    const correlation = graph.edges.find((edge) => edge.id === 'table_customers-scalar_subquery_period_order_amount_1');

    expect(scalar?.data.lineageNode.type).toBe('scalar_subquery');
    expect(outputToScalar).toMatchObject({
      source: 'main_output',
      target: 'scalar_subquery_period_order_amount_1',
      data: {
        lineageEdge: expect.objectContaining({ kind: 'subquery_value' }),
      },
    });
    expect(scalarToOrders).toMatchObject({
      source: 'scalar_subquery_period_order_amount_1',
      target: 'table_orders',
      data: {
        lineageEdge: expect.objectContaining({ kind: 'row_source' }),
      },
    });
    expect(correlation).toMatchObject({
      source: 'scalar_subquery_period_order_amount_1',
      target: 'table_customers',
      data: {
        lineageEdge: expect.objectContaining({ kind: 'correlation' }),
      },
      style: {
        stroke: '#d97706',
        strokeDasharray: '6 5',
      },
    });
  });

  it('renders predicate subquery edges as orange dashed lines', () => {
    const { lineage } = analyzeSql(`
      SELECT c.id, c.name
      FROM customers c
      WHERE EXISTS (
        SELECT 1
        FROM orders o
        WHERE o.customer_id = c.id
      )
    `);
    const graph = buildGraphModel(lineage);
    const customersEdge = graph.edges.find((edge) => edge.id === 'table_customers-main_output');
    const predicateSubqueryEdge = graph.edges.find((edge) => edge.id === 'table_orders-main_output');

    expect(customersEdge?.style).toMatchObject({
      stroke: '#059669',
      strokeWidth: 1.5,
    });
    expect(customersEdge?.style?.strokeDasharray).toBeUndefined();
    expect(predicateSubqueryEdge).toMatchObject({
      data: {
        lineageEdge: expect.objectContaining({ kind: 'predicate_subquery' }),
      },
      style: {
        stroke: '#d97706',
        strokeWidth: 1.5,
        strokeDasharray: '6 5',
      },
    });
  });

  it('renders parameter table sources for SELECT statements without FROM', () => {
    const { lineage } = analyzeSql('select :batch_id as batch_id');
    const graph = buildGraphModel(lineage, 'upstream');
    const parameterNode = graph.nodes.find((node) => node.id === 'parameter_parameters');
    const parameterEdge = graph.edges.find((edge) => edge.id === 'parameter_parameters-main_output');

    expect(parameterNode?.data.lineageNode.type).toBe('parameter_table');
    expect(parameterNode?.data.lineageNode.label).toBe('Parameters');
    expect(parameterEdge).toMatchObject({
      source: 'main_output',
      target: 'parameter_parameters',
      data: {
        lineageEdge: expect.objectContaining({ kind: 'value_flow' }),
      },
    });
  });

  it('keeps transformation chains closer to a straight line than leaf table branches', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const upstream = buildGraphModel(lineage, 'upstream');
    const output = upstream.nodes.find((node) => node.id === 'main_output');
    const customerScope = upstream.nodes.find((node) => node.id === 'cte_customer_scope');
    const directTargets = upstream.edges
      .filter((edge) => edge.source === 'main_output')
      .map((edge) => upstream.nodes.find((node) => node.id === edge.target))
      .filter((node): node is NonNullable<typeof node> => Boolean(node));
    const cteTargets = directTargets.filter((node) => node.data.lineageNode.type === 'cte');
    const tableTargets = upstream.edges
      .filter((edge) => edge.source === 'cte_customer_scope')
      .map((edge) => upstream.nodes.find((node) => node.id === edge.target))
      .filter((node): node is NonNullable<typeof node> => Boolean(node))
      .filter((node) => node.data.lineageNode.type === 'table');
    const cteAverageY = cteTargets.reduce((sum, node) => sum + node.position.y, 0) / cteTargets.length;
    const tableAverageY = tableTargets.reduce((sum, node) => sum + node.position.y, 0) / tableTargets.length;

    expect(directTargets.length).toBeGreaterThan(1);
    expect(cteTargets.length).toBeGreaterThan(0);
    expect(tableTargets.length).toBeGreaterThan(0);
    expect(Math.abs((output?.position.y ?? 0) - cteAverageY)).toBeLessThan(Math.abs((output?.position.y ?? 0) - tableAverageY));
    expect(Math.abs((customerScope?.position.y ?? 0) - tableAverageY)).toBeLessThanOrEqual(Math.abs((output?.position.y ?? 0) - tableAverageY));
  });

  it('keeps the primary transformation lane centered while sibling sources fan out', () => {
    const lineage = {
      kind: 'sql-lineage-model' as const,
      modelVersion: 1 as const,
      nodes: [
        { id: 'table_customer_favorites', type: 'table' as const, label: 'customer_favorites', columns: [] },
        { id: 'table_products', type: 'table' as const, label: 'products', columns: [] },
        { id: 'scalar_recent_order_count', type: 'scalar_subquery' as const, label: 'recent_order_count', columns: [] },
        { id: 'cte_ranked_customers', type: 'cte' as const, label: 'ranked_customers', columns: [] },
        { id: 'table_orders', type: 'table' as const, label: 'orders', columns: [] },
        { id: 'table_customers', type: 'table' as const, label: 'customers', columns: [] },
        { id: 'table_support_tickets', type: 'table' as const, label: 'support_tickets', columns: [] },
        { id: 'main_output', type: 'output' as const, label: 'Final Result', columns: [] },
      ],
      edges: [
        { id: 'table_customer_favorites-main_output', source: 'table_customer_favorites', target: 'main_output', type: 'dataFlow' as const, kind: 'predicate_subquery' as const },
        { id: 'table_products-main_output', source: 'table_products', target: 'main_output', type: 'dataFlow' as const, kind: 'value_flow' as const },
        { id: 'scalar_recent_order_count-main_output', source: 'scalar_recent_order_count', target: 'main_output', type: 'dataFlow' as const, kind: 'subquery_value' as const },
        { id: 'table_orders-scalar_recent_order_count', source: 'table_orders', target: 'scalar_recent_order_count', type: 'dataFlow' as const, kind: 'row_source' as const },
        { id: 'cte_ranked_customers-scalar_recent_order_count', source: 'cte_ranked_customers', target: 'scalar_recent_order_count', type: 'dataFlow' as const, kind: 'correlation' as const },
        { id: 'cte_ranked_customers-main_output', source: 'cte_ranked_customers', target: 'main_output', type: 'dataFlow' as const, kind: 'value_flow' as const },
        { id: 'table_orders-cte_ranked_customers', source: 'table_orders', target: 'cte_ranked_customers', type: 'dataFlow' as const, kind: 'value_flow' as const },
        { id: 'table_customers-cte_ranked_customers', source: 'table_customers', target: 'cte_ranked_customers', type: 'dataFlow' as const, kind: 'value_flow' as const },
        { id: 'table_support_tickets-cte_ranked_customers', source: 'table_support_tickets', target: 'cte_ranked_customers', type: 'dataFlow' as const, kind: 'value_flow' as const },
      ],
      scopes: [],
      analysisWarnings: [],
      raw: { adapter: 'rawsql-ts-ast' as const },
    };

    const graph = buildGraphModel(lineage, 'upstream');
    const output = graph.nodes.find((node) => node.id === 'main_output');
    const rankedCustomers = graph.nodes.find((node) => node.id === 'cte_ranked_customers');
    const recentOrderCount = graph.nodes.find((node) => node.id === 'scalar_recent_order_count');
    const orders = graph.nodes.find((node) => node.id === 'table_orders');
    const customers = graph.nodes.find((node) => node.id === 'table_customers');
    const supportTickets = graph.nodes.find((node) => node.id === 'table_support_tickets');
    const siblingYValues = graph.nodes
      .filter((node) => node.id === 'table_customer_favorites' || node.id === 'table_products')
      .map((node) => node.position.y);

    expect(output).toBeDefined();
    expect(rankedCustomers).toBeDefined();
    expect(recentOrderCount).toBeDefined();
    expect(rankedCustomers?.position.x).toBeGreaterThan(output?.position.x ?? Number.POSITIVE_INFINITY);
    expect(rankedCustomers?.position.y).toBe(output?.position.y);
    expect(orders?.position.y).toBe(recentOrderCount?.position.y);
    expect(customers?.position.y).toBe(rankedCustomers?.position.y);
    expect(supportTickets?.position.y).not.toBe(rankedCustomers?.position.y);
    expect(siblingYValues.some((y) => y < (rankedCustomers?.position.y ?? 0))).toBe(true);
    expect(siblingYValues.some((y) => y > (rankedCustomers?.position.y ?? 0))).toBe(true);
    expect(siblingYValues).not.toContain(rankedCustomers?.position.y);
    expect(recentOrderCount?.position.y).toBeGreaterThan(Math.min(...siblingYValues));
    expect(recentOrderCount?.position.y).toBeLessThan(Math.max(...siblingYValues));
  });

  it('compacts unused vertical lanes in the collapsed demo layout', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const collapsed = collapseLineageGroups(lineage, collectDefaultCollapsedGroupRootIds(lineage));
    const graph = buildGraphModel(collapsed.lineage, 'upstream', collapsed.lineage);
    const yValues = [...new Set(graph.nodes.map((node) => node.position.y))].sort((a, b) => a - b);
    const customerScopeY = graph.nodes.find((node) => node.id === 'cte_customer_scope')?.position.y ?? 0;
    const paymentSummaryY = graph.nodes.find((node) => node.id === 'cte_payment_summary')?.position.y ?? 0;
    const orderTotalsY = graph.nodes.find((node) => node.id === 'cte_order_totals')?.position.y ?? 0;
    const customersY = graph.nodes.find((node) => node.id === 'table_customers')?.position.y ?? 0;
    const paymentsY = graph.nodes.find((node) => node.id === 'table_payments')?.position.y ?? 0;
    const ordersY = graph.nodes.find((node) => node.id === 'table_orders')?.position.y ?? 0;
    const orderItemsY = graph.nodes.find((node) => node.id === 'table_order_items')?.position.y ?? 0;
    const customerFavoritesY = graph.nodes.find((node) => node.id === 'table_customer_favorites')?.position.y ?? 0;

    expect(yValues).toEqual(yValues.map((_, index) => index * 180));
    expect(customersY).toBe(customerScopeY);
    expect(paymentsY).toBe(paymentSummaryY);
    expect(ordersY).toBe(orderTotalsY);
    expect(orderItemsY).toBeGreaterThan(ordersY);
    expect(Math.abs(customerFavoritesY - customerScopeY)).toBeGreaterThan(Math.abs(customersY - customerScopeY));
  });

  it('keeps correlated scalar row sources and primary grouped sources on readable lanes', () => {
    const { lineage } = analyzeSql(rankedCustomerHealthSql);
    const collapsed = collapseLineageGroups(lineage, collectDefaultCollapsedGroupRootIds(lineage));
    const graph = buildGraphModel(collapsed.lineage, 'upstream', collapsed.lineage);
    const recentOrderCount = graph.nodes.find((node) => node.id === 'scalar_subquery_recent_order_count_1');
    const rankedCustomers = graph.nodes.find((node) => node.id === 'cte_ranked_customers');
    const customerOrderSummary = graph.nodes.find((node) => node.id === 'cte_customer_order_summary');
    const supportPressure = graph.nodes.find((node) => node.id === 'cte_support_pressure');
    const orders = graph.nodes.find((node) => node.id === 'table_orders');
    const customers = graph.nodes.find((node) => node.id === 'table_customers');
    const supportTickets = graph.nodes.find((node) => node.id === 'table_support_tickets');

    expect(orders?.position.y).toBe(recentOrderCount?.position.y);
    expect(customerOrderSummary?.position.y).toBe(rankedCustomers?.position.y);
    expect(customers?.position.y).toBe(customerOrderSummary?.position.y);
    expect(supportTickets?.position.y).toBe(supportPressure?.position.y);
  });

  it('keeps expanded helper CTE primary sources aligned after secondary inputs move outward', () => {
    const { lineage } = analyzeSql(rankedCustomerHealthSql);
    const visibleNodeIds = new Set([
      'main_output',
      'cte_ranked_customers',
      'cte_customer_order_summary',
      'cte_support_pressure',
      'cte_order_base',
      'table_orders',
      'table_customers',
      'table_support_tickets',
      'table_customer_favorites',
    ]);

    const graph = buildGraphModel(lineage, 'upstream', lineage, { visibleNodeIds });
    const orderBase = graph.nodes.find((node) => node.id === 'cte_order_base');
    const orders = graph.nodes.find((node) => node.id === 'table_orders');
    const customerOrderSummary = graph.nodes.find((node) => node.id === 'cte_customer_order_summary');
    const customers = graph.nodes.find((node) => node.id === 'table_customers');
    const supportPressure = graph.nodes.find((node) => node.id === 'cte_support_pressure');
    const supportTickets = graph.nodes.find((node) => node.id === 'table_support_tickets');

    expect(orders?.position.y).toBe(orderBase?.position.y);
    expect(customers?.position.y).toBe(customerOrderSummary?.position.y);
    expect(supportTickets?.position.y).toBe(supportPressure?.position.y);
  });

  it('does not render recursive CTE self-reference edges as graph lines', () => {
    const { lineage } = analyzeSql(recursiveEmployeeSql);
    const graph = buildGraphModel(lineage, 'upstream');
    const recursiveLineageEdges = lineage.edges.filter((edge) => edge.recursive);
    const recursiveGraphEdges = graph.edges.filter((edge) => edge.data?.lineageEdge.recursive);
    const employeeTree = graph.nodes.find((node) => node.id === 'cte_employee_tree');
    const output = graph.nodes.find((node) => node.id === 'main_output');

    expect(recursiveLineageEdges).toHaveLength(1);
    expect(recursiveGraphEdges).toHaveLength(0);
    expect(employeeTree?.data.lineageNode.recursive).toBe(true);
    expect(employeeTree?.position.x).toBeGreaterThan(output?.position.x ?? Number.POSITIVE_INFINITY);
    expect(employeeTree?.position.x).toBeLessThanOrEqual(720);
  });

  it('can render collapsed graph nodes at positions calculated from the uncollapsed graph', () => {
    const uncollapsedLineage = {
      kind: 'sql-lineage-model' as const,
      modelVersion: 1 as const,
      nodes: [
        { id: 'source_a', type: 'table' as const, label: 'source_a', columns: [] },
        { id: 'helper', type: 'cte' as const, label: 'helper', columns: [] },
        { id: 'root', type: 'cte' as const, label: 'root', columns: [] },
        { id: 'source_b', type: 'table' as const, label: 'source_b', columns: [] },
        { id: 'main_output', type: 'output' as const, label: 'Final Result', columns: [] },
      ],
      edges: [
        { id: 'source_a-helper', source: 'source_a', target: 'helper', type: 'dataFlow' as const },
        { id: 'helper-root', source: 'helper', target: 'root', type: 'dataFlow' as const },
        { id: 'source_b-root', source: 'source_b', target: 'root', type: 'dataFlow' as const },
        { id: 'root-main_output', source: 'root', target: 'main_output', type: 'dataFlow' as const },
      ],
      scopes: [],
      analysisWarnings: [],
      raw: { adapter: 'rawsql-ts-ast' as const },
    };
    const collapsedLineage = {
      ...uncollapsedLineage,
      nodes: uncollapsedLineage.nodes.filter((node) => node.id !== 'helper'),
      edges: [
        { id: 'source_a-root', source: 'source_a', target: 'root', type: 'dataFlow' as const },
        { id: 'source_b-root', source: 'source_b', target: 'root', type: 'dataFlow' as const },
        { id: 'root-main_output', source: 'root', target: 'main_output', type: 'dataFlow' as const },
      ],
    };
    const uncollapsed = buildGraphModel(uncollapsedLineage);
    const collapsedWithUncollapsedLayout = buildGraphModel(collapsedLineage, 'downstream', uncollapsedLineage);
    const collapsedWithoutLayout = buildGraphModel(collapsedLineage);

    expect(collapsedWithUncollapsedLayout.nodes.find((node) => node.id === 'root')?.position).toEqual(
      uncollapsed.nodes.find((node) => node.id === 'root')?.position,
    );
    expect(collapsedWithUncollapsedLayout.nodes.find((node) => node.id === 'root')?.position).not.toEqual(
      collapsedWithoutLayout.nodes.find((node) => node.id === 'root')?.position,
    );
  });

  it('keeps focused collapsed upstream branches flowing from output to group to source tables', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const collapsed = collapseLineageGroups(lineage, new Set(['cte_order_totals']));
    const visibleNodeIds = new Set(['main_output', 'cte_order_totals', 'table_orders', 'table_order_items']);

    const graph = buildGraphModel(collapsed.lineage, 'upstream', lineage, { visibleNodeIds });
    const x = (nodeId: string) => graph.nodes.find((node) => node.id === nodeId)?.position.x ?? Number.NEGATIVE_INFINITY;

    expect(x('main_output')).toBeLessThan(x('cte_order_totals'));
    expect(x('cte_order_totals')).toBeLessThan(x('table_orders'));
    expect(x('cte_order_totals')).toBeLessThan(x('table_order_items'));
  });
});
