import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { LocalMcpServerManager } from "../local-mcp-server-manager.js";

type RedditToolsOptions = {
  localServerManager?: LocalMcpServerManager;
};

const getMeSchema = z.object({});

const getSubredditPostsSchema = z.object({
  subreddit: z.string().describe("Subreddit name (without r/)"),
  sort: z.enum(["hot", "new", "top", "rising"]).optional(),
  limit: z.number().min(1).max(100).optional(),
});

const getPostCommentsSchema = z.object({
  post_id: z.string().describe("Reddit post ID (e.g., t3_xxx or just the ID)"),
  limit: z.number().min(1).max(100).optional(),
});

const submitPostSchema = z.object({
  subreddit: z.string().describe("Subreddit to post to"),
  title: z.string().max(300).describe("Post title"),
  text: z.string().optional().describe("Post body (for self/text posts)"),
  url: z.string().url().optional().describe("URL (for link posts)"),
});

const replyToCommentSchema = z.object({
  comment_id: z.string().describe("Reddit comment fullname (t1_xxx)"),
  text: z.string().describe("Reply text (Markdown supported)"),
});

const searchSchema = z.object({
  query: z.string().describe("Search query"),
  subreddit: z.string().optional().describe("Limit search to subreddit"),
  sort: z.enum(["relevance", "hot", "top", "new", "comments"]).optional(),
  limit: z.number().min(1).max(100).optional(),
});

const getInboxSchema = z.object({
  limit: z.number().min(1).max(100).optional(),
});

const sendMessageSchema = z.object({
  to: z.string().describe("Reddit username (without u/)"),
  subject: z.string().max(100).describe("Message subject"),
  text: z.string().describe("Message body (Markdown supported)"),
});

const callLocalServer = async (
  manager: LocalMcpServerManager | undefined,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ text: string; isError?: boolean }> => {
  if (!manager) {
    return { text: "Local MCP server manager not configured.", isError: true };
  }
  if (!manager.isRunning("reddit")) {
    return { text: "Reddit MCP server is not running. Check REDDIT_CLIENT_ID env var.", isError: true };
  }
  return manager.callTool("reddit", toolName, args);
};

export const createRedditTools = (options: RedditToolsOptions): ToolDefinition[] => {
  const mgr = options.localServerManager;

  return [
    {
      name: "reddit-get-me",
      description: "Get authenticated Reddit user profile.",
      inputSchema: { type: "object", properties: {} },
      zodSchema: getMeSchema,
      category: "social",
      riskLevel: "low",
      source: "reddit",
      handler: async (args) => callLocalServer(mgr, "reddit_get_me", args),
    },
    {
      name: "reddit-get-subreddit-posts",
      description: "Get posts from a subreddit with sort options.",
      inputSchema: { type: "object", properties: { subreddit: { type: "string" }, sort: { type: "string" }, limit: { type: "number" } }, required: ["subreddit"] },
      zodSchema: getSubredditPostsSchema,
      category: "social",
      riskLevel: "low",
      source: "reddit",
      handler: async (args) => callLocalServer(mgr, "reddit_get_subreddit_posts", args),
    },
    {
      name: "reddit-get-post-comments",
      description: "Get comments on a Reddit post.",
      inputSchema: { type: "object", properties: { post_id: { type: "string" }, limit: { type: "number" } }, required: ["post_id"] },
      zodSchema: getPostCommentsSchema,
      category: "social",
      riskLevel: "low",
      source: "reddit",
      handler: async (args) => callLocalServer(mgr, "reddit_get_post_comments", args),
    },
    {
      name: "reddit-submit-post",
      description: "Submit a new post to a subreddit.",
      inputSchema: { type: "object", properties: { subreddit: { type: "string" }, title: { type: "string" }, text: { type: "string" }, url: { type: "string" } }, required: ["subreddit", "title"] },
      zodSchema: submitPostSchema,
      category: "social",
      riskLevel: "high",
      source: "reddit",
      handler: async (args) => callLocalServer(mgr, "reddit_submit_post", args),
    },
    {
      name: "reddit-reply-to-comment",
      description: "Reply to a Reddit comment.",
      inputSchema: { type: "object", properties: { comment_id: { type: "string" }, text: { type: "string" } }, required: ["comment_id", "text"] },
      zodSchema: replyToCommentSchema,
      category: "social",
      riskLevel: "high",
      source: "reddit",
      handler: async (args) => callLocalServer(mgr, "reddit_reply_to_comment", args),
    },
    {
      name: "reddit-search",
      description: "Search Reddit posts and comments.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, subreddit: { type: "string" }, sort: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
      zodSchema: searchSchema,
      category: "social",
      riskLevel: "low",
      source: "reddit",
      handler: async (args) => callLocalServer(mgr, "reddit_search", args),
    },
    {
      name: "reddit-get-inbox",
      description: "Get Reddit inbox messages.",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
      zodSchema: getInboxSchema,
      category: "social",
      riskLevel: "high",
      source: "reddit",
      handler: async (args) => callLocalServer(mgr, "reddit_get_inbox", args),
    },
    {
      name: "reddit-send-message",
      description: "Send a private message to a Reddit user.",
      inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, text: { type: "string" } }, required: ["to", "subject", "text"] },
      zodSchema: sendMessageSchema,
      category: "social",
      riskLevel: "high",
      source: "reddit",
      handler: async (args) => callLocalServer(mgr, "reddit_send_message", args),
    },
  ];
};
