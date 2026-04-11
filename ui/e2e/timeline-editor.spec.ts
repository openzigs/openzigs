import { test, expect } from "@playwright/test";
import { navigateTo } from "./helpers";
import { TimelineEditorPage } from "./pages/timeline-editor.page";

/**
 * E2E Tests — Timeline Editor (#824)
 *
 * Acceptance Criteria from issue:
 * AC1: Timeline mode toggle in Director Studio (manifest view ↔ interactive timeline)
 * AC2: Drag clip left/right edges to trim in/out points on the timeline
 * AC3: Split clip at playhead position (keyboard shortcut: S)
 * AC4: Drag-to-reorder clips within a track
 * AC5: Zoom in/out on timeline (Ctrl+scroll or slider)
 * AC6: Undo/redo stack (Ctrl+Z / Ctrl+Shift+Z) with at least 20 steps
 * AC7: Audio track volume envelope
 * AC8: Preview playback updates in real-time as clips are edited
 * AC9: Export renders final video from timeline state
 * AC10: AI-generated scenes load into interactive timeline
 */
test.describe("Timeline Editor (#824)", () => {
  // AC1,AC6: Timeline toolbar visible with all controls
  test("should display timeline toolbar with all controls", async ({
    page,
  }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const editor = new TimelineEditorPage(page);
    await expect(editor.toolbar).toBeVisible();
  });

  // AC6: Undo button visible
  test("should display undo button in toolbar", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const editor = new TimelineEditorPage(page);
    await expect(editor.undoButton).toBeVisible();
  });

  // AC6: Undo button initially disabled (no history)
  test("should have undo button disabled when no actions to undo", async ({
    page,
  }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const editor = new TimelineEditorPage(page);
    await expect(editor.undoButton).toBeDisabled();
  });

  // AC6: Redo button visible
  test("should display redo button in toolbar", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const editor = new TimelineEditorPage(page);
    await expect(editor.redoButton).toBeVisible();
  });

  // AC6: Redo button initially disabled
  test("should have redo button disabled when no actions to redo", async ({
    page,
  }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const editor = new TimelineEditorPage(page);
    await expect(editor.redoButton).toBeDisabled();
  });

  // AC3: Split button visible
  test("should display split-at-playhead button", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const editor = new TimelineEditorPage(page);
    await expect(editor.splitButton).toBeVisible();
  });

  // AC3: Split button has tooltip
  test("should have split button with keyboard shortcut tooltip", async ({
    page,
  }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const editor = new TimelineEditorPage(page);
    await expect(editor.splitButton).toHaveAttribute(
      "title",
      /Split at Playhead \(S\)/i,
    );
  });

  // AC5: Zoom in/out buttons visible
  test("should display zoom in and zoom out buttons", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const editor = new TimelineEditorPage(page);
    await expect(editor.zoomInButton).toBeVisible();
    await expect(editor.zoomOutButton).toBeVisible();
  });

  // AC4: Snap toggle visible
  test("should display snap toggle button", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const editor = new TimelineEditorPage(page);
    await expect(editor.snapButton).toBeVisible();
  });

  // AC4: Snap toggle has state tooltip
  test("should show snap status in tooltip", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const editor = new TimelineEditorPage(page);
    await expect(editor.snapButton).toHaveAttribute("title", /Snap/i);
  });

  // AC5: Zoom level indicator visible
  test("should display current zoom level", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const editor = new TimelineEditorPage(page);
    await expect(editor.zoomLevel).toBeVisible();
  });

  // AC6: Undo has tooltip with keyboard shortcut
  test("should show undo keyboard shortcut in tooltip", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const editor = new TimelineEditorPage(page);
    await expect(editor.undoButton).toHaveAttribute("title", /Ctrl\+Z/i);
  });

  // AC6: Redo has tooltip with keyboard shortcut
  test("should show redo keyboard shortcut in tooltip", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const editor = new TimelineEditorPage(page);
    await expect(editor.redoButton).toHaveAttribute("title", /Ctrl\+Shift\+Z/i);
  });

  // AC5: Timeline ruler (canvas) visible
  test("should display timeline ruler canvas", async ({ page }) => {
    await navigateTo(page, "/director/studio/test-draft");
    const editor = new TimelineEditorPage(page);
    await expect(editor.rulerCanvas).toBeVisible();
  });
});
