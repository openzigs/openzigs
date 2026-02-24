import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { LocalMcpServerManager } from "../local-mcp-server-manager.js";

type InstagramToolsOptions = {
  localServerManager?: LocalMcpServerManager;
};

// ── Schemas ──

const getProfileSchema = z.object({
  account_id: z.string().optional().describe("Instagram business account ID (optional, uses configured account if not provided)"),
});

const getMediaPostsSchema = z.object({
  account_id: z.string().optional().describe("Instagram business account ID (optional)"),
  limit: z.number().min(1).max(100).optional().describe("Number of posts to retrieve (max 100)"),
  after: z.string().optional().describe("Pagination cursor for getting posts after a specific point"),
});

const getMediaInsightsSchema = z.object({
  media_id: z.string().describe("Instagram media ID to get insights for"),
  metrics: z.array(z.enum([
    "reach",
    "likes",
    "comments",
    "shares",
    "saved",
    "video_views",
  ])).optional().describe("Specific metrics to retrieve"),
});

const publishMediaSchema = z.object({
  image_url: z.string().url().optional().describe("URL of the image to publish"),
  video_url: z.string().url().optional().describe("URL of the video to publish"),
  caption: z.string().optional().describe("Caption for the post"),
  location_id: z.string().optional().describe("Facebook location ID for geotagging"),
}).refine(data => data.image_url || data.video_url, {
  message: "Either image_url or video_url is required",
});

const getAccountPagesSchema = z.object({});

const getAccountInsightsSchema = z.object({
  account_id: z.string().optional().describe("Instagram business account ID (optional)"),
  metrics: z.array(z.enum([
    "reach",
    "profile_views",
    "website_clicks",
    "accounts_engaged",
  ])).optional(),
  period: z.enum(["day", "lifetime"]).optional().describe("Time period for insights"),
});

const getConversationsSchema = z.object({
  page_id: z.string().optional().describe("Facebook page ID"),
  limit: z.number().min(1).max(100).optional(),
});

const getConversationMessagesSchema = z.object({
  conversation_id: z.string().describe("Instagram conversation ID"),
  limit: z.number().min(1).max(100).optional(),
});

const sendDmSchema = z.object({
  recipient_id: z.string().describe("Instagram Scoped User ID (IGSID) of recipient"),
  message: z.string().max(1000).describe("Message text to send"),
});

const replyToCommentSchema = z.object({
  comment_id: z.string().describe("Instagram comment ID to reply to"),
  message: z.string().max(2200).describe("Reply text"),
});

const getMediaCommentsSchema = z.object({
  media_id: z.string().describe("Instagram media ID"),
  limit: z.number().min(1).max(100).optional().describe("Number of comments to retrieve (max 100)"),
});

// ── Helper ──

const callLocalServer = async (
  manager: LocalMcpServerManager | undefined,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ text: string; isError?: boolean }> => {
  if (!manager) {
    return {
      text: `Local MCP server manager not configured. Cannot call tool "${toolName}".`,
      isError: true,
    };
  }

  if (!manager.isRunning("instagram")) {
    return {
      text: `Instagram MCP server is not running. Check environment variables (INSTAGRAM_ACCESS_TOKEN, FACEBOOK_APP_ID, etc.).`,
      isError: true,
    };
  }

  return manager.callTool("instagram", toolName, args);
};

// ── Factory ──

export const createInstagramTools = (
  options: InstagramToolsOptions
): ToolDefinition[] => {
  const mgr = options.localServerManager;

  return [
    {
      name: "instagram-get-profile",
      description: "Get Instagram business profile information including followers, bio, and account details.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
        },
      },
      zodSchema: getProfileSchema,
      category: "social",
      riskLevel: "low",
      source: "instagram",
      handler: async (args) => {
        return callLocalServer(mgr, "get_profile_info", args);
      },
    },
    {
      name: "instagram-get-posts",
      description: "Get recent media posts from an Instagram account with engagement metrics.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { type: "number" },
          after: { type: "string" },
        },
      },
      zodSchema: getMediaPostsSchema,
      category: "social",
      riskLevel: "low",
      source: "instagram",
      handler: async (args) => {
        return callLocalServer(mgr, "get_media_posts", args);
      },
    },
    {
      name: "instagram-get-media-insights",
      description: "Get detailed insights and analytics for a specific Instagram post.",
      inputSchema: {
        type: "object",
        properties: {
          media_id: { type: "string" },
          metrics: { type: "array", items: { type: "string" } },
        },
        required: ["media_id"],
      },
      zodSchema: getMediaInsightsSchema,
      category: "social",
      riskLevel: "low",
      source: "instagram",
      handler: async (args) => {
        return callLocalServer(mgr, "get_media_insights", args);
      },
    },
    {
      name: "instagram-publish-media",
      description: "Upload and publish an image or video to Instagram with caption.",
      inputSchema: {
        type: "object",
        properties: {
          image_url: { type: "string" },
          video_url: { type: "string" },
          caption: { type: "string" },
          location_id: { type: "string" },
        },
      },
      zodSchema: publishMediaSchema,
      category: "social",
      riskLevel: "high",
      source: "instagram",
      handler: async (args) => {
        return callLocalServer(mgr, "publish_media", args);
      },
    },
    {
      name: "instagram-get-pages",
      description: "Get Facebook pages connected to the account.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      zodSchema: getAccountPagesSchema,
      category: "social",
      riskLevel: "low",
      source: "instagram",
      handler: async (args) => {
        return callLocalServer(mgr, "get_account_pages", args);
      },
    },
    {
      name: "instagram-get-account-insights",
      description: "Get account-level insights and analytics.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          metrics: { type: "array", items: { type: "string" } },
          period: { type: "string" },
        },
      },
      zodSchema: getAccountInsightsSchema,
      category: "social",
      riskLevel: "low",
      source: "instagram",
      handler: async (args) => {
        return callLocalServer(mgr, "get_account_insights", args);
      },
    },
    {
      name: "instagram-get-conversations",
      description: "Get Instagram DM conversations. Requires permission.",
      inputSchema: {
        type: "object",
        properties: {
          page_id: { type: "string" },
          limit: { type: "number" },
        },
      },
      zodSchema: getConversationsSchema,
      category: "social",
      riskLevel: "high",
      source: "instagram",
      handler: async (args) => {
        return callLocalServer(mgr, "get_conversations", args);
      },
    },
    {
      name: "instagram-get-messages",
      description: "Get messages from a specific conversation.",
      inputSchema: {
        type: "object",
        properties: {
          conversation_id: { type: "string" },
          limit: { type: "number" },
        },
        required: ["conversation_id"],
      },
      zodSchema: getConversationMessagesSchema,
      category: "social",
      riskLevel: "high",
      source: "instagram",
      handler: async (args) => {
        return callLocalServer(mgr, "get_conversation_messages", args);
      },
    },
    {
      name: "instagram-send-dm",
      description: "Send Instagram direct message. Requires Advanced Access.",
      inputSchema: {
        type: "object",
        properties: {
          recipient_id: { type: "string" },
          message: { type: "string" },
        },
        required: ["recipient_id", "message"],
      },
      zodSchema: sendDmSchema,
      category: "social",
      riskLevel: "high",
      source: "instagram",
      handler: async (args) => {
        return callLocalServer(mgr, "send_dm", args);
      },
    },
    {
      name: "instagram-reply-to-comment",
      description: "Reply to a comment on an Instagram post. Requires instagram_manage_comments permission.",
      inputSchema: {
        type: "object",
        properties: {
          comment_id: { type: "string" },
          message: { type: "string" },
        },
        required: ["comment_id", "message"],
      },
      zodSchema: replyToCommentSchema,
      category: "social",
      riskLevel: "medium",
      source: "instagram",
      handler: async (args) => {
        return callLocalServer(mgr, "reply_to_comment", args);
      },
    },
    {
      name: "instagram-get-media-comments",
      description: "Get comments on a specific Instagram post.",
      inputSchema: {
        type: "object",
        properties: {
          media_id: { type: "string" },
          limit: { type: "number" },
        },
        required: ["media_id"],
      },
      zodSchema: getMediaCommentsSchema,
      category: "social",
      riskLevel: "low",
      source: "instagram",
      handler: async (args) => {
        return callLocalServer(mgr, "get_media_comments", args);
      },
    },
  ];
};
