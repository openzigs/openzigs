import { describe, it, expect, vi } from "vitest";
import { createGalleryTools } from "./gallery-tools.js";

function mockRepo() {
  const assets = [
    { id: "a1", type: "image", filename: "cat.png", prompt: "a cat", model: "flux-schnell", tags: ["nature"], source: "generated" },
    { id: "a2", type: "video", filename: "dog.mp4", prompt: "a dog", model: "ltx-2", tags: ["animals"], source: "generated" },
    { id: "a3", type: "audio", filename: "song.wav", prompt: "rock song", model: "musicgen", tags: ["music"], source: "generated" },
  ];
  return {
    getAsset: vi.fn((id: string) => assets.find((a) => a.id === id) ?? null),
    listAssets: vi.fn(() => assets),
  } as any;
}

describe("gallery-tools", () => {
  it("returns one tool definition", () => {
    const tools = createGalleryTools({ mediaQueueRepo: mockRepo() });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("query-gallery-assets");
  });

  it("lists all assets", async () => {
    const [tool] = createGalleryTools({ mediaQueueRepo: mockRepo() });
    const result = await tool.handler({});
    const parsed = JSON.parse(result.text);
    expect(parsed.count).toBe(3);
  });

  it("gets single asset by id", async () => {
    const [tool] = createGalleryTools({ mediaQueueRepo: mockRepo() });
    const result = await tool.handler({ asset_id: "a1" });
    const parsed = JSON.parse(result.text);
    expect(parsed.filename).toBe("cat.png");
  });

  it("returns error for missing asset", async () => {
    const [tool] = createGalleryTools({ mediaQueueRepo: mockRepo() });
    const result = await tool.handler({ asset_id: "missing" });
    expect(result.isError).toBe(true);
  });

  it("filters by model", async () => {
    const [tool] = createGalleryTools({ mediaQueueRepo: mockRepo() });
    const result = await tool.handler({ model: "flux" });
    const parsed = JSON.parse(result.text);
    expect(parsed.count).toBe(1);
    expect(parsed.assets[0].id).toBe("a1");
  });

  it("filters by search text", async () => {
    const [tool] = createGalleryTools({ mediaQueueRepo: mockRepo() });
    const result = await tool.handler({ search: "dog" });
    const parsed = JSON.parse(result.text);
    expect(parsed.count).toBe(1);
    expect(parsed.assets[0].id).toBe("a2");
  });

  it("applies limit and offset", async () => {
    const repo = mockRepo();
    const [tool] = createGalleryTools({ mediaQueueRepo: repo });
    await tool.handler({ limit: 10, offset: 5 });
    expect(repo.listAssets).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, offset: 5 }));
  });

  it("returns error on invalid args", async () => {
    const [tool] = createGalleryTools({ mediaQueueRepo: mockRepo() });
    const result = await tool.handler({ type: "invalid_type" });
    expect(result.isError).toBe(true);
  });
});
