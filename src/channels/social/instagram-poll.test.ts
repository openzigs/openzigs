import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInstagramPollFn } from "./instagram-poll.js";

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

/** Wrap an Instagram MCP-style result */
function mcpResult(success: boolean, data: unknown = null, error: string | null = null) {
  return JSON.stringify({ success, data, error, timestamp: new Date().toISOString() });
}

const SINCE = "2026-01-01T00:00:00Z";

// Mock INSTAGRAM_BUSINESS_ACCOUNT_ID for self-comment filtering
const BUSINESS_ACCOUNT_ID = "17841439350400283";

describe("createInstagramPollFn", () => {
  beforeEach(() => {
    vi.stubEnv("INSTAGRAM_BUSINESS_ACCOUNT_ID", BUSINESS_ACCOUNT_ID);
  });

  it("returns empty array when Instagram server is not running", async () => {
    const mgr = createMockManager({});
    mgr.isRunning.mockReturnValue(false);

    const poll = createInstagramPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
    expect(mgr.callTool).not.toHaveBeenCalled();
  });

  it("returns empty array when get_media_posts call fails", async () => {
    const mgr = createMockManager({
      get_media_posts: { text: "API error", isError: true },
    });

    const poll = createInstagramPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("returns empty array when get_media_posts response is unparseable", async () => {
    const mgr = createMockManager({
      get_media_posts: { text: "not-json" },
    });

    const poll = createInstagramPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("returns empty array when no posts found", async () => {
    const mgr = createMockManager({
      get_media_posts: { text: mcpResult(true, { posts: [], count: 0 }) },
    });

    const poll = createInstagramPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("returns empty array for posts with no actual comments", async () => {
    const mgr = createMockManager({
      get_media_posts: {
        text: mcpResult(true, {
          posts: [
            { id: "post1", caption: "No comments", comments_count: 0 },
          ],
          count: 1,
        }),
      },
      get_media_comments: {
        text: mcpResult(true, { comments: [], count: 0 }),
      },
    });

    const poll = createInstagramPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("returns empty array when get_media_comments fails", async () => {
    const mgr = createMockManager({
      get_media_posts: {
        text: mcpResult(true, {
          posts: [{ id: "post1", caption: "Test", comments_count: 5 }],
          count: 1,
        }),
      },
      get_media_comments: { text: "API error", isError: true },
    });

    const poll = createInstagramPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("filters out comments older than since timestamp", async () => {
    const mgr = createMockManager({
      get_media_posts: {
        text: mcpResult(true, {
          posts: [{ id: "post1", caption: "Test", comments_count: 1 }],
          count: 1,
        }),
      },
      get_media_comments: {
        text: mcpResult(true, {
          comments: [
            {
              id: "comment1",
              text: "Old comment",
              username: "someuser",
              timestamp: "2025-06-01T00:00:00Z", // Before SINCE
            },
          ],
          count: 1,
        }),
      },
    });

    const poll = createInstagramPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("filters out self-authored comments by business account ID", async () => {
    const mgr = createMockManager({
      get_media_posts: {
        text: mcpResult(true, {
          posts: [{ id: "post1", caption: "Test", comments_count: 1 }],
          count: 1,
        }),
      },
      get_media_comments: {
        text: mcpResult(true, {
          comments: [
            {
              id: "comment1",
              text: "My own comment",
              from: { id: BUSINESS_ACCOUNT_ID, username: "openzigs" },
              timestamp: "2026-03-01T12:00:00Z",
            },
          ],
          count: 1,
        }),
      },
    });

    const poll = createInstagramPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("parses comments as IncomingComment with correct structure", async () => {
    const mgr = createMockManager({
      get_media_posts: {
        text: mcpResult(true, {
          posts: [{ id: "post1", caption: "Test post", comments_count: 2 }],
          count: 1,
        }),
      },
      get_media_comments: {
        text: mcpResult(true, {
          comments: [
            {
              id: "comment1",
              text: "Great content!",
              username: "fanuser",
              from: { id: "user123", username: "fanuser" },
              timestamp: "2026-03-01T12:00:00Z",
            },
          ],
          count: 1,
        }),
      },
    });

    const poll = createInstagramPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      platform: "instagram",
      postId: "post1",
      commentId: "comment1",
      userId: "user123",
      username: "fanuser",
      text: "Great content!",
      timestamp: "2026-03-01T12:00:00.000Z",
    });
  });

  it("handles comments with username field but no from.id", async () => {
    const mgr = createMockManager({
      get_media_posts: {
        text: mcpResult(true, {
          posts: [{ id: "post1", caption: "Test", comments_count: 1 }],
          count: 1,
        }),
      },
      get_media_comments: {
        text: mcpResult(true, {
          comments: [
            {
              id: "comment1",
              text: "Nice!",
              username: "anotheruser",
              timestamp: "2026-03-01T14:00:00Z",
            },
          ],
          count: 1,
        }),
      },
    });

    const poll = createInstagramPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      platform: "instagram",
      postId: "post1",
      commentId: "comment1",
      userId: "",
      username: "anotheruser",
      text: "Nice!",
      timestamp: "2026-03-01T14:00:00.000Z",
    });
  });

  it("processes multiple posts with multiple comments", async () => {
    const mgr = createMockManager({
      get_media_posts: {
        text: mcpResult(true, {
          posts: [
            { id: "post1", caption: "First post", comments_count: 1 },
            { id: "post2", caption: "Second post", comments_count: 2 },
          ],
          count: 2,
        }),
      },
      get_media_comments: {
        text: mcpResult(true, {
          comments: [
            {
              id: "comment1",
              text: "Comment on post",
              username: "user1",
              from: { id: "uid1", username: "user1" },
              timestamp: "2026-03-01T12:00:00Z",
            },
            {
              id: "comment2",
              text: "Another comment",
              username: "user2",
              from: { id: "uid2", username: "user2" },
              timestamp: "2026-03-02T10:00:00Z",
            },
          ],
          count: 2,
        }),
      },
    });

    const poll = createInstagramPollFn(mgr as any);
    const results = await poll(SINCE);

    // Each post gets the same mock response so 2 posts × 2 comments = 4
    expect(results).toHaveLength(4);
    expect(results.map((r) => (r as { commentId: string }).commentId)).toEqual([
      "comment1",
      "comment2",
      "comment1",
      "comment2",
    ]);
  });

  it("skips comments with missing required fields", async () => {
    const mgr = createMockManager({
      get_media_posts: {
        text: mcpResult(true, {
          posts: [{ id: "post1", caption: "Test", comments_count: 3 }],
          count: 1,
        }),
      },
      get_media_comments: {
        text: mcpResult(true, {
          comments: [
            { id: "comment1" }, // Missing text and timestamp
            { id: "comment2", text: "Has text" }, // Missing timestamp
            { text: "Has text", timestamp: "2026-03-01T12:00:00Z" }, // Missing id
            {
              id: "valid",
              text: "Valid comment",
              username: "validuser",
              timestamp: "2026-03-01T15:00:00Z",
            },
          ],
          count: 4,
        }),
      },
    });

    const poll = createInstagramPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toHaveLength(1);
    expect((results[0] as { commentId: string }).commentId).toBe("valid");
  });

  it("handles unsuccessful MCP response for posts", async () => {
    const mgr = createMockManager({
      get_media_posts: { text: mcpResult(false, null, "Rate limited") },
    });

    const poll = createInstagramPollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("handles unsuccessful MCP response for comments gracefully", async () => {
    const mgr = createMockManager({
      get_media_posts: {
        text: mcpResult(true, {
          posts: [{ id: "post1", caption: "Test", comments_count: 5 }],
          count: 1,
        }),
      },
      get_media_comments: { text: mcpResult(false, null, "Permission denied") },
    });

    const poll = createInstagramPollFn(mgr as any);
    const results = await poll(SINCE);

    // Should return empty but not throw
    expect(results).toEqual([]);
  });

  it("skips posts without id", async () => {
    const mgr = createMockManager({
      get_media_posts: {
        text: mcpResult(true, {
          posts: [
            { caption: "No ID post", comments_count: 5 }, // Missing id
            { id: "post2", caption: "Has ID", comments_count: 1 },
          ],
          count: 2,
        }),
      },
      get_media_comments: {
        text: mcpResult(true, {
          comments: [
            {
              id: "comment1",
              text: "Comment",
              username: "user",
              timestamp: "2026-03-01T12:00:00Z",
            },
          ],
          count: 1,
        }),
      },
    });

    const poll = createInstagramPollFn(mgr as any);
    const results = await poll(SINCE);

    // Only post2 should be processed
    expect(results).toHaveLength(1);
    expect((results[0] as { postId: string }).postId).toBe("post2");
  });
});
