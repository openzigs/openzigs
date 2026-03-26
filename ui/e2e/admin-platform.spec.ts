import { test, expect } from './helpers';
import { AdminPage } from './pages/admin.page';

/**
 * E2E tests for platform capability awareness on the Admin page.
 * Covers acceptance criteria from Epic #590 / Issue #601:
 *
 * AC1: Admin page loads and displays platform information
 * AC2: Platform badge shows the correct OS information
 * AC3: Sidecar-dependent features show platform availability indicators
 * AC4: Platform API endpoint returns expected structure
 * AC5: Platform badge gracefully handles loading/error states
 *
 * Note: Badge rendering tests (AC2/AC3) verify via API structure and SSR
 * graceful degradation. Client-side React Query hydration for badges requires
 * a production build (next build && next start); the dev server HMR environment
 * does not reliably hydrate client components in Playwright.
 */

test.describe('Admin Platform Capabilities', () => {
  let adminPage: AdminPage;

  test.beforeEach(async ({ page }) => {
    adminPage = new AdminPage(page);
  });

  // ── AC1: Admin page loads and displays platform information ───────────
  test('should display the admin page heading and description', async () => {
    await adminPage.goto();

    await expect(adminPage.heading).toBeVisible();
    await expect(adminPage.subheading).toBeVisible();
    await expect(adminPage.restartButton).toBeVisible();
  });

  // ── AC3: Sidecar-dependent sections are present on admin page ─────────
  test('should render sidecar-dependent sections with platform badge slots', async () => {
    await adminPage.goto();

    // Verify Image Generation, Video Generation, and Music Generation
    // SectionCards are rendered in the SSR output
    await adminPage.imageGenSection.scrollIntoViewIfNeeded();
    await expect(adminPage.imageGenSection).toBeVisible();

    await adminPage.videoGenSection.scrollIntoViewIfNeeded();
    await expect(adminPage.videoGenSection).toBeVisible();

    await adminPage.musicGenSection.scrollIntoViewIfNeeded();
    await expect(adminPage.musicGenSection).toBeVisible();
  });

  // ── AC4: Platform API endpoint returns expected structure ─────────────
  test('should return well-structured platform API response', async () => {
    await adminPage.goto();
    const data = await adminPage.fetchPlatformApi();

    // Verify top-level structure
    expect(data).toHaveProperty('platform');
    expect(data).toHaveProperty('features');

    // Verify platform object shape
    const platform = data['platform'] as Record<string, unknown>;
    expect(platform).toHaveProperty('os');
    expect(platform).toHaveProperty('arch');
    expect(platform).toHaveProperty('dockerAvailable');
    expect(platform).toHaveProperty('sidecarsSupported');
    expect(platform).toHaveProperty('isWindows');
    expect(platform).toHaveProperty('isMacOS');
    expect(platform).toHaveProperty('isLinux');

    // OS must be a known value
    expect(['darwin', 'win32', 'linux']).toContain(platform['os']);
    // Exactly one OS flag should be true
    const osFlags = [platform['isWindows'], platform['isMacOS'], platform['isLinux']];
    expect(osFlags.filter(Boolean)).toHaveLength(1);
  });

  // ── AC2: Platform API returns correct feature availability per OS ─────
  test('should return feature availability that matches platform capabilities', async () => {
    await adminPage.goto();
    const data = await adminPage.fetchPlatformApi();
    const platform = data['platform'] as Record<string, unknown>;
    const features = data['features'] as Record<string, { available: boolean; reason?: string }>;

    // All expected feature keys must exist
    for (const key of ['imageGeneration', 'audioProcessing', 'musicGeneration', 'videoRendering', 'docker']) {
      expect(features).toHaveProperty(key);
      expect(features[key]).toHaveProperty('available');
    }

    // Sidecar features should match sidecarsSupported flag
    if (platform['sidecarsSupported']) {
      expect(features['imageGeneration'].available).toBe(true);
      expect(features['audioProcessing'].available).toBe(true);
      expect(features['musicGeneration'].available).toBe(true);
    } else {
      expect(features['imageGeneration'].available).toBe(false);
      expect(features['imageGeneration'].reason).toBeTruthy();
    }

    // Docker feature should match dockerAvailable
    expect(features['docker'].available).toBe(!!platform['dockerAvailable']);

    // Video rendering is always available
    expect(features['videoRendering'].available).toBe(true);
  });

  // ── AC5: Platform badge gracefully handles loading/error states ───────
  test('should render admin page even when platform API fails', async ({ page }) => {
    // Block the platform API to simulate a failure
    await page.route('**/api/admin/platform', (route) =>
      route.fulfill({ status: 500, body: 'Internal Server Error' }),
    );

    await adminPage.goto();

    // The page should still render — heading and sections should be visible
    await expect(adminPage.heading).toBeVisible();

    await adminPage.imageGenSection.scrollIntoViewIfNeeded();
    await expect(adminPage.imageGenSection).toBeVisible();

    await adminPage.videoGenSection.scrollIntoViewIfNeeded();
    await expect(adminPage.videoGenSection).toBeVisible();

    await adminPage.musicGenSection.scrollIntoViewIfNeeded();
    await expect(adminPage.musicGenSection).toBeVisible();
  });
});
