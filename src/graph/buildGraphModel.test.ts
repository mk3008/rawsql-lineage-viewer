import { describe, expect, it } from 'vitest';
import { salesSummarySql } from '../examples/salesSummarySql';
import { analyzeSql } from '../lineage/rawsqlAdapter';
import { buildGraphModel } from './buildGraphModel';

describe('buildGraphModel', () => {
  it('filters DataFlow and JOIN edges independently', () => {
    const { lineage } = analyzeSql(salesSummarySql);

    const all = buildGraphModel(lineage, { dataFlow: true, join: true });
    const dataFlowOnly = buildGraphModel(lineage, { dataFlow: true, join: false });
    const joinOnly = buildGraphModel(lineage, { dataFlow: false, join: true });

    expect(all.edges.some((edge) => edge.data?.lineageEdge.type === 'dataFlow')).toBe(true);
    expect(all.edges.some((edge) => edge.data?.lineageEdge.type === 'join')).toBe(true);
    expect(dataFlowOnly.edges.every((edge) => edge.data?.lineageEdge.type === 'dataFlow')).toBe(true);
    expect(joinOnly.edges.every((edge) => edge.data?.lineageEdge.type === 'join')).toBe(true);
  });

  it('renders inner joins as solid blue and outer joins as dashed blue', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const graph = buildGraphModel(lineage, { dataFlow: true, join: true });

    const innerJoin = graph.edges.find((edge) => edge.id === 'table_orders-table_order_items-JOIN');
    const outerJoin = graph.edges.find((edge) => edge.id === 'table_customers-cte_order_totals-LEFT_JOIN');
    const dataFlow = graph.edges.find((edge) => edge.id === 'table_customers-main_output');

    expect(innerJoin?.style).toMatchObject({
      stroke: '#2563eb',
      strokeWidth: 2,
    });
    expect(innerJoin?.style?.strokeDasharray).toBeUndefined();
    expect(outerJoin?.style).toMatchObject({
      stroke: '#2563eb',
      strokeWidth: 2,
      strokeDasharray: '8 5',
    });
    expect(dataFlow?.style).toMatchObject({
      stroke: '#059669',
      strokeWidth: 2,
    });
  });
});
