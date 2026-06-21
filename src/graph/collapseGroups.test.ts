import { describe, expect, it } from 'vitest';
import { salesSummarySql } from '../examples/salesSummarySql';
import { analyzeSql } from '../lineage/rawsqlAdapter';
import { collectCollapsibleUpstreamGroups, collectDefaultCollapsedGroupRootIds, collapseLineageGroups } from './collapseGroups';

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

const simpleRelaySql = `with order_base as (
  select o.id, o.customer_id
  from orders o
),
order_named as (
  select id, customer_id
  from order_base
)
select customer_id
from order_named`;

const recursiveEmployeeSql = `with recursive employee_tree as (
  select
    e.id,
    e.name,
    e.manager_id,
    0 as depth,
    cast(e.name as varchar(1000)) as path
  from employees e
  where e.manager_id is null
  union all
  select
    e.id,
    e.name,
    e.manager_id,
    et.depth + 1 as depth,
    cast(et.path || ' / ' || e.name as varchar(1000)) as path
  from employees e
  inner join employee_tree et on e.manager_id = et.id
)
select id, name, manager_id, depth, path
from employee_tree
order by path`;

describe('collapseGroups', () => {
  it('collects upstream helper CTEs for a CTE representative', () => {
    const { lineage } = analyzeSql(rankedCustomersSql);
    const groups = collectCollapsibleUpstreamGroups(lineage);

    expect(groups.get('cte_ranked_customers')).toMatchObject({
      label: 'ranked_customers',
      rootNodeId: 'cte_ranked_customers',
      helperNodes: expect.arrayContaining([
        { id: 'cte_order_base', label: 'order_base', type: 'cte' },
        { id: 'cte_customer_order_summary', label: 'customer_order_summary', type: 'cte' },
        { id: 'cte_support_pressure', label: 'support_pressure', type: 'cte' },
      ]),
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
    expect(collapsed.lineage.nodes.find((node) => node.id === 'cte_ranked_customers')?.label).toBe('ranked_customers');
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
      helperNodes: expect.arrayContaining([expect.objectContaining({ label: 'q', type: 'derived' })]),
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

  it('exposes dependency profile facts without auto-collapsing plain relay helpers', () => {
    const { lineage } = analyzeSql(simpleRelaySql);
    const orderBase = lineage.nodes.find((node) => node.id === 'cte_order_base');

    expect(orderBase?.dependencyProfile).toMatchObject({
      consumerNodeCount: 1,
      consumerNodeIds: ['cte_order_named'],
      hasGroupBy: false,
      hasJoin: false,
      hasSetOperation: false,
      hasWhere: false,
      inputNodeCount: 1,
      inputNodeIds: ['table_orders'],
      isRecursive: false,
      populationEffects: [],
    });
    expect(collectDefaultCollapsedGroupRootIds(lineage)).toEqual(new Set());
  });

  it('auto-collapses meaningful semantic steps and avoids nested default groups', () => {
    const { lineage } = analyzeSql(rankedCustomersSql);
    const { lineage: nestedLineage } = analyzeSql(nestedDerivedSql);

    expect(lineage.nodes.find((node) => node.id === 'cte_customer_order_summary')?.dependencyProfile).toMatchObject({
      hasGroupBy: true,
      hasJoin: true,
      populationEffects: expect.arrayContaining(['grain_change', 'null_extension']),
    });
    expect(collectDefaultCollapsedGroupRootIds(lineage)).toEqual(new Set(['cte_ranked_customers']));
    expect(collectDefaultCollapsedGroupRootIds(nestedLineage)).toEqual(new Set());
  });

  it('auto-collapses order_totals and preserves self and hidden descendant population effects', () => {
    const { lineage } = analyzeSql(salesSummarySql);
    const defaultCollapsedRootIds = collectDefaultCollapsedGroupRootIds(lineage);
    const groups = collectCollapsibleUpstreamGroups(lineage);
    const orderTotalsGroup = groups.get('cte_order_totals');

    expect(defaultCollapsedRootIds).toEqual(new Set(['cte_order_totals']));
    expect(orderTotalsGroup).toMatchObject({
      label: 'order_totals',
      helperNodeIds: ['cte_recent_orders'],
      summary: {
        operations: expect.arrayContaining(['sum(amount)']),
        groupBy: ['customer_id'],
        inputs: ['recent_orders'],
      },
      populationEffects: {
        self: ['grain_change'],
        descendants: expect.arrayContaining(['row_filter', 'row_multiplication']),
      },
    });

    const collapsed = collapseLineageGroups(lineage, defaultCollapsedRootIds);
    expect(collapsed.lineage.nodes.find((node) => node.id === 'cte_order_totals')?.label).toBe('order_totals');
    expect(collapsed.lineage.nodes.find((node) => node.id === 'cte_recent_orders')).toBeUndefined();
    expect(collapsed.groups.get('cte_order_totals')?.populationEffects).toMatchObject({
      self: ['grain_change'],
      descendants: expect.arrayContaining(['row_filter', 'row_multiplication']),
    });
  });

  it('excludes recursive CTEs from collapsible group candidates', () => {
    const { lineage } = analyzeSql(recursiveEmployeeSql);
    const groups = collectCollapsibleUpstreamGroups(lineage);
    const employeeTree = lineage.nodes.find((node) => node.id === 'cte_employee_tree');
    const collapsed = collapseLineageGroups(lineage, new Set(['cte_employee_tree']));

    expect(employeeTree).toMatchObject({
      label: 'employee_tree',
      recursive: true,
    });
    expect(employeeTree?.dependencyProfile?.isRecursive).toBe(true);
    expect(groups.has('cte_employee_tree')).toBe(false);
    expect(collectDefaultCollapsedGroupRootIds(lineage)).toEqual(new Set());
    expect(collapsed.groups.size).toBe(0);
    expect(collapsed.lineage.nodes.find((node) => node.id === 'cte_employee_tree')?.label).toBe('employee_tree');
  });
});
