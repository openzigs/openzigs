import { describe, expect, it, vi } from "vitest";
import { createTwitterTools } from "./twitter-tools.js";

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

describe("twitter-tools", () => {
  it("returns 10 tool definitions", () => {
    const tools = createTwitterTools({});
    expect(tools).toHaveLength(10);
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
    expect(names).toEqual(
      expect.arrayContaining([
        "twitter-get-me",
        "twitter-get-user-tweets",
        "twitter-search-tweets",
        "twitter-get-tweet",
        "twitter-post-tweet",
        "twitter-get-dm-events",
        "twitter-send-dm",
        "twitter-get-user",
        "twitter-post-analytics",
        "twitter-account-analytics",
      ]),
    );
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
      const mgr = createMockLocalServerManager({
        callResult: { text: '{"username":"test"}' },
      });
      const tools = createTwitterTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "twitter-get-me")!.handler;
      const result = await handler({});
      expect(mgr.callTool).toHaveBeenCalledWith(
        "twitter",
        "twitter_get_me",
        expect.any(Object),
      );
      expect(result.text).toBe('{"username":"test"}');
    });

    it("delegates correctly for twitter-post-tweet", async () => {
      const mgr = createMockLocalServerManager({
        callResult: { text: '{"id":"12345"}' },
      });
      const tools = createTwitterTools({ localServerManager: mgr as never });
      const handler = tools.find(
        (t) => t.name === "twitter-post-tweet",
      )!.handler;
      const result = await handler({ text: "Hello world" });
      expect(mgr.callTool).toHaveBeenCalledWith(
        "twitter",
        "twitter_post_tweet",
        { text: "Hello world" },
      );
      expect(result.text).toBe('{"id":"12345"}');
    });

    it("delegates correctly for twitter-search-tweets", async () => {
      const mgr = createMockLocalServerManager({
        callResult: { text: '{"data":[]}' },
      });
      const tools = createTwitterTools({ localServerManager: mgr as never });
      const handler = tools.find(
        (t) => t.name === "twitter-search-tweets",
      )!.handler;
      const result = await handler({ query: "AI agents", max_results: 20 });
      expect(mgr.callTool).toHaveBeenCalledWith(
        "twitter",
        "twitter_search_tweets",
        { query: "AI agents", max_results: 20 },
      );
      expect(result.text).toBe('{"data":[]}');
    });

    it("delegates correctly for twitter-get-tweet", async () => {
      const mgr = createMockLocalServerManager({
        callResult: { text: '{"data":{"id":"999"}}' },
      });
      const tools = createTwitterTools({ localServerManager: mgr as never });
      const handler = tools.find(
        (t) => t.name === "twitter-get-tweet",
      )!.handler;
      const result = await handler({ tweet_id: "999" });
      expect(mgr.callTool).toHaveBeenCalledWith(
        "twitter",
        "twitter_get_tweet",
        { tweet_id: "999" },
      );
      expect(result.text).toBe('{"data":{"id":"999"}}');
    });

    it("delegates correctly for twitter-get-user-tweets", async () => {
      const mgr = createMockLocalServerManager({
        callResult: { text: '{"data":[]}' },
      });
      const tools = createTwitterTools({ localServerManager: mgr as never });
      const handler = tools.find(
        (t) => t.name === "twitter-get-user-tweets",
      )!.handler;
      const result = await handler({ user_id: "123", max_results: 5 });
      expect(mgr.callTool).toHaveBeenCalledWith(
        "twitter",
        "twitter_get_user_tweets",
        { user_id: "123", max_results: 5 },
      );
      expect(result.text).toBe('{"data":[]}');
    });

    it("delegates correctly for twitter-get-dm-events", async () => {
      const mgr = createMockLocalServerManager({
        callResult: { text: '{"data":[]}' },
      });
      const tools = createTwitterTools({ localServerManager: mgr as never });
      const handler = tools.find(
        (t) => t.name === "twitter-get-dm-events",
      )!.handler;
      const result = await handler({ max_results: 10 });
      expect(mgr.callTool).toHaveBeenCalledWith(
        "twitter",
        "twitter_get_dm_events",
        { max_results: 10 },
      );
      expect(result.text).toBe('{"data":[]}');
    });

    it("delegates correctly for twitter-send-dm", async () => {
      const mgr = createMockLocalServerManager({
        callResult: { text: '{"sent":true}' },
      });
      const tools = createTwitterTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "twitter-send-dm")!.handler;
      const result = await handler({ participant_id: "456", text: "Hello!" });
      expect(mgr.callTool).toHaveBeenCalledWith("twitter", "twitter_send_dm", {
        participant_id: "456",
        text: "Hello!",
      });
      expect(result.text).toBe('{"sent":true}');
    });

    it("delegates correctly for twitter-get-user", async () => {
      const mgr = createMockLocalServerManager({
        callResult: { text: '{"data":{"username":"testuser"}}' },
      });
      const tools = createTwitterTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "twitter-get-user")!.handler;
      const result = await handler({ username: "testuser" });
      expect(mgr.callTool).toHaveBeenCalledWith("twitter", "twitter_get_user", {
        username: "testuser",
      });
      expect(result.text).toBe('{"data":{"username":"testuser"}}');
    });

    it("delegates correctly for twitter-post-analytics", async () => {
      const mgr = createMockLocalServerManager({
        callResult: { text: '{"data":{"public_metrics":{"like_count":42}}}' },
      });
      const tools = createTwitterTools({ localServerManager: mgr as never });
      const handler = tools.find(
        (t) => t.name === "twitter-post-analytics",
      )!.handler;
      const result = await handler({ tweet_id: "999" });
      expect(mgr.callTool).toHaveBeenCalledWith(
        "twitter",
        "twitter_post_analytics",
        { tweet_id: "999" },
      );
      expect(result.text).toBe(
        '{"data":{"public_metrics":{"like_count":42}}}',
      );
    });

    it("delegates correctly for twitter-account-analytics", async () => {
      const mgr = createMockLocalServerManager({
        callResult: { text: '{"data":{"public_metrics":{"followers_count":100}}}' },
      });
      const tools = createTwitterTools({ localServerManager: mgr as never });
      const handler = tools.find(
        (t) => t.name === "twitter-account-analytics",
      )!.handler;
      const result = await handler({ username: "alice" });
      expect(mgr.callTool).toHaveBeenCalledWith(
        "twitter",
        "twitter_account_analytics",
        { username: "alice" },
      );
      expect(result.text).toBe(
        '{"data":{"public_metrics":{"followers_count":100}}}',
      );
    });

    it("returns error from server", async () => {
      const mgr = createMockLocalServerManager({
        callResult: { text: "API rate limit exceeded", isError: true },
      });
      const tools = createTwitterTools({ localServerManager: mgr as never });
      const handler = tools.find((t) => t.name === "twitter-get-me")!.handler;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(result.text).toBe("API rate limit exceeded");
    });
  });

  describe("risk levels", () => {
    it("read operations are low risk", () => {
      const tools = createTwitterTools({});
      const lowRiskTools = [
        "twitter-get-me",
        "twitter-get-user-tweets",
        "twitter-search-tweets",
        "twitter-get-tweet",
        "twitter-get-user",
        "twitter-post-analytics",
        "twitter-account-analytics",
      ];
      for (const name of lowRiskTools) {
        const tool = tools.find((t) => t.name === name);
        expect(tool?.riskLevel).toBe("low");
      }
    });

    it("write operations are high risk", () => {
      const tools = createTwitterTools({});
      const highRiskTools = [
        "twitter-post-tweet",
        "twitter-get-dm-events",
        "twitter-send-dm",
      ];
      for (const name of highRiskTools) {
        const tool = tools.find((t) => t.name === name);
        expect(tool?.riskLevel).toBe("high");
      }
    });
  });
});
