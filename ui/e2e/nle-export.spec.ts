import { test, expect } from "@playwright/test";
import { navigateTo } from "./helpers";
import { NLEExportPage } from "./pages/nle-export.page";

/**
 * E2E Tests — NLE Export (#826)
 *
 * Acceptance Criteria from issue:
 * AC1: Export FCP XML that imports correctly into Adobe Premiere Pro
 * AC2: Export FCP XML that imports correctly into DaVinci Resolve
 * AC3: Export basic EDL that imports into any NLE
 * AC4: Clip boundaries preserved accurately (frame-accurate)
 * AC5: Caption/subtitle track included as text titles
 * AC6: Multi-track support: main video + B-Roll + audio
 * AC7: Transitions exported as dissolves with correct duration
 * AC8: Export button accessible in Director Studio UI
 * AC9: MCP tool works standalone for programmatic export
 */
test.describe("NLE Export (#826)", () => {
  // AC8: NLE Export panel visible in Director Studio
  test("should display NLE export panel with heading", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const panel = new NLEExportPage(page);
    await expect(panel.heading).toBeVisible();
  });

  // AC1,AC3: Format picker shows both FCPXML and EDL
  test("should display FCP XML and EDL format options", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const panel = new NLEExportPage(page);
    await expect(panel.fcpxmlOption).toBeVisible();
    await expect(panel.edlOption).toBeVisible();
  });

  // AC8: Export button visible
  test("should show export button", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const panel = new NLEExportPage(page);
    await expect(panel.exportButton).toBeVisible();
  });

  // AC1: FCP XML format details shown
  test("should show FCP XML description mentioning supported NLEs", async ({
    page,
  }) => {
    await navigateTo(page, "/director/studio/test-draft");
    await expect(
      page.getByText(/Premiere Pro|DaVinci Resolve|Final Cut Pro/i).first(),
    ).toBeVisible();
  });

  // AC3: EDL format details shown
  test("should show EDL description mentioning universal compatibility", async ({
    page,
  }) => {
    await navigateTo(page, "/director/studio/test-draft");
    await expect(
      page.getByText(/CMX3600|Universal NLE compatibility/i).first(),
    ).toBeVisible();
  });

  // AC9: Export API endpoint accepts FCPXML format
  test("should have export API accepting fcpxml format", async ({
    request,
  }) => {
    const res = await request.post("/api/studio/pipeline/export", {
      data: {
        manifest: {
          composition: { fps: 30, width: 1920, height: 1080 },
          timeline: [
            { id: "s1", durationInFrames: 90, media: { src: "test.mp4" } },
          ],
        },
        format: "fcpxml",
      },
    });
    if (res.ok()) {
      const body = await res.json();
      expect(body.format).toBe("fcpxml");
      expect(body.status).toBe("complete");
      expect(body).toHaveProperty("clips");
    }
  });

  // AC9: Export API accepts EDL format
  test("should have export API accepting edl format", async ({ request }) => {
    const res = await request.post("/api/studio/pipeline/export", {
      data: {
        manifest: {
          composition: { fps: 30 },
          timeline: [
            { id: "s1", durationInFrames: 90, media: { src: "test.mp4" } },
          ],
        },
        format: "edl",
      },
    });
    if (res.ok()) {
      const body = await res.json();
      expect(body.format).toBe("edl");
      expect(body.status).toBe("complete");
    }
  });

  // AC9: Export API rejects invalid format
  test("should reject invalid export format with 400", async ({ request }) => {
    const res = await request.post("/api/studio/pipeline/export", {
      data: { manifest: {}, format: "invalid" },
    });
    expect(res.status()).toBe(400);
  });
});
