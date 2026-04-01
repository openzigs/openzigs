import { expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';

/**
 * Page Object Model for /presenter/[id] — Presenter detail/player page.
 * Encapsulates locators and interactions for SCORM export acceptance criteria.
 *
 * Issue #688 / Epic SCORM Export for Presentations.
 */

export const MOCK_PRESENTATION_ID = 'e2e-scorm-test-001';

const MOCK_PRESENTATION_BODY = {
  id: MOCK_PRESENTATION_ID,
  title: 'E2E Test Presentation',
  video_path: '/files/nonexistent-e2e.mp4',
  thumbnail_path: null,
  duration_seconds: 90,
  fps: 30,
  script_json: [],
  chapters: [],
  user_chapters: [],
  voice_id: null,
  quiz_enabled: false,
  quiz_config: null,
  mode: 'standard',
  created_at: '2026-01-01T00:00:00.000Z',
};

export class PresenterDetailPage {
  readonly page: Page;

  /** Matches the SCORM export button in both default and loading states. */
  readonly scormExportButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.scormExportButton = page.getByRole('button', {
      name: /Export SCORM|Exporting/i,
    });
  }

  /**
   * Install API mocks for the presentation fetch and quiz fetch,
   * navigate to the presenter detail page, and wait until the SCORM button is
   * rendered (meaning the presentation data loaded successfully).
   */
  async gotoWithMocks(presentationId = MOCK_PRESENTATION_ID): Promise<void> {
    // Mock GET /api/presentations/:id — presentation metadata
    await this.page.route(
      (url) => url.pathname === `/api/presentations/${presentationId}`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...MOCK_PRESENTATION_BODY, id: presentationId }),
        }),
    );

    // Mock GET /api/presentations/:id/quiz — quiz questions
    await this.page.route(
      (url) => url.pathname === `/api/presentations/${presentationId}/quiz`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ questions: [] }),
        }),
    );

    await this.page.goto(`/presenter/${presentationId}`);

    // The SCORM button only appears after the presentation query succeeds.
    await expect(this.scormExportButton).toBeVisible({ timeout: 15_000 });
  }
}
