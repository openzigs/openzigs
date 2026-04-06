/**
 * MCP Tools: Social Caption & Hashtag Generator — LLM-powered content creation.
 * Issue #772: Generate platform-optimized captions and relevant hashtags.
 */

import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";
import type {
  OutboxRepository,
  OutboxPlatform,
} from "../../outbox/outbox-repository.js";

const PLATFORM_LIMITS: Record<
  string,
  { maxChars: number; maxHashtags: number; style: string }
> = {
  twitter: {
    maxChars: 280,
    maxHashtags: 3,
    style: "concise, punchy, conversational",
  },
  instagram: {
    maxChars: 2200,
    maxHashtags: 30,
    style: "engaging, visual storytelling, emoji-friendly",
  },
  linkedin: {
    maxChars: 3000,
    maxHashtags: 5,
    style: "professional, thought leadership, insightful",
  },
  facebook: {
    maxChars: 63206,
    maxHashtags: 5,
    style: "conversational, community-oriented",
  },
  pinterest: {
    maxChars: 500,
    maxHashtags: 20,
    style: "keyword-rich, SEO-optimized, descriptive",
  },
  youtube: {
    maxChars: 5000,
    maxHashtags: 15,
    style: "detailed, keyword-optimized, hook in first line",
  },
  reddit: {
    maxChars: 40000,
    maxHashtags: 0,
    style: "authentic, community-aware, no promotional language",
  },
};

const generateCaptionSchema = z.object({
  topic: z
    .string()
    .min(1)
    .describe("Topic or description of the content to write a caption for"),
  platform: z
    .enum([
      "twitter",
      "instagram",
      "linkedin",
      "facebook",
      "pinterest",
      "youtube",
      "reddit",
    ])
    .describe("Target social media platform"),
  tone: z
    .enum([
      "professional",
      "casual",
      "humorous",
      "inspirational",
      "educational",
      "promotional",
    ])
    .optional()
    .default("casual")
    .describe("Desired tone of the caption"),
  include_cta: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include a call-to-action"),
  include_emoji: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include relevant emojis"),
  context: z
    .string()
    .optional()
    .describe("Additional context (brand voice, campaign, audience)"),
  create_outbox_item: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "When true, create a pending outbox item with the generated caption",
    ),
});

const generateHashtagsSchema = z.object({
  topic: z.string().min(1).describe("Topic to generate hashtags for"),
  platform: z
    .enum([
      "twitter",
      "instagram",
      "linkedin",
      "facebook",
      "pinterest",
      "youtube",
    ])
    .describe("Target platform"),
  count: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .default(10)
    .describe("Number of hashtags to generate"),
  include_trending: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include trending/popular hashtags"),
  niche_level: z
    .enum(["broad", "medium", "niche"])
    .optional()
    .default("medium")
    .describe(
      "Hashtag specificity: broad (high volume), medium, niche (targeted)",
    ),
});

export interface SocialCaptionToolsOptions {
  copilotWrapper?: CopilotWrapper;
  outboxRepo?: OutboxRepository;
}

export const createSocialCaptionTools = ({
  copilotWrapper,
  outboxRepo,
}: SocialCaptionToolsOptions): ToolDefinition[] => {
  async function generateViaLLM(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    if (!copilotWrapper) {
      return "LLM not available — copilot wrapper not configured.";
    }
    try {
      let result = "";
      const gen = copilotWrapper.chat(`${systemPrompt}\n\nUser: ${userPrompt}`);
      for await (const chunk of gen) {
        result += chunk;
      }
      return result.trim();
    } catch {
      return "LLM generation failed. Please try again.";
    }
  }

  return [
    {
      name: "generate-social-caption",
      description:
        "Generate a platform-optimized social media caption using AI. Respects platform character limits, " +
        "style conventions, and supports multiple tones (professional, casual, humorous, etc.). " +
        "Optionally includes call-to-action and emojis.",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Content topic/description" },
          platform: {
            type: "string",
            enum: [
              "twitter",
              "instagram",
              "linkedin",
              "facebook",
              "pinterest",
              "youtube",
              "reddit",
            ],
          },
          tone: {
            type: "string",
            enum: [
              "professional",
              "casual",
              "humorous",
              "inspirational",
              "educational",
              "promotional",
            ],
          },
          include_cta: { type: "boolean" },
          include_emoji: { type: "boolean" },
          context: {
            type: "string",
            description: "Additional brand/campaign context",
          },
          create_outbox_item: {
            type: "boolean",
            description:
              "When true, create a pending outbox item with the caption",
          },
        },
        required: ["topic", "platform"],
      },
      zodSchema: generateCaptionSchema,
      category: "social",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = generateCaptionSchema.parse(args);
          const limits = PLATFORM_LIMITS[input.platform];

          const systemPrompt =
            "You are an expert social media copywriter. Generate a single caption optimized for the specified platform. " +
            "Follow the platform's character limits and style conventions exactly. " +
            "Return ONLY the caption text — no explanations, no labels, no formatting.";

          const userPrompt = [
            `Platform: ${input.platform} (max ${limits.maxChars} chars, style: ${limits.style})`,
            `Topic: ${input.topic}`,
            `Tone: ${input.tone}`,
            input.include_cta ? "Include a call-to-action." : "",
            input.include_emoji ? "Include relevant emojis." : "No emojis.",
            input.context ? `Brand context: ${input.context}` : "",
          ]
            .filter(Boolean)
            .join("\n");

          const caption = await generateViaLLM(systemPrompt, userPrompt);

          const result: Record<string, unknown> = {
            platform: input.platform,
            caption,
            charCount: caption.length,
            maxChars: limits.maxChars,
            withinLimit: caption.length <= limits.maxChars,
          };

          // Create outbox item if requested (Issue #816)
          if (input.create_outbox_item && outboxRepo && caption) {
            const outboxItem = outboxRepo.insert({
              platform: input.platform as OutboxPlatform,
              contentBody: caption,
              agentContext: `Auto-generated caption for: ${input.topic}`,
              scheduledTime: new Date(Date.now() + 30 * 60_000),
              assetType: "text",
              title: input.topic.slice(0, 100),
            });
            result.outboxItemId = outboxItem.id;
          }

          return {
            text: JSON.stringify(result),
          };
        } catch (err) {
          return {
            text: `Error generating caption: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
    {
      name: "generate-hashtags",
      description:
        "Generate relevant hashtags for a social media post. Optimized per platform with configurable " +
        "specificity (broad for reach, niche for targeted engagement). Returns hashtags with categories.",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string" },
          platform: {
            type: "string",
            enum: [
              "twitter",
              "instagram",
              "linkedin",
              "facebook",
              "pinterest",
              "youtube",
            ],
          },
          count: { type: "number", description: "Number of hashtags (1-30)" },
          include_trending: { type: "boolean" },
          niche_level: { type: "string", enum: ["broad", "medium", "niche"] },
        },
        required: ["topic", "platform"],
      },
      zodSchema: generateHashtagsSchema,
      category: "social",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = generateHashtagsSchema.parse(args);
          const limits = PLATFORM_LIMITS[input.platform];
          const maxTags = Math.min(input.count, limits.maxHashtags || 30);

          const systemPrompt =
            "You are a social media hashtag strategist. Generate hashtags optimized for the specified platform. " +
            "Return ONLY a JSON array of objects with 'tag' (without #) and 'category' (broad/medium/niche) fields. " +
            "No explanations — just the JSON array.";

          const userPrompt = [
            `Platform: ${input.platform}`,
            `Topic: ${input.topic}`,
            `Count: ${maxTags}`,
            `Focus: ${input.niche_level} specificity`,
            input.include_trending
              ? "Include popular/trending tags where relevant."
              : "Focus on evergreen tags.",
          ].join("\n");

          const response = await generateViaLLM(systemPrompt, userPrompt);

          // Try to parse as JSON, fall back to extracting hashtags from text
          let hashtags: Array<{ tag: string; category: string }>;
          try {
            const jsonMatch = response.match(/\[[\s\S]*\]/);
            hashtags = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
          } catch {
            // Fallback: extract words that look like hashtags
            const words = response.match(/#?\w+/g) ?? [];
            hashtags = words.slice(0, maxTags).map((w) => ({
              tag: w.replace(/^#/, ""),
              category: input.niche_level,
            }));
          }

          return {
            text: JSON.stringify({
              platform: input.platform,
              hashtags: hashtags.slice(0, maxTags).map((h) => ({
                tag: `#${h.tag.replace(/^#/, "")}`,
                category: h.category,
              })),
              count: Math.min(hashtags.length, maxTags),
            }),
          };
        } catch (err) {
          return {
            text: `Error generating hashtags: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
  ];
};
