import { describe, expect, it, vi } from "vitest";
import { createRedditTools } from "./reddit-tools.js";

function createMockLocalServerManager(opts: { running?: boolean; callResult?: { text: string; isError?: boolean } } = {}) {
  const { running = true, callResult = { text: "OK" } } = opts;
  return {
    isRunning: vi.fn().mockReturnValue(running),
    callTool: vi.fn().mockResolvedValue(callResult),
  };
}

describe("reddit-tools", () => {
  it("returns 8 tool definitions", () => {
    const tools = createRedditTools({});
    expect(tools).toHaveLength(8);
  });

  it("all tools have category social", () => {
    const tools = createRedditTools({});
    for (const tool of tools) {
      expect(tool.category).toBe("social");
    }
  });

  it("returns correct tool names", () => {
    const tools = createRedditTools({});
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      "reddit-get-me", "reddit-get-subreddit-posts", "reddit-get-post-comments",
      "reddit-submit-post", "reddit-reply-to-comment", "reddit-search",
      "reddit-get-inbox", "reddit-send-message",
    ]));
  });

  describe("when localServerManager is not configured", () => {
    it("returns error for all tools", async () => {
      const tools = createRedditTools({});
      for (const tool of tools) {
        const result = await tool.handler({});
        expect(result.isError).toBe(true);
      }
    });
  });

  describe("when reddit server is not running", () => {
    it("returns error for all tools", async () => {
      const mgr = createMockLocalServerManager({ running: false });
      const tools = createRedditTools({ localServerManager: mgr as never });
      for (const tool of tools) {
        const result = await tool.handler({});
        expect(result.isError).toBe(true);
      }
    });
  });

  describe("when reddit server is running", () => {
    it("delegates correctly for reddit-get-me", async () => {
      const mgr = createMockLocalServerManager({ callResult: { text: '{"name":"redditor"}' } });
      const tools = createRedditTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "reddit-get-me")!.handler;
      const result = await handler({});
      expect(mgr.callTool).toHaveBeenCalledWith("reddit", expect.any(String), expect.any(Object));
      expect(result.text).toBe('{"name":"redditor"}');
    });

    it("delegates correctly for reddit-submit-post", async () => {
      const mgr = createMockLocalServerManager({ callResult: { text: '{"id":"abc123"}' } });
      const tools = createRedditTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "reddit-submit-post")!.handler;
      const result = await handler({ subreddit: "test", title: "Hello", body: "World" });
      expect(mgr.callTool).toHaveBeenCalled();
      expect(result.text).toBe('{"id":"abc123"}');
    });
  });
});
