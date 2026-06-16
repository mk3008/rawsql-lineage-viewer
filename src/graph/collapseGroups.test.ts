import { describe, expect, it } from 'vitest';
import { analyzeSql } from '../lineage/rawsqlAdapter';
import { collectCollapsibleUpstreamGroups, collapseLineageGroups } from './collapseGroups';

const rankedCustomersSql = `with order_base as (
  select o.id, o.customer_id, o.status, o.total_amount
  from orders o
),
customer_order_summary as (
  select c.id customer_id, count(ob.id) order_count
  from customers c
  left join order_base ob on ob.customer_id = c.id
  group by c.id
),
support_pressure as (
  select st.customer_id, count(st.id) open_ticket_count
  from support_tickets st
  group by st.customer_id
),
ranked_customers as (
  select cos.customer_id, cos.order_count, coalesce(sp.open_ticket_count, 0) open_ticket_count
  from customer_order_summary cos
  left join support_pressure sp on sp.customer_id = cos.customer_id
)
select rc.customer_id, rc.order_count, rc.open_ticket_count
from ranked_customers rc`;

const nestedDerivedSql = `select q.customer_id, q.total_amount
from (
  select q.customer_id, q.total_amount
  from (
    select o.customer_id, sum(o.amount) total_amount
    from orders o
    group by o.customer_id
  ) q
) q`;

const sharedDetailSql = `with detail as (
  select q.customer_id, q.amount
  from (
    select o.customer_id, o.amount
    from orders o
  ) q
),
tax_summary as (
  select d.customer_id, sum(d.amount) tax_amount
  from detail d
  group by d.customer_id
)
select d.customer_id, d.amount, ts.tax_amount
from detail d
left join tax_summary ts on ts.customer_id = d.customer_id`;

describe('collapseGroups', () => {
  it('collects upstream helper CTEs for a CTE representative', () => {
    const { lineage } = analyzeSql(rankedCustomersSql);
    const groups = collectCollapsibleUpstreamGroups(lineage);

    expect(groups.get('cte_ranked_customers')).toMatchObject({
      label: 'Build ranked_customers',
      rootNodeId: 'cte_ranked_customers',
      helperNodeIds: expect.arrayContaining(['cte_order_base', 'cte_customer_order_summary', 'cte_support_pressure']),
      helperCounts: {
        ctes: 3,
        derived: 0,
      },
      sourceNodeIds: expect.arrayContaining(['table_orders', 'table_customers', 'table_support_tickets']),
      outputColumnCount: 3,
    });
  });

  it('collapses helper CTEs into the representative while preserving external flows', () => {
    const { lineage } = analyzeSql(rankedCustomersSql);
    const collapsed = collapseLineageGroups(lineage, new Set(['cte_ranked_customers']));

    expect(collapsed.groups.get('cte_ranked_customers')?.helperNodeIds).toHaveLength(3);
    expect(collapsed.lineage.nodes.map((node) => node.id)).not.toEqual(
      expect.arrayContaining(['cte_order_base', 'cte_customer_order_summary', 'cte_support_pressure']),
    );
    expect(collapsed.lineage.nodes.find((node) => node.id === 'cte_ranked_customers')?.label).toBe('Build ranked_customers');
    expect(collapsed.lineage.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'table_orders', target: 'cte_ranked_customers' }),
        expect.objectContaining({ source: 'table_customers', target: 'cte_ranked_customers' }),
        expect.objectContaining({ source: 'table_support_tickets', target: 'cte_ranked_customers' }),
        expect.objectContaining({ source: 'cte_ranked_customers', target: 'main_output' }),
      ]),
    );
    expect(collapsed.lineage.edges.some((edge) => edge.source === 'cte_customer_order_summary' || edge.target === 'cte_customer_order_summary')).toBe(false);
  });

  it('rewires collapsed representative column lineage through hidden helpers to visible sources', () => {
    const { lineage } = analyzeSql(rankedCustomersSql);
    const collapsed = collapseLineageGroups(lineage, new Set(['cte_ranked_customers']));
    const rankedCustomers = collapsed.lineage.nodes.find((node) => node.id === 'cte_ranked_customers');

    expect(rankedCustomers?.columns.find((column) => column.name === 'order_count')?.upstream).toEqual(
      expect.arrayContaining([{ nodeId: 'table_orders', columnName: 'id' }]),
    );
    expect(rankedCustomers?.columns.find((column) => column.name === 'customer_id')?.upstream).toEqual(
      expect.arrayContaining([{ nodeId: 'table_customers', columnName: 'id' }]),
    );
    expect(rankedCustomers?.columns.find((column) => column.name === 'order_count')?.upstream).not.toEqual(
      expect.arrayContaining([{ nodeId: 'cte_customer_order_summary', columnName: 'order_count' }]),
    );
  });

  it('collects nested FROM subqueries as collapsible derived query block internals', () => {
    const { lineage } = analyzeSql(nestedDerivedSql);
    const groups = collectCollapsibleUpstreamGroups(lineage);
    const derivedNodes = lineage.nodes.filter((node) => node.type === 'derived' && node.label === 'q');
    const outerDerived = derivedNodes.find((node) => lineage.edges.some((edge) => edge.source === node.id && edge.target === 'main_output'));

    expect(derivedNodes).toHaveLength(2);
    expect(new Set(derivedNodes.map((node) => node.id)).size).toBe(2);
    expect(outerDerived).toBeDefined();
    expect(groups.get(outerDerived!.id)).toMatchObject({
      rootNodeId: outerDerived!.id,
      helperCounts: {
        ctes: 0,
        derived: 1,
      },
      sourceNodeIds: ['table_orders'],
      outputColumnCount: 2,
    });
  });

  it('collapses nested derived helpers while preserving external data flows', () => {
    const { lineage } = analyzeSql(nestedDerivedSql);
    const outerDerived = lineage.nodes.find(
      (node) => node.type === 'derived' && lineage.edges.some((edge) => edge.source === node.id && edge.target === 'main_output'),
    );
    expect(outerDerived).toBeDefined();

    const collapsed = collapseLineageGroups(lineage, new Set([outerDerived!.id]));

    expect(collapsed.groups.get(outerDerived!.id)?.helperCounts.derived).toBe(1);
    expect(collapsed.lineage.nodes.filter((node) => node.type === 'derived')).toHaveLength(1);
    expect(collapsed.lineage.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'table_orders', target: outerDerived!.id }),
        expect.objectContaining({ source: outerDerived!.id, target: 'main_output' }),
      ]),
    );
  });

  it('does not collapse shared CTEs into a downstream query block', () => {
    const { lineage } = analyzeSql(sharedDetailSql);
    const groups = collectCollapsibleUpstreamGroups(lineage);

    expect(groups.get('cte_tax_summary')).toBeUndefined();
    expect(groups.get('cte_detail')?.helperCounts).toMatchObject({
      ctes: 0,
      derived: 1,
    });
  });
});
