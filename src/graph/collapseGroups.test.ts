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

describe('collapseGroups', () => {
  it('collects upstream helper CTEs for a CTE representative', () => {
    const { lineage } = analyzeSql(rankedCustomersSql);
    const groups = collectCollapsibleUpstreamGroups(lineage);

    expect(groups.get('cte_ranked_customers')).toMatchObject({
      label: 'Build ranked_customers',
      rootNodeId: 'cte_ranked_customers',
      helperNodeIds: expect.arrayContaining(['cte_order_base', 'cte_customer_order_summary', 'cte_support_pressure']),
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
});
