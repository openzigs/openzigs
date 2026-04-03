/**
 * Video Generation Presets — SQLite Repository
 * Issue #757: Persistence layer for reusable video generation preset configs.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface VideoPresetConfig {
  width?: number;
  height?: number;
  numFrames?: number;
  fps?: number;
  pipeline?: string;
  tiling?: string;
  audio?: boolean;
  enhancePrompt?: boolean;
  model?: string;
  modelRepo?: string;
  imageStrength?: number;
}

export interface VideoPreset {
  id: string;
  name: string;
  description: string | null;
  config: VideoPresetConfig;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

interface StoredVideoPreset {
  id: string;
  name: string;
  description: string | null;
  config: string;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

const BUILT_IN_PRESETS: Array<{
  id: string;
  name: string;
  description: string;
  config: VideoPresetConfig;
}> = [
  {
    id: "quick-draft",
    name: "Quick Draft",
    description: "Fast preview — low resolution, short duration",
    config: {
      width: 512,
      height: 320,
      numFrames: 49,
      fps: 24,
      pipeline: "distilled",
      tiling: "aggressive",
      audio: false,
      enhancePrompt: false,
    },
  },
  {
    id: "standard",
    name: "Standard",
    description: "Balanced quality and speed",
    config: {
      width: 768,
      height: 512,
      numFrames: 97,
      fps: 24,
      pipeline: "distilled",
      tiling: "aggressive",
      audio: true,
      enhancePrompt: false,
    },
  },
  {
    id: "high-quality",
    name: "High Quality",
    description: "Maximum quality — 2-stage pipeline, higher resolution",
    config: {
      width: 1024,
      height: 768,
      numFrames: 121,
      fps: 24,
      pipeline: "dev-two-stage",
      tiling: "auto",
      audio: true,
      enhancePrompt: true,
    },
  },
];

const toPreset = (row: StoredVideoPreset): VideoPreset => ({
  id: row.id,
  name: row.name,
  description: row.description,
  config: JSON.parse(row.config) as VideoPresetConfig,
  isBuiltin: row.is_builtin === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class VideoPresetsRepository {
  private db: Database.Database;
  private clock: () => Date;

  constructor(db: Database.Database, clock?: () => Date) {
    this.db = db;
    this.clock = clock ?? (() => new Date());
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS video_presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        config TEXT NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Seed built-in presets if they don't exist
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO video_presets (id, name, description, config, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `);

    const now = this.clock().toISOString();
    for (const preset of BUILT_IN_PRESETS) {
      insert.run(
        preset.id,
        preset.name,
        preset.description,
        JSON.stringify(preset.config),
        now,
        now,
      );
    }
  }

  listPresets(): VideoPreset[] {
    const rows = this.db
      .prepare("SELECT * FROM video_presets ORDER BY is_builtin DESC, name ASC")
      .all() as StoredVideoPreset[];
    return rows.map(toPreset);
  }

  getPreset(id: string): VideoPreset | null {
    const row = this.db
      .prepare("SELECT * FROM video_presets WHERE id = ?")
      .get(id) as StoredVideoPreset | undefined;
    return row ? toPreset(row) : null;
  }

  createPreset(
    name: string,
    description: string | null,
    config: VideoPresetConfig,
  ): VideoPreset {
    const id = randomUUID();
    const now = this.clock().toISOString();
    this.db
      .prepare(
        `INSERT INTO video_presets (id, name, description, config, is_builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(id, name, description, JSON.stringify(config), now, now);
    return this.getPreset(id)!;
  }

  updatePreset(
    id: string,
    updates: {
      name?: string;
      description?: string | null;
      config?: VideoPresetConfig;
    },
  ): VideoPreset | null {
    const existing = this.getPreset(id);
    if (!existing) return null;
    if (existing.isBuiltin) {
      throw new Error("Cannot update built-in presets");
    }

    const now = this.clock().toISOString();
    const name = updates.name ?? existing.name;
    const description =
      updates.description !== undefined
        ? updates.description
        : existing.description;
    const config = updates.config ?? existing.config;

    this.db
      .prepare(
        `UPDATE video_presets SET name = ?, description = ?, config = ?, updated_at = ? WHERE id = ?`,
      )
      .run(name, description, JSON.stringify(config), now, id);
    return this.getPreset(id);
  }

  deletePreset(id: string): boolean {
    const existing = this.getPreset(id);
    if (!existing) return false;
    if (existing.isBuiltin) {
      throw new Error("Cannot delete built-in presets");
    }
    this.db.prepare("DELETE FROM video_presets WHERE id = ?").run(id);
    return true;
  }
}
