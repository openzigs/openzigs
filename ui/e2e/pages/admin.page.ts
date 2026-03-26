import type { Page, Locator } from '@playwright/test';

/**
 * Page Object for /admin — Administration page.
 * Encapsulates locators and interactions for the admin panel,
 * including platform-related sections added in Issue #601.
 */
export class AdminPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly subheading: Locator;
  readonly restartButton: Locator;

  // Sidecar-dependent section buttons (collapsed SectionCards)
  readonly imageGenSection: Locator;
  readonly videoGenSection: Locator;
  readonly musicGenSection: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', { name: 'Administration' });
    this.subheading = page.getByText('Channels, MCP servers, tool controls, and environment at a glance.');
    this.restartButton = page.getByRole('button', { name: /Restart Server/i });

    // SectionCard titles that include PlatformBadge components
    this.imageGenSection = page.getByRole('button', { name: /Image Generation Node/i });
    this.videoGenSection = page.getByRole('button', { name: /Video Generation Node/i });
    this.musicGenSection = page.getByRole('button', { name: /Music Generation Node/i });
  }

  async goto() {
    await this.page.goto('/admin');
    await this.page.waitForLoadState('domcontentloaded');
    await this.heading.waitFor({ state: 'visible', timeout: 15_000 });
  }

  /** Return all platform badge elements currently visible on the page */
  getPlatformBadges() {
    // PlatformBadge renders either "Available" or the reason text
    return this.page.locator('span').filter({
      hasText: /Available|Requires|Unavailable|not detected/i,
    });
  }

  /** Fetch the platform API directly and return parsed JSON */
  async fetchPlatformApi(): Promise<Record<string, unknown>> {
    const response = await this.page.request.get('/api/admin/platform', {
      headers: {
        Authorization: `Bearer ${process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? ''}`,
      },
    });
    return response.json();
  }
}
