/**
 * Character Repository — SQLite persistence for Character Profiles.
 * Issue #375: LoRA-based character identity consistency.
 *
 * Stores character metadata, reference photo paths, training status,
 * and trained LoRA adapter paths for use in image generation.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { logger } from "../logging/logger.js";

// ── Types ───────────────────────────────────────────────────

export type CharacterStatus = "pending" | "training" | "ready" | "failed";

export interface CharacterProfile {
  id: string;
  name: string;
  description: string;
  triggerWord: string;
  referencePhotos: string[];
  photoCaptions: Record<string, string>;
  trainedLoraPath: string | null;
  loraScale: number;
  trainingConfig: Record<string, unknown> | null;
  /**
   * Base diffusion model the LoRA adapter was trained against
   * (e.g. "sdxl", "flux-dev", "flux-schnell", "sd15"). When set, the LoRA
   * injection layer forces inference to use this model so a SDXL-trained
   * adapter is never silently loaded into a FLUX pipe (and vice-versa).
   * WS3-C (#932).
   */
  baseModel: string | null;
  status: CharacterStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterCreate {
  name: string;
  description?: string;
  triggerWord: string;
  referencePhotos?: string[];
  photoCaptions?: Record<string, string>;
  loraScale?: number;
  trainingConfig?: Record<string, unknown>;
  baseModel?: string | null;
}

export interface CharacterUpdate {
  name?: string;
  description?: string;
  triggerWord?: string;
  referencePhotos?: string[];
  photoCaptions?: Record<string, string>;
  trainedLoraPath?: string | null;
  loraScale?: number;
  trainingConfig?: Record<string, unknown> | null;
  baseModel?: string | null;
  status?: CharacterStatus;
  errorMessage?: string | null;
}

type StoredCharacter = {
  id: string;
  name: string;
  description: string | null;
  trigger_word: string;
  reference_photos: string;
  photo_captions: string | null;
  trained_lora_path: string | null;
  lora_scale: number;
  training_config: string | null;
  base_model: string | null;
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

// ── Repository ──────────────────────────────────────────────

export class CharacterRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS character_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        trigger_word TEXT NOT NULL,
        reference_photos TEXT NOT NULL DEFAULT '[]',
        trained_lora_path TEXT,
        lora_scale REAL NOT NULL DEFAULT 0.8,
        training_config TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Runtime migration: add description column for existing tables
    try {
      this.db.exec(`ALTER TABLE character_profiles ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }

    // Runtime migration: add photo_captions column for per-image training prompts
    try {
      this.db.exec(`ALTER TABLE character_profiles ADD COLUMN photo_captions TEXT NOT NULL DEFAULT '{}'`);
    } catch {
      // Column already exists
    }

    // WS3-C (#932): Track which base model the LoRA was trained against so
    // the injection layer can force-pin the inference model and avoid silent
    // SDXL-LoRA-into-FLUX-pipe mismatches.
    try {
      this.db.exec(`ALTER TABLE character_profiles ADD COLUMN base_model TEXT`);
    } catch {
      // Column already exists
    }
  }

  create(input: CharacterCreate): CharacterProfile {
    const id = randomUUID();
    const now = this.clock().toISOString();

    this.db
      .prepare(
        `INSERT INTO character_profiles
           (id, name, description, trigger_word, reference_photos, photo_captions, lora_scale, training_config, base_model, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.description ?? "",
        input.triggerWord,
        JSON.stringify(input.referencePhotos ?? []),
        JSON.stringify(input.photoCaptions ?? {}),
        input.loraScale ?? 0.8,
        input.trainingConfig ? JSON.stringify(input.trainingConfig) : null,
        input.baseModel ?? null,
        now,
        now,
      );

    return this.getById(id)!;
  }

  getById(id: string): CharacterProfile | null {
    const row = this.db
      .prepare("SELECT * FROM character_profiles WHERE id = ?")
      .get(id) as StoredCharacter | undefined;
    return row ? this.toModel(row) : null;
  }

  getAll(): CharacterProfile[] {
    const rows = this.db
      .prepare("SELECT * FROM character_profiles ORDER BY created_at DESC")
      .all() as StoredCharacter[];
    return rows.map((r) => this.toModel(r));
  }

  getByStatus(status: CharacterStatus): CharacterProfile[] {
    const rows = this.db
      .prepare("SELECT * FROM character_profiles WHERE status = ? ORDER BY created_at DESC")
      .all(status) as StoredCharacter[];
    return rows.map((r) => this.toModel(r));
  }

  update(id: string, input: CharacterUpdate): CharacterProfile | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const now = this.clock().toISOString();
    const name = input.name ?? existing.name;
    const description = input.description ?? existing.description;
    const triggerWord = input.triggerWord ?? existing.triggerWord;
    const referencePhotos = input.referencePhotos ?? existing.referencePhotos;
    const photoCaptions = input.photoCaptions ?? existing.photoCaptions;
    const trainedLoraPath = input.trainedLoraPath !== undefined ? input.trainedLoraPath : existing.trainedLoraPath;
    const loraScale = input.loraScale ?? existing.loraScale;
    const trainingConfig = input.trainingConfig !== undefined ? input.trainingConfig : existing.trainingConfig;
    const baseModel = input.baseModel !== undefined ? input.baseModel : existing.baseModel;
    const status = input.status ?? existing.status;
    const errorMessage = input.errorMessage !== undefined ? input.errorMessage : existing.errorMessage;

    this.db
      .prepare(
        `UPDATE character_profiles
         SET name = ?, description = ?, trigger_word = ?, reference_photos = ?,
             photo_captions = ?, trained_lora_path = ?, lora_scale = ?, training_config = ?,
             base_model = ?, status = ?, error_message = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        name,
        description,
        triggerWord,
        JSON.stringify(referencePhotos),
        JSON.stringify(photoCaptions),
        trainedLoraPath,
        loraScale,
        trainingConfig ? JSON.stringify(trainingConfig) : null,
        baseModel,
        status,
        errorMessage,
        now,
        id,
      );

    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM character_profiles WHERE id = ?").run(id);
    return result.changes > 0;
  }

  private toModel(row: StoredCharacter): CharacterProfile {
    try {
      return {
        id: row.id,
        name: row.name,
        description: row.description ?? "",
        triggerWord: row.trigger_word,
        referencePhotos: JSON.parse(row.reference_photos) as string[],
        photoCaptions: row.photo_captions ? (JSON.parse(row.photo_captions) as Record<string, string>) : {},
        trainedLoraPath: row.trained_lora_path,
        loraScale: row.lora_scale,
        trainingConfig: row.training_config ? (JSON.parse(row.training_config) as Record<string, unknown>) : null,
        baseModel: row.base_model ?? null,
        status: row.status as CharacterStatus,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch (error) {
      logger.warn(`[CharacterRepository] Failed to parse JSON for character ${row.id}`, { error });
      return {
        id: row.id,
        name: row.name,
        description: row.description ?? "",
        triggerWord: row.trigger_word,
        referencePhotos: [],
        photoCaptions: {},
        trainedLoraPath: row.trained_lora_path,
        loraScale: row.lora_scale,
        trainingConfig: null,
        baseModel: row.base_model ?? null,
        status: row.status as CharacterStatus,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }
  }
}
