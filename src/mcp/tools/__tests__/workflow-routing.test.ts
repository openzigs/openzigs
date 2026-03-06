import { describe, it, expect } from "vitest";
import { routeToToolSequence } from "../../../routing/tool-router.js";

describe("Tier 3A: Workflow Routing — Forced Tool Sequences", () => {
  describe("Scenario 1: Character LoRA video + music", () => {
    it("routes cyberpunk video with character + music correctly", () => {
      const seq = routeToToolSequence(
        "Create a cyberpunk cityscape video with my character Alex and background music",
      );
      expect(seq.length).toBeGreaterThanOrEqual(4);
      expect(seq[0].tool).toBe("manage-characters");
      expect(seq[1].tool).toBe("get-job-status");
      expect(seq.some((s) => s.tool === "submit-media-job" && (s.expectedArgs as Record<string, unknown>).type === "txt2video")).toBe(true);
      expect(seq.some((s) => s.tool === "submit-media-job" && (s.expectedArgs as Record<string, unknown>).type === "txt2music")).toBe(true);
    });

    it("includes character lookup when character name detected", () => {
      const seq = routeToToolSequence("Generate a video with character Luna");
      expect(seq[0].tool).toBe("manage-characters");
    });
  });

  describe("Scenario 2: Remix pipeline", () => {
    it("routes remix with stem replacement correctly", () => {
      const seq = routeToToolSequence(
        "Remix the drum track from yesterday's upload and replace drums with strings",
      );
      expect(seq[0].tool).toBe("query-gallery-assets");
      expect(seq[1].tool).toBe("remix-session-manager");
      expect(seq[1].expectedArgs).toHaveProperty("action", "analyze");
      expect(
        seq.some(
          (s) =>
            s.tool === "remix-session-manager" &&
            (s.expectedArgs as Record<string, unknown>).action === "replace_stem",
        ),
      ).toBe(true);
      expect(seq[seq.length - 1].tool).toBe("remix-session-manager");
    });

    it("starts with audio gallery search", () => {
      const seq = routeToToolSequence("Remix my latest track");
      expect(seq[0].tool).toBe("query-gallery-assets");
    });
  });

  describe("Scenario 3: Scheduled content pipeline", () => {
    it("routes weekly motivational quote pipeline correctly", () => {
      const seq = routeToToolSequence(
        "Set up a weekly pipeline: generate a motivational image every Monday and publish to Instagram",
      );
      expect(seq[0].tool).toBe("list-secrets");
      expect(seq[1].tool).toBe("schedule-job");
      expect(seq[2].tool).toBe("schedule-job");
      expect(seq[2].expectedArgs).toHaveProperty("action", "create");
    });
  });

  describe("Gallery search", () => {
    it("routes find media query to gallery", () => {
      const seq = routeToToolSequence("Show me all my generated images");
      expect(seq[0].tool).toBe("query-gallery-assets");
    });
  });

  it("returns empty array for unrecognized prompts", () => {
    const seq = routeToToolSequence("What is the weather today?");
    expect(seq).toEqual([]);
  });
});
