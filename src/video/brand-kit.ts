/**
 * Brand Kit System — CRUD for brand visual identity presets.
 * Issue #523: Store brand colors, fonts, logo, watermark, and template references.
 * Issue #955 (Epic #951 / Studio Pitch): extended with `font_heading`,
 * `font_body`, and `footer_text` columns via idempotent ALTER TABLE migrations.
 */
import type Database from "better-sqlite3";

export interface BrandKit {
  id: string;
  name: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  fontFamily: string;
  /** Heading font family (Pitch Brand Kit). Null on legacy rows. */
  fontHeading: string | null;
  /** Body font family (Pitch Brand Kit). Null on legacy rows. */
  fontBody: string | null;
  /** Optional footer line (Pitch Brand Kit). Null when unset. */
  footerText: string | null;
  /**
   * Sub-issue #1047 — default corner for the per-slide logo when a slide
   * does not specify its own `branding.logoPlacement`. Null on legacy
   * rows; renderer treats that as `bottom-right`.
   */
  defaultLogoPlacement:
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right"
    | "none"
    | null;
  /**
   * Sub-issue #1047 — deck-wide toggle for the slide-number indicator.
   * Null on legacy rows; renderer treats that as `false`.
   */
  showSlideNumbers: boolean | null;
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
  font_heading: string | null;
  font_body: string | null;
  footer_text: string | null;
  /** #1047 — nullable on legacy rows. */
  default_logo_placement: string | null;
  /** #1047 — SQLite booleans are 0/1; nullable on legacy rows. */
  show_slide_numbers: number | null;
  logo_path: string | null;
  watermark_path: string | null;
  intro_template_id: string | null;
  outro_template_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToKit(row: BrandKitRow): BrandKit {
  // #1047 — narrow the persisted string to the placement enum so callers
  // never have to revalidate. Unknown values fall back to null (legacy
  // safety) so the renderer can apply its own default.
  const placement = (() => {
    switch (row.default_logo_placement) {
      case "top-left":
      case "top-right":
      case "bottom-left":
      case "bottom-right":
      case "none":
        return row.default_logo_placement;
      default:
        return null;
    }
  })();
  return {
    id: row.id,
    name: row.name,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
    accentColor: row.accent_color,
    fontFamily: row.font_family,
    fontHeading: row.font_heading,
    fontBody: row.font_body,
    footerText: row.footer_text,
    defaultLogoPlacement: placement,
    showSlideNumbers:
      row.show_slide_numbers === null ? null : row.show_slide_numbers === 1,
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

    // Issue #955 — additive forward-compat columns. Each ALTER is wrapped in
    // try/catch so re-running migrate() against an already-migrated DB is a
    // no-op (mirrors src/webhooks/webhook-repository.ts pattern).
    const additiveColumns = [
      "ALTER TABLE brand_kits ADD COLUMN font_heading TEXT",
      "ALTER TABLE brand_kits ADD COLUMN font_body TEXT",
      "ALTER TABLE brand_kits ADD COLUMN footer_text TEXT",
      // #1047 — brand-kit defaults for the per-slide logo + slide-number.
      "ALTER TABLE brand_kits ADD COLUMN default_logo_placement TEXT",
      "ALTER TABLE brand_kits ADD COLUMN show_slide_numbers INTEGER",
    ];
    for (const ddl of additiveColumns) {
      try {
        this.db.exec(ddl);
      } catch (err) {
        if (!/duplicate column name/i.test(String(err))) {
          throw err;
        }
      }
    }
  }

  create(
    kit: Omit<
      BrandKit,
      | "createdAt"
      | "updatedAt"
      | "fontHeading"
      | "fontBody"
      | "footerText"
      | "defaultLogoPlacement"
      | "showSlideNumbers"
    > &
      Partial<
        Pick<
          BrandKit,
          | "fontHeading"
          | "fontBody"
          | "footerText"
          | "defaultLogoPlacement"
          | "showSlideNumbers"
        >
      >,
  ): BrandKit {
    const now = new Date().toISOString();
    const fontHeading = kit.fontHeading ?? null;
    const fontBody = kit.fontBody ?? null;
    const footerText = kit.footerText ?? null;
    const defaultLogoPlacement = kit.defaultLogoPlacement ?? null;
    const showSlideNumbers =
      kit.showSlideNumbers === undefined || kit.showSlideNumbers === null
        ? null
        : kit.showSlideNumbers;
    this.db
      .prepare(
        `INSERT INTO brand_kits (id, name, primary_color, secondary_color, accent_color, font_family,
        font_heading, font_body, footer_text,
        default_logo_placement, show_slide_numbers,
        logo_path, watermark_path, intro_template_id, outro_template_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        kit.id,
        kit.name,
        kit.primaryColor,
        kit.secondaryColor,
        kit.accentColor,
        kit.fontFamily,
        fontHeading,
        fontBody,
        footerText,
        defaultLogoPlacement,
        showSlideNumbers === null ? null : showSlideNumbers ? 1 : 0,
        kit.logoPath ?? null,
        kit.watermarkPath ?? null,
        kit.introTemplateId ?? null,
        kit.outroTemplateId ?? null,
        now,
        now,
      );
    return {
      ...kit,
      fontHeading,
      fontBody,
      footerText,
      defaultLogoPlacement,
      showSlideNumbers,
      createdAt: now,
      updatedAt: now,
    };
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
      fontHeading:
        fields.fontHeading !== undefined
          ? fields.fontHeading
          : existing.fontHeading,
      fontBody:
        fields.fontBody !== undefined ? fields.fontBody : existing.fontBody,
      footerText:
        fields.footerText !== undefined
          ? fields.footerText
          : existing.footerText,
      defaultLogoPlacement:
        fields.defaultLogoPlacement !== undefined
          ? fields.defaultLogoPlacement
          : existing.defaultLogoPlacement,
      showSlideNumbers:
        fields.showSlideNumbers !== undefined
          ? fields.showSlideNumbers
          : existing.showSlideNumbers,
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
        font_family = ?, font_heading = ?, font_body = ?, footer_text = ?,
        default_logo_placement = ?, show_slide_numbers = ?,
        logo_path = ?, watermark_path = ?, intro_template_id = ?,
        outro_template_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        merged.name,
        merged.primaryColor,
        merged.secondaryColor,
        merged.accentColor,
        merged.fontFamily,
        merged.fontHeading,
        merged.fontBody,
        merged.footerText,
        merged.defaultLogoPlacement,
        merged.showSlideNumbers === null
          ? null
          : merged.showSlideNumbers
            ? 1
            : 0,
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
