/**
 * Post Template System — SQLite-backed post templates with brand kit integration.
 * Issue #776: Reusable social media post templates with layout, brand kit binding, and platform targeting.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface PostTemplate {
  id: string;
  name: string;
  description: string;
  platform: string;
  layout: string;
  contentTemplate: string;
  brandKitId: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface PostTemplateRow {
  id: string;
  name: string;
  description: string;
  platform: string;
  layout: string;
  content_template: string;
  brand_kit_id: string | null;
  tags: string;
  created_at: string;
  updated_at: string;
}

function rowToTemplate(row: PostTemplateRow): PostTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    platform: row.platform,
    layout: row.layout,
    contentTemplate: row.content_template,
    brandKitId: row.brand_kit_id,
    tags: JSON.parse(row.tags || "[]") as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreatePostTemplateInput {
  name: string;
  description?: string;
  platform: string;
  layout: string;
  contentTemplate: string;
  brandKitId?: string | null;
  tags?: string[];
}

export interface UpdatePostTemplateInput {
  name?: string;
  description?: string;
  platform?: string;
  layout?: string;
  contentTemplate?: string;
  brandKitId?: string | null;
  tags?: string[];
}

export class PostTemplateRepository {
  constructor(
    private db: Database.Database,
    private clock?: () => Date,
  ) {}

  private now(): string {
    return (this.clock?.() ?? new Date()).toISOString();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS post_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL,
        layout TEXT NOT NULL DEFAULT 'default',
        content_template TEXT NOT NULL DEFAULT '',
        brand_kit_id TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (brand_kit_id) REFERENCES brand_kits(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_post_templates_platform ON post_templates(platform);
      CREATE INDEX IF NOT EXISTS idx_post_templates_brand_kit ON post_templates(brand_kit_id);
    `);
  }

  create(input: CreatePostTemplateInput): PostTemplate {
    const now = this.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO post_templates (id, name, description, platform, layout, content_template, brand_kit_id, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.description ?? "",
        input.platform,
        input.layout,
        input.contentTemplate,
        input.brandKitId ?? null,
        JSON.stringify(input.tags ?? []),
        now,
        now,
      );
    return this.getById(id)!;
  }

  getById(id: string): PostTemplate | null {
    const row = this.db
      .prepare("SELECT * FROM post_templates WHERE id = ?")
      .get(id) as PostTemplateRow | undefined;
    return row ? rowToTemplate(row) : null;
  }

  list(
    filters: { platform?: string; brandKitId?: string } = {},
  ): PostTemplate[] {
    let sql = "SELECT * FROM post_templates WHERE 1=1";
    const params: unknown[] = [];
    if (filters.platform) {
      sql += " AND platform = ?";
      params.push(filters.platform);
    }
    if (filters.brandKitId) {
      sql += " AND brand_kit_id = ?";
      params.push(filters.brandKitId);
    }
    sql += " ORDER BY updated_at DESC";
    const rows = this.db.prepare(sql).all(...params) as PostTemplateRow[];
    return rows.map(rowToTemplate);
  }

  update(id: string, fields: UpdatePostTemplateInput): PostTemplate | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const now = this.now();
    const merged = {
      name: fields.name ?? existing.name,
      description: fields.description ?? existing.description,
      platform: fields.platform ?? existing.platform,
      layout: fields.layout ?? existing.layout,
      contentTemplate: fields.contentTemplate ?? existing.contentTemplate,
      brandKitId:
        fields.brandKitId !== undefined
          ? fields.brandKitId
          : existing.brandKitId,
      tags: fields.tags ?? existing.tags,
    };
    this.db
      .prepare(
        `UPDATE post_templates SET name=?, description=?, platform=?, layout=?, content_template=?, brand_kit_id=?, tags=?, updated_at=? WHERE id=?`,
      )
      .run(
        merged.name,
        merged.description,
        merged.platform,
        merged.layout,
        merged.contentTemplate,
        merged.brandKitId,
        JSON.stringify(merged.tags),
        now,
        id,
      );
    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM post_templates WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  applyTemplate(
    templateId: string,
    variables: Record<string, string>,
  ): { content: string; platform: string } | null {
    const template = this.getById(templateId);
    if (!template) return null;
    let content = template.contentTemplate;
    for (const [key, value] of Object.entries(variables)) {
      content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }
    return { content, platform: template.platform };
  }
}
