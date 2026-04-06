/**
 * MCP Tool: Art Style Picker for Flux — Prompt template presets for image generation.
 * Issue #770: Provides pre-built art style prompt templates that enhance Flux image generation.
 */

import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";

// ── Art Style Definitions ───────────────────────────────────

export interface ArtStyle {
  id: string;
  name: string;
  category: string;
  promptPrefix: string;
  promptSuffix: string;
  negativePrompt: string;
  description: string;
  recommendedSteps: number;
  recommendedGuidance: number;
}

export const ART_STYLES: ArtStyle[] = [
  {
    id: "photorealistic",
    name: "Photorealistic",
    category: "photography",
    promptPrefix: "ultra-realistic photograph,",
    promptSuffix:
      ", 8k UHD, high detail, sharp focus, professional photography, natural lighting",
    negativePrompt:
      "cartoon, illustration, painting, drawing, anime, CGI, 3D render",
    description: "Hyper-realistic photographic style with natural lighting",
    recommendedSteps: 30,
    recommendedGuidance: 7.5,
  },
  {
    id: "oil-painting",
    name: "Oil Painting",
    category: "classical",
    promptPrefix: "oil painting in the style of classical masters,",
    promptSuffix:
      ", rich colors, visible brushstrokes, canvas texture, museum quality, dramatic lighting",
    negativePrompt: "photograph, digital art, 3D render, cartoon",
    description:
      "Traditional oil painting with rich colors and visible brushwork",
    recommendedSteps: 35,
    recommendedGuidance: 8,
  },
  {
    id: "watercolor",
    name: "Watercolor",
    category: "classical",
    promptPrefix: "watercolor painting,",
    promptSuffix:
      ", soft edges, transparent washes, paper texture, delicate blending, artistic",
    negativePrompt: "photograph, digital art, sharp edges, 3D",
    description:
      "Soft watercolor style with transparent washes and gentle blending",
    recommendedSteps: 28,
    recommendedGuidance: 7,
  },
  {
    id: "anime",
    name: "Anime / Manga",
    category: "illustration",
    promptPrefix: "anime art style,",
    promptSuffix:
      ", clean lines, vibrant colors, cel shading, detailed eyes, high quality anime illustration",
    negativePrompt: "photograph, realistic, 3D, Western cartoon, blurry",
    description: "Japanese anime and manga illustration style",
    recommendedSteps: 25,
    recommendedGuidance: 7,
  },
  {
    id: "pixel-art",
    name: "Pixel Art",
    category: "digital",
    promptPrefix: "pixel art style,",
    promptSuffix:
      ", retro gaming aesthetic, limited color palette, blocky pixels, 16-bit, sprite art",
    negativePrompt: "photograph, smooth, realistic, high resolution, 3D",
    description: "Retro pixel art with limited palette and blocky aesthetics",
    recommendedSteps: 20,
    recommendedGuidance: 8,
  },
  {
    id: "cyberpunk",
    name: "Cyberpunk",
    category: "sci-fi",
    promptPrefix: "cyberpunk art style,",
    promptSuffix:
      ", neon lights, dark atmosphere, futuristic city, rain-slicked streets, holographic displays, dystopian",
    negativePrompt: "nature, rural, pastoral, bright daylight, historical",
    description: "Dark futuristic cyberpunk aesthetic with neon lights",
    recommendedSteps: 30,
    recommendedGuidance: 7.5,
  },
  {
    id: "art-nouveau",
    name: "Art Nouveau",
    category: "classical",
    promptPrefix: "art nouveau style illustration,",
    promptSuffix:
      ", organic flowing lines, floral motifs, ornate borders, Alphonse Mucha inspired, decorative",
    negativePrompt: "photograph, minimalist, modern, angular",
    description:
      "Ornate Art Nouveau with flowing organic lines and floral motifs",
    recommendedSteps: 30,
    recommendedGuidance: 7.5,
  },
  {
    id: "flat-design",
    name: "Flat Design",
    category: "digital",
    promptPrefix: "modern flat design illustration,",
    promptSuffix:
      ", clean geometric shapes, bold colors, minimal shadows, vector-like, UI design aesthetic",
    negativePrompt: "photograph, realistic, textured, 3D, detailed, busy",
    description:
      "Clean modern flat design with geometric shapes and bold colors",
    recommendedSteps: 20,
    recommendedGuidance: 7,
  },
  {
    id: "comic-book",
    name: "Comic Book",
    category: "illustration",
    promptPrefix: "comic book art style,",
    promptSuffix:
      ", bold outlines, halftone dots, dynamic pose, superhero comic aesthetic, vivid colors",
    negativePrompt: "photograph, realistic, soft edges, watercolor, blurry",
    description:
      "Bold comic book style with strong outlines and halftone shading",
    recommendedSteps: 25,
    recommendedGuidance: 7.5,
  },
  {
    id: "minimalist",
    name: "Minimalist",
    category: "digital",
    promptPrefix: "minimalist art,",
    promptSuffix:
      ", simple composition, limited color palette, clean lines, negative space, modern aesthetic",
    negativePrompt: "busy, cluttered, detailed, baroque, ornate, complex",
    description:
      "Clean minimalist style emphasizing simplicity and negative space",
    recommendedSteps: 20,
    recommendedGuidance: 7,
  },
  {
    id: "impressionist",
    name: "Impressionist",
    category: "classical",
    promptPrefix: "impressionist painting in the style of Monet,",
    promptSuffix:
      ", visible brushstrokes, light and color play, plein air, soft focus, luminous",
    negativePrompt: "photograph, sharp details, digital art, anime, pixel art",
    description:
      "Impressionist style with visible brushstrokes and light interplay",
    recommendedSteps: 30,
    recommendedGuidance: 7.5,
  },
  {
    id: "3d-render",
    name: "3D Render",
    category: "digital",
    promptPrefix: "3D rendered scene,",
    promptSuffix:
      ", octane render, ray tracing, volumetric lighting, high poly, physically based materials, cinematic",
    negativePrompt: "2D, flat, painting, sketch, hand-drawn",
    description: "Photorealistic 3D render with ray tracing and PBR materials",
    recommendedSteps: 30,
    recommendedGuidance: 8,
  },
];

// ── Schemas ─────────────────────────────────────────────────

const listArtStylesSchema = z.object({
  category: z
    .enum(["photography", "classical", "illustration", "digital", "sci-fi"])
    .optional()
    .describe("Filter styles by category"),
});

const applyArtStyleSchema = z.object({
  style_id: z.string().describe("Art style ID from the list-art-styles tool"),
  prompt: z
    .string()
    .min(1)
    .describe("The base prompt describing what to generate"),
});

// ── Tool factory ────────────────────────────────────────────

export const createArtStyleTools = (): ToolDefinition[] => {
  return [
    {
      name: "list-art-styles",
      description:
        "List available art style presets for Flux image generation. Each style includes prompt modifiers, " +
        "negative prompts, and recommended generation parameters. Filter by category: photography, classical, " +
        "illustration, digital, sci-fi.",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: [
              "photography",
              "classical",
              "illustration",
              "digital",
              "sci-fi",
            ],
            description: "Optional category filter",
          },
        },
      },
      zodSchema: listArtStylesSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        const input = listArtStylesSchema.parse(args);
        let styles = ART_STYLES;
        if (input.category) {
          styles = styles.filter((s) => s.category === input.category);
        }
        const summary = styles.map((s) => ({
          id: s.id,
          name: s.name,
          category: s.category,
          description: s.description,
          recommendedSteps: s.recommendedSteps,
          recommendedGuidance: s.recommendedGuidance,
        }));
        return { text: JSON.stringify(summary, null, 2) };
      },
    },
    {
      name: "apply-art-style",
      description:
        "Apply an art style preset to a prompt for Flux image generation. Takes a style ID and base prompt, " +
        "returns the enhanced prompt with style-specific prefixes, suffixes, negative prompts, and recommended settings.",
      inputSchema: {
        type: "object",
        properties: {
          style_id: { type: "string", description: "Art style ID" },
          prompt: {
            type: "string",
            description: "Base prompt describing what to generate",
          },
        },
        required: ["style_id", "prompt"],
      },
      zodSchema: applyArtStyleSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        const input = applyArtStyleSchema.parse(args);
        const style = ART_STYLES.find((s) => s.id === input.style_id);
        if (!style) {
          const validIds = ART_STYLES.map((s) => s.id).join(", ");
          return {
            text: `Unknown art style '${input.style_id}'. Valid styles: ${validIds}`,
            isError: true,
          };
        }

        const enhancedPrompt = `${style.promptPrefix} ${input.prompt}${style.promptSuffix}`;
        return {
          text: JSON.stringify({
            style: style.name,
            enhancedPrompt,
            negativePrompt: style.negativePrompt,
            recommendedSteps: style.recommendedSteps,
            recommendedGuidance: style.recommendedGuidance,
          }),
        };
      },
    },
  ];
};
