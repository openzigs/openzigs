import { describe, expect, it, vi } from "vitest";
import { createFacebookTools } from "./facebook-tools.js";

function createMockLocalServerManager(opts: { running?: boolean; callResult?: { text: string; isError?: boolean } } = {}) {
  const { running = true, callResult = { text: "OK" } } = opts;
  return {
    isRunning: vi.fn().mockReturnValue(running),
    callTool: vi.fn().mockResolvedValue(callResult),
  };
}

describe("facebook-tools", () => {
  it("returns 8 tool definitions", () => {
    const tools = createFacebookTools({});
    expect(tools).toHaveLength(8);
  });

  it("all tools have category social", () => {
    const tools = createFacebookTools({});
    for (const tool of tools) {
      expect(tool.category).toBe("social");
    }
  });

  it("returns correct tool names", () => {
    const tools = createFacebookTools({});
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      "facebook-get-page-info", "facebook-get-posts", "facebook-get-post-insights",
      "facebook-publish-post", "facebook-get-conversations", "facebook-get-messages",
      "facebook-send-message", "facebook-get-page-insights",
    ]));
  });

  describe("when localServerManager is not configured", () => {
    it("returns error for all tools", async () => {
      const tools = createFacebookTools({});
      for (const tool of tools) {
        const result = await tool.handler({});
        expect(result.isError).toBe(true);
      }
    });
  });

  describe("when facebook server is not running", () => {
    it("returns error for all tools", async () => {
      const mgr = createMockLocalServerManager({ running: false });
      const tools = createFacebookTools({ localServerManager: mgr as never });
      for (const tool of tools) {
        const result = await tool.handler({});
        expect(result.isError).toBe(true);
      }
    });
  });

  describe("when facebook server is running", () => {
    it("delegates correctly for facebook-get-page-info", async () => {
      const mgr = createMockLocalServerManager({ callResult: { text: '{"name":"My Page"}' } });
      const tools = createFacebookTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "facebook-get-page-info")!.handler;
      const result = await handler({});
      expect(mgr.callTool).toHaveBeenCalledWith("facebook", expect.any(String), expect.any(Object));
      expect(result.text).toBe('{"name":"My Page"}');
    });

    it("delegates correctly for facebook-publish-post", async () => {
      const mgr = createMockLocalServerManager({ callResult: { text: '{"id":"post123"}' } });
      const tools = createFacebookTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "facebook-publish-post")!.handler;
      const result = await handler({ message: "Hello Facebook" });
      expect(mgr.callTool).toHaveBeenCalled();
      expect(result.text).toBe('{"id":"post123"}');
    });
  });
});
