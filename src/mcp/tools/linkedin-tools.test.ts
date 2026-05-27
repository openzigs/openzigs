import { describe, expect, it, vi } from "vitest";
import { createLinkedInTools } from "./linkedin-tools.js";

function createMockLocalServerManager(
  opts: {
    running?: boolean;
    callResult?: { text: string; isError?: boolean };
  } = {},
) {
  const { running = true, callResult = { text: "OK" } } = opts;
  return {
    isRunning: vi.fn().mockReturnValue(running),
    callTool: vi.fn().mockResolvedValue(callResult),
  };
}

describe("linkedin-tools", () => {
  it("returns 10 tool definitions", () => {
    const tools = createLinkedInTools({});
    expect(tools).toHaveLength(10);
  });

  it("all tools have category social", () => {
    const tools = createLinkedInTools({});
    for (const tool of tools) {
      expect(tool.category).toBe("social");
    }
  });

  it("returns correct tool names", () => {
    const tools = createLinkedInTools({});
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "linkedin-get-profile",
        "linkedin-get-posts",
        "linkedin-create-post",
        "linkedin-get-company",
        "linkedin-send-message",
        "linkedin-get-conversations",
        "linkedin-get-post-comments",
        "linkedin-reply-to-comment",
        "linkedin-post-analytics",
        "linkedin-profile-analytics",
      ]),
    );
  });

  describe("when localServerManager is not configured", () => {
    it("returns error for all tools", async () => {
      const tools = createLinkedInTools({});
      for (const tool of tools) {
        const result = await tool.handler({});
        expect(result.isError).toBe(true);
      }
    });
  });

  describe("when linkedin server is not running", () => {
    it("returns error for all tools", async () => {
      const mgr = createMockLocalServerManager({ running: false });
      const tools = createLinkedInTools({ localServerManager: mgr as never });
      for (const tool of tools) {
        const result = await tool.handler({});
        expect(result.isError).toBe(true);
      }
    });
  });

  describe("when linkedin server is running", () => {
    it("delegates correctly for linkedin-get-profile", async () => {
      const mgr = createMockLocalServerManager({
        callResult: { text: '{"name":"Test User"}' },
      });
      const tools = createLinkedInTools({ localServerManager: mgr as never });
      const handler = tools.find(
        (t) => t.name === "linkedin-get-profile",
      )!.handler;
      const result = await handler({});
      expect(mgr.callTool).toHaveBeenCalledWith(
        "linkedin",
        expect.any(String),
        expect.any(Object),
      );
      expect(result.text).toBe('{"name":"Test User"}');
    });

    it("delegates correctly for linkedin-create-post", async () => {
      const mgr = createMockLocalServerManager({
        callResult: { text: '{"postId":"123"}' },
      });
      const tools = createLinkedInTools({ localServerManager: mgr as never });
      const handler = tools.find(
        (t) => t.name === "linkedin-create-post",
      )!.handler;
      const result = await handler({ content: "Hello LinkedIn" });
      expect(mgr.callTool).toHaveBeenCalled();
      expect(result.text).toBe('{"postId":"123"}');
    });

    it("delegates correctly for linkedin-post-analytics", async () => {
      const mgr = createMockLocalServerManager({
        callResult: { text: '{"impressions":1200}' },
      });
      const tools = createLinkedInTools({ localServerManager: mgr as never });
      const handler = tools.find(
        (t) => t.name === "linkedin-post-analytics",
      )!.handler;
      const result = await handler({ post_urn: "urn:li:share:123" });
      expect(mgr.callTool).toHaveBeenCalledWith(
        "linkedin",
        "linkedin_post_analytics",
        { post_urn: "urn:li:share:123" },
      );
      expect(result.text).toBe('{"impressions":1200}');
    });

    it("delegates correctly for linkedin-profile-analytics", async () => {
      const mgr = createMockLocalServerManager({
        callResult: { text: '{"firstDegreeSize":500}' },
      });
      const tools = createLinkedInTools({ localServerManager: mgr as never });
      const handler = tools.find(
        (t) => t.name === "linkedin-profile-analytics",
      )!.handler;
      const result = await handler({});
      expect(mgr.callTool).toHaveBeenCalledWith(
        "linkedin",
        "linkedin_profile_analytics",
        {},
      );
      expect(result.text).toBe('{"firstDegreeSize":500}');
    });
  });
});
