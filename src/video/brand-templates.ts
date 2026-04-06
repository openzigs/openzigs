/**
 * Brand Video Templates — #827
 *
 * Definitions for animated intro, outro, and lower-third templates.
 * Each template references brand kit values (colors, fonts, logo) and
 * can be rendered via Remotion compositions.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// ── Template definitions ────────────────────────────────────────

export type BrandTemplateType = "intro" | "outro" | "lower-third";
export type BrandTemplateStyle =
  | "logo-fade"
  | "logo-slide"
  | "title-card"
  | "subscribe-cta"
  | "next-video"
  | "bar"
  | "minimal";

export interface BrandTemplateDefinition {
  id: string;
  type: BrandTemplateType;
  style: BrandTemplateStyle;
  name: string;
  description: string;
  durationFrames: number; // default duration at 30fps
  animationConfig: AnimationConfig;
}

export interface AnimationConfig {
  easing: "ease-in" | "ease-out" | "ease-in-out" | "spring";
  fadeInFrames: number;
  holdFrames: number;
  fadeOutFrames: number;
  direction?: "left" | "right" | "up" | "down";
}

export interface SavedBrandTemplate {
  id: string;
  brandKitId: string;
  templateDefId: string;
  customTitle: string | null;
  customSubtitle: string | null;
  customDurationFrames: number | null;
  autoApply: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Built-in template library ──────────────────────────────────

export const BUILT_IN_TEMPLATES: BrandTemplateDefinition[] = [
  // Intros
  {
    id: "intro-logo-fade",
    type: "intro",
    style: "logo-fade",
    name: "Logo Reveal (Fade)",
    description: "Logo fade-in → hold → fade-out over brand color background",
    durationFrames: 90,
    animationConfig: {
      easing: "ease-in-out",
      fadeInFrames: 20,
      holdFrames: 50,
      fadeOutFrames: 20,
    },
  },
  {
    id: "intro-logo-slide",
    type: "intro",
    style: "logo-slide",
    name: "Logo Reveal (Slide)",
    description: "Logo slides in from left with brand color wipe",
    durationFrames: 90,
    animationConfig: {
      easing: "spring",
      fadeInFrames: 25,
      holdFrames: 45,
      fadeOutFrames: 20,
      direction: "left",
    },
  },
  {
    id: "intro-title-card",
    type: "intro",
    style: "title-card",
    name: "Title Card",
    description: "Episode title types in over logo with brand gradient",
    durationFrames: 120,
    animationConfig: {
      easing: "ease-out",
      fadeInFrames: 30,
      holdFrames: 60,
      fadeOutFrames: 30,
    },
  },
  // Outros
  {
    id: "outro-subscribe",
    type: "outro",
    style: "subscribe-cta",
    name: "Subscribe CTA",
    description: "Subscribe call-to-action with social handles sliding in",
    durationFrames: 150,
    animationConfig: {
      easing: "spring",
      fadeInFrames: 30,
      holdFrames: 90,
      fadeOutFrames: 30,
      direction: "up",
    },
  },
  {
    id: "outro-next-video",
    type: "outro",
    style: "next-video",
    name: "Up Next",
    description: '"Up Next" placeholder with social handles and logo',
    durationFrames: 150,
    animationConfig: {
      easing: "ease-in-out",
      fadeInFrames: 25,
      holdFrames: 100,
      fadeOutFrames: 25,
    },
  },
  // Lower-thirds
  {
    id: "lt-bar",
    type: "lower-third",
    style: "bar",
    name: "Animated Bar",
    description: "Animated brand color bar slides up with name and title",
    durationFrames: 0, // hold indefinitely
    animationConfig: {
      easing: "spring",
      fadeInFrames: 15,
      holdFrames: 0,
      fadeOutFrames: 15,
      direction: "up",
    },
  },
  {
    id: "lt-minimal",
    type: "lower-third",
    style: "minimal",
    name: "Minimal Text",
    description: "Subtle text fade with thin colored underline",
    durationFrames: 0,
    animationConfig: {
      easing: "ease-in",
      fadeInFrames: 20,
      holdFrames: 0,
      fadeOutFrames: 20,
    },
  },
];

// ── Lookups ────────────────────────────────────────────────────

export function getBuiltInTemplate(
  id: string,
): BrandTemplateDefinition | undefined {
  return BUILT_IN_TEMPLATES.find((t) => t.id === id);
}

export function getBuiltInTemplatesByType(
  type: BrandTemplateType,
): BrandTemplateDefinition[] {
  return BUILT_IN_TEMPLATES.filter((t) => t.type === type);
}

// ── Repository ─────────────────────────────────────────────────

interface SavedRow {
  id: string;
  brand_kit_id: string;
  template_def_id: string;
  custom_title: string | null;
  custom_subtitle: string | null;
  custom_duration_frames: number | null;
  auto_apply: number;
  created_at: string;
  updated_at: string;
}

function rowToSaved(row: SavedRow): SavedBrandTemplate {
  return {
    id: row.id,
    brandKitId: row.brand_kit_id,
    templateDefId: row.template_def_id,
    customTitle: row.custom_title,
    customSubtitle: row.custom_subtitle,
    customDurationFrames: row.custom_duration_frames,
    autoApply: row.auto_apply === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class BrandTemplateRepository {
  constructor(private db: Database.Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS brand_templates (
        id TEXT PRIMARY KEY,
        brand_kit_id TEXT NOT NULL,
        template_def_id TEXT NOT NULL,
        custom_title TEXT,
        custom_subtitle TEXT,
        custom_duration_frames INTEGER,
        auto_apply INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  create(input: {
    brandKitId: string;
    templateDefId: string;
    customTitle?: string;
    customSubtitle?: string;
    customDurationFrames?: number;
    autoApply?: boolean;
  }): SavedBrandTemplate {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO brand_templates (id, brand_kit_id, template_def_id, custom_title, custom_subtitle, custom_duration_frames, auto_apply, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        input.brandKitId,
        input.templateDefId,
        input.customTitle ?? null,
        input.customSubtitle ?? null,
        input.customDurationFrames ?? null,
        input.autoApply ? 1 : 0,
        now,
        now,
      );
    return this.getById(id)!;
  }

  getById(id: string): SavedBrandTemplate | null {
    const row = this.db
      .prepare("SELECT * FROM brand_templates WHERE id = ?")
      .get(id) as SavedRow | undefined;
    return row ? rowToSaved(row) : null;
  }

  listByBrandKit(brandKitId: string): SavedBrandTemplate[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM brand_templates WHERE brand_kit_id = ? ORDER BY created_at DESC",
      )
      .all(brandKitId) as SavedRow[];
    return rows.map(rowToSaved);
  }

  listAutoApply(brandKitId: string): SavedBrandTemplate[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM brand_templates WHERE brand_kit_id = ? AND auto_apply = 1",
      )
      .all(brandKitId) as SavedRow[];
    return rows.map(rowToSaved);
  }

  update(
    id: string,
    input: Partial<{
      customTitle: string | null;
      customSubtitle: string | null;
      customDurationFrames: number | null;
      autoApply: boolean;
    }>,
  ): SavedBrandTemplate | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE brand_templates SET
        custom_title = COALESCE(?, custom_title),
        custom_subtitle = COALESCE(?, custom_subtitle),
        custom_duration_frames = COALESCE(?, custom_duration_frames),
        auto_apply = COALESCE(?, auto_apply),
        updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        input.customTitle !== undefined ? input.customTitle : null,
        input.customSubtitle !== undefined ? input.customSubtitle : null,
        input.customDurationFrames !== undefined
          ? input.customDurationFrames
          : null,
        input.autoApply !== undefined ? (input.autoApply ? 1 : 0) : null,
        now,
        id,
      );
    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM brand_templates WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }
}
