import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

/**
 * Structured Brand Voice Rulebook extracted by the Linguistic Profiler.
 * Single source of truth for how the user writes.
 */
export interface BrandVoiceRulebook {
  /** Short vibe descriptor, e.g. "authoritative but casual, slightly sarcastic" */
  tone: string;
  /** Pacing & length descriptor, e.g. "prefers short, punchy sentences. Frequently uses em-dashes." */
  sentence_structure: string;
  /** Word choice descriptor, e.g. "B2B professional, zero fluff" */
  vocabulary_level: string;
  /** How they use bolding, bullet points, paragraphs */
  formatting_quirks: string;
  /** Words the author avoids + standard AI slop words */
  banned_words: string[];
}

export interface BrandVoice {
  id: string;
  name: string;
  rulebook: BrandVoiceRulebook;
  /** Whether this voice is the active default across all pipelines */
  active: boolean;
  /** Original writing samples used for analysis (JSON array) */
  samples: string[];
  createdAt: string;
  updatedAt: string;
}

export interface BrandVoiceCreate {
  name: string;
  rulebook: BrandVoiceRulebook;
  samples: string[];
  active?: boolean;
}

export interface BrandVoiceUpdate {
  name?: string;
  rulebook?: BrandVoiceRulebook;
  active?: boolean;
}

type StoredBrandVoice = {
  id: string;
  name: string;
  rulebook: string;
  active: number;
  samples: string;
  created_at: string;
  updated_at: string;
};

export class BrandVoiceRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.migrate();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS brand_voices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        rulebook TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        samples TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  create(input: BrandVoiceCreate): BrandVoice {
    const id = randomUUID();
    const now = this.clock().toISOString();

    // If setting this voice as active, deactivate all others first
    if (input.active) {
      this.db.prepare("UPDATE brand_voices SET active = 0").run();
    }

    this.db
      .prepare(
        `INSERT INTO brand_voices (id, name, rulebook, active, samples, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        JSON.stringify(input.rulebook),
        input.active ? 1 : 0,
        JSON.stringify(input.samples),
        now,
        now,
      );

    return this.getById(id)!;
  }

  getById(id: string): BrandVoice | null {
    const row = this.db
      .prepare("SELECT * FROM brand_voices WHERE id = ?")
      .get(id) as StoredBrandVoice | undefined;
    return row ? this.toModel(row) : null;
  }

  getAll(): BrandVoice[] {
    const rows = this.db
      .prepare("SELECT * FROM brand_voices ORDER BY created_at DESC")
      .all() as StoredBrandVoice[];
    return rows.map((r) => this.toModel(r));
  }

  getActive(): BrandVoice | null {
    const row = this.db
      .prepare("SELECT * FROM brand_voices WHERE active = 1")
      .get() as StoredBrandVoice | undefined;
    return row ? this.toModel(row) : null;
  }

  update(id: string, input: BrandVoiceUpdate): BrandVoice | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const now = this.clock().toISOString();

    // If activating this voice, deactivate all others first
    if (input.active) {
      this.db.prepare("UPDATE brand_voices SET active = 0").run();
    }

    const name = input.name ?? existing.name;
    const rulebook = input.rulebook ?? existing.rulebook;
    const active = input.active ?? existing.active;

    this.db
      .prepare(
        `UPDATE brand_voices
         SET name = ?, rulebook = ?, active = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(name, JSON.stringify(rulebook), active ? 1 : 0, now, id);

    return this.getById(id);
  }

  setActive(id: string): BrandVoice | null {
    const existing = this.getById(id);
    if (!existing) return null;

    this.db.prepare("UPDATE brand_voices SET active = 0").run();
    this.db.prepare("UPDATE brand_voices SET active = 1, updated_at = ? WHERE id = ?").run(
      this.clock().toISOString(),
      id,
    );

    return this.getById(id);
  }

  deactivateAll(): void {
    this.db.prepare("UPDATE brand_voices SET active = 0").run();
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM brand_voices WHERE id = ?").run(id);
    return result.changes > 0;
  }

  private toModel(row: StoredBrandVoice): BrandVoice {
    return {
      id: row.id,
      name: row.name,
      rulebook: JSON.parse(row.rulebook) as BrandVoiceRulebook,
      active: row.active === 1,
      samples: JSON.parse(row.samples) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
