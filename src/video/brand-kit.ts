/**
 * Brand Kit System — CRUD for brand visual identity presets.
 * Issue #523: Store brand colors, fonts, logo, watermark, and template references.
 */
import type Database from "better-sqlite3";

export interface BrandKit {
  id: string;
  name: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  fontFamily: string;
  logoPath: string | null;
  watermarkPath: string | null;
  introTemplateId: string | null;
  outroTemplateId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BrandKitRow {
  id: string;
  name: string;
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  font_family: string;
  logo_path: string | null;
  watermark_path: string | null;
  intro_template_id: string | null;
  outro_template_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToKit(row: BrandKitRow): BrandKit {
  return {
    id: row.id,
    name: row.name,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
    accentColor: row.accent_color,
    fontFamily: row.font_family,
    logoPath: row.logo_path,
    watermarkPath: row.watermark_path,
    introTemplateId: row.intro_template_id,
    outroTemplateId: row.outro_template_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class BrandKitRepository {
  constructor(private db: Database.Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS brand_kits (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        primary_color TEXT NOT NULL DEFAULT '#000000',
        secondary_color TEXT NOT NULL DEFAULT '#ffffff',
        accent_color TEXT NOT NULL DEFAULT '#0066ff',
        font_family TEXT NOT NULL DEFAULT 'Inter',
        logo_path TEXT,
        watermark_path TEXT,
        intro_template_id TEXT,
        outro_template_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  create(kit: Omit<BrandKit, "createdAt" | "updatedAt">): BrandKit {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO brand_kits (id, name, primary_color, secondary_color, accent_color, font_family,
        logo_path, watermark_path, intro_template_id, outro_template_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        kit.id,
        kit.name,
        kit.primaryColor,
        kit.secondaryColor,
        kit.accentColor,
        kit.fontFamily,
        kit.logoPath ?? null,
        kit.watermarkPath ?? null,
        kit.introTemplateId ?? null,
        kit.outroTemplateId ?? null,
        now,
        now,
      );
    return { ...kit, createdAt: now, updatedAt: now };
  }

  getById(id: string): BrandKit | null {
    const row = this.db
      .prepare(`SELECT * FROM brand_kits WHERE id = ?`)
      .get(id) as BrandKitRow | undefined;
    return row ? rowToKit(row) : null;
  }

  getAll(): BrandKit[] {
    const rows = this.db
      .prepare(`SELECT * FROM brand_kits ORDER BY name ASC`)
      .all() as BrandKitRow[];
    return rows.map(rowToKit);
  }

  update(
    id: string,
    fields: Partial<Omit<BrandKit, "id" | "createdAt" | "updatedAt">>,
  ): BrandKit | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const merged = {
      name: fields.name ?? existing.name,
      primaryColor: fields.primaryColor ?? existing.primaryColor,
      secondaryColor: fields.secondaryColor ?? existing.secondaryColor,
      accentColor: fields.accentColor ?? existing.accentColor,
      fontFamily: fields.fontFamily ?? existing.fontFamily,
      logoPath:
        fields.logoPath !== undefined ? fields.logoPath : existing.logoPath,
      watermarkPath:
        fields.watermarkPath !== undefined
          ? fields.watermarkPath
          : existing.watermarkPath,
      introTemplateId:
        fields.introTemplateId !== undefined
          ? fields.introTemplateId
          : existing.introTemplateId,
      outroTemplateId:
        fields.outroTemplateId !== undefined
          ? fields.outroTemplateId
          : existing.outroTemplateId,
    };

    this.db
      .prepare(
        `UPDATE brand_kits SET name = ?, primary_color = ?, secondary_color = ?, accent_color = ?,
        font_family = ?, logo_path = ?, watermark_path = ?, intro_template_id = ?,
        outro_template_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        merged.name,
        merged.primaryColor,
        merged.secondaryColor,
        merged.accentColor,
        merged.fontFamily,
        merged.logoPath,
        merged.watermarkPath,
        merged.introTemplateId,
        merged.outroTemplateId,
        now,
        id,
      );

    return { ...existing, ...merged, updatedAt: now };
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM brand_kits WHERE id = ?`)
      .run(id);
    return result.changes > 0;
  }
}
