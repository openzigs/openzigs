import { test, expect, navigateTo } from './helpers';

test.describe('Outbox', () => {
  test.beforeEach(async ({ page }) => {
    await navigateTo(page, '/outbox');
  });

  test('page heading is visible', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Publishing Outbox', level: 1 })).toBeVisible();
  });

  test('subtitle describes the page', async ({ page }) => {
    await expect(page.getByText('Queue content for autonomous publishing across platforms')).toBeVisible();
  });

  test('stats cards display status counts', async ({ page }) => {
    // Should see stat cards for each status
    await expect(page.getByText('Pending')).toBeVisible();
    await expect(page.getByText('Processing')).toBeVisible();
    await expect(page.getByText('Published')).toBeVisible();
    await expect(page.getByText('Failed')).toBeVisible();
    await expect(page.getByText('Canceled')).toBeVisible();
    await expect(page.getByText('Total')).toBeVisible();
  });

  test('platform filter dropdown is present', async ({ page }) => {
    const select = page.locator('select');
    await expect(select).toBeVisible();
    // Should have "All Platforms" as default
    await expect(select).toHaveValue('all');
  });

  test('queue section exists', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible();
  });

  test('empty state message when no items', async ({ page }) => {
    await expect(page.getByText('No items in the outbox')).toBeVisible();
    await expect(page.getByText('Use the Gallery to queue content for publishing')).toBeVisible();
  });

  test('navigation link exists in navbar', async ({ page }) => {
    const navLink = page.getByRole('link', { name: 'Outbox' });
    await expect(navLink).toBeVisible();
  });
});
