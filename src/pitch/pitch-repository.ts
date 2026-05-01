/**
 * Pitch SQLite repository — decks, slides, and assets.
 *
 * Mirrors the patterns in `WebhookRepository` and `PromptManager`:
 *  - constructor takes `db` + optional `clock` for deterministic time in tests
 *  - `migrate()` runs `CREATE TABLE IF NOT EXISTS` + per-column `ALTER TABLE`
 *    inside try/catch (idempotent forward-compat)
 *  - all writes go through field-allowlists; no caller-supplied identifier
 *    ever reaches a SQL fragment
 *
 * See research §7 for the full DDL and Epic #951 / sub-issue #956.
 */
import type Database from "better-sqlite3";
import {
  DeckSchema,
  SlideAssetSchema,
  SlideSchema,
  type Deck,
  type Slide,
  type SlideAsset,
  type SlideImage,
} from "./pitch-schema.js";

// ── Public API types (rich, JSON-decoded) ──────────────────────────────────

/** Persisted deck row mapped back to the `Deck` shape. */
export type DeckRecord = Deck;

/** Persisted slide row, expanded to include positioning + identity. */
export interface SlideRecord {
  id: string;
  deck_id: string;
  position: number;
  slide: Slide;
  created_at: string;
  updated_at: string;
}

/** Asset row (decoded from the `pitch_assets` table). */
export type AssetRecord = SlideAsset;

// ── Insert/update DTOs ─────────────────────────────────────────────────────

export interface InsertDeckInput {
  id: string;
  title: string;
  brand_kit_id: string;
  aspect_ratio?: Deck["aspect_ratio"];
  metadata: Deck["metadata"];
  slides: Array<{ id: string; slide: Slide }>;
}

export interface UpdateDeckInput {
  title?: string;
  brand_kit_id?: string;
  aspect_ratio?: Deck["aspect_ratio"];
  metadata?: Deck["metadata"];
}

export interface InsertSlideInput {
  id: string;
  deck_id: string;
  position: number;
  slide: Slide;
}

// ── Raw SQLite row shapes (snake_case) ─────────────────────────────────────

interface DeckRow {
  id: string;
  title: string;
  brand_kit_id: string;
  aspect_ratio: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface SlideRow {
  id: string;
  deck_id: string;
  position: number;
  template: string;
  content: string;
  speaker_notes: string;
  transition: string;
  fragments: string;
  background_image_prompt: string | null;
  source_anchor: string | null;
  image_style: string | null;
  created_at: string;
  updated_at: string;
}

interface AssetRow {
  id: string;
  deck_id: string;
  slide_id: string | null;
  kind: string;
  source: string;
  prompt: string | null;
  local_path: string;
  mime: string;
  width: number;
  height: number;
  created_at: string;
}

// ── Repository ─────────────────────────────────────────────────────────────

export class PitchRepository {
  private readonly db: Database.Database;
  private readonly clock: () => Date;

  constructor(db: Database.Database, clock: () => Date = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }

  // ── Schema ────────────────────────────────────────────────────────────

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pitch_decks (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        brand_kit_id  TEXT NOT NULL,
        aspect_ratio  TEXT NOT NULL DEFAULT '16:9',
        metadata      TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        FOREIGN KEY (brand_kit_id) REFERENCES brand_kits(id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS pitch_slides (
        id                       TEXT PRIMARY KEY,
        deck_id                  TEXT NOT NULL,
        position                 INTEGER NOT NULL,
        template                 TEXT NOT NULL,
        content                  TEXT NOT NULL,
        speaker_notes            TEXT NOT NULL DEFAULT '',
        transition               TEXT NOT NULL DEFAULT 'slide',
        fragments                TEXT NOT NULL DEFAULT '[]',
        background_image_prompt  TEXT,
        source_anchor            TEXT,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL,
        FOREIGN KEY (deck_id) REFERENCES pitch_decks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_pitch_slides_deck_pos
        ON pitch_slides(deck_id, position);

      CREATE TABLE IF NOT EXISTS pitch_assets (
        id          TEXT PRIMARY KEY,
        deck_id     TEXT NOT NULL,
        slide_id    TEXT,
        kind        TEXT NOT NULL,
        source      TEXT NOT NULL,
        prompt      TEXT,
        local_path  TEXT NOT NULL,
        mime        TEXT NOT NULL,
        width       INTEGER NOT NULL,
        height      INTEGER NOT NULL,
        created_at  TEXT NOT NULL,
        FOREIGN KEY (deck_id) REFERENCES pitch_decks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_pitch_assets_deck
        ON pitch_assets(deck_id);
      CREATE INDEX IF NOT EXISTS idx_pitch_assets_slide
        ON pitch_assets(slide_id);
    `);

    // Sub-issue #998 — additive `image_style` column on existing decks.
    // SQLite has no `ADD COLUMN IF NOT EXISTS`; tolerate the duplicate-column
    // error so re-running migrate() on a populated DB stays idempotent.
    try {
      this.db.exec(`ALTER TABLE pitch_slides ADD COLUMN image_style TEXT`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(msg)) throw err;
    }
  }

  // ── Decks ─────────────────────────────────────────────────────────────

  /**
   * Insert a deck and all its slides atomically.
   * Throws if any slide fails Zod validation (defensive write).
   */
  insertDeck(input: InsertDeckInput): DeckRecord {
    if (input.slides.length === 0) {
      throw new Error("insertDeck: deck must contain at least 1 slide");
    }

    const now = this.clock().toISOString();
    const aspectRatio = input.aspect_ratio ?? "16:9";

    // Validate every slide BEFORE any DB write so a single bad slide can't
    // leave the deck row orphaned.
    const validated = input.slides.map(({ id, slide }) => ({
      id,
      slide: SlideSchema.parse(slide),
    }));

    const insertDeckStmt = this.db.prepare(
      `INSERT INTO pitch_decks (id, title, brand_kit_id, aspect_ratio, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertSlideStmt = this.db.prepare(
      `INSERT INTO pitch_slides (id, deck_id, position, template, content, speaker_notes,
         transition, fragments, background_image_prompt, source_anchor, image_style,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = this.db.transaction(() => {
      insertDeckStmt.run(
        input.id,
        input.title,
        input.brand_kit_id,
        aspectRatio,
        JSON.stringify(input.metadata),
        now,
        now,
      );
      validated.forEach(({ id, slide }, idx) => {
        insertSlideStmt.run(
          id,
          input.id,
          idx,
          slide.template,
          JSON.stringify(slide.content),
          slide.speaker_notes,
          slide.transition,
          JSON.stringify(slide.fragments),
          slide.background_image_prompt ?? null,
          slide.source_anchor ?? null,
          slide.image_style ?? null,
          now,
          now,
        );
      });
    });
    tx();

    const stored = this.getDeck(input.id);
    if (!stored) throw new Error(`insertDeck: failed to read back deck ${input.id}`);
    return stored;
  }

  getDeck(id: string): DeckRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM pitch_decks WHERE id = ?`)
      .get(id) as DeckRow | undefined;
    if (!row) return null;
    try {
      return this.assembleDeck(row);
    } catch {
      return null;
    }
  }

  listDecks(): DeckRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM pitch_decks ORDER BY updated_at DESC`)
      .all() as DeckRow[];
    const decks: DeckRecord[] = [];
    for (const row of rows) {
      try {
        decks.push(this.assembleDeck(row));
      } catch {
        // Ignore malformed legacy rows so one bad deck cannot poison the library.
      }
    }
    return decks;
  }

  /**
   * Patch top-level deck fields. Slides are updated separately.
   * Allowlisted columns: title, brand_kit_id, aspect_ratio, metadata.
   */
  updateDeck(id: string, fields: UpdateDeckInput): DeckRecord | null {
    const existing = this.db
      .prepare(`SELECT * FROM pitch_decks WHERE id = ?`)
      .get(id) as DeckRow | undefined;
    if (!existing) return null;

    const now = this.clock().toISOString();

    // Sub-issue #956: closed allowlist of `column = ?` template strings;
    // no caller-supplied key flows into the SQL fragment.
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [now];
    if (fields.title !== undefined) {
      sets.push("title = ?");
      params.push(fields.title);
    }
    if (fields.brand_kit_id !== undefined) {
      sets.push("brand_kit_id = ?");
      params.push(fields.brand_kit_id);
    }
    if (fields.aspect_ratio !== undefined) {
      sets.push("aspect_ratio = ?");
      params.push(fields.aspect_ratio);
    }
    if (fields.metadata !== undefined) {
      sets.push("metadata = ?");
      params.push(JSON.stringify(fields.metadata));
    }
    params.push(id);
    this.db
      .prepare(`UPDATE pitch_decks SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);

    return this.getDeck(id);
  }

  /**
   * Cascade-delete a deck and its slides + assets (handled by FK ON DELETE CASCADE).
   * Returns true when a row was removed.
   */
  deleteDeck(id: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM pitch_decks WHERE id = ?`)
      .run(id);
    return result.changes > 0;
  }

  /**
   * Cheap EXISTS probe used by the brand-kit delete guard so the router does
   * not have to load every deck into memory just to check referential use.
   * Returns the first referencing deck id, or null when none reference the kit.
   */
  findFirstDeckIdByBrandKit(brandKitId: string): string | null {
    const row = this.db
      .prepare(`SELECT id FROM pitch_decks WHERE brand_kit_id = ? LIMIT 1`)
      .get(brandKitId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  // ── Slides ────────────────────────────────────────────────────────────

  insertSlide(input: InsertSlideInput): SlideRecord {
    const slide = SlideSchema.parse(input.slide);
    const now = this.clock().toISOString();
    this.db
      .prepare(
        `INSERT INTO pitch_slides (id, deck_id, position, template, content, speaker_notes,
           transition, fragments, background_image_prompt, source_anchor, image_style,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.deck_id,
        input.position,
        slide.template,
        JSON.stringify(slide.content),
        slide.speaker_notes,
        slide.transition,
        JSON.stringify(slide.fragments),
        slide.background_image_prompt ?? null,
        slide.source_anchor ?? null,
        slide.image_style ?? null,
        now,
        now,
      );
    const stored = this.getSlide(input.id);
    if (!stored) throw new Error(`insertSlide: read-back failed for ${input.id}`);
    return stored;
  }

  getSlide(id: string): SlideRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM pitch_slides WHERE id = ?`)
      .get(id) as SlideRow | undefined;
    if (!row) return null;
    try {
      return this.rowToSlideRecord(row);
    } catch {
      return null;
    }
  }

  listSlidesForDeck(deckId: string): SlideRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pitch_slides WHERE deck_id = ? ORDER BY position ASC`,
      )
      .all(deckId) as SlideRow[];
    const slides: SlideRecord[] = [];
    for (const row of rows) {
      try {
        slides.push(this.rowToSlideRecord(row));
      } catch {
        // Ignore malformed legacy slides so the rest of the deck can render.
      }
    }
    return slides;
  }

  /**
   * Replace a slide's content. The new slide is validated before write.
   * Position is preserved unless explicitly passed.
   */
  updateSlide(
    id: string,
    fields: { slide?: Slide; position?: number },
  ): SlideRecord | null {
    const existing = this.db
      .prepare(`SELECT * FROM pitch_slides WHERE id = ?`)
      .get(id) as SlideRow | undefined;
    if (!existing) return null;

    const now = this.clock().toISOString();

    // Closed allowlist — no dynamic column names.
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [now];
    if (fields.slide !== undefined) {
      const validated = SlideSchema.parse(fields.slide);
      sets.push(
        "template = ?",
        "content = ?",
        "speaker_notes = ?",
        "transition = ?",
        "fragments = ?",
        "background_image_prompt = ?",
        "source_anchor = ?",
        "image_style = ?",
      );
      params.push(
        validated.template,
        JSON.stringify(validated.content),
        validated.speaker_notes,
        validated.transition,
        JSON.stringify(validated.fragments),
        validated.background_image_prompt ?? null,
        validated.source_anchor ?? null,
        validated.image_style ?? null,
      );
    }
    if (fields.position !== undefined) {
      sets.push("position = ?");
      params.push(fields.position);
    }
    params.push(id);
    this.db
      .prepare(`UPDATE pitch_slides SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);

    return this.getSlide(id);
  }

  deleteSlide(id: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM pitch_slides WHERE id = ?`)
      .run(id);
    return result.changes > 0;
  }

  /**
   * Reorder slides transactionally. `orderedIds` MUST be the complete set of
   * slide ids belonging to `deckId`. Throws if the ids don't match — this is
   * a destructive operation and we refuse to do it on partial data.
   *
   * Implementation: rewrite to negative offsets first to avoid hitting the
   * UNIQUE-friendly index during the swap (positions are not unique today
   * but the negative pass is harmless and future-proofs the operation).
   */
  reorderSlides(deckId: string, orderedIds: string[]): void {
    const existing = this.listSlidesForDeck(deckId);
    if (existing.length !== orderedIds.length) {
      throw new Error(
        `reorderSlides: orderedIds length ${orderedIds.length} != deck slide count ${existing.length}`,
      );
    }
    const knownIds = new Set(existing.map((s) => s.id));
    for (const id of orderedIds) {
      if (!knownIds.has(id)) {
        throw new Error(`reorderSlides: unknown slide id ${id} for deck ${deckId}`);
      }
    }
    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new Error("reorderSlides: orderedIds contains duplicates");
    }

    const now = this.clock().toISOString();
    const updateStmt = this.db.prepare(
      `UPDATE pitch_slides SET position = ?, updated_at = ? WHERE id = ? AND deck_id = ?`,
    );
    const tx = this.db.transaction(() => {
      // Pass 1: move every slide to a negative bucket so the final positions
      // are guaranteed to be free.
      orderedIds.forEach((id, idx) => {
        updateStmt.run(-(idx + 1), now, id, deckId);
      });
      // Pass 2: assign final positions.
      orderedIds.forEach((id, idx) => {
        updateStmt.run(idx, now, id, deckId);
      });
    });
    tx();
  }

  // ── Assets ────────────────────────────────────────────────────────────

  insertAsset(asset: AssetRecord): AssetRecord {
    const validated = SlideAssetSchema.parse(asset);
    this.db
      .prepare(
        `INSERT INTO pitch_assets (id, deck_id, slide_id, kind, source, prompt,
           local_path, mime, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        validated.id,
        validated.deck_id,
        validated.slide_id,
        validated.kind,
        validated.source,
        validated.prompt,
        validated.local_path,
        validated.mime,
        validated.width,
        validated.height,
        validated.created_at,
      );
    return validated;
  }

  listAssetsForDeck(deckId: string): AssetRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pitch_assets WHERE deck_id = ? ORDER BY created_at ASC`,
      )
      .all(deckId) as AssetRow[];
    return rows.map((r) => this.rowToAsset(r));
  }

  /**
   * Best-effort repair for completed inline image jobs whose asset row was
   * persisted but whose slide JSON still has a missing `url`. This can happen
   * after a crash between asset insert and slide update, or for legacy rows
   * created before inline patching existed.
   */
  reconcileImageAssetsForDeck(deckId: string): number {
    const slides = this.listSlidesForDeck(deckId);
    const assetsBySlideId = new Map<string, AssetRecord[]>();
    for (const asset of this.listAssetsForDeck(deckId)) {
      if (asset.kind !== "image" || !asset.slide_id) continue;
      const existing = assetsBySlideId.get(asset.slide_id) ?? [];
      existing.push(asset);
      assetsBySlideId.set(asset.slide_id, existing);
    }

    let patched = 0;
    for (const slideRecord of slides) {
      const assets = assetsBySlideId.get(slideRecord.id);
      if (!assets || assets.length === 0) continue;
      const missingSlots = inlineImageSlots(slideRecord.slide).filter(
        (slot) => !hasImageUrl(slot.image),
      );
      if (missingSlots.length === 0) continue;

      let updatedContent: Record<string, unknown> | null = null;
      const usedAssetIds = new Set<string>();
      for (const slot of missingSlots) {
        const asset = selectAssetForSlot(
          slot.image,
          assets,
          usedAssetIds,
          missingSlots.length,
        );
        if (!asset) continue;
        usedAssetIds.add(asset.id);
        const targetContent: Record<string, unknown> = updatedContent ?? {
          ...(slideRecord.slide.content as Record<string, unknown>),
        };
        targetContent[slot.name] = {
          ...slot.image,
          url: pitchAssetUrl(deckId, asset.id),
        };
        updatedContent = targetContent;
      }

      if (!updatedContent) continue;
      const nextSlide = {
        ...slideRecord.slide,
        content: updatedContent,
      } as Slide;
      this.updateSlide(slideRecord.id, { slide: nextSlide });
      patched += usedAssetIds.size;
    }
    return patched;
  }

  deleteAssetsForSlide(slideId: string): number {
    const result = this.db
      .prepare(`DELETE FROM pitch_assets WHERE slide_id = ?`)
      .run(slideId);
    return result.changes;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private assembleDeck(row: DeckRow): DeckRecord {
    const slides = this.listSlidesForDeck(row.id).map((s) => s.slide);
    const deckLike: Deck = {
      id: row.id,
      title: row.title,
      brand_kit_id: row.brand_kit_id,
      aspect_ratio: row.aspect_ratio === "4:3" ? "4:3" : "16:9",
      slides,
      metadata: this.parseMetadata(row.metadata),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    // Defensive read-side validation: we trust the writer but a hand-edited DB
    // shouldn't poison downstream code.
    return DeckSchema.parse(deckLike);
  }

  private parseMetadata(raw: string): Deck["metadata"] {
    try {
      const parsed = JSON.parse(raw) as unknown;
      // Let DeckSchema do the heavy validation in `assembleDeck`.
      return parsed as Deck["metadata"];
    } catch {
      return { source_script: "", tone: "formal" };
    }
  }

  private rowToSlideRecord(row: SlideRow): SlideRecord {
    const slide = SlideSchema.parse({
      template: row.template,
      content: JSON.parse(row.content),
      speaker_notes: row.speaker_notes,
      transition: row.transition,
      fragments: JSON.parse(row.fragments),
      background_image_prompt: row.background_image_prompt ?? undefined,
      source_anchor: row.source_anchor ?? undefined,
      image_style: row.image_style ?? undefined,
    });
    return {
      id: row.id,
      deck_id: row.deck_id,
      position: row.position,
      slide,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private rowToAsset(row: AssetRow): AssetRecord {
    return SlideAssetSchema.parse({
      id: row.id,
      deck_id: row.deck_id,
      slide_id: row.slide_id,
      kind: row.kind,
      source: row.source,
      prompt: row.prompt,
      local_path: row.local_path,
      mime: row.mime,
      width: row.width,
      height: row.height,
      created_at: row.created_at,
    });
  }
}

type InlineImageSlotName = "image" | "left_image" | "right_image";

interface InlineImageSlot {
  name: InlineImageSlotName;
  image: SlideImage;
}

function inlineImageSlots(slide: Slide): InlineImageSlot[] {
  switch (slide.template) {
    case "bullet_list":
      return slide.content.image
        ? [{ name: "image", image: slide.content.image }]
        : [];
    case "two_column": {
      const slots: InlineImageSlot[] = [];
      if (slide.content.left_image) {
        slots.push({ name: "left_image", image: slide.content.left_image });
      }
      if (slide.content.right_image) {
        slots.push({ name: "right_image", image: slide.content.right_image });
      }
      return slots;
    }
    case "image_caption":
    case "full_bleed":
      return [{ name: "image", image: slide.content.image }];
    default:
      return [];
  }
}

function hasImageUrl(image: SlideImage): boolean {
  return typeof image.url === "string" && image.url.trim().length > 0;
}

function selectAssetForSlot(
  image: SlideImage,
  assets: readonly AssetRecord[],
  usedAssetIds: ReadonlySet<string>,
  missingSlotCount: number,
): AssetRecord | undefined {
  const unused = assets.filter((asset) => !usedAssetIds.has(asset.id));
  const promptMatch = [...unused]
    .reverse()
    .find((asset) => asset.prompt === image.prompt);
  if (promptMatch) return promptMatch;
  if (missingSlotCount === 1) return unused.at(-1);
  return undefined;
}

function pitchAssetUrl(deckId: string, assetId: string): string {
  return `/api/admin/pitch/decks/${encodeURIComponent(deckId)}/assets/${encodeURIComponent(assetId)}`;
}
