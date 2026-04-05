/**
 * MCP Tools: Brand Kit System — CRUD and application of brand kits.
 * Issue #778: MCP tools for managing brand visual identity presets.
 * Uses existing BrandKitRepository and brand_kits SQLite table.
 */

import * as z from "zod";
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrandKitRepository, BrandKit } from "../../video/brand-kit.js";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const listBrandKitsSchema = z.object({});

const getBrandKitSchema = z.object({
  kit_id: z.string().describe("Brand kit ID"),
});

const createBrandKitSchema = z.object({
  name: z.string().min(1).max(100).describe("Brand kit name"),
  primary_color: z
    .string()
    .regex(HEX_RE, "Must be a hex color (#RRGGBB)")
    .describe("Primary brand color"),
  secondary_color: z
    .string()
    .regex(HEX_RE, "Must be a hex color (#RRGGBB)")
    .describe("Secondary brand color"),
  accent_color: z
    .string()
    .regex(HEX_RE, "Must be a hex color (#RRGGBB)")
    .describe("Accent color"),
  font_family: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .default("Inter")
    .describe("Font family name"),
  logo_path: z
    .string()
    .nullable()
    .optional()
    .describe("Path to brand logo image"),
  watermark_path: z
    .string()
    .nullable()
    .optional()
    .describe("Path to watermark image"),
});

const updateBrandKitSchema = z.object({
  kit_id: z.string().describe("Brand kit ID to update"),
  name: z.string().min(1).max(100).optional(),
  primary_color: z.string().regex(HEX_RE).optional(),
  secondary_color: z.string().regex(HEX_RE).optional(),
  accent_color: z.string().regex(HEX_RE).optional(),
  font_family: z.string().min(1).max(100).optional(),
  logo_path: z.string().nullable().optional(),
  watermark_path: z.string().nullable().optional(),
});

const deleteBrandKitSchema = z.object({
  kit_id: z.string().describe("Brand kit ID to delete"),
});

export interface BrandKitToolsOptions {
  brandKitRepo: BrandKitRepository;
}

export const createBrandKitTools = ({
  brandKitRepo,
}: BrandKitToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "list-brand-kits",
      description:
        "List all saved brand kits with their colors, fonts, and asset paths.",
      inputSchema: { type: "object", properties: {} },
      zodSchema: listBrandKitsSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async () => {
        const kits = brandKitRepo.getAll();
        return { text: JSON.stringify(kits, null, 2) };
      },
    },
    {
      name: "get-brand-kit",
      description: "Get a specific brand kit by ID with all its properties.",
      inputSchema: {
        type: "object",
        properties: { kit_id: { type: "string" } },
        required: ["kit_id"],
      },
      zodSchema: getBrandKitSchema,
      category: "productivity",
      riskLevel: "low",
      handler: async (args) => {
        const input = getBrandKitSchema.parse(args);
        const kit = brandKitRepo.getById(input.kit_id);
        if (!kit)
          return {
            text: `Brand kit '${input.kit_id}' not found.`,
            isError: true,
          };
        return { text: JSON.stringify(kit, null, 2) };
      },
    },
    {
      name: "create-brand-kit",
      description:
        "Create a new brand kit with colors, font, and optional logo/watermark. " +
        "Use hex colors (#RRGGBB format). Returns the created brand kit with its ID.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          primary_color: { type: "string", description: "Hex color #RRGGBB" },
          secondary_color: { type: "string", description: "Hex color #RRGGBB" },
          accent_color: { type: "string", description: "Hex color #RRGGBB" },
          font_family: { type: "string" },
          logo_path: { type: "string" },
          watermark_path: { type: "string" },
        },
        required: ["name", "primary_color", "secondary_color", "accent_color"],
      },
      zodSchema: createBrandKitSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        try {
          const input = createBrandKitSchema.parse(args);
          const kit = brandKitRepo.create({
            id: randomUUID(),
            name: input.name,
            primaryColor: input.primary_color,
            secondaryColor: input.secondary_color,
            accentColor: input.accent_color,
            fontFamily: input.font_family,
            logoPath: input.logo_path ?? null,
            watermarkPath: input.watermark_path ?? null,
            introTemplateId: null,
            outroTemplateId: null,
          });
          return { text: JSON.stringify(kit, null, 2) };
        } catch (err) {
          return {
            text: `Error creating brand kit: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
    {
      name: "update-brand-kit",
      description:
        "Update an existing brand kit. Only the provided fields are changed.",
      inputSchema: {
        type: "object",
        properties: {
          kit_id: { type: "string" },
          name: { type: "string" },
          primary_color: { type: "string" },
          secondary_color: { type: "string" },
          accent_color: { type: "string" },
          font_family: { type: "string" },
          logo_path: { type: "string" },
          watermark_path: { type: "string" },
        },
        required: ["kit_id"],
      },
      zodSchema: updateBrandKitSchema,
      category: "productivity",
      riskLevel: "medium",
      handler: async (args) => {
        try {
          const input = updateBrandKitSchema.parse(args);
          const { kit_id, ...fields } = input;
          const updateFields: Record<string, unknown> = {};
          if (fields.name !== undefined) updateFields.name = fields.name;
          if (fields.primary_color !== undefined)
            updateFields.primaryColor = fields.primary_color;
          if (fields.secondary_color !== undefined)
            updateFields.secondaryColor = fields.secondary_color;
          if (fields.accent_color !== undefined)
            updateFields.accentColor = fields.accent_color;
          if (fields.font_family !== undefined)
            updateFields.fontFamily = fields.font_family;
          if (fields.logo_path !== undefined)
            updateFields.logoPath = fields.logo_path;
          if (fields.watermark_path !== undefined)
            updateFields.watermarkPath = fields.watermark_path;

          const updated = brandKitRepo.update(
            kit_id,
            updateFields as Partial<BrandKit>,
          );
          if (!updated)
            return { text: `Brand kit '${kit_id}' not found.`, isError: true };
          return { text: JSON.stringify(updated, null, 2) };
        } catch (err) {
          return {
            text: `Error updating brand kit: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    },
    {
      name: "delete-brand-kit",
      description: "Delete a brand kit by ID.",
      inputSchema: {
        type: "object",
        properties: { kit_id: { type: "string" } },
        required: ["kit_id"],
      },
      zodSchema: deleteBrandKitSchema,
      category: "productivity",
      riskLevel: "high",
      handler: async (args) => {
        const input = deleteBrandKitSchema.parse(args);
        const deleted = brandKitRepo.delete(input.kit_id);
        if (!deleted)
          return {
            text: `Brand kit '${input.kit_id}' not found.`,
            isError: true,
          };
        return {
          text: JSON.stringify({ success: true, deletedId: input.kit_id }),
        };
      },
    },
  ];
};
