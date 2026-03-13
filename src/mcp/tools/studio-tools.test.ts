import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStudioTools } from "./studio-tools.js";
import type { StudioToolsOptions } from "./studio-tools.js";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    statSync: vi.fn().mockReturnValue({ size: 1024 }),
    mkdirSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(true),
  statSync: vi.fn().mockReturnValue({ size: 1024 }),
  mkdirSync: vi.fn(),
}));

function createMockDeps(overrides: Partial<StudioToolsOptions> = {}): StudioToolsOptions {
  return {
    trimWorker: {
      submit: vi.fn().mockResolvedValue("job-1"),
      waitForCompletion: vi.fn().mockResolvedValue(undefined),
    } as any,
    analyzeWorker: {
      submit: vi.fn().mockResolvedValue("job-2"),
      waitForCompletion: vi.fn().mockResolvedValue({
        suggestedCuts: [{ start: 10, end: 15, reason: "dead air" }],
      }),
    } as any,
    mediaQueueRepo: {
      getAsset: vi.fn().mockReturnValue({ file_path: "/tmp/video.mp4" }),
      createAsset: vi.fn().mockReturnValue("asset-new"),
    } as any,
    ...overrides,
  };
}

describe("studio-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates two tools with correct names", () => {
    const tools = createStudioTools(createMockDeps());
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("trim-video");
    expect(tools[1].name).toBe("analyze-video-redundancy");
  });

  // ── trim-video ──────────────────────────────────────────────

  describe("trim-video", () => {
    function getTrimHandler(overrides: Partial<StudioToolsOptions> = {}) {
      const deps = createMockDeps(overrides);
      const tools = createStudioTools(deps);
      return { handler: tools[0].handler, deps };
    }

    it("rejects when end_time <= start_time", async () => {
      const { handler } = getTrimHandler();
      const result = await handler({ asset_id: "a1", start_time: 10, end_time: 5 });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("end_time must be greater than start_time");
    });

    it("returns error when asset not found", async () => {
      const { handler } = getTrimHandler({
        mediaQueueRepo: { getAsset: vi.fn().mockReturnValue(null), createAsset: vi.fn() } as any,
      });
      const result = await handler({ asset_id: "missing", start_time: 0, end_time: 10 });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not found in gallery");
    });

    it("returns error when file not on disk", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.default.existsSync).mockReturnValue(false);

      const { handler } = getTrimHandler();
      const result = await handler({ asset_id: "a1", start_time: 0, end_time: 10 });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not found on disk");
    });

    it("submits trim job and returns result on completion", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.default.existsSync).mockReturnValue(true);

      const { handler, deps } = getTrimHandler();
      const result = await handler({ asset_id: "a1", start_time: 0, end_time: 10 });
      const parsed = JSON.parse(result.text);
      expect(parsed.status).toBe("complete");
      expect(parsed.trimJobId).toBe("job-1");
      expect(parsed.newAssetId).toBe("asset-new");
      expect(deps.trimWorker.submit).toHaveBeenCalled();
    });

    it("returns submitted status on timeout", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.default.existsSync).mockReturnValue(true);

      const { handler } = getTrimHandler({
        trimWorker: {
          submit: vi.fn().mockResolvedValue("job-1"),
          waitForCompletion: vi.fn().mockRejectedValue(new Error("timeout")),
        } as any,
      });
      const result = await handler({ asset_id: "a1", start_time: 0, end_time: 10 });
      const parsed = JSON.parse(result.text);
      expect(parsed.status).toBe("submitted");
    });
  });

  // ── analyze-video-redundancy ────────────────────────────────

  describe("analyze-video-redundancy", () => {
    function getAnalyzeHandler(overrides: Partial<StudioToolsOptions> = {}) {
      const deps = createMockDeps(overrides);
      const tools = createStudioTools(deps);
      return { handler: tools[1].handler, deps };
    }

    it("returns error when asset not found", async () => {
      const { handler } = getAnalyzeHandler({
        mediaQueueRepo: { getAsset: vi.fn().mockReturnValue(null), createAsset: vi.fn() } as any,
      });
      const result = await handler({ asset_id: "missing" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not found in gallery");
    });

    it("returns error when file not on disk", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.default.existsSync).mockReturnValue(false);

      const { handler } = getAnalyzeHandler();
      const result = await handler({ asset_id: "a1" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not found on disk");
    });

    it("submits analysis job and returns suggested cuts", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.default.existsSync).mockReturnValue(true);

      const { handler, deps } = getAnalyzeHandler();
      const result = await handler({ asset_id: "a1" });
      const parsed = JSON.parse(result.text);
      expect(parsed.status).toBe("complete");
      expect(parsed.totalCuts).toBe(1);
      expect(parsed.suggestedCuts[0].reason).toBe("dead air");
      expect(deps.analyzeWorker.submit).toHaveBeenCalled();
    });

    it("returns submitted status on timeout", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.default.existsSync).mockReturnValue(true);

      const { handler } = getAnalyzeHandler({
        analyzeWorker: {
          submit: vi.fn().mockResolvedValue("job-2"),
          waitForCompletion: vi.fn().mockRejectedValue(new Error("timeout")),
        } as any,
      });
      const result = await handler({ asset_id: "a1" });
      const parsed = JSON.parse(result.text);
      expect(parsed.status).toBe("submitted");
    });
  });
});
