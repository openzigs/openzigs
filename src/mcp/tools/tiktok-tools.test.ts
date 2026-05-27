import { describe, expect, it, vi } from "vitest";
import { createTikTokTools } from "./tiktok-tools.js";
import type { LocalMcpServerManager } from "../local-mcp-server-manager.js";

function makeManager(
  opts: {
    isRunning?: boolean;
    callTool?: ReturnType<typeof vi.fn>;
  } = {},
): LocalMcpServerManager {
  return {
    isRunning: vi.fn().mockReturnValue(opts.isRunning ?? true),
    callTool:
      opts.callTool ??
      vi.fn().mockResolvedValue({ text: "published", isError: false }),
  } as unknown as LocalMcpServerManager;
}

describe("createTikTokTools", () => {
  it("registers exactly tiktok_publish_video", () => {
    const tools = createTikTokTools({});
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("tiktok_publish_video");
    expect(tools[0].source).toBe("tiktok");
    expect(tools[0].category).toBe("social");
    expect(tools[0].riskLevel).toBe("high");
  });

  it("returns error when local server manager is not configured", async () => {
    const [tool] = createTikTokTools({});
    const out = await tool.handler({
      video_url: "https://example.com/v.mp4",
      privacy_level: "SELF_ONLY",
      brand_content_toggle: false,
      brand_organic_toggle: false,
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("not configured");
  });

  it("returns error when sidecar is not running", async () => {
    const m = makeManager({ isRunning: false });
    const [tool] = createTikTokTools({ localServerManager: m });
    const out = await tool.handler({
      video_url: "https://example.com/v.mp4",
      privacy_level: "SELF_ONLY",
      brand_content_toggle: false,
      brand_organic_toggle: false,
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("TikTok MCP server is not running");
  });

  it("forwards args to tiktok_post_video on the sidecar", async () => {
    const callTool = vi.fn().mockResolvedValue({ text: "ok", isError: false });
    const m = makeManager({ callTool });
    const [tool] = createTikTokTools({ localServerManager: m });
    const args = {
      video_url: "https://example.com/v.mp4",
      privacy_level: "PUBLIC_TO_EVERYONE" as const,
      brand_content_toggle: true,
      brand_organic_toggle: false,
      title: "hi",
    };
    const out = await tool.handler(args);
    expect(out.isError).toBe(false);
    expect(callTool).toHaveBeenCalledWith("tiktok", "tiktok_post_video", args);
  });

  it("validates video_url is a URL via zod schema", () => {
    const [tool] = createTikTokTools({});
    const result = tool.zodSchema!.safeParse({
      video_url: "not-a-url",
      privacy_level: "SELF_ONLY",
      brand_content_toggle: false,
      brand_organic_toggle: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid privacy_level via zod schema", () => {
    const [tool] = createTikTokTools({});
    const result = tool.zodSchema!.safeParse({
      video_url: "https://example.com/v.mp4",
      privacy_level: "INVALID",
      brand_content_toggle: false,
      brand_organic_toggle: false,
    });
    expect(result.success).toBe(false);
  });
});
