import { expect, test } from '@playwright/test';

test('renders the sample SQL lineage graph on first load', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'SQL Lineage Viewer' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'SQL editor' })).toHaveValue(/WITH recent_orders AS/);
  await expect(page.getByTestId('analysis-status')).toContainText('Parsed successfully');
  await expect(page.getByTestId('lineage-graph')).toBeVisible();
  await expect(page.getByTestId('rf__node-table_orders')).toBeVisible();
  await expect(page.getByTestId('rf__node-table_order_items')).toBeVisible();
  await expect(page.getByTestId('rf__node-cte_recent_orders')).toBeVisible();
  await expect(page.getByTestId('rf__node-main_output')).toBeVisible();
  await expect(page.getByTestId('rf__edge-table_customers-main_output')).toBeAttached();
  await expect(page.getByTestId('rf__edge-cte_order_totals-main_output')).toBeAttached();
  await expect(page.getByTestId('rf__edge-cte_payment_summary-main_output')).toBeAttached();
  await expect(page.getByTestId('rf__edge-table_orders-cte_recent_orders')).toBeAttached();
  await expect(page.getByTestId('rf__edge-table_order_items-cte_recent_orders')).toBeAttached();
  await expect(page.getByTestId('rf__edge-table_order_items-cte_recent_orders-JOIN')).not.toBeAttached();
  await expect(page.getByTestId('rf__edge-cte_order_totals-main_output-LEFT_JOIN')).not.toBeAttached();
  await expect(page.getByTestId('rf__edge-cte_payment_summary-main_output-LEFT_JOIN')).not.toBeAttached();

  const outerDataFlowStyle = await page.getByTestId('rf__edge-cte_order_totals-main_output').locator('.react-flow__edge-path').first().getAttribute('style');
  expect(outerDataFlowStyle).toContain('stroke-dasharray');
  await expect(page.locator('.react-flow__edge-text')).toHaveCount(0);
  await expect(page.locator('.legend').getByText('Derived', { exact: true })).toBeVisible();
  await expect(page.getByTestId('graph-info')).toContainText('DataFlow');
  await expect(page.getByTestId('graph-info')).toContainText('Derived');
  await expect(page.getByTestId('graph-info')).not.toContainText('JOIN');
});

test('does not render join edges while keeping outer join context on data flows', async ({ page }) => {
  await page.goto('/');

  const dataFlowEdge = page.getByTestId('rf__edge-table_customers-main_output');
  const outerDataFlowEdge = page.getByTestId('rf__edge-cte_order_totals-main_output');
  const joinEdge = page.getByTestId('rf__edge-cte_order_totals-main_output-LEFT_JOIN');

  await expect(dataFlowEdge).toBeAttached();
  await expect(outerDataFlowEdge).toBeAttached();
  await expect(joinEdge).not.toBeAttached();
  const outerDataFlowStyle = await outerDataFlowEdge.locator('.react-flow__edge-path').first().getAttribute('style');
  expect(outerDataFlowStyle).toContain('stroke-dasharray');
});

test('shows referenced columns and can hide columns per node', async ({ page }) => {
  await page.goto('/');

  const ordersNode = page.getByTestId('rf__node-table_orders');
  const orderItemsNode = page.getByTestId('rf__node-table_order_items');
  const outputNode = page.getByTestId('rf__node-main_output');

  await expect(ordersNode.getByText('order_date')).toBeVisible();
  await expect(orderItemsNode.getByText('unit_price')).toBeVisible();
  await expect(outputNode.getByText('customer_name')).toBeVisible();

  await page.locator('button[aria-label="Hide columns for orders"]').click();

  await expect(ordersNode.getByText('order_date')).not.toBeVisible();
  await expect(orderItemsNode.getByText('unit_price')).toBeVisible();

  await page.locator('button[aria-label="Show columns for orders"]').click();
  await expect(ordersNode.getByText('order_date')).toBeVisible();
});

test('highlights upstream lineage when an output column is selected', async ({ page }) => {
  await page.goto('/');

  const outputNode = page.getByTestId('rf__node-main_output');
  const orderTotalsNode = page.getByTestId('rf__node-cte_order_totals');
  const recentOrdersNode = page.getByTestId('rf__node-cte_recent_orders');
  const orderItemsNode = page.getByTestId('rf__node-table_order_items');

  await outputNode.getByRole('button', { name: 'total_amount', exact: true }).click();

  await expect(outputNode.getByRole('button', { name: 'total_amount', exact: true })).toHaveClass(/lineage-column-selected/);
  await expect(orderTotalsNode.getByRole('button', { name: 'total_amount', exact: true })).toHaveClass(/lineage-column-highlighted/);
  await expect(recentOrdersNode.getByRole('button', { name: 'amount', exact: true })).toHaveClass(/lineage-column-highlighted/);
  await expect(orderItemsNode.getByRole('button', { name: 'quantity', exact: true })).toHaveClass(/lineage-column-source/);
  await expect(orderItemsNode.getByRole('button', { name: 'unit_price', exact: true })).toHaveClass(/lineage-column-source/);

  await outputNode.getByRole('button', { name: 'total_amount', exact: true }).click();
  await expect(outputNode.getByRole('button', { name: 'total_amount', exact: true })).not.toHaveClass(/lineage-column-selected/);
});

test('highlights downstream output lineage when a source column is selected', async ({ page }) => {
  await page.goto('/');

  const outputNode = page.getByTestId('rf__node-main_output');
  const orderTotalsNode = page.getByTestId('rf__node-cte_order_totals');
  const recentOrdersNode = page.getByTestId('rf__node-cte_recent_orders');
  const orderItemsNode = page.getByTestId('rf__node-table_order_items');

  await orderItemsNode.getByRole('button', { name: 'quantity', exact: true }).click();

  await expect(orderItemsNode.getByRole('button', { name: 'quantity', exact: true })).toHaveClass(/lineage-column-selected/);
  await expect(recentOrdersNode.getByRole('button', { name: 'amount', exact: true })).toHaveClass(/lineage-column-highlighted/);
  await expect(orderTotalsNode.getByRole('button', { name: 'total_amount', exact: true })).toHaveClass(/lineage-column-highlighted/);
  await expect(outputNode.getByRole('button', { name: 'total_amount', exact: true })).toHaveClass(/lineage-column-highlighted/);
});

test('can drag lineage nodes to separate overlapping lines', async ({ page }) => {
  await page.goto('/');

  const node = page.getByTestId('rf__node-table_orders');
  await expect(node).toBeVisible();
  const before = await node.boundingBox();
  const beforeTransform = await node.getAttribute('style');
  expect(before).not.toBeNull();

  await page.mouse.move(before!.x + 28, before!.y + 20);
  await page.mouse.down();
  await page.mouse.move(before!.x + 118, before!.y + 90, { steps: 8 });
  await page.mouse.up();

  await expect(node).not.toHaveAttribute('style', beforeTransform ?? '');
});

test('updates the lineage graph after editing SQL', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('textbox', { name: 'SQL editor' }).fill('SELECT u.id, u.name FROM users u LEFT JOIN accounts a ON a.user_id = u.id');
  await page.getByRole('button', { name: 'Analyze SQL' }).click();

  await expect(page.getByTestId('analysis-status')).toContainText('Parsed successfully');
  await expect(page.getByTestId('rf__node-table_users')).toBeVisible();
  await expect(page.getByTestId('rf__node-table_accounts')).toBeVisible();
  await expect(page.getByTestId('rf__edge-table_accounts-main_output')).toBeAttached();
  await expect(page.getByTestId('rf__edge-table_accounts-main_output-LEFT_JOIN')).not.toBeAttached();
  await expect(page.getByTestId('lineage-graph').getByText('LEFT JOIN')).not.toBeVisible();
});
