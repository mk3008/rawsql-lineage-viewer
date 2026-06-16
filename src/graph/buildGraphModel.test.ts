import { describe, expect, it } from 'vitest';
import { salesSummarySql } from '../examples/salesSummarySql';
import { analyzeSql } from '../lineage/rawsqlAdapter';
import { buildGraphModel } from './buildGraphModel';

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
      strokeWidth: 2,
    });
    expect(preservedDataFlow?.style?.strokeDasharray).toBeUndefined();
    expect(outerDataFlow?.style).toMatchObject({
      stroke: '#059669',
      strokeWidth: 2,
      strokeDasharray: '8 5',
    });
    expect(innerDataFlow?.style?.strokeDasharray).toBeUndefined();
  });

  it('uses curved edges and roomy vertical spacing to reduce visual overlap', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const graph = buildGraphModel(lineage);

    const orders = graph.nodes.find((node) => node.id === 'table_orders');
    const orderItems = graph.nodes.find((node) => node.id === 'table_order_items');

    expect(graph.edges.every((edge) => edge.type === 'lineageDataFlow')).toBe(true);
    expect(orders?.position.x).toBe(orderItems?.position.x);
    expect(Math.abs((orders?.position.y ?? 0) - (orderItems?.position.y ?? 0))).toBeGreaterThanOrEqual(230);
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
});
