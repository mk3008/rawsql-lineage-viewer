import { describe, expect, it } from 'vitest';
import { salesSummarySql } from '../examples/salesSummarySql';
import { analyzeSql } from '../lineage/rawsqlAdapter';
import { buildGraphModel } from './buildGraphModel';

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

describe('buildGraphModel', () => {
  it('renders only data flow edges', () => {
    const { lineage } = analyzeSql(salesSummarySql);

    const graph = buildGraphModel(lineage);

    expect(graph.edges).toHaveLength(lineage.edges.filter((edge) => edge.type === 'dataFlow').length);
    expect(graph.edges.every((edge) => edge.data?.lineageEdge.type === 'dataFlow')).toBe(true);
  });

  it('renders data source aliases on data flows and preserves outer join context as a dashed line', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const graph = buildGraphModel(lineage);

    const preservedDataFlow = graph.edges.find((edge) => edge.id === 'table_customers-main_output');
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
    const upstreamCustomerEdge = upstream.edges.find((edge) => edge.id === 'table_customers-main_output');

    expect(downstreamCustomers?.position.x).toBeLessThan(downstreamOutput?.position.x ?? 0);
    expect(upstreamOutput?.position.x).toBeLessThan(upstreamCustomers?.position.x ?? 0);
    expect(upstreamCustomerEdge).toMatchObject({
      source: 'main_output',
      target: 'table_customers',
    });
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
    });
  });

  it('keeps transformation chains closer to a straight line than leaf table branches', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const upstream = buildGraphModel(lineage, 'upstream');
    const output = upstream.nodes.find((node) => node.id === 'main_output');
    const directTargets = upstream.edges
      .filter((edge) => edge.source === 'main_output')
      .map((edge) => upstream.nodes.find((node) => node.id === edge.target))
      .filter((node): node is NonNullable<typeof node> => Boolean(node));
    const cteTargets = directTargets.filter((node) => node.data.lineageNode.type === 'cte');
    const tableTargets = directTargets.filter((node) => node.data.lineageNode.type === 'table');
    const cteAverageY = cteTargets.reduce((sum, node) => sum + node.position.y, 0) / cteTargets.length;
    const tableAverageY = tableTargets.reduce((sum, node) => sum + node.position.y, 0) / tableTargets.length;

    expect(directTargets.length).toBeGreaterThan(1);
    expect(cteTargets.length).toBeGreaterThan(0);
    expect(tableTargets.length).toBeGreaterThan(0);
    expect(Math.abs((output?.position.y ?? 0) - cteAverageY)).toBeLessThan(Math.abs((output?.position.y ?? 0) - tableAverageY));
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
      ],
      edges: [
        { id: 'source_a-helper', source: 'source_a', target: 'helper', type: 'dataFlow' as const },
        { id: 'helper-root', source: 'helper', target: 'root', type: 'dataFlow' as const },
        { id: 'source_b-root', source: 'source_b', target: 'root', type: 'dataFlow' as const },
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
});
