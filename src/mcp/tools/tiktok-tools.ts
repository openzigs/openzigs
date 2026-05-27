import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { LocalMcpServerManager } from "../local-mcp-server-manager.js";

type TikTokToolsOptions = {
  localServerManager?: LocalMcpServerManager;
};

const publishVideoSchema = z.object({
  video_url: z
    .string()
    .url()
    .describe("Publicly accessible URL of the video file to upload"),
  privacy_level: z
    .enum([
      "PUBLIC_TO_EVERYONE",
      "MUTUAL_FOLLOW_FRIENDS",
      "FOLLOWER_OF_CREATOR",
      "SELF_ONLY",
    ])
    .describe(
      "Privacy setting — must match an option returned by tiktok_query_creator_info",
    ),
  brand_content_toggle: z
    .boolean()
    .describe(
      "Set true if this is paid partnership content (required by TikTok)",
    ),
  brand_organic_toggle: z
    .boolean()
    .describe("Set true if promoting your own business (required by TikTok)"),
  title: z
    .string()
    .max(4000)
    .optional()
    .describe("Video caption (max 4000 UTF-16 chars)"),
  disable_comment: z.boolean().optional(),
  disable_duet: z.boolean().optional(),
  disable_stitch: z.boolean().optional(),
});

const callLocalServer = async (
  manager: LocalMcpServerManager | undefined,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> => {
  if (!manager) {
    return { text: "Local MCP server manager not configured.", isError: true };
  }
  if (!manager.isRunning("tiktok")) {
    return {
      text: "TikTok MCP server is not running. Check TIKTOK_ACCESS_TOKEN env var.",
      isError: true,
    };
  }
  return manager.callTool("tiktok", toolName, args);
};

export const createTikTokTools = (
  options: TikTokToolsOptions,
): ToolDefinition[] => {
  const mgr = options.localServerManager;

  return [
    {
      name: "tiktok_publish_video",
      description:
        "Publish a video to TikTok via the Content Posting API. Wraps the sidecar's tiktok_post_video tool with full Zod validation.",
      inputSchema: {
        type: "object",
        properties: {
          video_url: { type: "string" },
          privacy_level: {
            type: "string",
            enum: [
              "PUBLIC_TO_EVERYONE",
              "MUTUAL_FOLLOW_FRIENDS",
              "FOLLOWER_OF_CREATOR",
              "SELF_ONLY",
            ],
          },
          brand_content_toggle: { type: "boolean" },
          brand_organic_toggle: { type: "boolean" },
          title: { type: "string" },
          disable_comment: { type: "boolean" },
          disable_duet: { type: "boolean" },
          disable_stitch: { type: "boolean" },
        },
        required: [
          "video_url",
          "privacy_level",
          "brand_content_toggle",
          "brand_organic_toggle",
        ],
      },
      zodSchema: publishVideoSchema,
      category: "social",
      riskLevel: "high",
      source: "tiktok",
      handler: async (args) => callLocalServer(mgr, "tiktok_post_video", args),
    },
  ];
};
