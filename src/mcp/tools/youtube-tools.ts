import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { LocalMcpServerManager } from "../local-mcp-server-manager.js";

type YouTubeToolsOptions = {
  localServerManager?: LocalMcpServerManager;
};

const getChannelInfoSchema = z.object({
  channel_id: z.string().optional().describe("YouTube channel ID (uses authenticated channel if not provided)"),
});

const getChannelVideosSchema = z.object({
  channel_id: z.string().optional(),
  max_results: z.number().min(1).max(50).optional(),
});

const getVideoDetailsSchema = z.object({
  video_id: z.string().describe("YouTube video ID"),
});

const getVideoCommentsSchema = z.object({
  video_id: z.string().describe("YouTube video ID"),
  max_results: z.number().min(1).max(100).optional(),
});

const replyToCommentSchema = z.object({
  parent_comment_id: z.string().describe("Parent comment ID to reply to"),
  text: z.string().max(10000).describe("Reply text"),
});

const searchVideosSchema = z.object({
  query: z.string().describe("Search query"),
  max_results: z.number().min(1).max(50).optional(),
});

const getChannelAnalyticsSchema = z.object({
  start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
  end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
});

const callLocalServer = async (
  manager: LocalMcpServerManager | undefined,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ text: string; isError?: boolean }> => {
  if (!manager) {
    return { text: "Local MCP server manager not configured.", isError: true };
  }
  if (!manager.isRunning("youtube")) {
    return { text: "YouTube MCP server is not running. Check YOUTUBE_API_KEY env var.", isError: true };
  }
  return manager.callTool("youtube", toolName, args);
};

export const createYouTubeTools = (options: YouTubeToolsOptions): ToolDefinition[] => {
  const mgr = options.localServerManager;

  return [
    {
      name: "youtube-get-channel-info",
      description: "Get YouTube channel information and statistics.",
      inputSchema: { type: "object", properties: { channel_id: { type: "string" } } },
      zodSchema: getChannelInfoSchema,
      category: "social",
      riskLevel: "low",
      source: "youtube",
      handler: async (args) => callLocalServer(mgr, "yt_get_channel_info", args),
    },
    {
      name: "youtube-get-channel-videos",
      description: "Get recent videos from a YouTube channel.",
      inputSchema: { type: "object", properties: { channel_id: { type: "string" }, max_results: { type: "number" } } },
      zodSchema: getChannelVideosSchema,
      category: "social",
      riskLevel: "low",
      source: "youtube",
      handler: async (args) => callLocalServer(mgr, "yt_get_channel_videos", args),
    },
    {
      name: "youtube-get-video-details",
      description: "Get detailed info and statistics for a YouTube video.",
      inputSchema: { type: "object", properties: { video_id: { type: "string" } }, required: ["video_id"] },
      zodSchema: getVideoDetailsSchema,
      category: "social",
      riskLevel: "low",
      source: "youtube",
      handler: async (args) => callLocalServer(mgr, "yt_get_video_details", args),
    },
    {
      name: "youtube-get-video-comments",
      description: "Get comments on a YouTube video.",
      inputSchema: { type: "object", properties: { video_id: { type: "string" }, max_results: { type: "number" } }, required: ["video_id"] },
      zodSchema: getVideoCommentsSchema,
      category: "social",
      riskLevel: "low",
      source: "youtube",
      handler: async (args) => callLocalServer(mgr, "yt_get_video_comments", args),
    },
    {
      name: "youtube-reply-to-comment",
      description: "Reply to a comment on YouTube.",
      inputSchema: { type: "object", properties: { parent_comment_id: { type: "string" }, text: { type: "string" } }, required: ["parent_comment_id", "text"] },
      zodSchema: replyToCommentSchema,
      category: "social",
      riskLevel: "high",
      source: "youtube",
      handler: async (args) => callLocalServer(mgr, "yt_reply_to_comment", args),
    },
    {
      name: "youtube-search-videos",
      description: "Search for YouTube videos.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" } }, required: ["query"] },
      zodSchema: searchVideosSchema,
      category: "social",
      riskLevel: "low",
      source: "youtube",
      handler: async (args) => callLocalServer(mgr, "yt_search_videos", args),
    },
    {
      name: "youtube-get-channel-analytics",
      description: "Get YouTube channel analytics (views, subscribers, watch time).",
      inputSchema: { type: "object", properties: { start_date: { type: "string" }, end_date: { type: "string" } } },
      zodSchema: getChannelAnalyticsSchema,
      category: "social",
      riskLevel: "low",
      source: "youtube",
      handler: async (args) => callLocalServer(mgr, "yt_get_channel_analytics", args),
    },
  ];
};
