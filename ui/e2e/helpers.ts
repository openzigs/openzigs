import { test, expect, type Page } from '@playwright/test';

/**
 * Shared helpers for OpenZigs E2E tests.
 * Import from here instead of duplicating across test files.
 */

/** Wait for the Next.js app to be fully hydrated */
export async function waitForHydration(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  // Wait for the main element to appear (Next.js App Router renders into <main>)
  await page.locator('main').waitFor({ state: 'visible', timeout: 15_000 });
}

/** Navigate and wait for the page to settle */
export async function navigateTo(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
}

/** Assert the nav bar is visible with expected links */
export async function expectNavBar(page: Page) {
  const nav = page.locator('nav');
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Chat' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Workbench' })).toBeVisible();
}

export { test, expect };
