import { test, expect } from "@playwright/test";
import { FramingPanelPage } from "../../pages/framing-panel.page";

/**
 * Epic #910 — Issue #834: UI: Reframe side-by-side preview and subject overlay
 *
 * Audit ACs (2026-04-19):
 * - AC1: Side-by-side preview component renders original and reframed video
 * - AC2: Subject bounding box overlay shows tracked regions
 * - AC3: Integrated into Director Studio framing panel
 * - AC4: Responsive layout for different screen sizes
 *
 * Wiring status (PR #913):
 *   ✅ ReframePreview + SubjectOverlay imported into framing-panel.tsx and
 *      rendered conditionally when `sourceVideoUrl` prop is provided.
 *   ⚠️  scene-inspector.tsx mounts <FramingPanel> WITHOUT passing
 *      sourceVideoUrl / reframedVideoUrl / trackingBoxes. So the
 *      ReframePreview never renders in the live app yet — pending the
 *      follow-up integration that feeds the source manifest URL into the
 *      inspector. Tests that depend on a rendered preview are marked
 *      `test.fixme` with a clear comment.
 */
test.describe("Epic #910 / Issue #834 — Reframe Preview & Subject Overlay", () => {
  // AC3: Integrated into Director Studio framing panel
  test("framing panel mounts inside Director Studio scene inspector", async ({
    page,
  }) => {
    const framing = new FramingPanelPage(page);
    await framing.gotoStudio();
    await framing.expectPanelVisible();
    await expect(framing.offsetSlider).toBeVisible();
    await expect(framing.fitButton).toBeVisible();
    await expect(framing.cropButton).toBeVisible();
  });

  // AC3: Crop offset slider remains operable (existing behaviour preserved)
  test("offset slider is enabled in crop mode and reset returns to 50", async ({
    page,
  }) => {
    const framing = new FramingPanelPage(page);
    await framing.gotoStudio();
    await framing.cropButton.click();
    await expect(framing.offsetSlider).toBeEnabled();
    await framing.offsetSlider.fill("75");
    await expect(framing.offsetSlider).toHaveValue("75");
    await framing.resetButton.click();
    await expect(framing.offsetSlider).toHaveValue("50");
  });

  // AC1: Side-by-side preview renders source + reframed players
  test.fixme("renders side-by-side source and reframed videos in the studio", async ({
    page,
  }) => {
    // BLOCKED: scene-inspector.tsx does not yet pass `sourceVideoUrl` to
    // <FramingPanel>. ReframePreview is rendered conditionally, so the
    // dual-video layout is never present in the live UI today.
    // Component-level coverage is provided by reframe-preview.test.tsx.
    const framing = new FramingPanelPage(page);
    await framing.gotoStudio();
    await expect(framing.reframePreview).toBeVisible();
    await expect(framing.sourceVideo).toBeVisible();
    await expect(framing.reframedVideo).toBeVisible();
  });

  // AC1: Sync controls toggle play / pause on both players
  test.fixme("play / pause button label toggles when activated", async ({
    page,
  }) => {
    // BLOCKED: same integration gap as the test above — preview is not
    // mounted because no sourceVideoUrl is provided by the scene inspector.
    const framing = new FramingPanelPage(page);
    await framing.gotoStudio();
    await expect(framing.playButton).toBeVisible();
    await framing.playButton.click();
    await expect(framing.pauseButton).toBeVisible();
  });

  // AC2: Subject bounding box overlay shows tracked regions
  test.fixme("subject tracking overlay is visible on top of the source player", async ({
    page,
  }) => {
    // BLOCKED: requires `trackingBoxes` to be passed from the inspector;
    // currently no caller wires this prop. Pure overlay logic is exercised
    // by subject-overlay.test.tsx and the findBoxAt helper unit tests.
    const framing = new FramingPanelPage(page);
    await framing.gotoStudio();
    await expect(framing.subjectOverlay).toBeVisible();
    await expect(framing.subjectOverlay).toHaveAttribute(
      "aria-label",
      "Subject tracking overlay",
    );
  });

  // AC4: Responsive layout — N/A as a pure e2e assertion. Visual responsiveness
  // is enforced via Tailwind classes (`grid-cols-2 gap-3`); no behavioural
  // breakpoint exists in this PR. Documented here for traceability.
  test.skip("responsive layout for mobile / desktop breakpoints", () => {});
});
