import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { LocalMcpServerManager } from "../local-mcp-server-manager.js";

type InstagramToolsOptions = {
  localServerManager?: LocalMcpServerManager;
};

const callLocalServer = async (
  manager: LocalMcpServerManager | undefined,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> => {
  if (!manager) {
    return { text: "Local MCP server manager not configured.", isError: true };
  }
  if (!manager.isRunning("instagram")) {
    return { text: "Instagram MCP server is not running. Check INSTAGRAM_ACCESS_TOKEN env var.", isError: true };
  }
  return manager.callTool("instagram", toolName, args);
};

export const createInstagramTools = (options: InstagramToolsOptions): ToolDefinition[] => {
  const mgr = options.localServerManager;

  return [
    {
      name: "get_profile_info",
      description: "Get Instagram business profile information including followers, bio, and account details.",
      inputSchema: {
        type: "object",
        properties: { account_id: { type: "string", description: "Instagram business account ID (optional)" } },
      },
      zodSchema: z.object({ account_id: z.string().optional() }),
      category: "social",
      riskLevel: "low",
      source: "instagram",
      handler: async (args) => callLocalServer(mgr, "get_profile_info", args),
    },
    {
      name: "get_media_posts",
      description: "Get recent media posts from Instagram account with engagement metrics.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string", description: "Instagram business account ID (optional)" },
          limit: { type: "integer", description: "Number of posts to retrieve (max 100)" },
          after: { type: "string", description: "Pagination cursor" },
        },
      },
      zodSchema: z.object({ account_id: z.string().optional(), limit: z.number().min(1).max(100).optional(), after: z.string().optional() }),
      category: "social",
      riskLevel: "low",
      source: "instagram",
      handler: async (args) => callLocalServer(mgr, "get_media_posts", args),
    },
    {
      name: "get_media_insights",
      description: "Get detailed insights and analytics for a specific Instagram post.",
      inputSchema: {
        type: "object",
        properties: {
          media_id: { type: "string", description: "Instagram media ID" },
          metrics: { type: "array", items: { type: "string" }, description: "Specific metrics to retrieve" },
        },
        required: ["media_id"],
      },
      zodSchema: z.object({ media_id: z.string(), metrics: z.array(z.string()).optional() }),
      category: "social",
      riskLevel: "low",
      source: "instagram",
      handler: async (args) => callLocalServer(mgr, "get_media_insights", args),
    },
    {
      name: "publish_media",
      description: "Upload and publish an image or video to Instagram with caption and optional location.",
      inputSchema: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "URL of the image to publish (must be publicly accessible)" },
          video_url: { type: "string", description: "URL of the video to publish (must be publicly accessible)" },
          caption: { type: "string", description: "Caption for the post" },
          location_id: { type: "string", description: "Facebook location ID for geotagging (optional)" },
        },
      },
      zodSchema: z.object({
        image_url: z.string().optional(),
        video_url: z.string().optional(),
        caption: z.string().optional(),
        location_id: z.string().optional(),
      }),
      category: "social",
      riskLevel: "high",
      source: "instagram",
      handler: async (args) => callLocalServer(mgr, "publish_media", args),
    },
    {
      name: "get_account_pages",
      description: "Get Facebook pages connected to the account and their Instagram business accounts.",
      inputSchema: { type: "object", properties: {} },
      zodSchema: z.object({}),
      category: "social",
      riskLevel: "low",
      source: "instagram",
      handler: async (args) => callLocalServer(mgr, "get_account_pages", args),
    },
    {
      name: "get_account_insights",
      description: "Get account-level insights and analytics for Instagram business account.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string", description: "Instagram business account ID (optional)" },
          metrics: { type: "array", items: { type: "string" }, description: "Specific metrics to retrieve" },
          period: { type: "string", enum: ["day", "lifetime"], description: "Time period for insights" },
        },
      },
      zodSchema: z.object({ account_id: z.string().optional(), metrics: z.array(z.string()).optional(), period: z.enum(["day", "lifetime"]).optional() }),
      category: "social",
      riskLevel: "low",
      source: "instagram",
      handler: async (args) => callLocalServer(mgr, "get_account_insights", args),
    },
    {
      name: "validate_access_token",
      description: "Validate the Instagram API access token and check permissions.",
      inputSchema: { type: "object", properties: {} },
      zodSchema: z.object({}),
      category: "social",
      riskLevel: "low",
      source: "instagram",
      handler: async (args) => callLocalServer(mgr, "validate_access_token", args),
    },
    {
      name: "get_conversations",
      description: "Get Instagram DM conversations. Requires instagram_manage_messages permission.",
      inputSchema: {
        type: "object",
        properties: {
          page_id: { type: "string", description: "Facebook page ID (optional, auto-detected)" },
          limit: { type: "integer", description: "Number of conversations (max 100)" },
        },
      },
      zodSchema: z.object({ page_id: z.string().optional(), limit: z.number().min(1).max(100).optional() }),
      category: "social",
      riskLevel: "low",
      source: "instagram",
      handler: async (args) => callLocalServer(mgr, "get_conversations", args),
    },
    {
      name: "get_conversation_messages",
      description: "Get messages from a specific Instagram DM conversation.",
      inputSchema: {
        type: "object",
        properties: {
          conversation_id: { type: "string", description: "Instagram conversation ID" },
          limit: { type: "integer", description: "Number of messages (max 100)" },
        },
        required: ["conversation_id"],
      },
      zodSchema: z.object({ conversation_id: z.string(), limit: z.number().min(1).max(100).optional() }),
      category: "social",
      riskLevel: "low",
      source: "instagram",
      handler: async (args) => callLocalServer(mgr, "get_conversation_messages", args),
    },
    {
      name: "reply_to_comment",
      description: "Reply to an Instagram comment on one of your posts.",
      inputSchema: {
        type: "object",
        properties: {
          comment_id: { type: "string", description: "Instagram comment ID to reply to" },
          message: { type: "string", description: "Reply text (max 2200 characters)" },
        },
        required: ["comment_id", "message"],
      },
      zodSchema: z.object({ comment_id: z.string(), message: z.string().max(2200) }),
      category: "social",
      riskLevel: "high",
      source: "instagram",
      handler: async (args) => callLocalServer(mgr, "reply_to_comment", args),
    },
    {
      name: "get_media_comments",
      description: "Get comments on a specific Instagram post.",
      inputSchema: {
        type: "object",
        properties: {
          media_id: { type: "string", description: "Instagram media ID" },
          limit: { type: "integer", description: "Number of comments (max 100)" },
        },
        required: ["media_id"],
      },
      zodSchema: z.object({ media_id: z.string(), limit: z.number().min(1).max(100).optional() }),
      category: "social",
      riskLevel: "low",
      source: "instagram",
      handler: async (args) => callLocalServer(mgr, "get_media_comments", args),
    },
    {
      name: "send_dm",
      description: "Send Instagram direct message. Requires instagram_manage_messages with Advanced Access. Can only reply within 24h of user's last message.",
      inputSchema: {
        type: "object",
        properties: {
          recipient_id: { type: "string", description: "Instagram Scoped User ID (IGSID)" },
          message: { type: "string", description: "Message text (max 1000 characters)" },
        },
        required: ["recipient_id", "message"],
      },
      zodSchema: z.object({ recipient_id: z.string(), message: z.string().max(1000) }),
      category: "social",
      riskLevel: "high",
      source: "instagram",
      handler: async (args) => callLocalServer(mgr, "send_dm", args),
    },
  ];
};
