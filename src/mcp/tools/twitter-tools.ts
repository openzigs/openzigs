import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { LocalMcpServerManager } from "../local-mcp-server-manager.js";

type TwitterToolsOptions = {
  localServerManager?: LocalMcpServerManager;
};

const getMeSchema = z.object({});

const getUserTweetsSchema = z.object({
  user_id: z.string().describe("Twitter user ID"),
  max_results: z.number().min(5).max(100).optional(),
});

const searchTweetsSchema = z.object({
  query: z.string().describe("Search query (Twitter search syntax)"),
  max_results: z.number().min(10).max(100).optional(),
});

const getTweetSchema = z.object({
  tweet_id: z.string().describe("Tweet ID to fetch"),
});

const postTweetSchema = z.object({
  text: z.string().max(280).describe("Tweet text"),
  reply_to: z.string().optional().describe("Tweet ID to reply to"),
});

const getDmEventsSchema = z.object({
  max_results: z.number().min(1).max(100).optional(),
});

const sendDmSchema = z.object({
  participant_id: z.string().describe("Twitter user ID of recipient"),
  text: z.string().max(10000).describe("DM text"),
});

const getUserSchema = z.object({
  username: z.string().describe("Twitter username (without @)"),
});

const callLocalServer = async (
  manager: LocalMcpServerManager | undefined,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ text: string; isError?: boolean }> => {
  if (!manager) {
    return { text: "Local MCP server manager not configured.", isError: true };
  }
  if (!manager.isRunning("twitter")) {
    return { text: "Twitter MCP server is not running. Check TWITTER_BEARER_TOKEN env var.", isError: true };
  }
  return manager.callTool("twitter", toolName, args);
};

export const createTwitterTools = (options: TwitterToolsOptions): ToolDefinition[] => {
  const mgr = options.localServerManager;

  return [
    {
      name: "twitter-get-me",
      description: "Get authenticated Twitter/X user profile information.",
      inputSchema: { type: "object", properties: {} },
      zodSchema: getMeSchema,
      category: "social",
      riskLevel: "low",
      source: "twitter",
      handler: async (args) => callLocalServer(mgr, "twitter_get_me", args),
    },
    {
      name: "twitter-get-user-tweets",
      description: "Get recent tweets from a Twitter/X user.",
      inputSchema: { type: "object", properties: { user_id: { type: "string" }, max_results: { type: "number" } }, required: ["user_id"] },
      zodSchema: getUserTweetsSchema,
      category: "social",
      riskLevel: "low",
      source: "twitter",
      handler: async (args) => callLocalServer(mgr, "twitter_get_user_tweets", args),
    },
    {
      name: "twitter-search-tweets",
      description: "Search for tweets using Twitter/X search syntax.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" } }, required: ["query"] },
      zodSchema: searchTweetsSchema,
      category: "social",
      riskLevel: "low",
      source: "twitter",
      handler: async (args) => callLocalServer(mgr, "twitter_search_tweets", args),
    },
    {
      name: "twitter-get-tweet",
      description: "Get a specific tweet by ID with full details.",
      inputSchema: { type: "object", properties: { tweet_id: { type: "string" } }, required: ["tweet_id"] },
      zodSchema: getTweetSchema,
      category: "social",
      riskLevel: "low",
      source: "twitter",
      handler: async (args) => callLocalServer(mgr, "twitter_get_tweet", args),
    },
    {
      name: "twitter-post-tweet",
      description: "Post a tweet on Twitter/X. Supports replies.",
      inputSchema: { type: "object", properties: { text: { type: "string" }, reply_to: { type: "string" } }, required: ["text"] },
      zodSchema: postTweetSchema,
      category: "social",
      riskLevel: "high",
      source: "twitter",
      handler: async (args) => callLocalServer(mgr, "twitter_post_tweet", args),
    },
    {
      name: "twitter-get-dm-events",
      description: "Get recent Twitter/X direct message events.",
      inputSchema: { type: "object", properties: { max_results: { type: "number" } } },
      zodSchema: getDmEventsSchema,
      category: "social",
      riskLevel: "high",
      source: "twitter",
      handler: async (args) => callLocalServer(mgr, "twitter_get_dm_events", args),
    },
    {
      name: "twitter-send-dm",
      description: "Send a Twitter/X direct message.",
      inputSchema: { type: "object", properties: { participant_id: { type: "string" }, text: { type: "string" } }, required: ["participant_id", "text"] },
      zodSchema: sendDmSchema,
      category: "social",
      riskLevel: "high",
      source: "twitter",
      handler: async (args) => callLocalServer(mgr, "twitter_send_dm", args),
    },
    {
      name: "twitter-get-user",
      description: "Look up a Twitter/X user by username.",
      inputSchema: { type: "object", properties: { username: { type: "string" } }, required: ["username"] },
      zodSchema: getUserSchema,
      category: "social",
      riskLevel: "low",
      source: "twitter",
      handler: async (args) => callLocalServer(mgr, "twitter_get_user", args),
    },
  ];
};
