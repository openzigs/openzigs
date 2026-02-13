/**
 * Template export/import service for prompt portability.
 *
 * Exports a `SavedPrompt` to a portable `.openzigs-template.json` file,
 * tokenizing environment-specific post-action config values using each
 * action type's declared `sensitiveFields` manifest. On import, a wizard
 * collects replacement values and the prompt is saved via `PromptManager`.
 *
 * @module
 */

import type { PromptManager, SavedPrompt } from "./prompt-manager.js";
import type { postActionRegistry as postActionRegistrySingleton } from "../tasks/post-action-registry.js";
import {
  TemplateExportSchema,
  type TemplateExport,
  type TemplatePlaceholder,
  type TemplateAnalysis,
} from "./template-schema.js";

/** The registry type inferred from the singleton export. */
type PostActionRegistry = typeof postActionRegistrySingleton;

/* ── Error types ──────────────────────────────────────────────────── */

export class TemplateValidationError extends Error {
  public readonly issues: { message: string; path?: string }[];
  constructor(issues: { message: string; path?: (string | number)[] }[]) {
    const summary = issues.map((i) => i.message).join("; ");
    super(`Template validation failed: ${summary}`);
    this.name = "TemplateValidationError";
    this.issues = issues.map((i) => ({
      message: i.message,
      path: i.path?.join("."),
    }));
  }
}

export class PlaceholderResolutionError extends Error {
  public readonly missing: TemplatePlaceholder[];
  constructor(missing: TemplatePlaceholder[]) {
    super(`Missing required placeholders: ${missing.map((p) => p.key).join(", ")}`);
    this.name = "PlaceholderResolutionError";
    this.missing = missing;
  }
}

/* ── Deep object path utilities ───────────────────────────────────── */

/** Read a value from a nested object using dot-notation path. */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (curr, key) =>
      curr != null && typeof curr === "object"
        ? (curr as Record<string, unknown>)[key]
        : undefined,
    obj,
  );
}

/** Set a value in a nested object using dot-notation path. Creates intermediates. */
export function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  const target = keys.reduce<Record<string, unknown>>((curr, key) => {
    if (!(key in curr) || typeof curr[key] !== "object" || curr[key] === null) {
      curr[key] = {};
    }
    return curr[key] as Record<string, unknown>;
  }, obj);
  target[last] = value;
}

/* ── Template Service ─────────────────────────────────────────────── */

export interface TemplateServiceOptions {
  promptManager: PromptManager;
  postActionRegistry: PostActionRegistry;
  /** Optional instance identifier embedded in exports. */
  instanceId?: string;
}

export class TemplateService {
  private promptManager: PromptManager;
  private registry: PostActionRegistry;
  private instanceId: string;

  constructor({ promptManager, postActionRegistry, instanceId }: TemplateServiceOptions) {
    this.promptManager = promptManager;
    this.registry = postActionRegistry;
    this.instanceId = instanceId ?? "openzigs";
  }

  /* ── Export ──────────────────────────────────────────────────────── */

  /**
   * Export a saved prompt to a portable template JSON structure.
   *
   * Environment-specific post-action config values are replaced with
   * `{{placeholder}}` tokens based on each action type's `sensitiveFields`
   * manifest. The manfiest is included in the export so the import wizard
   * knows which fields to prompt for.
   */
  export(promptId: string): TemplateExport {
    const prompt = this.promptManager.getById(promptId);
    if (!prompt) {
      throw new Error(`Prompt not found: ${promptId}`);
    }

    const placeholders: TemplatePlaceholder[] = [];
    const tokenized = structuredClone(prompt);

    const stages = tokenized.stages ?? [];
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      if (!stage.postAction?.config) continue;

      const actionDef = this.registry.get(stage.postAction.type);
      const sensitiveFields = actionDef?.sensitiveFields;
      if (!sensitiveFields || sensitiveFields.length === 0) continue;

      for (const fieldPath of sensitiveFields) {
        // sensitiveFields use "config.owner" format — strip the leading "config."
        // to get the path relative to the config object.
        const relativePath = fieldPath.replace(/^config\./, "");
        const currentValue = getNestedValue(
          stage.postAction.config as Record<string, unknown>,
          relativePath,
        );

        if (currentValue != null && typeof currentValue === "string" && currentValue.length > 0) {
          const placeholderKey = `stage_${i}_${relativePath.replace(/\./g, "_")}`;

          setNestedValue(
            stage.postAction.config as Record<string, unknown>,
            relativePath,
            `{{${placeholderKey}}}`,
          );

          placeholders.push({
            key: placeholderKey,
            path: `stages[${i}].postAction.${fieldPath}`,
            description: `${stage.name} → ${relativePath}`,
            type: "string",
            required: true,
          });
        }
      }
    }

    return {
      $schema: "openzigs-template-v1",
      version: 1,
      exportedAt: new Date().toISOString(),
      exportedFrom: this.instanceId,
      prompt: {
        name: tokenized.name,
        description: tokenized.description,
        template: tokenized.template,
        tags: tokenized.tags,
        preferredTools: tokenized.preferredTools,
        stages: tokenized.stages,
      },
      placeholders,
    };
  }

  /* ── Analyze (pre-import validation) ────────────────────────────── */

  /**
   * Validate and preview a template without importing it.
   * Returns placeholder manifest and prompt metadata for the wizard.
   */
  analyze(data: unknown): TemplateAnalysis {
    const parsed = TemplateExportSchema.safeParse(data);
    if (!parsed.success) {
      return {
        valid: false,
        errors: parsed.error.issues.map((i) => ({
          message: i.message,
          path: i.path.join("."),
        })),
        placeholders: [],
      };
    }

    return {
      valid: true,
      errors: [],
      prompt: {
        name: parsed.data.prompt.name,
        description: parsed.data.prompt.description,
        stageCount: parsed.data.prompt.stages?.length ?? 0,
        tags: parsed.data.prompt.tags,
      },
      placeholders: parsed.data.placeholders,
      exportedAt: parsed.data.exportedAt,
      exportedFrom: parsed.data.exportedFrom,
    };
  }

  /* ── Import ─────────────────────────────────────────────────────── */

  /**
   * Import a template with resolved placeholder values.
   *
   * @param data Raw JSON (from file upload)
   * @param resolvedPlaceholders `{ placeholderKey: resolvedValue }`
   * @returns The newly created `SavedPrompt`
   */
  import(
    data: unknown,
    resolvedPlaceholders: Record<string, string>,
  ): SavedPrompt {
    // 1. Validate structure
    const parsed = TemplateExportSchema.safeParse(data);
    if (!parsed.success) {
      throw new TemplateValidationError(parsed.error.issues);
    }

    const template = parsed.data;

    // 2. Verify all required placeholders are resolved
    const missing = template.placeholders.filter(
      (p) => p.required && !resolvedPlaceholders[p.key],
    );
    if (missing.length > 0) {
      throw new PlaceholderResolutionError(missing);
    }

    // 3. Replace placeholders with resolved values
    let promptJson = JSON.stringify(template.prompt);
    for (const [key, value] of Object.entries(resolvedPlaceholders)) {
      // Escape the value for safe JSON embedding
      const escaped = JSON.stringify(value).slice(1, -1); // strip wrapping quotes
      promptJson = promptJson.replaceAll(`{{${key}}}`, escaped);
    }
    const resolvedPrompt = JSON.parse(promptJson) as TemplateExport["prompt"];

    // 4. Handle duplicate names — append "(imported)" if name exists
    let finalName = resolvedPrompt.name;
    const existing = this.promptManager.getByName(finalName);
    if (existing) {
      finalName = `${finalName} (imported)`;
      // If that also exists, add a counter
      let counter = 2;
      while (this.promptManager.getByName(finalName)) {
        finalName = `${resolvedPrompt.name} (imported ${counter})`;
        counter++;
      }
    }

    // 5. Ensure "imported" tag is present
    const tags = [...resolvedPrompt.tags];
    if (!tags.includes("imported")) {
      tags.push("imported");
    }

    // 6. Create the prompt
    const cleanStages = resolvedPrompt.stages?.map((s) => ({
      ...s,
      tools: s.tools ?? undefined,
      autoApproveTools: s.autoApproveTools ?? undefined,
    }));
    return this.promptManager.create({
      name: finalName,
      template: resolvedPrompt.template,
      description: resolvedPrompt.description,
      tags,
      preferredTools: resolvedPrompt.preferredTools ?? undefined,
      stages: cleanStages,
    });
  }
}
