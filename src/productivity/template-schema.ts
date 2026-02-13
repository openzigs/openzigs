/**
 * Zod schemas for the portable template export/import format.
 *
 * Templates use the `.openzigs-template.json` file extension and follow the
 * `openzigs-template-v1` schema. Sensitive / environment-specific values in
 * post-action configs are replaced with `{{placeholder}}` tokens on export
 * and resolved via a wizard on import.
 *
 * @module
 */

import { z } from "zod";

/* ── Placeholders ─────────────────────────────────────────────────── */

export const TemplatePlaceholderSchema = z.object({
  /** Machine-readable key used inside `{{…}}` tokens. */
  key: z.string().min(1),
  /** Dot-notation path in the exported prompt where this placeholder lives. */
  path: z.string().min(1),
  /** Human-readable label shown in the import wizard. */
  description: z.string(),
  /** Value type for input rendering. */
  type: z.enum(["string", "number", "boolean"]),
  /** Whether the placeholder *must* be resolved before import. */
  required: z.boolean(),
});

export type TemplatePlaceholder = z.infer<typeof TemplatePlaceholderSchema>;

/* ── Post-action (inside a stage) ─────────────────────────────────── */

const TemplatePostActionSchema = z.object({
  type: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});

/* ── Pipeline stage ───────────────────────────────────────────────── */

const TemplateStageSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  tools: z.array(z.string()).nullish(),
  autoApproveTools: z.array(z.string()).nullish(),
  model: z.string().optional(),
  timeoutSeconds: z.number().optional(),
  postAction: TemplatePostActionSchema.optional(),
});

/* ── Top-level export envelope ────────────────────────────────────── */

export const TemplateExportSchema = z.object({
  /** Fixed schema identifier for forward-compatibility detection. */
  $schema: z.literal("openzigs-template-v1"),
  /** Schema version number. */
  version: z.number().int().positive(),
  /** ISO-8601 timestamp of when the export was created. */
  exportedAt: z.string(),
  /** Optional instance identifier. */
  exportedFrom: z.string().optional(),
  /** The prompt data. */
  prompt: z.object({
    name: z.string().min(1),
    description: z.string(),
    template: z.string(),
    tags: z.array(z.string()),
    preferredTools: z.array(z.string()).nullable(),
    stages: z.array(TemplateStageSchema).nullable(),
  }),
  /** Placeholder manifest — one entry per tokenized field. */
  placeholders: z.array(TemplatePlaceholderSchema),
});

export type TemplateExport = z.infer<typeof TemplateExportSchema>;

/* ── Analysis result (pre-import preview) ─────────────────────────── */

export type TemplateAnalysis = {
  valid: boolean;
  errors: { message: string; path?: string }[];
  prompt?: {
    name: string;
    description: string;
    stageCount: number;
    tags: string[];
  };
  placeholders: TemplatePlaceholder[];
  exportedAt?: string;
  exportedFrom?: string;
};
