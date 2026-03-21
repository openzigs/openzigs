import { describe, it, expect, vi } from "vitest";
import { createRedditPollFn } from "./reddit-poll.js";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const createMockManager = (response: { text: string; isError?: boolean }) => ({
  callTool: vi.fn().mockResolvedValue(response),
  isRunning: vi.fn().mockReturnValue(true),
});

describe("createRedditPollFn", () => {
  it("returns empty array on MCP error", async () => {
    const mgr = createMockManager({ text: "Server error", isError: true });
    const poll = createRedditPollFn(mgr as any);
    const results = await poll("2026-01-01T00:00:00Z");
    expect(results).toEqual([]);
  });

  it("returns empty array on unparseable response", async () => {
    const mgr = createMockManager({ text: "not-json" });
    const poll = createRedditPollFn(mgr as any);
    const results = await poll("2026-01-01T00:00:00Z");
    expect(results).toEqual([]);
  });

  it("returns empty array when inbox has no children", async () => {
    const mgr = createMockManager({
      text: JSON.stringify({ success: true, data: { data: { children: [] } } }),
    });
    const poll = createRedditPollFn(mgr as any);
    const results = await poll("2026-01-01T00:00:00Z");
    expect(results).toEqual([]);
  });

  it("filters out items older than since timestamp", async () => {
    const mgr = createMockManager({
      text: JSON.stringify({
        success: true,
        data: {
          data: {
            children: [
              {
                data: {
                  name: "t4_old",
                  author: "user1",
                  body: "Old message",
                  created_utc: 1704067200, // 2024-01-01T00:00:00Z
                  was_comment: false,
                },
              },
            ],
          },
        },
      }),
    });
    const poll = createRedditPollFn(mgr as any);
    const results = await poll("2025-01-01T00:00:00Z");
    expect(results).toEqual([]);
  });

  it("parses private messages as IncomingSocialMessage", async () => {
    const mgr = createMockManager({
      text: JSON.stringify({
        success: true,
        data: {
          data: {
            children: [
              {
                data: {
                  name: "t4_msg123",
                  author: "cool_user",
                  body: "Hey there!",
                  created_utc: 1738800000, // 2025-02-06T00:00:00Z
                  was_comment: false,
                },
              },
            ],
          },
        },
      }),
    });
    const poll = createRedditPollFn(mgr as any);
    const results = await poll("2025-02-01T00:00:00Z");

    expect(results).toHaveLength(1);
    const msg = results[0];
    expect(msg).toEqual(
      expect.objectContaining({
        platform: "reddit",
        platformMessageId: "t4_msg123",
        platformUserId: "cool_user",
        username: "cool_user",
        text: "Hey there!",
      }),
    );
    expect("commentId" in msg).toBe(false);
  });

  it("parses comment replies as IncomingComment", async () => {
    const mgr = createMockManager({
      text: JSON.stringify({
        success: true,
        data: {
          data: {
            children: [
              {
                data: {
                  name: "t1_comment456",
                  author: "replier",
                  body: "Nice post!",
                  created_utc: 1738800000,
                  was_comment: true,
                  link_id: "t3_post789",
                },
              },
            ],
          },
        },
      }),
    });
    const poll = createRedditPollFn(mgr as any);
    const results = await poll("2025-02-01T00:00:00Z");

    expect(results).toHaveLength(1);
    const comment = results[0] as { platform: string; postId: string; commentId: string; text: string };
    expect(comment.platform).toBe("reddit");
    expect(comment.postId).toBe("post789");
    expect(comment.commentId).toBe("t1_comment456");
    expect(comment.text).toBe("Nice post!");
  });

  it("handles mixed messages and comments", async () => {
    const mgr = createMockManager({
      text: JSON.stringify({
        success: true,
        data: {
          data: {
            children: [
              {
                data: {
                  name: "t4_dm1",
                  author: "sender1",
                  body: "DM text",
                  created_utc: 1738800000,
                  was_comment: false,
                },
              },
              {
                data: {
                  name: "t1_reply1",
                  author: "commenter1",
                  body: "Reply text",
                  created_utc: 1738800001,
                  was_comment: true,
                  link_id: "t3_abc",
                },
              },
            ],
          },
        },
      }),
    });
    const poll = createRedditPollFn(mgr as any);
    const results = await poll("2025-02-01T00:00:00Z");

    expect(results).toHaveLength(2);
    // First is a DM
    expect("platformMessageId" in results[0]).toBe(true);
    // Second is a comment
    expect("commentId" in results[1]).toBe(true);
  });

  it("calls reddit_get_inbox with limit 50", async () => {
    const mgr = createMockManager({
      text: JSON.stringify({ success: true, data: { data: { children: [] } } }),
    });
    const poll = createRedditPollFn(mgr as any);
    await poll("2025-01-01T00:00:00Z");

    expect(mgr.callTool).toHaveBeenCalledWith("reddit", "reddit_get_inbox", { limit: 50 });
  });

  it("strips t3_ prefix from link_id for comment postId", async () => {
    const mgr = createMockManager({
      text: JSON.stringify({
        success: true,
        data: {
          data: {
            children: [
              {
                data: {
                  name: "t1_c1",
                  author: "u",
                  body: "text",
                  created_utc: 1738800000,
                  was_comment: true,
                  link_id: "t3_stripped",
                },
              },
            ],
          },
        },
      }),
    });
    const poll = createRedditPollFn(mgr as any);
    const results = await poll("2025-02-01T00:00:00Z");
    const comment = results[0] as { postId: string };
    expect(comment.postId).toBe("stripped");
  });

  it("handles alternative data shape (children at top level)", async () => {
    const mgr = createMockManager({
      text: JSON.stringify({
        success: true,
        data: {
          children: [
            {
              data: {
                name: "t4_alt",
                author: "alt_user",
                body: "Alt format",
                created_utc: 1738800000,
                was_comment: false,
              },
            },
          ],
        },
      }),
    });
    const poll = createRedditPollFn(mgr as any);
    const results = await poll("2025-02-01T00:00:00Z");
    expect(results).toHaveLength(1);
    expect((results[0] as { username: string }).username).toBe("alt_user");
  });
});
