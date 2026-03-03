import { describe, expect, it, vi } from "vitest";
import { createYouTubeTools } from "./youtube-tools.js";

function createMockLocalServerManager(opts: { running?: boolean; callResult?: { text: string; isError?: boolean } } = {}) {
  const { running = true, callResult = { text: "OK" } } = opts;
  return {
    isRunning: vi.fn().mockReturnValue(running),
    callTool: vi.fn().mockResolvedValue(callResult),
  };
}

describe("youtube-tools", () => {
  it("returns 8 tool definitions", () => {
    const tools = createYouTubeTools({});
    expect(tools).toHaveLength(8);
  });

  it("all tools have category social", () => {
    const tools = createYouTubeTools({});
    for (const tool of tools) {
      expect(tool.category).toBe("social");
    }
  });

  it("returns correct tool names", () => {
    const tools = createYouTubeTools({});
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      "youtube-get-channel-info", "youtube-get-channel-videos", "youtube-get-video-details",
      "youtube-get-video-comments", "youtube-reply-to-comment", "youtube-search-videos",
      "youtube-get-channel-analytics", "youtube-upload-video",
    ]));
  });

  describe("when localServerManager is not configured", () => {
    it("returns error for all tools", async () => {
      const tools = createYouTubeTools({});
      for (const tool of tools) {
        const result = await tool.handler({});
        expect(result.isError).toBe(true);
      }
    });
  });

  describe("when youtube server is not running", () => {
    it("returns error for all tools", async () => {
      const mgr = createMockLocalServerManager({ running: false });
      const tools = createYouTubeTools({ localServerManager: mgr as never });
      for (const tool of tools) {
        const result = await tool.handler({});
        expect(result.isError).toBe(true);
      }
    });
  });

  describe("when youtube server is running", () => {
    it("delegates correctly for youtube-get-channel-info", async () => {
      const mgr = createMockLocalServerManager({ callResult: { text: '{"title":"My Channel"}' } });
      const tools = createYouTubeTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "youtube-get-channel-info")!.handler;
      const result = await handler({});
      expect(mgr.callTool).toHaveBeenCalledWith("youtube", expect.any(String), expect.any(Object));
      expect(result.text).toBe('{"title":"My Channel"}');
    });

    it("delegates correctly for youtube-upload-video", async () => {
      const mgr = createMockLocalServerManager({ callResult: { text: '{"videoId":"abc"}' } });
      const tools = createYouTubeTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "youtube-upload-video")!.handler;
      const result = await handler({ title: "Test Video" });
      expect(mgr.callTool).toHaveBeenCalled();
      expect(result.text).toBe('{"videoId":"abc"}');
    });
  });
});
