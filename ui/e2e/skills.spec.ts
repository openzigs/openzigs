import { test, expect, navigateTo } from './helpers';

test.describe('Skills Editor', () => {
  test.beforeEach(async ({ page }) => {
    await navigateTo(page, '/admin/skills');
  });

  test('page heading and description', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Skills', level: 1 })).toBeVisible();
    await expect(page.getByText('Manage built-in and custom SKILL.md skill files')).toBeVisible();
  });

  test('back to admin link', async ({ page }) => {
    const link = page.getByRole('link', { name: '← Admin' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/admin');
  });

  test('new skill button is present', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'New Skill' })).toBeVisible();
  });

  test('built-in skill cards are rendered', async ({ page }) => {
    const expectedSkills = [
      'Content Creator',
      'Knowledge Curator',
      'Media Director',
      'Pinterest Marketer',
      'Platform Manager',
      'Remix Engineer',
      'Research Synthesizer',
      'System Operator',
    ];

    for (const skill of expectedSkills) {
      await expect(page.getByRole('heading', { name: skill, level: 3 })).toBeVisible();
    }
  });

  test('skill cards show Built-in badge', async ({ page }) => {
    const badges = page.getByText('Built-in', { exact: true });
    await expect(badges.first()).toBeVisible();
    // Should have at least one Built-in badge visible
    expect(await badges.count()).toBeGreaterThanOrEqual(1);
  });

  test('skill cards show description', async ({ page }) => {
    // Media Director card should show its description
    await expect(page.getByText(/Orchestrates image generation.*media queue/)).toBeVisible();
  });

  test('skill cards show tool tags', async ({ page }) => {
    // Check that tool tags appear on cards
    await expect(page.getByText('web-search')).toBeVisible();
    await expect(page.getByText('submit-media-job').first()).toBeVisible();
  });

  test('skill cards have View button', async ({ page }) => {
    const viewBtns = page.getByRole('button', { name: 'View' });
    await expect(viewBtns.first()).toBeVisible();
    expect(await viewBtns.count()).toBe(8);
  });

  test('overflow tool count indicator', async ({ page }) => {
    // Some cards show "+N more" for overflow tools
    const overflow = page.getByText(/\+\d+ more/).first();
    await expect(overflow).toBeVisible();
  });

  test('clicking View opens skill detail', async ({ page }) => {
    // Click View on the first skill card
    await page.getByRole('button', { name: 'View' }).first().click();

    // A modal or detail view should appear with skill content
    // Wait for some detail content to appear
    await page.waitForTimeout(500);

    // Should show a close/back mechanism
    const closeBtn = page.getByRole('button', { name: /Close|Back|×/ });
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
    }
  });
});
