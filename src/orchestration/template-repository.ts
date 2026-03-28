import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  OrchestrationTemplate,
  OrchestrationMode,
  CreateOrchestrationTemplateInput,
  UpdateOrchestrationTemplateInput,
  StoredOrchestrationTemplate,
} from "./types.js";
import { OrchestrationStageSchema, TemplateVariableSchema } from "./types.js";

const toTemplate = (row: StoredOrchestrationTemplate): OrchestrationTemplate => ({
  id: row.id,
  name: row.name,
  description: row.description,
  category: row.category as OrchestrationTemplate["category"],
  stages: OrchestrationStageSchema.array().parse(JSON.parse(row.stages_json)),
  variables: TemplateVariableSchema.array().parse(JSON.parse(row.variables_json)),
  aggregationPrompt: row.aggregation_prompt,
  defaultMode: (row.default_mode as OrchestrationMode) ?? undefined,
  isBuiltIn: row.is_built_in === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class TemplateRepository {
  private db: Database.Database;
  private clock: () => Date;

  constructor(db: Database.Database, clock?: () => Date) {
    this.db = db;
    this.clock = clock ?? (() => new Date());
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestration_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'custom',
        stages_json TEXT NOT NULL,
        variables_json TEXT NOT NULL DEFAULT '[]',
        aggregation_prompt TEXT,
        default_mode TEXT,
        is_built_in INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Add default_mode column to existing tables
    try {
      this.db.exec(`ALTER TABLE orchestration_templates ADD COLUMN default_mode TEXT`);
    } catch {
      // Column already exists
    }
  }

  insert(input: CreateOrchestrationTemplateInput, isBuiltIn = false): OrchestrationTemplate {
    const id = randomUUID();
    const now = this.clock().toISOString();

    this.db
      .prepare(
        `INSERT INTO orchestration_templates
          (id, name, description, category, stages_json, variables_json, aggregation_prompt, default_mode, is_built_in, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.description,
        input.category,
        JSON.stringify(input.stages),
        JSON.stringify(input.variables),
        input.aggregationPrompt ?? null,
        input.defaultMode ?? null,
        isBuiltIn ? 1 : 0,
        now,
        now
      );

    return this.getById(id)!;
  }

  getById(id: string): OrchestrationTemplate | null {
    const row = this.db
      .prepare("SELECT * FROM orchestration_templates WHERE id = ?")
      .get(id) as StoredOrchestrationTemplate | undefined;
    return row ? toTemplate(row) : null;
  }

  getByName(name: string): OrchestrationTemplate | null {
    const row = this.db
      .prepare("SELECT * FROM orchestration_templates WHERE name = ?")
      .get(name) as StoredOrchestrationTemplate | undefined;
    return row ? toTemplate(row) : null;
  }

  list(): OrchestrationTemplate[] {
    const rows = this.db
      .prepare("SELECT * FROM orchestration_templates ORDER BY is_built_in DESC, name ASC")
      .all() as StoredOrchestrationTemplate[];
    return rows.map(toTemplate);
  }

  update(id: string, input: UpdateOrchestrationTemplateInput): OrchestrationTemplate | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const now = this.clock().toISOString();
    const name = input.name ?? existing.name;
    const description = input.description ?? existing.description;
    const category = input.category ?? existing.category;
    const stages = input.stages ?? existing.stages;
    const variables = input.variables ?? existing.variables;
    const aggregationPrompt = input.aggregationPrompt !== undefined
      ? input.aggregationPrompt
      : existing.aggregationPrompt;
    const defaultMode = input.defaultMode !== undefined
      ? input.defaultMode
      : existing.defaultMode;

    this.db
      .prepare(
        `UPDATE orchestration_templates
         SET name = ?, description = ?, category = ?, stages_json = ?,
             variables_json = ?, aggregation_prompt = ?, default_mode = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        name,
        description,
        category,
        JSON.stringify(stages),
        JSON.stringify(variables),
        aggregationPrompt,
        defaultMode ?? null,
        now,
        id
      );

    return this.getById(id)!;
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM orchestration_templates WHERE id = ? AND is_built_in = 0")
      .run(id);
    return result.changes > 0;
  }

  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM orchestration_templates")
      .get() as { count: number };
    return row.count;
  }
}
