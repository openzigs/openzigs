import { describe, it, expect, vi } from "vitest";
import { createYouTubePollFn } from "./youtube-poll.js";

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

/** Wrap a YouTube MCP-style result */
function mcpResult(success: boolean, data: unknown = null, error: string | null = null) {
  return JSON.stringify({ success, data, error, timestamp: new Date().toISOString() });
}

const SINCE = "2026-01-01T00:00:00Z";

describe("createYouTubePollFn", () => {
  it("returns empty array when YouTube server is not running", async () => {
    const mgr = createMockManager({});
    mgr.isRunning.mockReturnValue(false);

    const poll = createYouTubePollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
    expect(mgr.callTool).not.toHaveBeenCalled();
  });

  it("returns empty array when channel videos call fails", async () => {
    const mgr = createMockManager({
      yt_get_channel_videos: { text: "Server error", isError: true },
    });

    const poll = createYouTubePollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("returns empty array when channel videos response is unparseable", async () => {
    const mgr = createMockManager({
      yt_get_channel_videos: { text: "not-json" },
    });

    const poll = createYouTubePollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("returns empty array when channel has no videos", async () => {
    const mgr = createMockManager({
      yt_get_channel_videos: { text: mcpResult(true, { items: [] }) },
    });

    const poll = createYouTubePollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
    // Should not attempt to fetch comments
    expect(mgr.callTool).toHaveBeenCalledTimes(1);
  });

  it("returns empty array when MCP response success is false", async () => {
    const mgr = createMockManager({
      yt_get_channel_videos: { text: mcpResult(false, null, "API quota exceeded") },
    });

    const poll = createYouTubePollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("fetches comments for discovered videos and filters by since", async () => {
    const mgr = createMockManager({
      yt_get_channel_videos: {
        text: mcpResult(true, {
          items: [{ id: { videoId: "vid1" } }],
        }),
      },
      yt_get_video_comments: {
        text: mcpResult(true, {
          items: [
            {
              id: "thread1",
              snippet: {
                videoId: "vid1",
                topLevelComment: {
                  id: "comment1",
                  snippet: {
                    textDisplay: "Great video!",
                    authorDisplayName: "TestUser",
                    authorChannelId: { value: "UC123" },
                    publishedAt: "2026-03-01T12:00:00Z",
                  },
                },
              },
            },
            {
              id: "thread2",
              snippet: {
                videoId: "vid1",
                topLevelComment: {
                  id: "comment2",
                  snippet: {
                    textDisplay: "Old comment",
                    authorDisplayName: "OldUser",
                    authorChannelId: { value: "UC456" },
                    publishedAt: "2025-06-01T00:00:00Z", // Before SINCE
                  },
                },
              },
            },
          ],
        }),
      },
    });

    const poll = createYouTubePollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      platform: "youtube",
      postId: "vid1",
      commentId: "comment1",
      userId: "UC123",
      username: "TestUser",
      text: "Great video!",
      timestamp: "2026-03-01T12:00:00.000Z",
    });
  });

  it("handles video ID as a direct string (video details format)", async () => {
    const mgr = createMockManager({
      yt_get_channel_videos: {
        text: mcpResult(true, {
          items: [{ id: "directVideoId" }],
        }),
      },
      yt_get_video_comments: {
        text: mcpResult(true, { items: [] }),
      },
    });

    const poll = createYouTubePollFn(mgr as any);
    await poll(SINCE);

    expect(mgr.callTool).toHaveBeenCalledWith("youtube", "yt_get_video_comments", {
      video_id: "directVideoId",
      max_results: 20,
    });
  });

  it("skips videos with null/undefined IDs", async () => {
    const mgr = createMockManager({
      yt_get_channel_videos: {
        text: mcpResult(true, {
          items: [{ id: null }, { id: { videoId: "goodId" } }],
        }),
      },
      yt_get_video_comments: {
        text: mcpResult(true, { items: [] }),
      },
    });

    const poll = createYouTubePollFn(mgr as any);
    await poll(SINCE);

    // Should only fetch comments for 'goodId'
    expect(mgr.callTool).toHaveBeenCalledTimes(2); // channel_videos + 1 video
    expect(mgr.callTool).toHaveBeenCalledWith("youtube", "yt_get_video_comments", {
      video_id: "goodId",
      max_results: 20,
    });
  });

  it("continues fetching comments even if one video fails", async () => {
    let callCount = 0;
    const mgr = {
      isRunning: vi.fn().mockReturnValue(true),
      callTool: vi.fn().mockImplementation((_server: string, tool: string, args: Record<string, unknown>) => {
        if (tool === "yt_get_channel_videos") {
          return Promise.resolve({
            text: mcpResult(true, {
              items: [{ id: { videoId: "vid1" } }, { id: { videoId: "vid2" } }],
            }),
          });
        }
        callCount++;
        if (args.video_id === "vid1") {
          return Promise.resolve({ text: "Error", isError: true });
        }
        return Promise.resolve({
          text: mcpResult(true, {
            items: [
              {
                id: "thread3",
                snippet: {
                  videoId: "vid2",
                  topLevelComment: {
                    id: "c3",
                    snippet: {
                      textDisplay: "From vid2",
                      authorDisplayName: "User2",
                      authorChannelId: { value: "UC789" },
                      publishedAt: "2026-02-15T00:00:00Z",
                    },
                  },
                },
              },
            ],
          }),
        });
      }),
    };

    const poll = createYouTubePollFn(mgr as any);
    const results = await poll(SINCE);

    expect(callCount).toBe(2); // Both videos attempted
    expect(results).toHaveLength(1);
    expect(results[0].postId).toBe("vid2");
  });

  it("respects maxVideos parameter", async () => {
    const mgr = createMockManager({
      yt_get_channel_videos: {
        text: mcpResult(true, {
          items: [
            { id: { videoId: "v1" } },
            { id: { videoId: "v2" } },
            { id: { videoId: "v3" } },
          ],
        }),
      },
      yt_get_video_comments: {
        text: mcpResult(true, { items: [] }),
      },
    });

    const poll = createYouTubePollFn(mgr as any, 2); // maxVideos=2
    await poll(SINCE);

    // channel_videos call + 2 comment calls (not 3)
    expect(mgr.callTool).toHaveBeenCalledTimes(3);
  });

  it("respects commentsPerVideo parameter", async () => {
    const mgr = createMockManager({
      yt_get_channel_videos: {
        text: mcpResult(true, {
          items: [{ id: { videoId: "v1" } }],
        }),
      },
      yt_get_video_comments: {
        text: mcpResult(true, { items: [] }),
      },
    });

    const poll = createYouTubePollFn(mgr as any, 5, 50);
    await poll(SINCE);

    expect(mgr.callTool).toHaveBeenCalledWith("youtube", "yt_get_video_comments", {
      video_id: "v1",
      max_results: 50,
    });
  });

  it("calls yt_get_channel_videos with correct parameters", async () => {
    const mgr = createMockManager({
      yt_get_channel_videos: {
        text: mcpResult(true, { items: [] }),
      },
    });

    const poll = createYouTubePollFn(mgr as any, 7);
    await poll(SINCE);

    expect(mgr.callTool).toHaveBeenCalledWith("youtube", "yt_get_channel_videos", {
      max_results: 7,
    });
  });

  it("skips comments with missing publishedAt", async () => {
    const mgr = createMockManager({
      yt_get_channel_videos: {
        text: mcpResult(true, { items: [{ id: { videoId: "v1" } }] }),
      },
      yt_get_video_comments: {
        text: mcpResult(true, {
          items: [
            {
              id: "t1",
              snippet: {
                topLevelComment: {
                  id: "c1",
                  snippet: {
                    textDisplay: "No date",
                    authorDisplayName: "User",
                    // Missing publishedAt
                  },
                },
              },
            },
          ],
        }),
      },
    });

    const poll = createYouTubePollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("handles unparseable comments response gracefully", async () => {
    const mgr = createMockManager({
      yt_get_channel_videos: {
        text: mcpResult(true, { items: [{ id: { videoId: "v1" } }] }),
      },
      yt_get_video_comments: { text: "bad-json" },
    });

    const poll = createYouTubePollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toEqual([]);
  });

  it("uses thread.id as fallback commentId when topLevelComment.id is missing", async () => {
    const mgr = createMockManager({
      yt_get_channel_videos: {
        text: mcpResult(true, { items: [{ id: { videoId: "v1" } }] }),
      },
      yt_get_video_comments: {
        text: mcpResult(true, {
          items: [
            {
              id: "threadFallback",
              snippet: {
                topLevelComment: {
                  // No id field on topLevelComment
                  snippet: {
                    textDisplay: "Fallback test",
                    authorDisplayName: "Fb",
                    authorChannelId: { value: "UC1" },
                    publishedAt: "2026-02-01T00:00:00Z",
                  },
                },
              },
            },
          ],
        }),
      },
    });

    const poll = createYouTubePollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toHaveLength(1);
    expect(results[0].commentId).toBe("threadFallback");
  });

  it("handles multiple videos with multiple comments", async () => {
    const mgr = {
      isRunning: vi.fn().mockReturnValue(true),
      callTool: vi.fn().mockImplementation((_server: string, tool: string, args: Record<string, unknown>) => {
        if (tool === "yt_get_channel_videos") {
          return Promise.resolve({
            text: mcpResult(true, {
              items: [{ id: { videoId: "v1" } }, { id: { videoId: "v2" } }],
            }),
          });
        }
        const videoId = args.video_id as string;
        return Promise.resolve({
          text: mcpResult(true, {
            items: [
              {
                id: `t_${videoId}_1`,
                snippet: {
                  topLevelComment: {
                    id: `c_${videoId}_1`,
                    snippet: {
                      textDisplay: `Comment on ${videoId}`,
                      authorDisplayName: "Author",
                      authorChannelId: { value: "UC" },
                      publishedAt: "2026-02-15T00:00:00Z",
                    },
                  },
                },
              },
            ],
          }),
        });
      }),
    };

    const poll = createYouTubePollFn(mgr as any);
    const results = await poll(SINCE);

    expect(results).toHaveLength(2);
    expect(results[0].postId).toBe("v1");
    expect(results[0].commentId).toBe("c_v1_1");
    expect(results[1].postId).toBe("v2");
    expect(results[1].commentId).toBe("c_v2_1");
  });
});
