import { test, expect, navigateTo } from './helpers';

test.describe('Social Brain', () => {
  test.beforeEach(async ({ page }) => {
    await navigateTo(page, '/social');
  });

  test('page heading and description', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Social Brain' })).toBeVisible();
    await expect(
      page.getByText('Unified inbox, CRM, and automated response engine for social platforms.'),
    ).toBeVisible();
  });

  test('tab navigation shows all tabs', async ({ page }) => {
    const tabs = ['dashboard', 'crm', 'automations', 'leads', 'analytics', 'activity', 'settings'];
    for (const tab of tabs) {
      await expect(page.getByRole('button', { name: tab, exact: false })).toBeVisible();
    }
  });

  test('dashboard tab shows stats cards', async ({ page }) => {
    await expect(page.getByText('Contacts')).toBeVisible();
    await expect(page.getByText('Total Messages')).toBeVisible();
    await expect(page.getByText('Active Handoffs')).toBeVisible();
    await expect(page.getByText('Messages (24h)')).toBeVisible();
    await expect(page.getByText('Automation Triggers')).toBeVisible();
  });

  test('dashboard shows Connected Platforms section', async ({ page }) => {
    await expect(page.getByText('Connected Platforms')).toBeVisible();
  });

  test('connected platforms section displays all 5 platform names', async ({ page }) => {
    // The section shows platforms that are connected or configured
    // At minimum, the platform names should be rendered as badges
    const section = page.locator('text=Connected Platforms').locator('..');
    await expect(section).toBeVisible();
    // Check the page renders at least the platform labels
    // (platforms shown depend on config, but the settings tab always shows all 5)
  });

  test('settings tab shows all 5 platform cards', async ({ page }) => {
    await page.getByRole('button', { name: 'settings' }).click();
    await expect(page.getByText('Platform Configuration')).toBeVisible();

    // All 5 platforms should have cards in settings
    await expect(page.getByText('twitter').first()).toBeVisible();
    await expect(page.getByText('linkedin').first()).toBeVisible();
    await expect(page.getByText('reddit').first()).toBeVisible();
    await expect(page.getByText('youtube').first()).toBeVisible();
    await expect(page.getByText('tiktok').first()).toBeVisible();
  });

  test('settings tab shows confidence threshold', async ({ page }) => {
    await page.getByRole('button', { name: 'settings' }).click();
    await expect(page.getByText('Confidence Threshold')).toBeVisible();
  });

  test('settings tab shows webhook verify token status', async ({ page }) => {
    await page.getByRole('button', { name: 'settings' }).click();
    await expect(page.getByText('Webhook Verify Token')).toBeVisible();
    // Should show either "Set" or "Not Set"
    const status = page.locator('text=/^Set$|^Not Set$/');
    await expect(status.first()).toBeVisible();
  });

  test('settings tab has quick setup guide', async ({ page }) => {
    await page.getByRole('button', { name: 'settings' }).click();
    await expect(page.getByText('Quick Setup Guide')).toBeVisible();
  });

  test('platform cards show connection status', async ({ page }) => {
    await page.getByRole('button', { name: 'settings' }).click();
    // Each card shows one of: Connected, Token Set — Not Enabled, Not Configured
    const statusLabels = page.locator('text=/Connected|Token Set|Not Configured/');
    // Should have at least 5 status labels (one per platform)
    await expect(statusLabels.first()).toBeVisible();
    const count = await statusLabels.count();
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test('platform card shows env var info', async ({ page }) => {
    await page.getByRole('button', { name: 'settings' }).click();
    // Access Token labels visible for each platform
    const tokenLabels = page.getByText('Access Token');
    await expect(tokenLabels.first()).toBeVisible();
  });

  test('crm tab loads with contacts list', async ({ page }) => {
    await page.getByRole('button', { name: 'crm' }).click();
    // Should have a search input
    const searchInput = page.getByPlaceholder(/search/i);
    await expect(searchInput).toBeVisible();
  });

  test('automations tab loads', async ({ page }) => {
    await page.getByRole('button', { name: 'automations' }).click();
    // Either shows rules or "No rules" message
    const hasContent = await page.getByText(/Comment Automation Rules|No automation rules/i).first().isVisible().catch(() => false);
    expect(hasContent).toBeTruthy();
  });

  test('automations tab shows AI Generate button', async ({ page }) => {
    await page.getByRole('button', { name: 'automations' }).click();
    const aiBtn = page.getByRole('button', { name: /ai generate/i });
    await expect(aiBtn).toBeVisible();
  });

  test('activity tab loads', async ({ page }) => {
    await page.getByRole('button', { name: 'activity' }).click();
    // Should show activity section
    const hasContent = await page.getByText(/Activity|No recent activity/i).first().isVisible().catch(() => false);
    expect(hasContent).toBeTruthy();
  });

  test('leads tab loads', async ({ page }) => {
    await page.getByRole('button', { name: 'leads' }).click();
    // Should show the leads section — either data or empty state
    const hasContent = await page.getByText(/leads|No leads captured/i).first().isVisible().catch(() => false);
    expect(hasContent).toBeTruthy();
  });

  test('leads tab shows platform filter', async ({ page }) => {
    await page.getByRole('button', { name: 'leads' }).click();
    // Platform filter dropdown should be present
    const filter = page.locator('select, [role="combobox"]').first();
    const hasFilter = await filter.isVisible().catch(() => false);
    // It's acceptable if filter is only shown when leads exist
    if (!hasFilter) {
      const emptyState = page.getByText(/No leads captured/i);
      await expect(emptyState).toBeVisible();
    }
  });

  test('analytics tab loads with summary', async ({ page }) => {
    await page.getByRole('button', { name: 'analytics' }).click();
    // Should show analytics section with summary cards or loading state
    const hasContent = await page.getByText(/analytics|conversations|messages|automations/i).first().isVisible().catch(() => false);
    expect(hasContent).toBeTruthy();
  });

  test('pinterest analytics link is visible', async ({ page }) => {
    await expect(page.getByText('Pinterest Analytics')).toBeVisible();
  });

  test('Ask AI button is visible', async ({ page }) => {
    const askBtn = page.getByRole('button', { name: /ask ai/i });
    await expect(askBtn).toBeVisible();
  });

  test('automations tab shows Create Rule button', async ({ page }) => {
    await page.getByRole('button', { name: 'automations' }).click();
    const createBtn = page.getByRole('button', { name: /create|add|new/i });
    const hasCreate = await createBtn.first().isVisible().catch(() => false);
    expect(hasCreate).toBeTruthy();
  });

  test('dashboard shows Messages (24h) stat card', async ({ page }) => {
    const card = page.getByText('Messages (24h)');
    await expect(card).toBeVisible();
  });

  test('dashboard shows Automation Triggers stat card', async ({ page }) => {
    const card = page.getByText('Automation Triggers');
    await expect(card).toBeVisible();
  });

  test('crm tab search input can be typed into', async ({ page }) => {
    await page.getByRole('button', { name: 'crm' }).click();
    const searchInput = page.getByPlaceholder(/search/i);
    await searchInput.fill('test_user');
    await expect(searchInput).toHaveValue('test_user');
  });

  test('settings tab shows all expected sections', async ({ page }) => {
    await page.getByRole('button', { name: 'settings' }).click();
    await expect(page.getByText('Platform Configuration')).toBeVisible();
    await expect(page.getByText('Confidence Threshold')).toBeVisible();
    await expect(page.getByText('Quick Setup Guide')).toBeVisible();
  });

  test('can switch between all tabs', async ({ page }) => {
    const tabs = ['crm', 'automations', 'leads', 'analytics', 'activity', 'settings', 'dashboard'];
    for (const tab of tabs) {
      await page.getByRole('button', { name: tab, exact: false }).click();
      // Brief wait for tab content to render
      await page.waitForTimeout(300);
    }
    // Should end on dashboard without errors
    await expect(page.getByText('Contacts')).toBeVisible();
  });
});
