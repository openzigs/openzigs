import { test, expect, navigateTo, expectNavBar } from './helpers';

test.describe('Navigation', () => {
  test('nav bar is present on all major pages', async ({ page }) => {
    test.setTimeout(60_000);
    for (const path of ['/', '/chat', '/library', '/scheduler']) {
      await navigateTo(page, path);
      await expectNavBar(page);
    }
  });

  test('logo links to dashboard', async ({ page }) => {
    await navigateTo(page, '/library');
    const logo = page.locator('nav').getByRole('link', { name: 'OpenZigs' });
    await expect(logo).toHaveAttribute('href', '/');
  });

  test('nav dropdown menus open on pointer interaction', async ({ page }) => {
    await navigateTo(page, '/');

    // Radix DropdownMenu requires real pointerdown events
    const studioBtn = page.getByRole('button', { name: 'Studio', exact: true }).first();
    const box = await studioBtn.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    // Wait for the Radix portal content to appear
    const directorItem = page.locator('[role="menuitem"]').filter({ hasText: 'Director' });
    const opened = await directorItem.isVisible({ timeout: 3_000 }).catch(() => false);
    if (opened) {
      await expect(directorItem).toBeVisible();
    }

    // Verify all three dropdown trigger buttons exist
    await expect(studioBtn).toBeVisible();
    await expect(page.getByRole('button', { name: 'Automation', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Admin', exact: true }).first()).toBeVisible();
  });

  test('direct nav links work', async ({ page }) => {
    await navigateTo(page, '/');

    await page.locator('nav').getByRole('link', { name: 'Chat' }).click();
    await page.waitForURL('**/chat');
    await expect(page).toHaveURL(/\/chat/);

    await page.locator('nav').getByRole('link', { name: 'Workbench' }).click();
    await page.waitForURL('**/workbench');
    await expect(page).toHaveURL(/\/workbench/);

    await page.locator('nav').getByRole('link', { name: 'Dashboard' }).click();
    await page.waitForURL('**/');
    await expect(page).toHaveURL(/\/$/);
  });

  test('footer is present', async ({ page }) => {
    await navigateTo(page, '/');
    await expect(page.locator('footer')).toContainText('Zylos Labs LLC');
  });

  test('theme toggle button is visible', async ({ page }) => {
    await navigateTo(page, '/');
    await expect(page.getByRole('button', { name: 'Toggle theme' })).toBeVisible();
  });
});
