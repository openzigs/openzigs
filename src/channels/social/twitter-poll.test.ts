import { describe, it, expect, vi } from "vitest";
import { createTwitterPollFn } from "./twitter-poll.js";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Helper: build a mock LocalMcpServerManager that returns canned responses per tool. */
function createMockManager(responses: Record<string, { text: string; isError?: boolean }>) {
  return {
    isRunning: vi.fn().mockReturnValue(true),
    callTool: vi.fn().mockImplementation((_server: string, tool: string) => {
      return Promise.resolve(responses[tool] ?? { text: "{}", isError: true });
    }),
  };
}

/** Wrap a Twitter MCP-style result */
function mcpResult(success: boolean, data: unknown = null, error: string | null = null) {
  return JSON.stringify({ success, data, error, timestamp: new Date().toISOString() });
}

const SINCE = "2026-01-01T00:00:00Z";

const ME_RESPONSE = {
  data: { id: "12345", name: "TestBot", username: "testbot" },
};

/** Standard responses where mentions endpoint returns the data (primary path). */
function mentionsResponses(twitterData: { data?: unknown[]; includes?: unknown; meta?: unknown }) {
  return {
    twitter_get_me: { text: mcpResult(true, ME_RESPONSE) },
    twitter_get_mentions: { text: mcpResult(true, twitterData) },
    twitter_search_replies: { text: mcpResult(true, { data: [], meta: { result_count: 0 } }) },
  };
}

/** Standard responses where mentions endpoint fails and we fall back to search_replies. */
function searchFallbackResponses(twitterData: { data?: unknown[]; includes?: unknown; meta?: unknown }) {
  return {
    twitter_get_me: { text: mcpResult(true, ME_RESPONSE) },
    twitter_get_mentions: { text: "OAuth 1.0a credentials required", isError: true },
    twitter_search_replies: { text: mcpResult(true, twitterData) },
  };
}

describe("createTwitterPollFn", () => {
  it("returns empty array when Twitter server is not running", async () => {
    const mgr = createMockManager({});
    mgr.isRunning.mockReturnValue(false);

    const poll = createTwitterPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
    expect(mgr.callTool).not.toHaveBeenCalled();
  });

  it("returns empty array when get_me call fails", async () => {
    const mgr = createMockManager({
      twitter_get_me: { text: "Server error", isError: true },
    });

    const poll = createTwitterPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("returns empty array when get_me response is unparseable", async () => {
    const mgr = createMockManager({
      twitter_get_me: { text: "not-json" },
    });

    const poll = createTwitterPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("returns empty array when get_me response has no user data", async () => {
    const mgr = createMockManager({
      twitter_get_me: { text: mcpResult(true, { data: {} }) },
    });

    const poll = createTwitterPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("returns empty array when both mentions and search_replies fail", async () => {
    const mgr = createMockManager({
      twitter_get_me: { text: mcpResult(true, ME_RESPONSE) },
      twitter_get_mentions: { text: "OAuth error", isError: true },
      twitter_search_replies: { text: "Server error", isError: true },
    });

    const poll = createTwitterPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("falls back to search_replies when mentions endpoint fails", async () => {
    const mgr = createMockManager(searchFallbackResponses({
      data: [
        {
          id: "reply1",
          text: "Fallback reply",
          author_id: "999",
          conversation_id: "conv1",
          created_at: "2026-03-01T12:00:00Z",
        },
      ],
      includes: { users: [{ id: "999", name: "User", username: "user999" }] },
    }));

    const poll = createTwitterPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining({ commentId: "reply1" }));
  });

  it("returns empty array when mentions response is unsuccessful", async () => {
    const mgr = createMockManager({
      twitter_get_me: { text: mcpResult(true, ME_RESPONSE) },
      twitter_get_mentions: { text: mcpResult(false, null, "Rate limited") },
    });

    const poll = createTwitterPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("returns empty array when no tweets match", async () => {
    const mgr = createMockManager(mentionsResponses({ data: [], meta: { result_count: 0 } }));

    const poll = createTwitterPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("filters out tweets older than since timestamp", async () => {
    const mgr = createMockManager(mentionsResponses({
      data: [
        {
          id: "tweet1",
          text: "Old reply",
          author_id: "999",
          conversation_id: "conv1",
          created_at: "2025-06-01T00:00:00Z",
        },
      ],
      includes: { users: [{ id: "999", name: "OldUser", username: "olduser" }] },
    }));

    const poll = createTwitterPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("filters out self-authored tweets", async () => {
    const mgr = createMockManager(mentionsResponses({
      data: [
        {
          id: "tweet1",
          text: "My own reply",
          author_id: "12345", // Same as ME_RESPONSE
          conversation_id: "conv1",
          created_at: "2026-03-01T12:00:00Z",
        },
      ],
    }));

    const poll = createTwitterPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("parses reply tweets as IncomingComment", async () => {
    const mgr = createMockManager(mentionsResponses({
      data: [
        {
          id: "reply1",
          text: "@testbot Great content!",
          author_id: "999",
          conversation_id: "original_tweet_1",
          created_at: "2026-03-01T12:00:00Z",
        },
      ],
      includes: {
        users: [{ id: "999", name: "Fan User", username: "fanuser" }],
      },
    }));

    const poll = createTwitterPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      platform: "twitter",
      postId: "original_tweet_1",
      commentId: "reply1",
      userId: "999",
      username: "fanuser",
      text: "@testbot Great content!",
      timestamp: "2026-03-01T12:00:00.000Z",
    });
  });

  it("parses standalone mentions as IncomingSocialMessage", async () => {
    const mgr = createMockManager(mentionsResponses({
      data: [
        {
          id: "mention1",
          text: "Hey @testbot check this out!",
          author_id: "888",
          conversation_id: "mention1", // Same as id = standalone tweet
          created_at: "2026-03-01T14:00:00Z",
        },
      ],
      includes: {
        users: [{ id: "888", name: "Mentioner", username: "mentioner" }],
      },
    }));

    const poll = createTwitterPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toHaveLength(1);
    const msg = results[0];
    expect(msg).toEqual(
      expect.objectContaining({
        platform: "twitter",
        platformMessageId: "mention1",
        platformUserId: "888",
        username: "mentioner",
        text: "Hey @testbot check this out!",
      }),
    );
    expect("commentId" in msg).toBe(false);
  });

  it("handles multiple tweets with mixed types", async () => {
    const mgr = createMockManager(mentionsResponses({
      data: [
        {
          id: "reply1",
          text: "Nice post!",
          author_id: "100",
          conversation_id: "original1",
          created_at: "2026-03-01T10:00:00Z",
        },
        {
          id: "mention1",
          text: "@testbot hello",
          author_id: "200",
          conversation_id: "mention1",
          created_at: "2026-03-01T11:00:00Z",
        },
        {
          id: "old_reply",
          text: "Old stuff",
          author_id: "300",
          conversation_id: "old_conv",
          created_at: "2025-06-01T00:00:00Z", // Before SINCE
        },
        {
          id: "self_reply",
          text: "My own tweet",
          author_id: "12345", // Self
          conversation_id: "conv99",
          created_at: "2026-03-01T12:00:00Z",
        },
      ],
      includes: {
        users: [
          { id: "100", username: "user100" },
          { id: "200", username: "user200" },
          { id: "300", username: "user300" },
          { id: "12345", username: "testbot" },
        ],
      },
    }));

    const poll = createTwitterPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toHaveLength(2);
    // Reply
    expect(results[0]).toEqual(
      expect.objectContaining({
        commentId: "reply1",
        postId: "original1",
        username: "user100",
      }),
    );
    // Mention
    expect(results[1]).toEqual(
      expect.objectContaining({
        platformMessageId: "mention1",
        username: "user200",
      }),
    );
  });

  it("caches user identity across multiple poll calls", async () => {
    const mgr = createMockManager(mentionsResponses({ data: [], meta: { result_count: 0 } }));

    const poll = createTwitterPollFn(mgr as any);
    await poll(SINCE);
    await poll(SINCE);

    // twitter_get_me should only be called once (cached)
    const getMeCalls = (mgr.callTool as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[1] === "twitter_get_me",
    );
    expect(getMeCalls).toHaveLength(1);
  });

  it("falls back to author_id when user not in expansions", async () => {
    const mgr = createMockManager(mentionsResponses({
      data: [
        {
          id: "reply1",
          text: "Hello!",
          author_id: "unknown_id",
          conversation_id: "conv1",
          created_at: "2026-03-01T12:00:00Z",
        },
      ],
      // No includes/users
    }));

    const poll = createTwitterPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(
      expect.objectContaining({
        userId: "unknown_id",
        username: "unknown_id",
      }),
    );
  });

  it("skips tweets missing created_at or id", async () => {
    const mgr = createMockManager(mentionsResponses({
      data: [
        { id: "tweet_no_date", text: "missing timestamp", author_id: "999" },
        { text: "missing id", author_id: "999", created_at: "2026-03-01T12:00:00Z" },
        {
          id: "good_tweet",
          text: "This is valid",
          author_id: "999",
          conversation_id: "conv1",
          created_at: "2026-03-01T12:00:00Z",
        },
      ],
      includes: { users: [{ id: "999", username: "gooduser" }] },
    }));

    const poll = createTwitterPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(
      expect.objectContaining({ commentId: "good_tweet" }),
    );
  });

  it("deduplicates tweets returned by both mentions and search", async () => {
    const sharedTweet = {
      id: "dup1",
      text: "Appears in both",
      author_id: "999",
      conversation_id: "conv1",
      created_at: "2026-03-01T12:00:00Z",
    };
    const searchOnly = {
      id: "search_only1",
      text: "Only in search",
      author_id: "888",
      conversation_id: "conv2",
      created_at: "2026-03-01T13:00:00Z",
    };

    const mgr = createMockManager({
      twitter_get_me: { text: mcpResult(true, ME_RESPONSE) },
      twitter_get_mentions: {
        text: mcpResult(true, {
          data: [sharedTweet],
          includes: { users: [{ id: "999", username: "user999" }] },
        }),
      },
      twitter_search_replies: {
        text: mcpResult(true, {
          data: [sharedTweet, searchOnly],
          includes: { users: [{ id: "888", username: "user888" }, { id: "999", username: "user999" }] },
        }),
      },
    });

    const poll = createTwitterPollFn(mgr as any);
    const results = await poll(SINCE);

    // dup1 should appear only once, plus search_only1
    expect(results).toHaveLength(2);
    expect(results.map((r) => ("commentId" in r ? r.commentId : undefined))).toEqual(["dup1", "search_only1"]);
  });
});
