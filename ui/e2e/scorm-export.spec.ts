import { test, expect } from './helpers';
import { PresenterDetailPage, MOCK_PRESENTATION_ID } from './pages/presenter-detail.page';

/**
 * E2E tests for SCORM Export (Epic #688 — SCORM Export for Presentations).
 *
 * Acceptance Criteria Mapping:
 *
 * AC1 — SCORM Export button is visible on the presenter detail page for an
 *        authenticated admin user.
 * AC2 — Loading state: button shows "Exporting…" and is disabled while the
 *        download request is in progress.
 * AC3 — Download triggered: clicking the button initiates a POST request to
 *        the SCORM endpoint.
 * AC4 — Button text: the default label is "Export SCORM".
 * AC5 — Unauthenticated API access: POST /api/presentations/:id/scorm without
 *        an Authorization token returns HTTP 401.
 */
test.describe('SCORM Export', () => {
  // ── AC1 + AC4: Button is visible with the correct default label ───────────
  test('should display Export SCORM button on the presenter detail page', async ({
    page,
  }) => {
    const presenterPage = new PresenterDetailPage(page);

    await test.step('Navigate to presenter detail page with mocked API', async () => {
      await presenterPage.gotoWithMocks(MOCK_PRESENTATION_ID);
    });

    // AC1: button is visible
    await test.step('Verify SCORM Export button is visible', async () => {
      await expect(presenterPage.scormExportButton).toBeVisible();
    });

    // AC4: default label is "Export SCORM"
    await test.step('Verify default button label is "Export SCORM"', async () => {
      await expect(presenterPage.scormExportButton).toHaveText('Export SCORM');
    });
  });

  // ── AC2: Loading state appears while the fetch is in flight ──────────────
  test('should show loading indicator while SCORM export is in progress', async ({
    page,
  }) => {
    const presenterPage = new PresenterDetailPage(page);

    await test.step('Navigate to presenter detail page with mocked API', async () => {
      await presenterPage.gotoWithMocks(MOCK_PRESENTATION_ID);
    });

    // Use a deferred gate so we can verify the loading state before
    // the route resolves — avoids arbitrary sleeps.
    let releaseRoute!: () => void;
    const routeGate = new Promise<void>((resolve) => {
      releaseRoute = resolve;
    });

    await page.route(
      (url) =>
        url.pathname === `/api/presentations/${MOCK_PRESENTATION_ID}/scorm`,
      async (route) => {
        // Hold the response until the test releases the gate.
        await routeGate;
        await route.abort('failed');
      },
    );

    await test.step('Click Export SCORM button', async () => {
      await presenterPage.scormExportButton.click();
    });

    await test.step('Verify loading state: button shows "Exporting…" and is disabled', async () => {
      // Web-first assertions auto-retry until the React re-render completes.
      const loadingButton = page.getByRole('button', { name: 'Exporting…' });
      await expect(loadingButton).toBeVisible();
      await expect(loadingButton).toBeDisabled();
    });

    // Release the blocked route so the test and browser can clean up.
    releaseRoute();
  });

  // ── AC3: Clicking the button sends a POST to the SCORM endpoint ──────────
  test('should initiate a POST request to the SCORM endpoint when clicked', async ({
    page,
  }) => {
    const presenterPage = new PresenterDetailPage(page);

    await test.step('Navigate to presenter detail page with mocked API', async () => {
      await presenterPage.gotoWithMocks(MOCK_PRESENTATION_ID);
    });

    // Minimal valid ZIP end-of-central-directory signature so the browser
    // can create a Blob without errors.
    const minimalZip = Buffer.from([
      0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    await page.route(
      (url) =>
        url.pathname === `/api/presentations/${MOCK_PRESENTATION_ID}/scorm`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/zip',
          headers: {
            'Content-Disposition': `attachment; filename="presentation-${MOCK_PRESENTATION_ID}-scorm.zip"`,
          },
          body: minimalZip,
        }),
    );

    // Use Promise.all so we wait for the request concurrently with the click.
    let capturedRequest: { method: string; url: string } | null = null;

    const [scormRequest] = await Promise.all([
      page.waitForRequest(
        (req) =>
          req.url().includes(`/scorm`) && req.method() === 'POST',
      ),
      presenterPage.scormExportButton.click(),
    ]);

    capturedRequest = { method: scormRequest.method(), url: scormRequest.url() };

    await test.step('Verify the SCORM request was a POST to the correct endpoint', async () => {
      expect(capturedRequest!.method).toBe('POST');
      expect(capturedRequest!.url).toContain(
        `/api/presentations/${MOCK_PRESENTATION_ID}/scorm`,
      );
    });

    await test.step('Verify button returns to default state after export completes', async () => {
      // After the fetch resolves, scormExporting resets to false.
      await expect(
        page.getByRole('button', { name: 'Export SCORM' }),
      ).toBeVisible();
    });
  });

  // ── AC5: Unauthenticated API request returns 401 ─────────────────────────
  //
  // This test calls the backend directly (bypassing the Next.js middleware
  // which would inject the auth token). A POST without a Bearer token must
  // be rejected with 401 Unauthorized.
  //
  // Requires the backend to be running at http://localhost:3000 (or E2E_API_BASE_URL).
  test('should return 401 for unauthenticated POST to SCORM export endpoint', async ({
    request,
  }) => {
    const apiBase = process.env.E2E_API_BASE_URL ?? 'http://localhost:3000';
    // Direct backend URL — bypasses Next.js middleware auth injection.
    const response = await request.post(
      `${apiBase}/api/presentations/nonexistent-id/scorm`,
      {
        headers: {}, // explicitly no Authorization header
        failOnStatusCode: false,
      },
    );

    expect(response.status()).toBe(401);
  });
});
