import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGalleryTools } from "../gallery-tools.js";

describe("Tier 2: query-gallery-assets handler", () => {
  const mockRepo = {
    listAssets: vi.fn().mockReturnValue([
      { id: "a1", filename: "test.png", type: "image", tags: "sunset", prompt: "sunset sky", model: "flux-schnell" },
      { id: "a2", filename: "track.wav", type: "audio", tags: null, prompt: null, model: "ace-step" },
    ]),
    getAsset: vi.fn().mockReturnValue(
      { id: "a1", filename: "test.png", type: "image", tags: "sunset" },
    ),
  };

  let handler: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;

  beforeEach(() => {
    vi.clearAllMocks();
    const tools = createGalleryTools({ mediaQueueRepo: mockRepo as never });
    handler = tools[0].handler;
  });

  it("returns all assets when no filters provided", async () => {
    const result = await handler({});
    expect(mockRepo.listAssets).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.count).toBe(2);
  });

  it("filters by type", async () => {
    const result = await handler({ type: "image" });
    expect(mockRepo.listAssets).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image" }),
    );
    expect(result.isError).toBeUndefined();
  });

  it("returns single asset by id", async () => {
    const result = await handler({ asset_id: "a1" });
    expect(mockRepo.getAsset).toHaveBeenCalledWith("a1");
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.text)).toHaveProperty("id", "a1");
  });

  it("returns isError when asset not found", async () => {
    mockRepo.getAsset.mockReturnValueOnce(null);
    const result = await handler({ asset_id: "nonexistent" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not found");
  });

  it("applies text search filter", async () => {
    const result = await handler({ search: "sunset" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.count).toBe(1);
    expect(parsed.assets[0].id).toBe("a1");
  });

  it("applies model filter", async () => {
    const result = await handler({ model: "flux" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text);
    expect(parsed.count).toBe(1);
  });
});
