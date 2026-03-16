import { test, expect, navigateTo } from './helpers';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await navigateTo(page, '/');
  });

  test('page heading and description', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Control Panel' })).toBeVisible();
    await expect(page.getByText('Monitor approvals, tool controls, and audit activity in real time.')).toBeVisible();
  });

  test('agent status indicator is visible', async ({ page }) => {
    await expect(page.getByText('Agent status')).toBeVisible();
    // Status should be either Connected or Connecting
    const status = page.locator('text=/Connected|Connecting/');
    await expect(status.first()).toBeVisible();
  });

  test('audit log section with filters', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Audit Log' })).toBeVisible();

    // Category filter
    const categoryFilter = page.getByRole('combobox').filter({ has: page.locator('option', { hasText: 'All categories' }) });
    await expect(categoryFilter).toBeVisible();
    await expect(categoryFilter.locator('option')).toHaveCount(4); // All categories, System, Tool, Security

    // Level filter
    const levelFilter = page.getByRole('combobox').filter({ has: page.locator('option', { hasText: 'All levels' }) });
    await expect(levelFilter).toBeVisible();

    // Export button
    await expect(page.getByRole('button', { name: 'Export JSON' })).toBeVisible();
  });

  test('snapshot section shows tool/approval counts', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Snapshot' })).toBeVisible();
    await expect(page.getByText('Tools', { exact: true })).toBeVisible();
    await expect(page.getByText('Approvals', { exact: true })).toBeVisible();
  });

  test('active automations section', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Active Automations' })).toBeVisible();
    // Should show at least one automation or "No active automations"
    const hasAutomations = await page.getByText(/Daily Pinterest|java-code-review|morning-brief/).first().isVisible().catch(() => false);
    const hasEmpty = await page.getByText('No active automations').isVisible().catch(() => false);
    expect(hasAutomations || hasEmpty).toBeTruthy();
  });

  test('pending approvals section', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Pending Approvals' })).toBeVisible();
  });

  test('view all automations link navigates to scheduler', async ({ page }) => {
    const link = page.getByRole('link', { name: 'View all automations' });
    // Only test if automations exist (link only shows when there are jobs)
    if (await link.isVisible().catch(() => false)) {
      await expect(link).toHaveAttribute('href', '/scheduler');
    }
  });

  test('all dashboard sections are rendered', async ({ page }) => {
    // Verify all four sections are present and have their headings
    await expect(page.getByRole('heading', { name: 'Audit Log' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Snapshot' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Active Automations' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pending Approvals' })).toBeVisible();
  });
});
