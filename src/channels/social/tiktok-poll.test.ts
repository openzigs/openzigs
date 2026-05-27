/**
 * Tests for the TikTok polling adapter.
 *
 * The TikTok Display API does not expose a public comment-list endpoint
 * (Research-API-only as of 2026). The poller surfaces video-level
 * comment_count and like_count deltas as engagement events.
 */

import { describe, expect, it, vi } from "vitest";
import { createTikTokPollFn } from "./tiktok-poll.js";
import type { LocalMcpServerManager } from "../../mcp/local-mcp-server-manager.js";
import type { IncomingComment } from "./types.js";

const SINCE = "2026-01-01T00:00:00Z";

function makeManager(opts: {
  isRunning?: boolean;
  callTool?: ReturnType<typeof vi.fn>;
}): LocalMcpServerManager {
  return {
    isRunning: vi.fn().mockReturnValue(opts.isRunning ?? true),
    callTool:
      opts.callTool ??
      vi.fn().mockResolvedValue({ text: "No videos found.", isError: false }),
  } as unknown as LocalMcpServerManager;
}

function jsonText(videos: unknown[]): string {
  return JSON.stringify({ data: { videos } });
}

describe("createTikTokPollFn", () => {
  it("returns empty when sidecar is not running", async () => {
    const m = makeManager({ isRunning: false });
    const poll = createTikTokPollFn(m);
    expect(await poll(SINCE)).toEqual([]);
  });

  it("returns empty when callTool errors", async () => {
    const callTool = vi.fn().mockResolvedValue({ text: "boom", isError: true });
    const poll = createTikTokPollFn(makeManager({ callTool }));
    expect(await poll(SINCE)).toEqual([]);
  });

  it("calls tiktok_list_videos with max_count", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValue({ text: jsonText([]), isError: false });
    const poll = createTikTokPollFn(makeManager({ callTool }), 7);
    await poll(SINCE);
    expect(callTool).toHaveBeenCalledWith("tiktok", "tiktok_list_videos", {
      max_count: 7,
    });
  });

  it("emits new-video event for a video created after `since`", async () => {
    const recent = Math.floor(
      new Date("2026-02-01T00:00:00Z").getTime() / 1000,
    );
    const callTool = vi.fn().mockResolvedValue({
      text: jsonText([
        {
          id: "v_new",
          title: "Fresh Take",
          create_time: recent,
          comment_count: 0,
          like_count: 0,
        },
      ]),
      isError: false,
    });
    const poll = createTikTokPollFn(makeManager({ callTool }));
    const out = (await poll(SINCE)) as IncomingComment[];
    expect(out).toHaveLength(1);
    expect(out[0].platform).toBe("tiktok");
    expect(out[0].postId).toBe("v_new");
    expect(out[0].commentId).toBe("tt_video_created_v_new");
    expect(out[0].text).toContain("Fresh Take");
  });

  it("does NOT emit for old videos with zero deltas", async () => {
    const old = Math.floor(new Date("2025-01-01T00:00:00Z").getTime() / 1000);
    const callTool = vi.fn().mockResolvedValue({
      text: jsonText([
        { id: "v_old", create_time: old, comment_count: 5, like_count: 10 },
      ]),
      isError: false,
    });
    const poll = createTikTokPollFn(makeManager({ callTool }));
    expect(await poll(SINCE)).toEqual([]); // seed
    expect(await poll(SINCE)).toEqual([]); // no deltas
  });

  it("emits a comment-delta event when comment_count grows", async () => {
    const old = Math.floor(new Date("2025-01-01T00:00:00Z").getTime() / 1000);
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        text: jsonText([
          { id: "v1", create_time: old, comment_count: 5, like_count: 10 },
        ]),
        isError: false,
      })
      .mockResolvedValueOnce({
        text: jsonText([
          { id: "v1", create_time: old, comment_count: 8, like_count: 10 },
        ]),
        isError: false,
      });
    const poll = createTikTokPollFn(makeManager({ callTool }));
    await poll(SINCE); // seed
    const out = (await poll(SINCE)) as IncomingComment[];
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("+3 new comments");
    expect(out[0].commentId).toMatch(/^tt_comments_v1_\d{4}-\d{2}-\d{2}$/);
  });

  it("emits a like-delta event when only likes grow", async () => {
    const old = Math.floor(new Date("2025-01-01T00:00:00Z").getTime() / 1000);
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        text: jsonText([
          { id: "v2", create_time: old, comment_count: 5, like_count: 10 },
        ]),
        isError: false,
      })
      .mockResolvedValueOnce({
        text: jsonText([
          { id: "v2", create_time: old, comment_count: 5, like_count: 15 },
        ]),
        isError: false,
      });
    const poll = createTikTokPollFn(makeManager({ callTool }));
    await poll(SINCE);
    const out = (await poll(SINCE)) as IncomingComment[];
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("+5 new likes");
  });

  it("parses human-readable text response from sidecar", async () => {
    const recent = Math.floor(
      new Date("2026-02-01T00:00:00Z").getTime() / 1000,
    );
    const text = [
      `ID: v_text`,
      `Title: Plain-Text Video`,
      `Created: ${recent}`,
      `Comments: 0`,
      `Likes: 0`,
    ].join("\n");
    const callTool = vi.fn().mockResolvedValue({ text, isError: false });
    const poll = createTikTokPollFn(makeManager({ callTool }));
    const out = (await poll(SINCE)) as IncomingComment[];
    expect(out).toHaveLength(1);
    expect(out[0].postId).toBe("v_text");
    expect(out[0].text).toContain("Plain-Text Video");
  });
});
