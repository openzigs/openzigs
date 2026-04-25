/**
 * Pitch — REST API Router (Phase 3 of Epic #951).
 *
 * Mounted at `/api/admin/pitch` in `src/server.ts`. Auth is applied at the
 * mount-point (mirrors `directorRouter`) so this router itself does NOT
 * call `authMiddleware` — wiring that twice would force every test to
 * provide a token.
 *
 * Sub-issues handled here:
 *   #961 — router scaffold + factory + auth wiring
 *   #959 — deck + slide CRUD
 *   #962 — AI endpoints (draft, regenerate, enhance, image)
 *   #966 — brand kit endpoints + logo upload
 *
 * Hard rules (see Epic #951 acceptance criteria):
 *   - All request bodies validated with Zod (`.strict()` everywhere a
 *     literal object schema is used) — unknown fields → 400.
 *   - Structured error envelope: `{ error: { code, message, details? } }`.
 *   - No new top-level dependencies — `multer` is already a workspace dep.
 *   - No rate-limiting in this phase (deferred to #977 / Phase 7).
 *   - Returns JSON for `/decks/draft` (no SSE pattern exists in the
 *     codebase today; tracked as a follow-up in the PR description).
 */
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { z, type ZodTypeAny } from "zod";
import { logger } from "../logging/logger.js";
import {
  BrandKitRepository,
  type BrandKit as RepoBrandKit,
} from "../video/brand-kit.js";
import { PitchRepository } from "../pitch/pitch-repository.js";
import {
  generateDeck,
  regenerateSlide,
} from "../pitch/pitch-generator.js";
import { submitSlideRegenerateTask } from "../pitch/pitch-regenerate.js";
import { enqueueSlideImage } from "../pitch/pitch-image-service.js";
import {
  BrandKitSchema as PitchBrandKitSchema,
  DeckAspectRatioEnum,
  DeckToneEnum,
  SlideSchema,
  type BrandKit as PitchBrandKit,
  type Slide,
} from "../pitch/pitch-schema.js";
import { STARTER_BRAND_KITS } from "../pitch/starter-brand-kits.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { TaskEngine } from "../tasks/task-engine.js";
import type { MediaQueueRepository } from "../queue/media-queue-repository.js";
import type { CharacterRepository } from "../characters/character-repository.js";

// ── Public surface ──────────────────────────────────────────────────────

export interface PitchRouterDeps {
  pitchRepo: PitchRepository;
  brandKitRepo: BrandKitRepository;
  copilot: CopilotWrapper;
  taskEngine: TaskEngine;
  mediaQueueRepo: MediaQueueRepository;
  /** Optional — used by `enqueueSlideImage` for LoRA trigger word resolution. */
  characterRepo?: CharacterRepository;
  /** Override for the brand-kit asset directory (tests). Defaults to `~/.openzigs/brand-kits`. */
  brandKitsDir?: string;
}

const DEFAULT_BRAND_KITS_DIR = join(homedir(), ".openzigs", "brand-kits");
const STARTER_KIT_IDS = new Set(STARTER_BRAND_KITS.map((k) => k.id));
const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB cap (#966)
const ALLOWED_LOGO_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/gif",
]);
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/gif": "gif",
};

// ── Error envelope helpers ─────────────────────────────────────────────

type ErrorCode =
  | "validation_error"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "bad_request"
  | "internal_error";

function sendError(
  res: Response,
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): void {
  res.status(status).json({
    error: details === undefined ? { code, message } : { code, message, details },
  });
}

function parseBody<T extends ZodTypeAny>(
  schema: T,
  res: Response,
  req: Request,
): z.infer<T> | undefined {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    sendError(res, 400, "validation_error", "Request body failed validation", {
      issues: result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
        code: i.code,
      })),
    });
    return undefined;
  }
  return result.data as z.infer<T>;
}

// ── Brand kit DTO conversion (RepoBrandKit ↔ PitchBrandKit) ────────────

function repoToPitchBrandKit(kit: RepoBrandKit): PitchBrandKit {
  // The Pitch BrandKit Zod schema requires `logoUrl` to be a valid URL or
  // null. The repository stores a filesystem path — convert local paths to
  // a `file://` URL for downstream consumers (LLM prompt, exporters).
  const logoUrl = kit.logoPath ? toFileUrl(kit.logoPath) : null;
  const watermarkUrl = kit.watermarkPath ? toFileUrl(kit.watermarkPath) : null;
  return PitchBrandKitSchema.parse({
    id: kit.id,
    name: kit.name,
    primaryColor: kit.primaryColor,
    secondaryColor: kit.secondaryColor,
    accentColor: kit.accentColor,
    fontHeading: kit.fontHeading ?? kit.fontFamily,
    fontBody: kit.fontBody ?? kit.fontFamily,
    logoUrl,
    watermarkUrl,
    footerText: kit.footerText,
  });
}

function toFileUrl(p: string): string {
  if (/^[a-z]+:\/\//i.test(p)) return p;
  // Naive cross-platform file:// builder (sufficient for our local cache).
  const norm = p.replace(/\\/g, "/");
  return norm.startsWith("/") ? `file://${norm}` : `file:///${norm}`;
}

// ── Body schemas ────────────────────────────────────────────────────────

const DeckMetadataSchema = z
  .object({
    source_script: z.string().max(50_000).default(""),
    source_summary: z.string().max(2000).optional(),
    audience: z.string().max(120).optional(),
    tone: DeckToneEnum.default("formal"),
    estimated_minutes: z.number().int().min(1).max(180).optional(),
  })
  .strict();

const CreateDeckBody = z
  .object({
    title: z.string().min(1).max(160),
    brand_kit_id: z.string().min(1),
    aspect_ratio: DeckAspectRatioEnum.optional(),
    metadata: DeckMetadataSchema.optional(),
  })
  .strict();

const UpdateDeckBody = z
  .object({
    title: z.string().min(1).max(160).optional(),
    brand_kit_id: z.string().min(1).optional(),
    aspect_ratio: DeckAspectRatioEnum.optional(),
    metadata: DeckMetadataSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });

const AppendSlideBody = z
  .object({
    slide: SlideSchema,
    position: z.number().int().min(0).optional(),
  })
  .strict();

const PatchSlideBody = z
  .object({
    slide: SlideSchema.optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((v) => v.slide !== undefined || v.position !== undefined, {
    message: "Either `slide` or `position` is required",
  });

const MoveSlideBody = z
  .object({
    position: z.number().int().min(0),
  })
  .strict();

const DraftDeckBody = z
  .object({
    script: z.string().min(1).max(50_000),
    brandKitId: z.string().min(1),
    title: z.string().min(1).max(160).optional(),
    options: z
      .object({
        audience: z.string().max(120).optional(),
        tone: DeckToneEnum.optional(),
        estimatedMinutes: z.number().int().min(1).max(180).optional(),
        targetSlideCount: z.number().int().min(1).max(80).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const RegenerateSlideBody = z
  .object({
    instruction: z.string().max(1000).optional(),
  })
  .strict();

const EnhanceSlideBody = z
  .object({
    instruction: z.string().max(1000).optional(),
  })
  .strict();

const SlideImageBody = z
  .object({
    prompt: z.string().min(3).max(400),
    mode: z.enum(["background", "inline"]),
    loraTriggerWord: z.string().max(80).optional(),
    seed: z.number().int().min(0).optional(),
    width: z.number().int().min(64).max(4096).optional(),
    height: z.number().int().min(64).max(4096).optional(),
  })
  .strict();

const CreateBrandKitBody = z
  .object({
    name: z.string().min(1).max(80),
    primaryColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .default("#000000"),
    secondaryColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .default("#ffffff"),
    accentColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .default("#0066ff"),
    fontFamily: z.string().min(1).max(60).default("Inter"),
    fontHeading: z.string().min(1).max(60).optional(),
    fontBody: z.string().min(1).max(60).optional(),
    footerText: z.string().max(120).optional(),
  })
  .strict();

const UpdateBrandKitBody = z
  .object({
    name: z.string().min(1).max(80).optional(),
    primaryColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    secondaryColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    accentColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    fontFamily: z.string().min(1).max(60).optional(),
    fontHeading: z.string().min(1).max(60).nullable().optional(),
    fontBody: z.string().min(1).max(60).nullable().optional(),
    footerText: z.string().max(120).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });

// ── Multer (logo upload) ────────────────────────────────────────────────

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES, files: 1 },
});

// ── Default placeholder slide for empty decks ──────────────────────────

function buildPlaceholderTitleSlide(title: string): Slide {
  return SlideSchema.parse({
    template: "title",
    content: { title },
    speaker_notes: "",
    transition: "slide",
    fragments: [],
  });
}

// ── Factory ─────────────────────────────────────────────────────────────

export function createPitchRouter(deps: PitchRouterDeps): Router {
  const router = Router();
  const brandKitsDir = deps.brandKitsDir ?? DEFAULT_BRAND_KITS_DIR;

  // ────────────────────────────────────────────────────────────────────
  // Deck CRUD (#959)
  // ────────────────────────────────────────────────────────────────────

  router.get("/decks", (req, res) => {
    const limitRaw = Number.parseInt(String(req.query.limit ?? "50"), 10);
    const offsetRaw = Number.parseInt(String(req.query.offset ?? "0"), 10);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 200)
      : 50;
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

    const all = deps.pitchRepo.listDecks();
    const page = all.slice(offset, offset + limit);
    res.json({
      decks: page,
      pagination: { total: all.length, limit, offset },
    });
  });

  router.post("/decks", (req, res) => {
    const body = parseBody(CreateDeckBody, res, req);
    if (!body) return;

    if (!deps.brandKitRepo.getById(body.brand_kit_id)) {
      sendError(res, 404, "not_found", `brand kit ${body.brand_kit_id} not found`);
      return;
    }

    try {
      const placeholder = buildPlaceholderTitleSlide(body.title);
      const deck = deps.pitchRepo.insertDeck({
        id: nanoid(),
        title: body.title,
        brand_kit_id: body.brand_kit_id,
        aspect_ratio: body.aspect_ratio ?? "16:9",
        metadata: {
          source_script: body.metadata?.source_script ?? "",
          source_summary: body.metadata?.source_summary,
          audience: body.metadata?.audience,
          tone: body.metadata?.tone ?? "formal",
          estimated_minutes: body.metadata?.estimated_minutes,
        },
        slides: [{ id: nanoid(), slide: placeholder }],
      });
      res.status(201).json({ deck });
    } catch (err) {
      logger.error(`[Pitch API] POST /decks failed: ${errMessage(err)}`);
      sendError(res, 500, "internal_error", errMessage(err));
    }
  });

  router.get("/decks/:deckId", (req, res) => {
    const deck = deps.pitchRepo.getDeck(req.params.deckId);
    if (!deck) {
      sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
      return;
    }
    const slides = deps.pitchRepo.listSlidesForDeck(deck.id);
    res.json({ deck, slides });
  });

  router.patch("/decks/:deckId", (req, res) => {
    const body = parseBody(UpdateDeckBody, res, req);
    if (!body) return;

    if (
      body.brand_kit_id &&
      !deps.brandKitRepo.getById(body.brand_kit_id)
    ) {
      sendError(
        res,
        404,
        "not_found",
        `brand kit ${body.brand_kit_id} not found`,
      );
      return;
    }

    const updated = deps.pitchRepo.updateDeck(req.params.deckId, {
      title: body.title,
      brand_kit_id: body.brand_kit_id,
      aspect_ratio: body.aspect_ratio,
      metadata: body.metadata
        ? {
            source_script: body.metadata.source_script ?? "",
            source_summary: body.metadata.source_summary,
            audience: body.metadata.audience,
            tone: body.metadata.tone ?? "formal",
            estimated_minutes: body.metadata.estimated_minutes,
          }
        : undefined,
    });
    if (!updated) {
      sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
      return;
    }
    res.json({ deck: updated });
  });

  router.delete("/decks/:deckId", (req, res) => {
    // Cascade is intentional (per #956 design / FK ON DELETE CASCADE on slides
    // and assets). Block only if deck is missing.
    const ok = deps.pitchRepo.deleteDeck(req.params.deckId);
    if (!ok) {
      sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
      return;
    }
    res.json({ ok: true });
  });

  // ────────────────────────────────────────────────────────────────────
  // Slide CRUD (#959)
  // ────────────────────────────────────────────────────────────────────

  router.post("/decks/:deckId/slides", (req, res) => {
    const body = parseBody(AppendSlideBody, res, req);
    if (!body) return;

    const deck = deps.pitchRepo.getDeck(req.params.deckId);
    if (!deck) {
      sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
      return;
    }

    const slides = deps.pitchRepo.listSlidesForDeck(deck.id);
    const insertAt =
      body.position !== undefined
        ? Math.min(Math.max(body.position, 0), slides.length)
        : slides.length;

    try {
      // Append at end first, then reorder if a specific position is requested.
      const appendPosition = slides.length;
      const newId = nanoid();
      const created = deps.pitchRepo.insertSlide({
        id: newId,
        deck_id: deck.id,
        position: appendPosition,
        slide: body.slide,
      });

      if (insertAt !== appendPosition) {
        const ordered = [
          ...slides.map((s) => s.id).slice(0, insertAt),
          newId,
          ...slides.map((s) => s.id).slice(insertAt),
        ];
        deps.pitchRepo.reorderSlides(deck.id, ordered);
      }

      const final = deps.pitchRepo.getSlide(created.id);
      res.status(201).json({ slide: final });
    } catch (err) {
      logger.error(`[Pitch API] POST /decks/:deckId/slides failed: ${errMessage(err)}`);
      sendError(res, 400, "bad_request", errMessage(err));
    }
  });

  router.patch("/decks/:deckId/slides/:slideId", (req, res) => {
    const body = parseBody(PatchSlideBody, res, req);
    if (!body) return;

    const existing = deps.pitchRepo.getSlide(req.params.slideId);
    if (!existing || existing.deck_id !== req.params.deckId) {
      sendError(res, 404, "not_found", `slide ${req.params.slideId} not found`);
      return;
    }

    try {
      const updated = deps.pitchRepo.updateSlide(req.params.slideId, {
        slide: body.slide,
        position: body.position,
      });
      res.json({ slide: updated });
    } catch (err) {
      sendError(res, 400, "bad_request", errMessage(err));
    }
  });

  router.put("/decks/:deckId/slides/:slideId/move", (req, res) => {
    const body = parseBody(MoveSlideBody, res, req);
    if (!body) return;

    const slides = deps.pitchRepo.listSlidesForDeck(req.params.deckId);
    if (slides.length === 0) {
      sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
      return;
    }
    const idx = slides.findIndex((s) => s.id === req.params.slideId);
    if (idx === -1) {
      sendError(res, 404, "not_found", `slide ${req.params.slideId} not in deck`);
      return;
    }

    const target = Math.min(Math.max(body.position, 0), slides.length - 1);
    if (target === idx) {
      res.json({ ok: true, slides: slides.map((s) => s.id) });
      return;
    }

    const ids = slides.map((s) => s.id);
    const [moved] = ids.splice(idx, 1);
    ids.splice(target, 0, moved);
    try {
      deps.pitchRepo.reorderSlides(req.params.deckId, ids);
      res.json({ ok: true, slides: ids });
    } catch (err) {
      sendError(res, 400, "bad_request", errMessage(err));
    }
  });

  router.delete("/decks/:deckId/slides/:slideId", (req, res) => {
    const existing = deps.pitchRepo.getSlide(req.params.slideId);
    if (!existing || existing.deck_id !== req.params.deckId) {
      sendError(res, 404, "not_found", `slide ${req.params.slideId} not found`);
      return;
    }
    // Refuse to delete the last slide — DeckSchema enforces ≥1 slide.
    const remaining = deps.pitchRepo.listSlidesForDeck(req.params.deckId);
    if (remaining.length <= 1) {
      sendError(
        res,
        409,
        "conflict",
        "cannot delete the last slide of a deck",
      );
      return;
    }
    deps.pitchRepo.deleteSlide(req.params.slideId);
    // Compact positions so we never leave gaps.
    const after = deps.pitchRepo.listSlidesForDeck(req.params.deckId);
    deps.pitchRepo.reorderSlides(
      req.params.deckId,
      after.map((s) => s.id),
    );
    res.json({ ok: true });
  });

  // ────────────────────────────────────────────────────────────────────
  // AI endpoints (#962)
  // ────────────────────────────────────────────────────────────────────

  router.post("/decks/draft", async (req, res) => {
    const body = parseBody(DraftDeckBody, res, req);
    if (!body) return;

    const repoKit = deps.brandKitRepo.getById(body.brandKitId);
    if (!repoKit) {
      sendError(res, 404, "not_found", `brand kit ${body.brandKitId} not found`);
      return;
    }
    const brandKit = repoToPitchBrandKit(repoKit);

    try {
      const generated = await generateDeck({
        script: body.script,
        brandKit,
        options: body.options,
        copilot: deps.copilot,
      });

      // Persist via repo, overriding the title if the caller supplied one.
      const finalTitle = body.title ?? generated.title;
      const persisted = deps.pitchRepo.insertDeck({
        id: nanoid(),
        title: finalTitle,
        brand_kit_id: brandKit.id,
        aspect_ratio: generated.aspect_ratio,
        metadata: generated.metadata,
        slides: generated.slides.map((slide) => ({ id: nanoid(), slide })),
      });
      res.status(201).json({ deck: persisted });
    } catch (err) {
      logger.error(`[Pitch API] POST /decks/draft failed: ${errMessage(err)}`);
      sendError(res, 502, "internal_error", `pitch draft failed: ${errMessage(err)}`);
    }
  });

  router.post(
    "/decks/:deckId/slides/:slideId/regenerate",
    async (req, res) => {
      const body = parseBody(RegenerateSlideBody, res, req);
      if (!body) return;

      const slide = deps.pitchRepo.getSlide(req.params.slideId);
      if (!slide || slide.deck_id !== req.params.deckId) {
        sendError(res, 404, "not_found", `slide ${req.params.slideId} not found`);
        return;
      }

      try {
        const submission = submitSlideRegenerateTask({
          taskEngine: deps.taskEngine,
          pitchRepo: deps.pitchRepo,
          deckId: req.params.deckId,
          slideId: req.params.slideId,
          hint: body.instruction,
        });
        res.status(202).json({ taskId: submission.task.id });
      } catch (err) {
        logger.error(
          `[Pitch API] regenerate slide failed: ${errMessage(err)}`,
        );
        sendError(res, 500, "internal_error", errMessage(err));
      }
    },
  );

  router.post("/decks/:deckId/slides/:slideId/enhance", async (req, res) => {
    const body = parseBody(EnhanceSlideBody, res, req);
    if (!body) return;

    const deck = deps.pitchRepo.getDeck(req.params.deckId);
    if (!deck) {
      sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
      return;
    }
    const slide = deps.pitchRepo.getSlide(req.params.slideId);
    if (!slide || slide.deck_id !== req.params.deckId) {
      sendError(res, 404, "not_found", `slide ${req.params.slideId} not found`);
      return;
    }

    const hint = (body.instruction ?? "").trim();
    const polishHint = hint
      ? `Polish & enhance this slide. ${hint}`
      : "Polish & enhance this slide: tighten wording, sharpen the hook, keep template/structure identical.";

    try {
      const polished = await regenerateSlide({
        deck,
        slide: slide.slide,
        hint: polishHint,
        copilot: deps.copilot,
      });
      const updated = deps.pitchRepo.updateSlide(slide.id, { slide: polished });
      res.json({ slide: updated });
    } catch (err) {
      logger.error(`[Pitch API] enhance slide failed: ${errMessage(err)}`);
      sendError(res, 502, "internal_error", `slide enhance failed: ${errMessage(err)}`);
    }
  });

  router.post("/decks/:deckId/slides/:slideId/image", (req, res) => {
    const body = parseBody(SlideImageBody, res, req);
    if (!body) return;

    const slide = deps.pitchRepo.getSlide(req.params.slideId);
    if (!slide || slide.deck_id !== req.params.deckId) {
      sendError(res, 404, "not_found", `slide ${req.params.slideId} not found`);
      return;
    }

    // If a LoRA trigger word is supplied, prefix it onto the prompt so that
    // `injectCharacterLora` (called inside enqueueSlideImage) can resolve it.
    const finalPrompt = body.loraTriggerWord
      ? `${body.loraTriggerWord} ${body.prompt}`
      : body.prompt;

    try {
      const result = enqueueSlideImage({
        deckId: req.params.deckId,
        slideId: req.params.slideId,
        prompt: finalPrompt,
        kind: body.mode === "inline" ? "image" : "background",
        seed: body.seed,
        width: body.width,
        height: body.height,
        mediaQueueRepo: deps.mediaQueueRepo,
        characterRepo: deps.characterRepo,
      });
      res.status(202).json({ jobId: result.jobId, assetId: result.assetId });
    } catch (err) {
      logger.error(`[Pitch API] image enqueue failed: ${errMessage(err)}`);
      sendError(res, 400, "bad_request", errMessage(err));
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Brand kits (#966)
  // ────────────────────────────────────────────────────────────────────

  router.get("/brand-kits", (_req, res) => {
    const kits = deps.brandKitRepo.getAll();
    res.json({
      brandKits: kits.map((k) => ({
        ...k,
        isStarter: STARTER_KIT_IDS.has(k.id),
      })),
    });
  });

  router.post("/brand-kits", (req, res) => {
    const body = parseBody(CreateBrandKitBody, res, req);
    if (!body) return;

    const id = nanoid();
    try {
      const created = deps.brandKitRepo.create({
        id,
        name: body.name,
        primaryColor: body.primaryColor,
        secondaryColor: body.secondaryColor,
        accentColor: body.accentColor,
        fontFamily: body.fontFamily,
        fontHeading: body.fontHeading,
        fontBody: body.fontBody,
        footerText: body.footerText,
        logoPath: null,
        watermarkPath: null,
        introTemplateId: null,
        outroTemplateId: null,
      });
      res.status(201).json({ brandKit: { ...created, isStarter: false } });
    } catch (err) {
      // Likely UNIQUE name collision.
      sendError(res, 409, "conflict", errMessage(err));
    }
  });

  router.get("/brand-kits/:id", (req, res) => {
    const kit = deps.brandKitRepo.getById(req.params.id);
    if (!kit) {
      sendError(res, 404, "not_found", `brand kit ${req.params.id} not found`);
      return;
    }
    res.json({
      brandKit: { ...kit, isStarter: STARTER_KIT_IDS.has(kit.id) },
    });
  });

  router.patch("/brand-kits/:id", (req, res) => {
    if (STARTER_KIT_IDS.has(req.params.id)) {
      sendError(res, 403, "forbidden", "starter brand kits are immutable");
      return;
    }
    const body = parseBody(UpdateBrandKitBody, res, req);
    if (!body) return;

    const updated = deps.brandKitRepo.update(req.params.id, body);
    if (!updated) {
      sendError(res, 404, "not_found", `brand kit ${req.params.id} not found`);
      return;
    }
    res.json({
      brandKit: { ...updated, isStarter: false },
    });
  });

  router.delete("/brand-kits/:id", (req, res) => {
    if (STARTER_KIT_IDS.has(req.params.id)) {
      sendError(res, 403, "forbidden", "starter brand kits cannot be deleted");
      return;
    }
    const decks = deps.pitchRepo.listDecks();
    const referencingDeck = decks.find((d) => d.brand_kit_id === req.params.id);
    if (referencingDeck) {
      sendError(
        res,
        409,
        "conflict",
        `brand kit is referenced by deck ${referencingDeck.id}`,
        { deckId: referencingDeck.id },
      );
      return;
    }
    const ok = deps.brandKitRepo.delete(req.params.id);
    if (!ok) {
      sendError(res, 404, "not_found", `brand kit ${req.params.id} not found`);
      return;
    }
    res.json({ ok: true });
  });

  router.post(
    "/brand-kits/:id/logo",
    logoUpload.single("logo"),
    async (req, res) => {
      const kit = deps.brandKitRepo.getById(req.params.id);
      if (!kit) {
        sendError(res, 404, "not_found", `brand kit ${req.params.id} not found`);
        return;
      }
      // Permit logo updates on starter kits is debatable; the issue says
      // PATCH on starter → 403, and logo upload is effectively a PATCH.
      if (STARTER_KIT_IDS.has(req.params.id)) {
        sendError(res, 403, "forbidden", "starter brand kits are immutable");
        return;
      }

      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        sendError(res, 400, "bad_request", "logo file is required (multipart field 'logo')");
        return;
      }
      if (!ALLOWED_LOGO_MIMES.has(file.mimetype)) {
        sendError(
          res,
          400,
          "bad_request",
          `unsupported logo MIME ${file.mimetype}`,
          { allowed: Array.from(ALLOWED_LOGO_MIMES) },
        );
        return;
      }
      if (file.size > LOGO_MAX_BYTES) {
        // Defence in depth — multer should have rejected this already.
        sendError(res, 413, "bad_request", "logo exceeds 2 MB cap");
        return;
      }

      try {
        const ext =
          MIME_TO_EXT[file.mimetype] ??
          (extname(file.originalname || "").replace(/^\./, "") || "bin");
        const kitDir = resolve(brandKitsDir, kit.id);
        await mkdir(kitDir, { recursive: true });
        const finalPath = join(kitDir, `logo.${ext}`);
        const tmpPath = `${finalPath}.tmp-${nanoid(8)}`;
        await writeFile(tmpPath, file.buffer);
        // Clean up any stale logo with a different extension before rename.
        for (const oldExt of Object.values(MIME_TO_EXT)) {
          const old = join(kitDir, `logo.${oldExt}`);
          if (old !== finalPath && existsSync(old)) {
            try {
              await unlink(old);
            } catch {
              /* best-effort */
            }
          }
        }
        await rename(tmpPath, finalPath);
        await stat(finalPath); // confirm it landed

        const updated = deps.brandKitRepo.update(kit.id, {
          logoPath: finalPath,
        });
        res.json({
          brandKit: { ...(updated ?? kit), isStarter: false },
          logo: { path: finalPath, size: file.size, mime: file.mimetype },
        });
      } catch (err) {
        logger.error(`[Pitch API] logo upload failed: ${errMessage(err)}`);
        sendError(res, 500, "internal_error", errMessage(err));
      }
    },
  );

  // Multer error → JSON envelope (covers MulterError fileSize / files cap).
  router.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      next: import("express").NextFunction,
    ) => {
      if (err instanceof multer.MulterError) {
        const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        sendError(res, status, "bad_request", `upload error: ${err.message}`, {
          code: err.code,
        });
        return;
      }
      next(err);
    },
  );

  return router;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
