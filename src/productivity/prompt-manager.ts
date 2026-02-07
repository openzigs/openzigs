import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type SavedPrompt = {
  id: string;
  name: string;
  template: string;
  description: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type CreatePromptInput = {
  name: string;
  template: string;
  description?: string;
  tags?: string[];
};

export type UpdatePromptInput = {
  name?: string;
  template?: string;
  description?: string;
  tags?: string[];
};

type StoredPrompt = {
  id: string;
  name: string;
  template: string;
  description: string;
  tags: string;
  created_at: string;
  updated_at: string;
};

const toPrompt = (row: StoredPrompt): SavedPrompt => ({
  id: row.id,
  name: row.name,
  template: row.template,
  description: row.description,
  tags: JSON.parse(row.tags) as string[],
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
  }

  create(input: CreatePromptInput): SavedPrompt {
    const now = this.clock().toISOString();
    const id = randomUUID();
    const tags = JSON.stringify(input.tags ?? []);

    this.db
      .prepare(
        `INSERT INTO saved_prompts (id, name, template, description, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.name, input.template, input.description ?? "", tags, now, now);

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

    this.db
      .prepare(
        `UPDATE saved_prompts SET name = ?, template = ?, description = ?, tags = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(name, template, description, tags, now, id);

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
}
