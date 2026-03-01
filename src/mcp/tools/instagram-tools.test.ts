import { describe, expect, it, vi } from "vitest";
import { createInstagramTools } from "./instagram-tools.js";

function createMockLocalServerManager(opts: { running?: boolean; callResult?: { text: string; isError?: boolean } } = {}) {
  const { running = true, callResult = { text: "OK" } } = opts;
  return {
    isRunning: vi.fn().mockReturnValue(running),
    callTool: vi.fn().mockResolvedValue(callResult),
  };
}

describe("instagram-tools", () => {
  it("returns 11 tool definitions", () => {
    const tools = createInstagramTools({});
    expect(tools).toHaveLength(11);
  });

  it("all tools have category social and source instagram", () => {
    const tools = createInstagramTools({});
    for (const tool of tools) {
      expect(tool.category).toBe("social");
      expect((tool as { source?: string }).source).toBe("instagram");
    }
  });

  it("returns correct tool names", () => {
    const tools = createInstagramTools({});
    const names = tools.map((t) => t.name);
    expect(names).toContain("instagram-get-profile");
    expect(names).toContain("instagram-get-posts");
    expect(names).toContain("instagram-get-media-insights");
    expect(names).toContain("instagram-publish-media");
    expect(names).toContain("instagram-get-pages");
    expect(names).toContain("instagram-get-account-insights");
    expect(names).toContain("instagram-get-conversations");
    expect(names).toContain("instagram-get-messages");
    expect(names).toContain("instagram-send-dm");
    expect(names).toContain("instagram-reply-to-comment");
    expect(names).toContain("instagram-get-media-comments");
  });

  describe("when localServerManager is not configured", () => {
    it("returns error for all tools", async () => {
      const tools = createInstagramTools({});
      for (const tool of tools) {
        const result = await tool.handler({});
        expect(result.isError).toBe(true);
        expect(result.text).toContain("not configured");
      }
    });
  });

  describe("when instagram server is not running", () => {
    it("returns error for all tools", async () => {
      const mgr = createMockLocalServerManager({ running: false });
      const tools = createInstagramTools({ localServerManager: mgr as never });
      for (const tool of tools) {
        const result = await tool.handler({});
        expect(result.isError).toBe(true);
        expect(result.text).toContain("not running");
      }
    });
  });

  describe("when instagram server is running", () => {
    it("instagram-get-profile calls local server correctly", async () => {
      const mgr = createMockLocalServerManager({ callResult: { text: '{"username":"test"}' } });
      const tools = createInstagramTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "instagram-get-profile")!.handler;
      const result = await handler({ account_id: "123" });
      expect(mgr.callTool).toHaveBeenCalledWith("instagram", "get_profile_info", { account_id: "123" });
      expect(result.text).toContain("test");
    });

    it("instagram-get-posts calls with correct args", async () => {
      const mgr = createMockLocalServerManager();
      const tools = createInstagramTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "instagram-get-posts")!.handler;
      await handler({ limit: 10 });
      expect(mgr.callTool).toHaveBeenCalledWith("instagram", "get_media_posts", { limit: 10 });
    });

    it("instagram-publish-media calls with correct args", async () => {
      const mgr = createMockLocalServerManager();
      const tools = createInstagramTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "instagram-publish-media")!.handler;
      await handler({ image_url: "https://example.com/photo.jpg", caption: "Hello" });
      expect(mgr.callTool).toHaveBeenCalledWith("instagram", "publish_media", { image_url: "https://example.com/photo.jpg", caption: "Hello" });
    });

    it("instagram-send-dm calls with correct args", async () => {
      const mgr = createMockLocalServerManager();
      const tools = createInstagramTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "instagram-send-dm")!.handler;
      await handler({ recipient_id: "user123", message: "Hi there" });
      expect(mgr.callTool).toHaveBeenCalledWith("instagram", "send_dm", { recipient_id: "user123", message: "Hi there" });
    });

    it("instagram-reply-to-comment calls with correct args", async () => {
      const mgr = createMockLocalServerManager();
      const tools = createInstagramTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "instagram-reply-to-comment")!.handler;
      await handler({ comment_id: "c1", message: "Thanks!" });
      expect(mgr.callTool).toHaveBeenCalledWith("instagram", "reply_to_comment", { comment_id: "c1", message: "Thanks!" });
    });

    it("instagram-get-media-comments calls with correct args", async () => {
      const mgr = createMockLocalServerManager();
      const tools = createInstagramTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "instagram-get-media-comments")!.handler;
      await handler({ media_id: "m1", limit: 50 });
      expect(mgr.callTool).toHaveBeenCalledWith("instagram", "get_media_comments", { media_id: "m1", limit: 50 });
    });
  });
});
