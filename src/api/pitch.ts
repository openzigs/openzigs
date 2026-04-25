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
import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import sharp from "sharp";
import type { Server as SocketIOServer } from "socket.io";
import { z, type ZodTypeAny } from "zod";
import { logger } from "../logging/logger.js";
import { AuditLogger, type AuditCategory } from "../logging/audit-logger.js";
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
import { renderDeckToHtml } from "../pitch/pitch-renderer.js";
import { exportDeckToPdf } from "../pitch/pitch-export-pdf.js";
import { exportDeckToPptx } from "../pitch/pitch-export-pptx.js";
import { exportDeckToZip } from "../pitch/pitch-export-zip.js";
import { exportDeckToMarkdown } from "../pitch/pitch-export-md.js";
import { exportNotesToPdf } from "../pitch/pitch-export-notes.js";
import { safeFilename } from "../pitch/pitch-export-utils.js";
import {
  BrandKitSchema as PitchBrandKitSchema,
  DeckAspectRatioEnum,
  DeckToneEnum,
  DraftDeckBodySchema,
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
  /** Audit log sink. Mutating routes emit categorized events through it. */
  auditLogger?: AuditLogger;
  /** Socket.IO server. Mutating routes broadcast `pitch:*` events through it. */
  io?: SocketIOServer;
  /**
   * Phase 6 export overrides — tests inject these to mock subprocess /
   * pptx / zip generation. Production wiring leaves them undefined and
   * the modules use their real implementations.
   */
  exporters?: {
    pdf?: typeof exportDeckToPdf;
    pptx?: typeof exportDeckToPptx;
    zip?: typeof exportDeckToZip;
    md?: typeof exportDeckToMarkdown;
    notes?: typeof exportNotesToPdf;
  };
}

const DEFAULT_BRAND_KITS_DIR = join(homedir(), ".openzigs", "brand-kits");
const STARTER_KIT_IDS = new Set(STARTER_BRAND_KITS.map((k) => k.id));
const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB cap (#966)
// Allow-list per #966 acceptance criteria. SVG is intentionally excluded:
// it is a stored-XSS / XXE carrier and the Phase 4 Reveal renderer would
// embed it inline. Raster formats are re-encoded through `sharp` to strip
// EXIF / embedded scripts and to resize to a sane max dimension.
const ALLOWED_LOGO_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
/** sharp `metadata().format` value → canonical claimed MIME for sniff matching. */
const SHARP_FORMAT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
};
/** Max logo dimension after re-encode (#966 — keeps assets bounded for Reveal). */
const LOGO_MAX_DIMENSION = 1024;

/**
 * Late-bound Socket.IO reference. The Phase-3 router is constructed before
 * the HTTP server / Socket.IO server in `src/server.ts`, so production code
 * sets the reference after `io` is built. Tests prefer `PitchRouterDeps.io`.
 */
let _pitchIO: SocketIOServer | null = null;
export function setPitchIO(io: SocketIOServer): void {
  _pitchIO = io;
}

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

const DraftDeckBody = DraftDeckBodySchema;

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

  // ── Audit + Socket.IO emit helpers ─────────────────────────────────
  // Both sinks are optional so test harnesses can opt-in. Production
  // wiring in `src/server.ts` always provides both.
  const audit = (
    category: AuditCategory,
    event: string,
    details: Record<string, unknown> = {},
    level: "info" | "warn" | "error" | "security" = "info",
  ): void => {
    if (!deps.auditLogger) return;
    void deps.auditLogger
      .log({ level, category, event, details })
      .catch((err) => {
        logger.warn(`[Pitch API] audit log failed: ${errMessage(err)}`);
      });
  };
  const emit = (event: string, payload: Record<string, unknown>): void => {
    const target = deps.io ?? _pitchIO;
    if (!target) return;
    try {
      target.emit(event, payload);
    } catch (err) {
      logger.warn(`[Pitch API] socket emit ${event} failed: ${errMessage(err)}`);
    }
  };

  // ────────────────────────────────────────────────────────────────────
  // Rate limiting (Phase 7 / sub-issue #977)
  //
  // Per-IP limits applied to the expensive endpoints. The global app-level
  // rate limiter in `src/app.ts` still runs first (5000 req / 15 min) — the
  // limiters below are tighter ceilings on individual cost centres:
  //   - LLM-backed routes (draft, regenerate, enhance, image)
  //   - Subprocess-backed exports (pdf, pptx, zip, notes)
  //   - Cheap CRUD/list — basically just abuse protection
  //
  // All limiters emit standard `RateLimit-*` headers and a `429` with
  // `Retry-After`. `windowMs` is set to one hour (3 600 000 ms) so the
  // per-route caps are easy to reason about ("10 drafts per hour", etc.).
  // ────────────────────────────────────────────────────────────────────

  const ONE_HOUR_MS = 60 * 60 * 1000;
  const buildLimiter = (max: number, label: string): RateLimitRequestHandler =>
    rateLimit({
      windowMs: ONE_HOUR_MS,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        error: {
          code: "rate_limited",
          message: `Too many ${label} requests, please slow down`,
        },
      },
      // Audit every 429 with category `security` so brute-force /
      // denial-of-wallet attempts surface in the audit log alongside the
      // starter-kit-immutability blocks. Mirrors the `audit("security",
      // ...)` calls earlier in this router. Sub-issue follow-up to PR
      // #984 review.
      handler: (req, res, _next, options) => {
        audit(
          "security",
          "pitch.rate_limit_exceeded",
          {
            ip: req.ip,
            route: req.originalUrl ?? req.url,
            label,
            limit: max,
            windowMs: ONE_HOUR_MS,
          },
          "warn",
        );
        res.status(options.statusCode).json(options.message);
      },
      // The Express server already sets `trust proxy` per the deployment;
      // we don't override the IPv6 validator here. Tests that hit limits
      // run against a single localhost IP so the per-IP partitioning is
      // exactly what we want to assert against.
    });

  const draftLimiter = buildLimiter(10, "deck draft");
  const regenerateLimiter = buildLimiter(60, "slide regenerate");
  const enhanceLimiter = buildLimiter(60, "slide enhance");
  const imageLimiter = buildLimiter(30, "slide image");
  const pdfLimiter = buildLimiter(20, "PDF export");
  const pptxLimiter = buildLimiter(30, "PPTX export");
  const zipLimiter = buildLimiter(30, "ZIP export");
  const mdLimiter = buildLimiter(60, "Markdown export");
  const htmlLimiter = buildLimiter(60, "HTML export");
  const notesLimiter = buildLimiter(20, "speaker-notes PDF");
  const crudLimiter = buildLimiter(600, "API");

  // ────────────────────────────────────────────────────────────────────
  // Deck CRUD (#959)
  // ────────────────────────────────────────────────────────────────────

  router.get("/decks", crudLimiter, (req, res) => {
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

  router.post("/decks", crudLimiter, (req, res) => {
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
      audit("system", "pitch_deck_created", {
        deckId: deck.id,
        brandKitId: deck.brand_kit_id,
      });
      emit("pitch:deck:created", { deckId: deck.id, deck });
      res.status(201).json({ deck });
    } catch (err) {
      logger.error(`[Pitch API] POST /decks failed: ${errMessage(err)}`);
      sendError(res, 500, "internal_error", errMessage(err));
    }
  });

  router.get("/decks/:deckId", crudLimiter, (req, res) => {
    const deck = deps.pitchRepo.getDeck(req.params.deckId);
    if (!deck) {
      sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
      return;
    }
    const slides = deps.pitchRepo.listSlidesForDeck(deck.id);
    res.json({ deck, slides });
  });

  // Phase 4 / sub-issue #963 — Reveal HTML render endpoint.
  router.get("/decks/:deckId/render", htmlLimiter, (req, res) => {
    const mode = req.query.mode === "standalone" ? "standalone" : "embedded";
    const deck = deps.pitchRepo.getDeck(req.params.deckId);
    if (!deck) {
      sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
      return;
    }
    const repoKit = deps.brandKitRepo.getById(deck.brand_kit_id);
    if (!repoKit) {
      sendError(
        res,
        404,
        "not_found",
        `brand kit ${deck.brand_kit_id} not found`,
      );
      return;
    }
    try {
      const brandKit = repoToPitchBrandKit(repoKit);
      const { html, slideCount } = renderDeckToHtml(deck, brandKit, mode);
      audit("system", "pitch_deck_rendered", {
        deckId: deck.id,
        mode,
        slideCount,
      });
      emit("pitch:deck:rendered", {
        deckId: deck.id,
        mode,
        slideCount,
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // Render output is dynamic per-deck — never cache at the edge.
      res.setHeader("Cache-Control", "no-store");
      // CSP (#977): standalone Reveal HTML inlines its own init script
      // and styles, so `'unsafe-inline'` is required for both — mitigated
      // by the fact that ALL user content interpolated into the HTML
      // passes through `sanitizeRichText` / `escapeHtml` first. The CDN
      // entries are explicit — reveal.js comes from jsdelivr in standalone
      // mode, image URLs are http(s) only, and `data:` is allowed only
      // for inline image previews. Embedded mode also benefits since the
      // browser still respects the header on the response.
      res.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
          "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
          "img-src 'self' data: https:",
          "font-src 'self' data: https:",
          "connect-src 'self'",
          "frame-ancestors 'self'",
          "base-uri 'self'",
          "form-action 'none'",
        ].join("; "),
      );
      res.send(html);
    } catch (err) {
      logger.error(
        `[Pitch API] GET /decks/${req.params.deckId}/render failed: ${errMessage(err)}`,
      );
      sendError(res, 500, "internal_error", errMessage(err));
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 6 — Export endpoints (#972 #973 #974)
  //
  // All routes are GET so a browser can hit them directly with a normal
  // download. Each route resolves the deck + brand kit, calls into the
  // matching `pitch-export-*` module, sets a sanitized
  // `Content-Disposition` header, and streams the buffer back. Audit log
  // + Socket.IO emit fire on success. Hard 60s express timeout for the
  // PDF routes (decktape's own wall-clock is enforced inside the helper
  // — this is belt-and-braces for the HTTP layer).
  // ────────────────────────────────────────────────────────────────────

  const pdfExporter = deps.exporters?.pdf ?? exportDeckToPdf;
  const pptxExporter = deps.exporters?.pptx ?? exportDeckToPptx;
  const zipExporter = deps.exporters?.zip ?? exportDeckToZip;
  const mdExporter = deps.exporters?.md ?? exportDeckToMarkdown;
  const notesExporter = deps.exporters?.notes ?? exportNotesToPdf;

  type DeckCtx = {
    deck: ReturnType<PitchRepository["getDeck"]>;
    brandKit: PitchBrandKit;
  };
  const loadDeckAndKit = (req: Request, res: Response): DeckCtx | null => {
    const deck = deps.pitchRepo.getDeck(req.params.deckId);
    if (!deck) {
      sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
      return null;
    }
    const repoKit = deps.brandKitRepo.getById(deck.brand_kit_id);
    if (!repoKit) {
      sendError(res, 404, "not_found", `brand kit ${deck.brand_kit_id} not found`);
      return null;
    }
    return { deck, brandKit: repoToPitchBrandKit(repoKit) };
  };

  /** Sanitized Content-Disposition header — never trusts user input directly. */
  const setDownloadHeaders = (
    res: Response,
    contentType: string,
    rawTitle: string,
    deckId: string,
    ext: string,
  ): void => {
    const filename = safeFilename(rawTitle, deckId, ext);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
  };

  router.get("/decks/:deckId/export.html", htmlLimiter, (req, res) => {
    // Alias for `/render?mode=standalone` so the export menu is uniform.
    const ctx = loadDeckAndKit(req, res);
    if (!ctx?.deck) return;
    try {
      const { html, slideCount } = renderDeckToHtml(
        ctx.deck,
        ctx.brandKit,
        "standalone",
      );
      audit("system", "pitch_deck_exported", {
        deckId: ctx.deck.id,
        format: "html",
        slideCount,
      });
      emit("pitch:deck:exported", { deckId: ctx.deck.id, format: "html" });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      // Same CSP as `/render` (#977) — standalone HTML carries inlined
      // Reveal init + theme overrides, so `'unsafe-inline'` is required.
      res.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
          "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
          "img-src 'self' data: https:",
          "font-src 'self' data: https:",
          "connect-src 'self'",
          "frame-ancestors 'self'",
          "base-uri 'self'",
          "form-action 'none'",
        ].join("; "),
      );
      res.send(html);
    } catch (err) {
      logger.error(
        `[Pitch API] GET /decks/${req.params.deckId}/export.html failed: ${errMessage(err)}`,
      );
      sendError(res, 500, "internal_error", errMessage(err));
    }
  });

  router.get("/decks/:deckId/export.md", mdLimiter, (req, res) => {
    const ctx = loadDeckAndKit(req, res);
    if (!ctx?.deck) return;
    try {
      const { buffer, contentType } = mdExporter(ctx.deck);
      setDownloadHeaders(res, contentType, ctx.deck.title, ctx.deck.id, ".md");
      audit("system", "pitch_deck_exported", {
        deckId: ctx.deck.id,
        format: "md",
        bytes: buffer.byteLength,
      });
      emit("pitch:deck:exported", { deckId: ctx.deck.id, format: "md" });
      res.send(buffer);
    } catch (err) {
      logger.error(
        `[Pitch API] GET /decks/${req.params.deckId}/export.md failed: ${errMessage(err)}`,
      );
      sendError(res, 500, "internal_error", "markdown export failed");
    }
  });

  router.get("/decks/:deckId/export.zip", zipLimiter, async (req, res) => {
    const ctx = loadDeckAndKit(req, res);
    if (!ctx?.deck) return;
    try {
      const { buffer, contentType } = await zipExporter(ctx.deck, ctx.brandKit);
      setDownloadHeaders(res, contentType, ctx.deck.title, ctx.deck.id, ".zip");
      audit("system", "pitch_deck_exported", {
        deckId: ctx.deck.id,
        format: "zip",
        bytes: buffer.byteLength,
      });
      emit("pitch:deck:exported", { deckId: ctx.deck.id, format: "zip" });
      res.send(buffer);
    } catch (err) {
      logger.error(
        `[Pitch API] GET /decks/${req.params.deckId}/export.zip failed: ${errMessage(err)}`,
      );
      sendError(res, 500, "internal_error", "zip export failed");
    }
  });

  router.get("/decks/:deckId/export.pptx", pptxLimiter, async (req, res) => {
    const ctx = loadDeckAndKit(req, res);
    if (!ctx?.deck) return;
    try {
      const { buffer, contentType } = await pptxExporter(ctx.deck, ctx.brandKit);
      setDownloadHeaders(res, contentType, ctx.deck.title, ctx.deck.id, ".pptx");
      audit("system", "pitch_deck_exported", {
        deckId: ctx.deck.id,
        format: "pptx",
        bytes: buffer.byteLength,
      });
      emit("pitch:deck:exported", { deckId: ctx.deck.id, format: "pptx" });
      res.send(buffer);
    } catch (err) {
      logger.error(
        `[Pitch API] GET /decks/${req.params.deckId}/export.pptx failed: ${errMessage(err)}`,
      );
      sendError(res, 500, "internal_error", "pptx export failed");
    }
  });

  router.get("/decks/:deckId/export.pdf", pdfLimiter, async (req, res) => {
    const ctx = loadDeckAndKit(req, res);
    if (!ctx?.deck) return;
    // Belt-and-braces — express response timeout matches decktape's hard cap.
    req.setTimeout(60_000);
    const ac = new AbortController();
    req.once("close", () => {
      if (!res.writableEnded) ac.abort();
    });
    try {
      const { buffer, contentType } = await pdfExporter(ctx.deck, ctx.brandKit, {
        signal: ac.signal,
      });
      setDownloadHeaders(res, contentType, ctx.deck.title, ctx.deck.id, ".pdf");
      audit("system", "pitch_deck_exported", {
        deckId: ctx.deck.id,
        format: "pdf",
        bytes: buffer.byteLength,
      });
      emit("pitch:deck:exported", { deckId: ctx.deck.id, format: "pdf" });
      res.send(buffer);
    } catch (err) {
      logger.error(
        `[Pitch API] GET /decks/${req.params.deckId}/export.pdf failed: ${errMessage(err)}`,
      );
      // Generic message — never leak subprocess stderr to clients.
      sendError(res, 500, "internal_error", "pdf export failed");
    }
  });

  router.get("/decks/:deckId/export.notes.pdf", notesLimiter, async (req, res) => {
    const ctx = loadDeckAndKit(req, res);
    if (!ctx?.deck) return;
    req.setTimeout(60_000);
    const ac = new AbortController();
    req.once("close", () => {
      if (!res.writableEnded) ac.abort();
    });
    try {
      const { buffer, contentType } = await notesExporter(ctx.deck, {
        signal: ac.signal,
      });
      setDownloadHeaders(
        res,
        contentType,
        `${ctx.deck.title}-notes`,
        ctx.deck.id,
        ".pdf",
      );
      audit("system", "pitch_deck_exported", {
        deckId: ctx.deck.id,
        format: "notes-pdf",
        bytes: buffer.byteLength,
      });
      emit("pitch:deck:exported", { deckId: ctx.deck.id, format: "notes-pdf" });
      res.send(buffer);
    } catch (err) {
      logger.error(
        `[Pitch API] GET /decks/${req.params.deckId}/export.notes.pdf failed: ${errMessage(err)}`,
      );
      sendError(res, 500, "internal_error", "notes pdf export failed");
    }
  });

  router.patch("/decks/:deckId", crudLimiter, (req, res) => {
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
    audit("system", "pitch_deck_updated", {
      deckId: updated.id,
      fields: Object.keys(body),
    });
    emit("pitch:deck:updated", { deckId: updated.id, deck: updated });
    res.json({ deck: updated });
  });

  router.delete("/decks/:deckId", crudLimiter, (req, res) => {
    // Cascade is intentional (per #956 design / FK ON DELETE CASCADE on slides
    // and assets). Block only if deck is missing.
    const ok = deps.pitchRepo.deleteDeck(req.params.deckId);
    if (!ok) {
      sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
      return;
    }
    audit("system", "pitch_deck_deleted", { deckId: req.params.deckId });
    emit("pitch:deck:deleted", { deckId: req.params.deckId });
    res.json({ ok: true });
  });

  // ────────────────────────────────────────────────────────────────────
  // Slide CRUD (#959)
  // ────────────────────────────────────────────────────────────────────

  router.post("/decks/:deckId/slides", crudLimiter, (req, res) => {
    const body = parseBody(AppendSlideBody, res, req);
    if (!body) return;

    const deck = deps.pitchRepo.getDeck(req.params.deckId);
    if (!deck) {
      sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
      return;
    }

    const slides = deps.pitchRepo.listSlidesForDeck(deck.id);
    // Defence-in-depth (#977): reject before insert if appending would
    // push the deck past the schema's 80-slide hard cap. Mirrors
    // `MAX_SLIDES_PER_DECK` in `pitch-generator.ts`.
    if (slides.length >= 80) {
      sendError(
        res,
        409,
        "conflict",
        "deck has reached the 80-slide cap; remove a slide before appending",
      );
      return;
    }
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
      audit("system", "pitch_slide_created", {
        deckId: deck.id,
        slideId: created.id,
        position: insertAt,
      });
      emit("pitch:slide:created", {
        deckId: deck.id,
        slideId: created.id,
        slide: final,
      });
      res.status(201).json({ slide: final });
    } catch (err) {
      logger.error(`[Pitch API] POST /decks/:deckId/slides failed: ${errMessage(err)}`);
      sendError(res, 400, "bad_request", errMessage(err));
    }
  });

  router.patch("/decks/:deckId/slides/:slideId", crudLimiter, (req, res) => {
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
      audit("system", "pitch_slide_updated", {
        deckId: req.params.deckId,
        slideId: req.params.slideId,
        fields: Object.keys(body),
      });
      emit("pitch:slide:updated", {
        deckId: req.params.deckId,
        slideId: req.params.slideId,
        slide: updated,
      });
      res.json({ slide: updated });
    } catch (err) {
      sendError(res, 400, "bad_request", errMessage(err));
    }
  });

  router.put("/decks/:deckId/slides/:slideId/move", crudLimiter, (req, res) => {
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
      audit("system", "pitch_slide_moved", {
        deckId: req.params.deckId,
        slideId: req.params.slideId,
        from: idx,
        to: target,
      });
      emit("pitch:slide:moved", {
        deckId: req.params.deckId,
        slideId: req.params.slideId,
        from: idx,
        to: target,
        slides: ids,
      });
      res.json({ ok: true, slides: ids });
    } catch (err) {
      sendError(res, 400, "bad_request", errMessage(err));
    }
  });

  router.delete("/decks/:deckId/slides/:slideId", crudLimiter, (req, res) => {
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
    audit("system", "pitch_slide_deleted", {
      deckId: req.params.deckId,
      slideId: req.params.slideId,
    });
    emit("pitch:slide:deleted", {
      deckId: req.params.deckId,
      slideId: req.params.slideId,
    });
    res.json({ ok: true });
  });

  // ────────────────────────────────────────────────────────────────────
  // AI endpoints (#962)
  // ────────────────────────────────────────────────────────────────────

  router.post("/decks/draft", draftLimiter, async (req, res) => {
    const body = parseBody(DraftDeckBody, res, req);
    if (!body) return;

    const repoKit = deps.brandKitRepo.getById(body.brandKitId);
    if (!repoKit) {
      sendError(res, 404, "not_found", `brand kit ${body.brandKitId} not found`);
      return;
    }
    const brandKit = repoToPitchBrandKit(repoKit);

    try {
      audit("tool", "pitch_draft_started", {
        brandKitId: brandKit.id,
        scriptLength: body.script.length,
      });
      emit("pitch:draft:started", {
        brandKitId: brandKit.id,
        scriptLength: body.script.length,
      });
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
      audit("system", "pitch_deck_created", {
        deckId: persisted.id,
        brandKitId: persisted.brand_kit_id,
        source: "draft",
      });
      emit("pitch:deck:created", { deckId: persisted.id, deck: persisted });
      res.status(201).json({ deck: persisted });
    } catch (err) {
      logger.error(`[Pitch API] POST /decks/draft failed: ${errMessage(err)}`);
      sendError(res, 502, "internal_error", `pitch draft failed: ${errMessage(err)}`);
    }
  });

  router.post(
    "/decks/:deckId/slides/:slideId/regenerate",
    regenerateLimiter,
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
        audit("tool", "pitch_slide_regenerate_queued", {
          deckId: req.params.deckId,
          slideId: req.params.slideId,
          taskId: submission.task.id,
        });
        emit("pitch:slide:regenerate-queued", {
          deckId: req.params.deckId,
          slideId: req.params.slideId,
          taskId: submission.task.id,
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

  router.post("/decks/:deckId/slides/:slideId/enhance", enhanceLimiter, async (req, res) => {
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
      audit("tool", "pitch_slide_enhanced", {
        deckId: req.params.deckId,
        slideId: req.params.slideId,
      });
      emit("pitch:slide:updated", {
        deckId: req.params.deckId,
        slideId: req.params.slideId,
        slide: updated,
        source: "enhance",
      });
      res.json({ slide: updated });
    } catch (err) {
      logger.error(`[Pitch API] enhance slide failed: ${errMessage(err)}`);
      sendError(res, 502, "internal_error", `slide enhance failed: ${errMessage(err)}`);
    }
  });

  router.post("/decks/:deckId/slides/:slideId/image", imageLimiter, (req, res) => {
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
      audit("tool", "pitch_image_queued", {
        deckId: req.params.deckId,
        slideId: req.params.slideId,
        jobId: result.jobId,
        assetId: result.assetId,
        mode: body.mode,
      });
      emit("pitch:image:queued", {
        deckId: req.params.deckId,
        slideId: req.params.slideId,
        jobId: result.jobId,
        assetId: result.assetId,
        mode: body.mode,
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

  router.get("/brand-kits", crudLimiter, (_req, res) => {
    const kits = deps.brandKitRepo.getAll();
    res.json({
      brandKits: kits.map((k) => ({
        ...k,
        isStarter: STARTER_KIT_IDS.has(k.id),
      })),
    });
  });

  router.post("/brand-kits", crudLimiter, (req, res) => {
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
      audit("system", "pitch_brand_kit_created", {
        brandKitId: created.id,
        name: created.name,
      });
      emit("pitch:brand-kit:created", {
        brandKitId: created.id,
        brandKit: { ...created, isStarter: false },
      });
    } catch (err) {
      // Likely UNIQUE name collision.
      sendError(res, 409, "conflict", errMessage(err));
    }
  });

  router.get("/brand-kits/:id", crudLimiter, (req, res) => {
    const kit = deps.brandKitRepo.getById(req.params.id);
    if (!kit) {
      sendError(res, 404, "not_found", `brand kit ${req.params.id} not found`);
      return;
    }
    res.json({
      brandKit: { ...kit, isStarter: STARTER_KIT_IDS.has(kit.id) },
    });
  });

  router.patch("/brand-kits/:id", crudLimiter, (req, res) => {
    if (STARTER_KIT_IDS.has(req.params.id)) {
      audit(
        "security",
        "pitch_brand_kit_mutation_blocked",
        { brandKitId: req.params.id, reason: "starter_immutable" },
        "warn",
      );
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
    audit("system", "pitch_brand_kit_updated", {
      brandKitId: req.params.id,
      fields: Object.keys(body),
    });
    emit("pitch:brand-kit:updated", {
      brandKitId: req.params.id,
      brandKit: { ...updated, isStarter: false },
    });
    res.json({
      brandKit: { ...updated, isStarter: false },
    });
  });

  router.delete("/brand-kits/:id", crudLimiter, (req, res) => {
    if (STARTER_KIT_IDS.has(req.params.id)) {
      audit(
        "security",
        "pitch_brand_kit_mutation_blocked",
        { brandKitId: req.params.id, reason: "starter_immutable" },
        "warn",
      );
      sendError(res, 403, "forbidden", "starter brand kits cannot be deleted");
      return;
    }
    const referencingDeckId = deps.pitchRepo.findFirstDeckIdByBrandKit(
      req.params.id,
    );
    if (referencingDeckId) {
      sendError(
        res,
        409,
        "conflict",
        `brand kit is referenced by deck ${referencingDeckId}`,
        { deckId: referencingDeckId },
      );
      return;
    }
    const ok = deps.brandKitRepo.delete(req.params.id);
    if (!ok) {
      sendError(res, 404, "not_found", `brand kit ${req.params.id} not found`);
      return;
    }
    audit("system", "pitch_brand_kit_deleted", { brandKitId: req.params.id });
    emit("pitch:brand-kit:deleted", { brandKitId: req.params.id });
    res.json({ ok: true });
  });

  router.post(
    "/brand-kits/:id/logo",
    crudLimiter,
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
        audit(
          "security",
          "pitch_brand_kit_mutation_blocked",
          { brandKitId: req.params.id, reason: "starter_immutable" },
          "warn",
        );
        sendError(res, 403, "forbidden", "starter brand kits are immutable");
        return;
      }

      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        sendError(res, 400, "bad_request", "logo file is required (multipart field 'logo')");
        return;
      }
      // Step 1: Reject by claimed MIME first — cheap, keeps the deny-list tight.
      // SVG and GIF are intentionally NOT in the allow-list (stored-XSS / large
      // animated payload sinks for the Phase 4 Reveal renderer).
      if (!ALLOWED_LOGO_MIMES.has(file.mimetype)) {
        audit(
          "security",
          "pitch_logo_upload_rejected",
          {
            brandKitId: req.params.id,
            reason: "mime_not_allowed",
            claimedMime: file.mimetype,
          },
          "warn",
        );
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
        audit(
          "security",
          "pitch_logo_upload_rejected",
          {
            brandKitId: req.params.id,
            reason: "oversize",
            size: file.size,
          },
          "warn",
        );
        sendError(res, 413, "bad_request", "logo exceeds 2 MB cap");
        return;
      }

      // Step 2: Content-sniff with `sharp`. The client `Content-Type` header
      // is attacker-controlled — verify the actual bytes match the claim.
      // `sharp` parses the file header so an HTML / shell / PE payload
      // mislabelled as `image/png` will throw or report a non-image format.
      let sniffedFormat: string | undefined;
      let sniffedWidth: number | undefined;
      let sniffedHeight: number | undefined;
      try {
        const meta = await sharp(file.buffer).metadata();
        sniffedFormat = meta.format;
        sniffedWidth = meta.width;
        sniffedHeight = meta.height;
      } catch (err) {
        audit(
          "security",
          "pitch_logo_upload_rejected",
          {
            brandKitId: req.params.id,
            reason: "sniff_failed",
            claimedMime: file.mimetype,
            error: errMessage(err),
          },
          "warn",
        );
        sendError(
          res,
          400,
          "bad_request",
          "logo bytes are not a recognisable image",
        );
        return;
      }
      const sniffedMime = sniffedFormat
        ? SHARP_FORMAT_TO_MIME[sniffedFormat]
        : undefined;
      if (!sniffedMime || sniffedMime !== file.mimetype) {
        audit(
          "security",
          "pitch_logo_upload_rejected",
          {
            brandKitId: req.params.id,
            reason: "mime_mismatch",
            claimedMime: file.mimetype,
            sniffedFormat,
          },
          "warn",
        );
        sendError(
          res,
          400,
          "bad_request",
          `logo content does not match claimed MIME ${file.mimetype}`,
          { sniffedFormat: sniffedFormat ?? null },
        );
        return;
      }

      try {
        // Step 3: Re-encode through sharp. This strips EXIF, ICC profiles,
        // embedded XMP / scripts, and clamps the dimensions. The output is
        // written in the same format family as the (verified) input so the
        // brand kit retains its intended look.
        const pipeline = sharp(file.buffer).resize({
          width: LOGO_MAX_DIMENSION,
          height: LOGO_MAX_DIMENSION,
          fit: "inside",
          withoutEnlargement: true,
        });
        let reencoded: Buffer;
        switch (sniffedFormat) {
          case "png":
            reencoded = await pipeline.png().toBuffer();
            break;
          case "jpeg":
          case "jpg":
            reencoded = await pipeline.jpeg({ quality: 90 }).toBuffer();
            break;
          case "webp":
            reencoded = await pipeline.webp({ quality: 90 }).toBuffer();
            break;
          default:
            // Unreachable — gated by SHARP_FORMAT_TO_MIME above.
            sendError(
              res,
              400,
              "bad_request",
              `unsupported sniffed format ${sniffedFormat}`,
            );
            return;
        }

        const ext =
          MIME_TO_EXT[file.mimetype] ??
          (extname(file.originalname || "").replace(/^\./, "") || "bin");
        const kitDir = resolve(brandKitsDir, kit.id);
        await mkdir(kitDir, { recursive: true });
        const finalPath = join(kitDir, `logo.${ext}`);
        const tmpPath = `${finalPath}.tmp-${nanoid(8)}`;
        await writeFile(tmpPath, reencoded);
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
        audit("system", "pitch_brand_kit_logo_updated", {
          brandKitId: kit.id,
          path: finalPath,
          originalSize: file.size,
          reencodedSize: reencoded.length,
          sniffedFormat,
          width: sniffedWidth,
          height: sniffedHeight,
        });
        emit("pitch:brand-kit:updated", {
          brandKitId: kit.id,
          brandKit: { ...(updated ?? kit), isStarter: false },
          source: "logo",
        });
        res.json({
          brandKit: { ...(updated ?? kit), isStarter: false },
          logo: {
            path: finalPath,
            size: reencoded.length,
            mime: file.mimetype,
            originalSize: file.size,
          },
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
