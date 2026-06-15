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
  await expect(page.getByTestId('rf__edge-table_order_items-cte_recent_orders-JOIN')).toBeAttached();
  await expect(page.getByTestId('rf__edge-cte_order_totals-main_output-LEFT_JOIN')).toBeAttached();
  await expect(page.getByTestId('rf__edge-cte_payment_summary-main_output-LEFT_JOIN')).toBeAttached();

  const innerJoinStyle = await page.getByTestId('rf__edge-table_order_items-cte_recent_orders-JOIN').locator('.react-flow__edge-path').first().getAttribute('style');
  const outerJoinStyle = await page.getByTestId('rf__edge-cte_order_totals-main_output-LEFT_JOIN').locator('.react-flow__edge-path').first().getAttribute('style');
  const outerDataFlowStyle = await page.getByTestId('rf__edge-cte_order_totals-main_output').locator('.react-flow__edge-path').first().getAttribute('style');
  expect(innerJoinStyle).not.toContain('stroke-dasharray');
  expect(outerJoinStyle).toContain('stroke-dasharray');
  expect(outerDataFlowStyle).toContain('stroke-dasharray');
  await expect(page.getByTestId('graph-info')).toContainText('DataFlow');
  await expect(page.getByTestId('graph-info')).toContainText('JOIN');
});

test('can toggle data flow and join edges independently', async ({ page }) => {
  await page.goto('/');

  const dataFlowEdge = page.getByTestId('rf__edge-table_customers-main_output');
  const outerDataFlowEdge = page.getByTestId('rf__edge-cte_order_totals-main_output');
  const joinEdge = page.getByTestId('rf__edge-cte_order_totals-main_output-LEFT_JOIN');

  await expect(dataFlowEdge).toBeAttached();
  await expect(outerDataFlowEdge).toBeAttached();
  await expect(joinEdge).toBeAttached();

  await page.getByRole('checkbox', { name: 'JOIN' }).uncheck();
  await expect(dataFlowEdge).toBeAttached();
  await expect(outerDataFlowEdge).toBeAttached();
  await expect(joinEdge).not.toBeAttached();
  const outerDataFlowStyle = await outerDataFlowEdge.locator('.react-flow__edge-path').first().getAttribute('style');
  expect(outerDataFlowStyle).toContain('stroke-dasharray');

  await page.getByRole('checkbox', { name: 'JOIN' }).check();
  await page.getByRole('checkbox', { name: 'DataFlow' }).uncheck();
  await expect(dataFlowEdge).not.toBeAttached();
  await expect(joinEdge).toBeAttached();
});

test('can drag lineage nodes to separate overlapping lines', async ({ page }) => {
  await page.goto('/');

  const node = page.getByTestId('rf__node-table_orders');
  await expect(node).toBeVisible();
  const before = await node.boundingBox();
  expect(before).not.toBeNull();

  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  await page.mouse.move(before!.x + before!.width / 2 + 90, before!.y + before!.height / 2 + 70, { steps: 8 });
  await page.mouse.up();

  const after = await node.boundingBox();
  expect(after).not.toBeNull();
  expect(after!.x).toBeGreaterThan(before!.x + 40);
  expect(after!.y).toBeGreaterThan(before!.y + 30);
});

test('updates the lineage graph after editing SQL', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('textbox', { name: 'SQL editor' }).fill('SELECT u.id, u.name FROM users u LEFT JOIN accounts a ON a.user_id = u.id');
  await page.getByRole('button', { name: 'Analyze SQL' }).click();

  await expect(page.getByTestId('analysis-status')).toContainText('Parsed successfully');
  await expect(page.getByTestId('rf__node-table_users')).toBeVisible();
  await expect(page.getByTestId('rf__node-table_accounts')).toBeVisible();
  await expect(page.getByTestId('rf__edge-table_accounts-main_output-LEFT_JOIN')).toBeAttached();
  await expect(page.getByTestId('lineage-graph').getByText('LEFT JOIN').first()).toBeVisible();
});
