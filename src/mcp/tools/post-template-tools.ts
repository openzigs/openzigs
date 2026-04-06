/**
 * MCP Tools: Post Template System — Create, manage, and apply reusable post templates.
 * Issue #776: Depends on #778 (Brand Kit System). Templates can reference brand kits.
 */

import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { PostTemplateRepository } from "../../creative/post-template-repository.js";

const VALID_PLATFORMS = [
  "twitter",
  "instagram",
  "linkedin",
  "facebook",
  "pinterest",
  "youtube",
  "reddit",
] as const;

const listTemplatesSchema = z.object({
  platform: z.enum(VALID_PLATFORMS).optional().describe("Filter by platform"),
  brand_kit_id: z.string().optional().describe("Filter by brand kit ID"),
});

const getTemplateSchema = z.object({
  template_id: z.string().describe("Post template ID"),
});

const createTemplateSchema = z.object({
  name: z.string().min(1).max(200).describe("Template name"),
  description: z
    .string()
    .optional()
    .default("")
    .describe("Template description"),
  platform: z.enum(VALID_PLATFORMS).describe("Target platform"),
  layout: z
    .enum(["default", "image-top", "image-left", "carousel", "story", "reel"])
    .optional()
    .default("default")
    .describe("Post layout type"),
  content_template: z
    .string()
    .min(1)
    .describe("Content template with {{variable}} placeholders"),
  brand_kit_id: z
    .string()
    .nullable()
    .optional()
    .describe("Brand kit to associate"),
  tags: z
    .array(z.string())
    .optional()
    .default([])
    .describe("Tags for organization"),
});

const updateTemplateSchema = z.object({
  template_id: z.string().describe("Template ID to update"),
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  platform: z.enum(VALID_PLATFORMS).optional(),
  layout: z.string().optional(),
  content_template: z.string().optional(),
  brand_kit_id: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

const deleteTemplateSchema = z.object({
  template_id: z.string().describe("Template ID to delete"),
});

const applyTemplateSchema = z.object({
  template_id: z.string().describe("Template ID to apply"),
  variables: z
    .record(z.string())
    .describe("Key-value pairs to replace {{variable}} placeholders"),
});

export interface PostTemplateToolsOptions {
  postTemplateRepo: PostTemplateRepository;
}

export const createPostTemplateTools = ({
  postTemplateRepo,
}: PostTemplateToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "list-post-templates",
      description:
        "List all saved post templates. Filter by platform or brand kit.",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: [...VALID_PLATFORMS] },
          brand_kit_id: { type: "string" },
        },
      },
      zodSchema: listTemplatesSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        const input = listTemplatesSchema.parse(args);
        const templates = postTemplateRepo.list({
          platform: input.platform,
          brandKitId: input.brand_kit_id,
        });
        return { text: JSON.stringify(templates, null, 2) };
      },
    },
    {
      name: "get-post-template",
      description: "Get a specific post template by ID.",
      inputSchema: {
        type: "object",
        properties: { template_id: { type: "string" } },
        required: ["template_id"],
      },
      zodSchema: getTemplateSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        const input = getTemplateSchema.parse(args);
        const template = postTemplateRepo.getById(input.template_id);
        if (!template)
          return {
            text: `Template '${input.template_id}' not found.`,
            isError: true,
          };
        return { text: JSON.stringify(template, null, 2) };
      },
    },
    {
      name: "create-post-template",
      description:
        "Create a reusable social media post template. Use {{variable}} placeholders in the content " +
        "that can be filled when applying the template. Optionally link to a brand kit for consistent styling.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          platform: { type: "string", enum: [...VALID_PLATFORMS] },
          layout: {
            type: "string",
            enum: [
              "default",
              "image-top",
              "image-left",
              "carousel",
              "story",
              "reel",
            ],
          },
          content_template: {
            type: "string",
            description: "Template with {{variable}} placeholders",
          },
          brand_kit_id: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["name", "platform", "content_template"],
      },
      zodSchema: createTemplateSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        try {
          const input = createTemplateSchema.parse(args);
          const template = postTemplateRepo.create({
            name: input.name,
            description: input.description,
            platform: input.platform,
            layout: input.layout,
            contentTemplate: input.content_template,
            brandKitId: input.brand_kit_id,
            tags: input.tags,
          });
          return { text: JSON.stringify(template, null, 2) };
        } catch (err) {
          return {
            text: `Error creating template: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
    {
      name: "update-post-template",
      description:
        "Update an existing post template. Only provided fields are changed.",
      inputSchema: {
        type: "object",
        properties: {
          template_id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          platform: { type: "string" },
          layout: { type: "string" },
          content_template: { type: "string" },
          brand_kit_id: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["template_id"],
      },
      zodSchema: updateTemplateSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        try {
          const input = updateTemplateSchema.parse(args);
          const { template_id, ...fields } = input;
          const updated = postTemplateRepo.update(template_id, {
            name: fields.name,
            description: fields.description,
            platform: fields.platform,
            layout: fields.layout,
            contentTemplate: fields.content_template,
            brandKitId: fields.brand_kit_id,
            tags: fields.tags,
          });
          if (!updated)
            return {
              text: `Template '${template_id}' not found.`,
              isError: true,
            };
          return { text: JSON.stringify(updated, null, 2) };
        } catch (err) {
          return {
            text: `Error updating template: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
    {
      name: "delete-post-template",
      description: "Delete a post template by ID.",
      inputSchema: {
        type: "object",
        properties: { template_id: { type: "string" } },
        required: ["template_id"],
      },
      zodSchema: deleteTemplateSchema,
      category: "productivity",
      riskLevel: "high",
      handler: async (args) => {
        const input = deleteTemplateSchema.parse(args);
        const deleted = postTemplateRepo.delete(input.template_id);
        if (!deleted)
          return {
            text: `Template '${input.template_id}' not found.`,
            isError: true,
          };
        return {
          text: JSON.stringify({ success: true, deletedId: input.template_id }),
        };
      },
    },
    {
      name: "apply-post-template",
      description:
        "Apply a post template by filling in its {{variable}} placeholders with provided values. " +
        "Returns the rendered content ready for posting.",
      inputSchema: {
        type: "object",
        properties: {
          template_id: { type: "string" },
          variables: {
            type: "object",
            description: "Key-value pairs for {{variable}} replacement",
          },
        },
        required: ["template_id", "variables"],
      },
      zodSchema: applyTemplateSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        const input = applyTemplateSchema.parse(args);
        const result = postTemplateRepo.applyTemplate(
          input.template_id,
          input.variables,
        );
        if (!result)
          return {
            text: `Template '${input.template_id}' not found.`,
            isError: true,
          };
        return { text: JSON.stringify(result, null, 2) };
      },
    },
  ];
};
