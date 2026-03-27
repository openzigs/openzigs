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
  order: z.enum(["date", "rating", "relevance", "title", "viewCount"]).optional().describe("Sort order (default: relevance)"),
});

const getChannelAnalyticsSchema = z.object({
  start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
  end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
});

const uploadVideoSchema = z.object({
  file_path: z.string().describe("Absolute path to the video file on disk"),
  title: z.string().max(100).describe("Video title (max 100 characters)"),
  description: z.string().max(5000).optional().describe("Video description (max 5000 characters)"),
  tags: z.array(z.string()).optional().describe("Keyword tags for the video"),
  category_id: z.string().optional().describe("YouTube category ID (default: '22' = People & Blogs)"),
  privacy_status: z.enum(["public", "unlisted", "private"]).optional().describe("Video privacy (default: 'private')"),
  notify_subscribers: z.boolean().optional().describe("Notify channel subscribers (default: true)"),
});

const checkVideoExistsSchema = z.object({
  video_id: z.string().describe("YouTube video ID to check"),
});

const uploadCaptionsSchema = z.object({
  video_id: z.string().describe("YouTube video ID"),
  language: z.string().optional().describe("Caption language code (default: 'en')"),
  caption_name: z.string().optional().describe("Caption track name (default: 'English')"),
  srt_content: z.string().describe("SRT subtitle content"),
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
      inputSchema: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" }, order: { type: "string", enum: ["date", "rating", "relevance", "title", "viewCount"], description: "Sort order (default: relevance)" } }, required: ["query"] },
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
    {
      name: "youtube-upload-video",
      description:
        "Upload a video file to YouTube. Requires OAuth2 with youtube.upload scope. " +
        "The file must exist on the server filesystem. Costs 1600 quota units per upload " +
        "(~6 uploads/day with default 10k daily quota). Max file size: 256 GB.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the video file" },
          title: { type: "string", description: "Video title (max 100 chars)" },
          description: { type: "string", description: "Video description (max 5000 chars)" },
          tags: { type: "array", items: { type: "string" }, description: "Keyword tags" },
          category_id: { type: "string", description: "YouTube category ID (default '22')" },
          privacy_status: { type: "string", enum: ["public", "unlisted", "private"], description: "Privacy status" },
          notify_subscribers: { type: "boolean", description: "Notify subscribers (default true)" },
        },
        required: ["file_path", "title"],
      },
      zodSchema: uploadVideoSchema,
      category: "social",
      riskLevel: "high",
      source: "youtube",
      handler: async (args) => callLocalServer(mgr, "yt_upload_video", args),
    },
    {
      name: "youtube-check-video-exists",
      description: "Check if a YouTube video still exists (not deleted/removed). Costs 1 quota unit.",
      inputSchema: {
        type: "object",
        properties: { video_id: { type: "string", description: "YouTube video ID to check" } },
        required: ["video_id"],
      },
      zodSchema: checkVideoExistsSchema,
      category: "social",
      riskLevel: "low",
      source: "youtube",
      handler: async (args) => callLocalServer(mgr, "yt_check_video_exists", args),
    },
    {
      name: "youtube-upload-captions",
      description:
        "Upload SRT captions/subtitles to a YouTube video. Costs 400 quota units. " +
        "Video must be fully processed before captions can be uploaded.",
      inputSchema: {
        type: "object",
        properties: {
          video_id: { type: "string", description: "YouTube video ID" },
          language: { type: "string", description: "Caption language code (default 'en')" },
          caption_name: { type: "string", description: "Caption track name (default 'English')" },
          srt_content: { type: "string", description: "SRT subtitle content" },
        },
        required: ["video_id", "srt_content"],
      },
      zodSchema: uploadCaptionsSchema,
      category: "social",
      riskLevel: "high",
      source: "youtube",
      handler: async (args) => callLocalServer(mgr, "yt_upload_captions", args),
    },
  ];
};
