import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";

/**
 * Social media MCP tools connect to external Python sidecar MCP servers
 * running in Docker containers. These tools proxy requests to the sidecars.
 */

type SocialMediaOptions = {
  linkedinSidecarUrl?: string;
  twitterSidecarUrl?: string;
  facebookSidecarUrl?: string;
};

const postContentSchema = z.object({
  platform: z.enum(["linkedin", "twitter", "facebook"]),
  content: z.string(),
  mediaUrls: z.array(z.string()).optional(),
  scheduledFor: z.string().optional(),
});

const getTimelineSchema = z.object({
  platform: z.enum(["linkedin", "twitter", "facebook"]),
  count: z.number().optional(),
});

const getProfileSchema = z.object({
  platform: z.enum(["linkedin", "twitter", "facebook"]),
  username: z.string().optional(),
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
    default:
      return undefined;
  }
};

export const createSocialMediaTools = (options: SocialMediaOptions): ToolDefinition[] => {
  return [
    {
      name: "social-post",
      description:
        "Post content to a social media platform (LinkedIn, Twitter/X, or Facebook) via MCP sidecar",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["linkedin", "twitter", "facebook"],
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
      handler: async (args) => {
        const input = args as z.infer<typeof postContentSchema>;
        const url = getSidecarUrl(input.platform, options);
        return callSidecar(url, "post_content", input);
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
            enum: ["linkedin", "twitter", "facebook"],
          },
          count: { type: "number" },
        },
        required: ["platform"],
      },
      zodSchema: getTimelineSchema,
      category: "social",
      riskLevel: "medium",
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
            enum: ["linkedin", "twitter", "facebook"],
          },
          username: { type: "string" },
        },
        required: ["platform"],
      },
      zodSchema: getProfileSchema,
      category: "social",
      riskLevel: "low",
      handler: async (args) => {
        const input = args as z.infer<typeof getProfileSchema>;
        const url = getSidecarUrl(input.platform, options);
        return callSidecar(url, "get_profile", input);
      },
    },
  ];
};
