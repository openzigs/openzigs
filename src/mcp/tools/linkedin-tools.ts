import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { LocalMcpServerManager } from "../local-mcp-server-manager.js";

type LinkedInToolsOptions = {
  localServerManager?: LocalMcpServerManager;
};

const getProfileSchema = z.object({});

const getPostsSchema = z.object({
  count: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of posts (default: 20)"),
});

const createPostSchema = z.object({
  text: z.string().max(3000).describe("Post text content"),
  visibility: z.enum(["PUBLIC", "CONNECTIONS"]).optional(),
});

const getCompanySchema = z.object({
  company_id: z.string().describe("LinkedIn company/organization ID"),
});

const sendMessageSchema = z.object({
  recipient_urn: z.string().describe("LinkedIn member URN (urn:li:person:xxx)"),
  subject: z.string().optional().describe("Message subject"),
  body: z.string().max(8000).describe("Message body text"),
});

const getConversationsSchema = z.object({
  count: z.number().min(1).max(50).optional(),
});

const getPostCommentsSchema = z.object({
  post_urn: z
    .string()
    .describe("Post URN (e.g. urn:li:share:xxx or urn:li:ugcPost:xxx)"),
  count: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of comments (default: 20)"),
});

const replyToCommentSchema = z.object({
  post_urn: z.string().describe("Post URN"),
  comment_urn: z.string().describe("Comment URN to reply to"),
  text: z.string().max(3000).describe("Reply text"),
});

const postAnalyticsSchema = z.object({
  post_urn: z
    .string()
    .describe("Post URN (urn:li:share:xxx or urn:li:ugcPost:xxx)"),
});

const profileAnalyticsSchema = z.object({
  organization_id: z
    .string()
    .optional()
    .describe(
      "Organization ID for org-level analytics. Omit for member profile.",
    ),
});

const callLocalServer = async (
  manager: LocalMcpServerManager | undefined,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> => {
  if (!manager) {
    return { text: "Local MCP server manager not configured.", isError: true };
  }
  if (!manager.isRunning("linkedin")) {
    return {
      text: "LinkedIn MCP server is not running. Check LINKEDIN_ACCESS_TOKEN env var.",
      isError: true,
    };
  }
  return manager.callTool("linkedin", toolName, args);
};

export const createLinkedInTools = (
  options: LinkedInToolsOptions,
): ToolDefinition[] => {
  const mgr = options.localServerManager;

  return [
    {
      name: "linkedin-get-profile",
      description: "Get authenticated LinkedIn user profile information.",
      inputSchema: { type: "object", properties: {} },
      zodSchema: getProfileSchema,
      category: "social",
      riskLevel: "low",
      source: "linkedin",
      handler: async (args) =>
        callLocalServer(mgr, "linkedin_get_profile", args),
    },
    {
      name: "linkedin-get-posts",
      description: "Get recent LinkedIn posts from the authenticated user.",
      inputSchema: {
        type: "object",
        properties: { count: { type: "number" } },
      },
      zodSchema: getPostsSchema,
      category: "social",
      riskLevel: "low",
      source: "linkedin",
      handler: async (args) => callLocalServer(mgr, "linkedin_get_posts", args),
    },
    {
      name: "linkedin-create-post",
      description: "Create and publish a post on LinkedIn.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          visibility: { type: "string" },
        },
        required: ["text"],
      },
      zodSchema: createPostSchema,
      category: "social",
      riskLevel: "high",
      source: "linkedin",
      handler: async (args) =>
        callLocalServer(mgr, "linkedin_create_post", args),
    },
    {
      name: "linkedin-get-company",
      description: "Get LinkedIn company/organization page details.",
      inputSchema: {
        type: "object",
        properties: { company_id: { type: "string" } },
        required: ["company_id"],
      },
      zodSchema: getCompanySchema,
      category: "social",
      riskLevel: "low",
      source: "linkedin",
      handler: async (args) =>
        callLocalServer(mgr, "linkedin_get_company", args),
    },
    {
      name: "linkedin-send-message",
      description: "Send a LinkedIn direct message to a connection.",
      inputSchema: {
        type: "object",
        properties: {
          recipient_urn: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["recipient_urn", "body"],
      },
      zodSchema: sendMessageSchema,
      category: "social",
      riskLevel: "high",
      source: "linkedin",
      handler: async (args) =>
        callLocalServer(mgr, "linkedin_send_message", args),
    },
    {
      name: "linkedin-get-conversations",
      description: "Get recent LinkedIn messaging conversations.",
      inputSchema: {
        type: "object",
        properties: { count: { type: "number" } },
      },
      zodSchema: getConversationsSchema,
      category: "social",
      riskLevel: "high",
      source: "linkedin",
      handler: async (args) =>
        callLocalServer(mgr, "linkedin_get_conversations", args),
    },
    {
      name: "linkedin-get-post-comments",
      description: "Get comments on a LinkedIn post.",
      inputSchema: {
        type: "object",
        properties: { post_urn: { type: "string" }, count: { type: "number" } },
        required: ["post_urn"],
      },
      zodSchema: getPostCommentsSchema,
      category: "social",
      riskLevel: "low",
      source: "linkedin",
      handler: async (args) =>
        callLocalServer(mgr, "linkedin_get_post_comments", args),
    },
    {
      name: "linkedin-reply-to-comment",
      description: "Reply to a comment on a LinkedIn post.",
      inputSchema: {
        type: "object",
        properties: {
          post_urn: { type: "string" },
          comment_urn: { type: "string" },
          text: { type: "string" },
        },
        required: ["post_urn", "comment_urn", "text"],
      },
      zodSchema: replyToCommentSchema,
      category: "social",
      riskLevel: "high",
      source: "linkedin",
      handler: async (args) =>
        callLocalServer(mgr, "linkedin_reply_to_comment", args),
    },
    {
      name: "linkedin-post-analytics",
      description:
        "Get analytics for a LinkedIn post (impressions, clicks, likes, comments, shares, engagement rate). Only available for organization-owned posts where the app has rw_organization_admin scope.",
      inputSchema: {
        type: "object",
        properties: { post_urn: { type: "string" } },
        required: ["post_urn"],
      },
      zodSchema: postAnalyticsSchema,
      category: "social",
      riskLevel: "low",
      source: "linkedin",
      handler: async (args) =>
        callLocalServer(mgr, "linkedin_post_analytics", args),
    },
    {
      name: "linkedin-profile-analytics",
      description:
        "Get profile/page-level analytics (follower count, follower growth, page views). Organization-level analytics require organization_id and rw_organization_admin scope; member analytics are limited by LinkedIn API tier.",
      inputSchema: {
        type: "object",
        properties: { organization_id: { type: "string" } },
      },
      zodSchema: profileAnalyticsSchema,
      category: "social",
      riskLevel: "low",
      source: "linkedin",
      handler: async (args) =>
        callLocalServer(mgr, "linkedin_profile_analytics", args),
    },
  ];
};
