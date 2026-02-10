import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import { markdownToSocialText } from "../../channels/social-formatter.js";

/**
 * Social media MCP tools connect to external Python sidecar MCP servers
 * running in Docker containers. These tools proxy requests to the sidecars.
 */

type SocialMediaOptions = {
  linkedinSidecarUrl?: string;
  twitterSidecarUrl?: string;
  facebookSidecarUrl?: string;
  pinterestSidecarUrl?: string;
};

const postContentSchema = z.object({
  platform: z.enum(["linkedin", "twitter", "facebook", "pinterest"]),
  content: z.string(),
  mediaUrls: z.array(z.string()).optional(),
  scheduledFor: z.string().optional(),
});

const getTimelineSchema = z.object({
  platform: z.enum(["linkedin", "twitter", "facebook", "pinterest"]),
  count: z.number().optional(),
});

const getProfileSchema = z.object({
  platform: z.enum(["linkedin", "twitter", "facebook", "pinterest"]),
  username: z.string().optional(),
});

const pinterestBoardsSchema = z.object({
  action: z.enum(["list", "create", "get"]),
  boardId: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  privacy: z.enum(["PUBLIC", "PROTECTED", "SECRET"]).optional(),
  pageSize: z.number().optional(),
});

const pinterestPinsSchema = z.object({
  action: z.enum(["list", "create", "get"]),
  pinId: z.string().optional(),
  boardId: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  link: z.string().optional(),
  imageUrl: z.string().optional(),
  altText: z.string().optional(),
  pageSize: z.number().optional(),
});

const callSidecar = async (
  baseUrl: string | undefined,
  method: string,
  params: Record<string, unknown>
): Promise<{ text: string; isError?: boolean }> => {
  if (!baseUrl) {
    return {
      text: "Social media sidecar not configured. Set the sidecar URL in environment variables.",
      isError: true,
    };
  }

  try {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { text: `Sidecar error: ${errorText}`, isError: true };
    }

    const result = await response.json() as { result?: string };
    return { text: result.result ?? JSON.stringify(result) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `Failed to reach sidecar: ${message}`, isError: true };
  }
};

const getSidecarUrl = (
  platform: string,
  options: SocialMediaOptions
): string | undefined => {
  switch (platform) {
    case "linkedin":
      return options.linkedinSidecarUrl;
    case "twitter":
      return options.twitterSidecarUrl;
    case "facebook":
      return options.facebookSidecarUrl;
    case "pinterest":
      return options.pinterestSidecarUrl;
    default:
      return undefined;
  }
};

export const createSocialMediaTools = (options: SocialMediaOptions): ToolDefinition[] => {
  return [
    {
      name: "social-post",
      description:
        "Post content to a social media platform (LinkedIn, Twitter/X, or Facebook) via MCP sidecar. " +
        "If the input content is Markdown, it will be automatically converted to platform-safe plain text " +
        "before posting: **bold** → Unicode bold, *italic* → Unicode italic, [text](url) → text (url), " +
        "# Heading → HEADING (bold uppercase), - list → • list, > quote → ❝quote❞. " +
        "Do NOT include raw Markdown syntax in the posted text.",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["linkedin", "twitter", "facebook", "pinterest"],
          },
          content: { type: "string" },
          mediaUrls: { type: "array", items: { type: "string" } },
          scheduledFor: { type: "string" },
        },
        required: ["platform", "content"],
      },
      zodSchema: postContentSchema,
      category: "social",
      riskLevel: "high",
      source: "social",
      handler: async (args) => {
        const input = args as z.infer<typeof postContentSchema>;
        const url = getSidecarUrl(input.platform, options);
        const safeContent = markdownToSocialText(input.content);
        return callSidecar(url, "post_content", { ...input, content: safeContent });
      },
    },
    {
      name: "social-timeline",
      description:
        "Get recent posts from a social media timeline (LinkedIn, Twitter/X, or Facebook)",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["linkedin", "twitter", "facebook", "pinterest"],
          },
          count: { type: "number" },
        },
        required: ["platform"],
      },
      zodSchema: getTimelineSchema,
      category: "social",
      riskLevel: "medium",
      source: "social",
      handler: async (args) => {
        const input = args as z.infer<typeof getTimelineSchema>;
        const url = getSidecarUrl(input.platform, options);
        return callSidecar(url, "get_timeline", input);
      },
    },
    {
      name: "social-profile",
      description: "Get profile information from a social media platform",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["linkedin", "twitter", "facebook", "pinterest"],
          },
          username: { type: "string" },
        },
        required: ["platform"],
      },
      zodSchema: getProfileSchema,
      category: "social",
      riskLevel: "low",
      source: "social",
      handler: async (args) => {
        const input = args as z.infer<typeof getProfileSchema>;
        const url = getSidecarUrl(input.platform, options);
        return callSidecar(url, "get_profile", input);
      },
    },
    // ── Pinterest-specific tools ──
    {
      name: "pinterest-boards",
      description:
        "Manage Pinterest boards: list all boards, create a new board, or get details of a specific board",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "create", "get"],
          },
          boardId: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          privacy: {
            type: "string",
            enum: ["PUBLIC", "PROTECTED", "SECRET"],
          },
          pageSize: { type: "number" },
        },
        required: ["action"],
      },
      zodSchema: pinterestBoardsSchema,
      category: "social",
      riskLevel: "medium",
      source: "pinterest",
      handler: async (args) => {
        const input = args as z.infer<typeof pinterestBoardsSchema>;
        const url = options.pinterestSidecarUrl;
        const methodMap: Record<string, string> = {
          list: "pinterest_boards_list",
          create: "pinterest_boards_create",
          get: "pinterest_boards_get",
        };
        return callSidecar(url, methodMap[input.action] ?? input.action, input);
      },
    },
    {
      name: "pinterest-pins",
      description:
        "Manage Pinterest pins: list pins on a board, create a new pin, or get details of a specific pin",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "create", "get"],
          },
          pinId: { type: "string" },
          boardId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          link: { type: "string" },
          imageUrl: { type: "string" },
          altText: { type: "string" },
          pageSize: { type: "number" },
        },
        required: ["action"],
      },
      zodSchema: pinterestPinsSchema,
      category: "social",
      riskLevel: "medium",
      source: "pinterest",
      handler: async (args) => {
        const input = args as z.infer<typeof pinterestPinsSchema>;
        const url = options.pinterestSidecarUrl;
        const methodMap: Record<string, string> = {
          list: "pinterest_pins_list",
          create: "pinterest_pins_create",
          get: "pinterest_pins_get",
        };
        return callSidecar(url, methodMap[input.action] ?? input.action, input);
      },
    },
  ];
};
