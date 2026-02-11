import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { PipelineStage } from "../tasks/types.js";

export type SavedPrompt = {
  id: string;
  name: string;
  template: string;
  description: string;
  tags: string[];
  /** Optional list of preferred tool names for this prompt. null = no preference. */
  preferredTools: string[] | null;
  /** Optional pipeline stages for multi-stage execution. null = single-stage prompt. */
  stages: PipelineStage[] | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreatePromptInput = {
  name: string;
  template: string;
  description?: string;
  tags?: string[];
  /** Optional list of preferred tool names for this prompt. */
  preferredTools?: string[];
  /** Optional pipeline stages for multi-stage execution. */
  stages?: PipelineStage[];
};

export type UpdatePromptInput = {
  name?: string;
  template?: string;
  description?: string;
  tags?: string[];
  /** Set to an array to configure preferred tools, or null to clear. */
  preferredTools?: string[] | null;
  /** Set to an array to configure pipeline stages, or null to clear. */
  stages?: PipelineStage[] | null;
};

type StoredPrompt = {
  id: string;
  name: string;
  template: string;
  description: string;
  tags: string;
  preferred_tools: string | null;
  stages: string | null;
  created_at: string;
  updated_at: string;
};

const toPrompt = (row: StoredPrompt): SavedPrompt => ({
  id: row.id,
  name: row.name,
  template: row.template,
  description: row.description,
  tags: JSON.parse(row.tags) as string[],
  preferredTools: row.preferred_tools ? (JSON.parse(row.preferred_tools) as string[]) : null,
  stages: row.stages ? (JSON.parse(row.stages) as PipelineStage[]) : null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

/**
 * Interpolate `{{variable}}` placeholders in a template string.
 * Missing variables are left as-is.
 */
export const interpolateTemplate = (
  template: string,
  variables: Record<string, string>
): string => {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return key in variables ? variables[key] : `{{${key}}}`;
  });
};

/**
 * Extract variable names from a template.
 */
export const extractVariables = (template: string): string[] => {
  const matches = template.matchAll(/\{\{(\w+)\}\}/g);
  const names = new Set<string>();
  for (const match of matches) {
    names.add(match[1]);
  }
  return Array.from(names);
};

export type PromptManagerOptions = {
  db: Database.Database;
  clock?: () => Date;
};

export class PromptManager {
  private db: Database.Database;
  private clock: () => Date;

  constructor({ db, clock }: PromptManagerOptions) {
    this.db = db;
    this.clock = clock ?? (() => new Date());
    this.migrateSchema();
  }

  /** Run lightweight schema migrations (add columns if missing). */
  private migrateSchema(): void {
    const columns = this.db.pragma("table_info(saved_prompts)") as Array<{ name: string }>;

    // Add 'preferred_tools' column — JSON array of tool names or NULL
    if (!columns.some((c) => c.name === "preferred_tools")) {
      this.db.exec("ALTER TABLE saved_prompts ADD COLUMN preferred_tools TEXT DEFAULT NULL");
    }

    // Add 'stages' column — JSON array of pipeline stage definitions or NULL
    if (!columns.some((c) => c.name === "stages")) {
      this.db.exec("ALTER TABLE saved_prompts ADD COLUMN stages TEXT DEFAULT NULL");
    }
  }

  create(input: CreatePromptInput): SavedPrompt {
    const now = this.clock().toISOString();
    const id = randomUUID();
    const tags = JSON.stringify(input.tags ?? []);

    this.db
      .prepare(
        `INSERT INTO saved_prompts (id, name, template, description, tags, preferred_tools, stages, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.name, input.template, input.description ?? "", tags, input.preferredTools ? JSON.stringify(input.preferredTools) : null, input.stages ? JSON.stringify(input.stages) : null, now, now);

    return this.getById(id)!;
  }

  getById(id: string): SavedPrompt | null {
    const row = this.db
      .prepare("SELECT * FROM saved_prompts WHERE id = ?")
      .get(id) as StoredPrompt | undefined;
    return row ? toPrompt(row) : null;
  }

  getByName(name: string): SavedPrompt | null {
    const row = this.db
      .prepare("SELECT * FROM saved_prompts WHERE name = ?")
      .get(name) as StoredPrompt | undefined;
    return row ? toPrompt(row) : null;
  }

  list(): SavedPrompt[] {
    const rows = this.db
      .prepare("SELECT * FROM saved_prompts ORDER BY updated_at DESC")
      .all() as StoredPrompt[];
    return rows.map(toPrompt);
  }

  search(query: string): SavedPrompt[] {
    const pattern = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM saved_prompts
         WHERE name LIKE ? OR description LIKE ? OR template LIKE ?
         ORDER BY updated_at DESC`
      )
      .all(pattern, pattern, pattern) as StoredPrompt[];
    return rows.map(toPrompt);
  }

  update(id: string, input: UpdatePromptInput): SavedPrompt {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Prompt not found: ${id}`);
    }

    const now = this.clock().toISOString();
    const name = input.name ?? existing.name;
    const template = input.template ?? existing.template;
    const description = input.description ?? existing.description;
    const tags = JSON.stringify(input.tags ?? existing.tags);
    const preferredTools = input.preferredTools !== undefined
      ? (input.preferredTools ? JSON.stringify(input.preferredTools) : null)
      : (existing.preferredTools ? JSON.stringify(existing.preferredTools) : null);
    const stages = input.stages !== undefined
      ? (input.stages ? JSON.stringify(input.stages) : null)
      : (existing.stages ? JSON.stringify(existing.stages) : null);

    this.db
      .prepare(
        `UPDATE saved_prompts SET name = ?, template = ?, description = ?, tags = ?, preferred_tools = ?, stages = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(name, template, description, tags, preferredTools, stages, now, id);

    return this.getById(id)!;
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM saved_prompts WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  /**
   * Resolve a prompt by name with optional variable interpolation.
   */
  resolve(name: string, variables: Record<string, string> = {}): string | null {
    const prompt = this.getByName(name);
    if (!prompt) {
      return null;
    }
    return interpolateTemplate(prompt.template, variables);
  }

  /**
   * Resolve a prompt by name, returning both the interpolated text and any
   * preferred tools attached to the prompt. Used by the scheduler to scope
   * tool access when executing prompt-based jobs.
   */
  resolveWithTools(
    name: string,
    variables: Record<string, string> = {}
  ): { text: string; preferredTools: string[] | null } | null {
    const prompt = this.getByName(name);
    if (!prompt) {
      return null;
    }
    return {
      text: interpolateTemplate(prompt.template, variables),
      preferredTools: prompt.preferredTools,
    };
  }

  /**
   * Resolve a prompt by name with full metadata: interpolated text,
   * preferred tools, and pipeline stages (with variable interpolation
   * applied to each stage's prompt text).
   */
  resolveWithStages(
    name: string,
    variables: Record<string, string> = {}
  ): { text: string; preferredTools: string[] | null; stages: PipelineStage[] | null } | null {
    const prompt = this.getByName(name);
    if (!prompt) {
      return null;
    }

    // Interpolate variables in stage prompts too
    const resolvedStages = prompt.stages?.map((stage) => ({
      ...stage,
      prompt: interpolateTemplate(stage.prompt, variables),
    })) ?? null;

    return {
      text: interpolateTemplate(prompt.template, variables),
      preferredTools: prompt.preferredTools,
      stages: resolvedStages,
    };
  }
}
