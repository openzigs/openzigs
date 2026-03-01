import { describe, expect, it, vi } from "vitest";
import { createTwitterTools } from "./twitter-tools.js";

function createMockLocalServerManager(opts: { running?: boolean; callResult?: { text: string; isError?: boolean } } = {}) {
  const { running = true, callResult = { text: "OK" } } = opts;
  return {
    isRunning: vi.fn().mockReturnValue(running),
    callTool: vi.fn().mockResolvedValue(callResult),
  };
}

describe("twitter-tools", () => {
  it("returns 8 tool definitions", () => {
    const tools = createTwitterTools({});
    expect(tools).toHaveLength(8);
  });

  it("all tools have category social and source twitter", () => {
    const tools = createTwitterTools({});
    for (const tool of tools) {
      expect(tool.category).toBe("social");
      expect((tool as { source?: string }).source).toBe("twitter");
    }
  });

  it("returns correct tool names", () => {
    const tools = createTwitterTools({});
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      "twitter-get-me", "twitter-get-user-tweets", "twitter-search-tweets",
      "twitter-get-tweet", "twitter-post-tweet", "twitter-get-dm-events",
      "twitter-send-dm", "twitter-get-user",
    ]));
  });

  describe("when localServerManager is not configured", () => {
    it("returns error for all tools", async () => {
      const tools = createTwitterTools({});
      for (const tool of tools) {
        const result = await tool.handler({});
        expect(result.isError).toBe(true);
        expect(result.text).toContain("not configured");
      }
    });
  });

  describe("when twitter server is not running", () => {
    it("returns error for all tools", async () => {
      const mgr = createMockLocalServerManager({ running: false });
      const tools = createTwitterTools({ localServerManager: mgr as never });
      for (const tool of tools) {
        const result = await tool.handler({});
        expect(result.isError).toBe(true);
        expect(result.text).toContain("not running");
      }
    });
  });

  describe("when twitter server is running", () => {
    it("delegates correctly for twitter-get-me", async () => {
      const mgr = createMockLocalServerManager({ callResult: { text: '{"username":"test"}' } });
      const tools = createTwitterTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "twitter-get-me")!.handler;
      const result = await handler({});
      expect(mgr.callTool).toHaveBeenCalledWith("twitter", expect.any(String), expect.any(Object));
      expect(result.text).toBe('{"username":"test"}');
    });

    it("delegates correctly for twitter-post-tweet", async () => {
      const mgr = createMockLocalServerManager({ callResult: { text: '{"id":"12345"}' } });
      const tools = createTwitterTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "twitter-post-tweet")!.handler;
      const result = await handler({ text: "Hello world" });
      expect(mgr.callTool).toHaveBeenCalled();
      expect(result.text).toBe('{"id":"12345"}');
    });
  });
});
