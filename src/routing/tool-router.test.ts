import { describe, it, expect } from "vitest";
import { routeToToolSequence } from "./tool-router.js";

describe("routeToToolSequence", () => {
  it("returns empty array for unrecognized prompt", () => {
    expect(routeToToolSequence("hello world")).toEqual([]);
  });

  it("matches video + character scenario", () => {
    const steps = routeToToolSequence("Create a video with character Alice and background music");
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps[0].tool).toBe("manage-characters");
    expect(steps.some((s) => s.tool === "submit-media-job")).toBe(true);
  });

  it("matches video + music scenario", () => {
    const steps = routeToToolSequence("Create a video with music");
    expect(steps.some((s) => s.tool === "submit-media-job")).toBe(true);
    // Should include music job since prompt mentions music
    const musicJobs = steps.filter((s) => s.tool === "submit-media-job");
    expect(musicJobs.length).toBeGreaterThanOrEqual(1);
  });

  it("matches remix pipeline", () => {
    const steps = routeToToolSequence("remix the drum track");
    expect(steps.some((s) => s.tool === "query-gallery-assets")).toBe(true);
    expect(steps.some((s) => s.tool === "remix-session-manager")).toBe(true);
  });

  it("matches remix with stem replacement", () => {
    const steps = routeToToolSequence("remix and replace drums with synth");
    const replaceStem = steps.find((s) => s.expectedArgs.action === "replace_stem");
    expect(replaceStem).toBeDefined();
  });

  it("matches scheduled content pipeline", () => {
    const steps = routeToToolSequence("schedule a weekly content pipeline");
    expect(steps.some((s) => s.tool === "schedule-job")).toBe(true);
    expect(steps.some((s) => s.tool === "list-secrets")).toBe(true);
  });

  it("matches image generation with character", () => {
    const steps = routeToToolSequence("generate a photo with character Bob");
    expect(steps[0].tool).toBe("manage-characters");
    expect(steps.some((s) => s.tool === "submit-media-job")).toBe(true);
  });

  it("matches image generation without character", () => {
    const steps = routeToToolSequence("generate a photo of a sunset");
    expect(steps[0].tool).toBe("submit-media-job");
  });

  it("matches gallery search", () => {
    const steps = routeToToolSequence("find my media assets");
    expect(steps).toEqual([{ tool: "query-gallery-assets", expectedArgs: {} }]);
  });

  it("matches daily/cron scheduling keywords", () => {
    const steps = routeToToolSequence("set up a daily cron job");
    expect(steps.some((s) => s.tool === "schedule-job")).toBe(true);
  });

  it("matches show gallery variants", () => {
    const steps1 = routeToToolSequence("show me all images in gallery");
    expect(steps1[0].tool).toBe("query-gallery-assets");
    const steps2 = routeToToolSequence("list all video assets");
    expect(steps2[0].tool).toBe("query-gallery-assets");
    const steps3 = routeToToolSequence("search audio files");
    expect(steps3[0].tool).toBe("query-gallery-assets");
  });
});
