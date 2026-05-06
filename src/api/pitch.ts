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
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { Router, type Request, type Response } from "express";
import express from "express";
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
import {
  condenseScript,
  CONDENSE_HARD_CEILING_BYTES,
  DEFAULT_CONDENSE_TARGET_BYTES,
} from "../pitch/pitch-condense.js";
import { submitSlideRegenerateTask } from "../pitch/pitch-regenerate.js";
import { enqueueSlideImage } from "../pitch/pitch-image-service.js";
import { fanOutImageGeneration, recommendedDimsForSlot } from "../pitch/image-fanout.js";
import {
  refreshFluxQGpuAvailable,
  getCachedFluxQGpuAvailable,
} from "../pitch/fluxq-recommended-dims.js";
import { renderDeckToHtml } from "../pitch/pitch-renderer.js";
import { exportDeckToPdf } from "../pitch/pitch-export-pdf.js";
import { exportDeckToPptx } from "../pitch/pitch-export-pptx.js";
import { exportDeckToZip } from "../pitch/pitch-export-zip.js";
import { exportDeckToMarkdown } from "../pitch/pitch-export-md.js";
import { exportNotesToPdf } from "../pitch/pitch-export-notes.js";
import { safeFilename } from "../pitch/pitch-export-utils.js";
import {
  ShareTokenRepository,
  hashTokenPrefix,
} from "../pitch/share-token-repository.js";
import {
  BrandKitSchema as PitchBrandKitSchema,
  DeckAspectRatioEnum,
  DeckToneEnum,
  DraftDeckBodySchema,
  ImageStyleEnum,
  SlideSchema,
  type BrandKit as PitchBrandKit,
  type Deck,
  type Slide,
} from "../pitch/pitch-schema.js";
import { STARTER_BRAND_KITS } from "../pitch/starter-brand-kits.js";
import { PITCH_ASSET_PATH_RE } from "../auth/auth.js";
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
  /**
   * Sub-issue #1000 — public share-link tokens. Optional in test harnesses
   * that don't exercise the share routes; production wiring in `src/server.ts`
   * always provides it.
   */
  shareTokenRepo?: ShareTokenRepository;
  /** Override for the brand-kit asset directory (tests). Defaults to `~/.openzigs/brand-kits`. */
  brandKitsDir?: string;
  /**
   * Override for the pitch slide-asset directory (tests). Defaults to
   * `~/.openzigs/pitch/assets` — must match `pitch-image-service.ts`
   * because the asset-serve route below containment-checks against it
   * (sub-issue #992).
   */
  assetsBaseDir?: string;
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
const DEFAULT_ASSETS_DIR = join(homedir(), ".openzigs", "pitch", "assets");
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
  | "internal_error"
  | "rate_limited"
  | "pdf_export_unavailable"
  | "image_gen_unavailable";

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

export function repoToPitchBrandKit(kit: RepoBrandKit): PitchBrandKit {
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
    // #1047 \u2014 brand-kit defaults for per-slide logo + slide-number
    // indicator. `undefined` (not null) so the optional Zod fields stay
    // omitted when the column is unset (legacy rows).
    defaultLogoPlacement: kit.defaultLogoPlacement ?? undefined,
    showSlideNumbers: kit.showSlideNumbers ?? undefined,
  });
}

function toFileUrl(p: string): string {
  if (/^[a-z]+:\/\//i.test(p)) return p;
  // Naive cross-platform file:// builder (sufficient for our local cache).
  const norm = p.replace(/\\/g, "/");
  return norm.startsWith("/") ? `file://${norm}` : `file:///${norm}`;
}

/**
 * Sub-issue #992 — build a slide-index → background-asset URL map for
 * the renderer. Picks the most-recently-created `kind="background"`
 * asset per slide so re-generations win. The renderer keys by index
 * (Deck JSON has no per-slide row IDs — see `assembleDeck` in
 * `pitch-repository.ts`), so we resolve `asset.slide_id` →
 * `slideRecord.position` here. URLs are root-relative paths into this
 * router; the renderer re-validates them through `safeUrl` before
 * emission.
 *
 * When `accessToken` is supplied, each emitted URL is suffixed with
 * `?token=<encoded>` so the rendered iframe (`/render?mode=present`) can
 * fetch the asset without an `Authorization` header — `<img>` /
 * `data-background-image` cannot carry one. The auth middleware already
 * allowlists `?token=` for `PITCH_ASSET_PATH_RE` (see `src/auth/auth.ts`).
 * Pass `undefined` (or omit) when no token is needed (test harnesses with
 * auth disabled, public-share routes that authenticate differently).
 */
export function buildBackgroundImageUrlMap(
  deckId: string,
  slides: ReadonlyArray<{ id: string; position: number }>,
  assets: ReadonlyArray<{
    id: string;
    slide_id: string | null;
    kind: string;
    created_at: string;
  }>,
  accessToken?: string,
): Map<number, string> {
  const positionBySlideId = new Map<string, number>();
  for (const s of slides) positionBySlideId.set(s.id, s.position);
  const latestByPosition = new Map<
    number,
    { id: string; created_at: string }
  >();
  for (const asset of assets) {
    if (asset.kind !== "background") continue;
    if (!asset.slide_id) continue;
    const position = positionBySlideId.get(asset.slide_id);
    if (position === undefined) continue;
    const prior = latestByPosition.get(position);
    if (!prior || asset.created_at > prior.created_at) {
      latestByPosition.set(position, {
        id: asset.id,
        created_at: asset.created_at,
      });
    }
  }
  const tokenSuffix =
    accessToken && accessToken.length > 0
      ? `?token=${encodeURIComponent(accessToken)}`
      : "";
  const out = new Map<number, string>();
  for (const [position, asset] of latestByPosition) {
    out.set(
      position,
      `/api/admin/pitch/decks/${encodeURIComponent(deckId)}/assets/${encodeURIComponent(asset.id)}${tokenSuffix}`,
    );
  }
  return out;
}

/**
 * Build a slide-index → `data:` URI map by reading every per-slide
 * background asset off disk and base64-encoding it. Used by the PDF
 * exporter because `decktape` opens the standalone HTML through a
 * `file://` URL — relative `/api/admin/pitch/decks/.../assets/...`
 * paths cannot resolve from a `file://` document and the embedded
 * Reveal background plugin silently drops them, leaving the deck with
 * its theme background instead of the brand-generated artwork.
 *
 * Same per-slide selection rules as {@link buildBackgroundImageUrlMap}
 * (latest `kind="background"` asset wins). Files outside the assets
 * base directory or missing on disk are skipped; the slide simply
 * renders without a background image. Read failures are logged but
 * never bubble up — a failed PDF export over a missing asset would be
 * worse for the user than a slide with no background.
 */
async function buildBackgroundImageDataUriMap(
  deckId: string,
  slides: ReadonlyArray<{ id: string; position: number }>,
  assets: ReadonlyArray<{
    id: string;
    deck_id: string;
    slide_id: string | null;
    kind: string;
    local_path: string;
    mime_type?: string | null;
    created_at: string;
  }>,
  assetsBaseDir: string,
): Promise<Map<number, string>> {
  const positionBySlideId = new Map<string, number>();
  for (const s of slides) positionBySlideId.set(s.id, s.position);
  const latestByPosition = new Map<
    number,
    {
      id: string;
      created_at: string;
      local_path: string;
      mime_type?: string | null;
    }
  >();
  for (const asset of assets) {
    if (asset.kind !== "background") continue;
    if (!asset.slide_id) continue;
    if (asset.deck_id !== deckId) continue;
    const position = positionBySlideId.get(asset.slide_id);
    if (position === undefined) continue;
    const prior = latestByPosition.get(position);
    if (!prior || asset.created_at > prior.created_at) {
      latestByPosition.set(position, {
        id: asset.id,
        created_at: asset.created_at,
        local_path: asset.local_path,
        mime_type: asset.mime_type ?? null,
      });
    }
  }
  const out = new Map<number, string>();
  await Promise.all(
    Array.from(latestByPosition.entries()).map(async ([position, asset]) => {
      try {
        const absPath = resolve(asset.local_path);
        const rel = relative(assetsBaseDir, absPath);
        if (rel.startsWith("..") || resolve(assetsBaseDir, rel) !== absPath) {
          return;
        }
        if (!existsSync(absPath)) return;
        const bytes = await readFile(absPath);
        const mime = asset.mime_type && /^image\//.test(asset.mime_type)
          ? asset.mime_type
          : sniffImageMime(bytes) ?? "image/png";
        out.set(position, `data:${mime};base64,${bytes.toString("base64")}`);
      } catch (err) {
        logger.warn(
          `[Pitch API] PDF bg asset read failed (deck ${deckId}, slide pos ${position}, asset ${asset.id}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );
  return out;
}

/**
 * Best-effort image MIME sniff using the first few bytes. Limited to the
 * formats produced by the Pitch image pipeline (PNG, JPEG, WEBP) plus
 * GIF for completeness. Returns `undefined` when the magic bytes don't
 * match any known image type so callers can fall back to a default.
 */
function sniffImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  return undefined;
}

// ── Render-iframe auth-token plumbing (Pitch Present bug fix) ───────────
//
// The Present route mounts `/render?mode=present` HTML inside a sandboxed
// `<iframe srcDoc>`. Inside that iframe `<img>` / `data-background-image`
// requests cannot carry an `Authorization: Bearer ...` header (the
// browser strips it for navigation-style asset GETs), so they 401 against
// the admin auth middleware. The middleware already allowlists `?token=`
// for `/api/admin/pitch/decks/.../assets/...` precisely for this scenario
// (see `PITCH_ASSET_PATH_RE` in `src/auth/auth.ts`); the helpers below
// append the token to the URLs that the renderer emits.

/**
 * Append `?token=<encoded>` to a single URL iff its path matches the
 * Pitch asset route. Preserves any pre-existing query string and is a
 * no-op for null/undefined/non-matching URLs. The token is always run
 * through `encodeURIComponent` so that a token containing `&`, `?`, `#`,
 * `=`, or `/` cannot inject extra query params or path segments.
 *
 * Exported for direct unit testing — see `pitch.test.ts`.
 */
export function appendTokenToAssetUrl(
  url: string | null | undefined,
  token: string,
): string | null {
  if (!url) return url ?? null;
  if (!token) return url;
  const [path, existingQuery] = url.split("?", 2);
  if (!PITCH_ASSET_PATH_RE.test(path)) return url;
  const prefix = existingQuery ? `?${existingQuery}&` : "?";
  return `${path}${prefix}token=${encodeURIComponent(token)}`;
}

/**
 * Extract the bearer token used to authenticate the current request.
 * Reads `Authorization: Bearer <token>` first, then falls back to
 * `?token=` (the render route's `PITCH_RENDER_PATH_RE` allowlist still
 * accepts the query form for backwards compatibility with externally
 * saved Present URLs / shared bookmarks). Returns `undefined` when no
 * token was presented (e.g. auth disabled, test harness without
 * middleware) — callers MUST treat this as "do not append a token" so we
 * never surface a literal `?token=` in audit logs or the rendered HTML.
 */
function extractRequestAuthToken(req: Request): string | undefined {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) {
    const t = header.slice("Bearer ".length).trim();
    if (t.length > 0) return t;
  }
  const q = req.query.token;
  if (typeof q === "string" && q.length > 0) return q;
  return undefined;
}

/**
 * Mutate-in-place: walk `deck.slides` and tokenize every inline image
 * `url` that points at the local Pitch asset route. Touches the
 * three slide image slots produced by `SlideImageSchema` —
 * `content.image`, `content.left_image`, `content.right_image`. Safe to
 * call when `token` is empty (no-op) and safe against unknown templates
 * (only reads the documented field names).
 *
 * IMPORTANT: callers pass an in-memory deck object (returned fresh from
 * `pitchRepo.getDeck()` each request via `assembleDeck()`), so this never
 * leaks token-tagged URLs back into persistence.
 */
export function appendTokenToPitchAssetUrls(
  deck: { slides: Array<Record<string, unknown>> },
  token: string,
): void {
  if (!token) return;
  for (const slide of deck.slides) {
    const content = (slide as { content?: Record<string, unknown> }).content;
    if (!content || typeof content !== "object") continue;
    for (const slot of ["image", "left_image", "right_image"] as const) {
      const img = content[slot] as
        | { url?: string | null }
        | undefined
        | null;
      if (!img || typeof img !== "object") continue;
      const next = appendTokenToAssetUrl(img.url, token);
      if (next !== img.url) img.url = next;
    }
  }
}

// ── Body schemas ────────────────────────────────────────────────────────

const DeckMetadataSchema = z
  .object({
    source_script: z.string().max(50_000).default(""),
    source_summary: z.string().max(2000).optional(),
    audience: z.string().max(120).optional(),
    tone: DeckToneEnum.default("formal"),
    estimated_minutes: z.number().int().min(1).max(180).optional(),
    image_style: ImageStyleEnum.optional(),
    image_model: z.enum(["flux-schnell", "flux-dev"]).optional(),
    auto_generate_backgrounds: z.boolean().optional(),
  })
  .strict();

/** PATCH /decks/:id — all keys optional so a client can update e.g. `image_style` alone. */
const DeckMetadataPatchSchema = z
  .object({
    source_script: z.string().max(50_000).optional(),
    source_summary: z.string().max(2000).optional(),
    audience: z.string().max(120).optional(),
    tone: DeckToneEnum.optional(),
    estimated_minutes: z.number().int().min(1).max(180).optional(),
    image_style: ImageStyleEnum.optional(),
    image_model: z.enum(["flux-schnell", "flux-dev"]).optional(),
    auto_generate_backgrounds: z.boolean().optional(),
  })
  .strict();

function mergeDeckMetadata(
  prev: Deck["metadata"],
  patch: z.infer<typeof DeckMetadataPatchSchema>,
): Deck["metadata"] {
  return {
    source_script:
      patch.source_script !== undefined ? patch.source_script : prev.source_script,
    source_summary:
      patch.source_summary !== undefined
        ? patch.source_summary
        : prev.source_summary,
    audience: patch.audience !== undefined ? patch.audience : prev.audience,
    tone: patch.tone !== undefined ? patch.tone : prev.tone,
    estimated_minutes:
      patch.estimated_minutes !== undefined
        ? patch.estimated_minutes
        : prev.estimated_minutes,
    image_style:
      patch.image_style !== undefined ? patch.image_style : prev.image_style,
    image_model:
      patch.image_model !== undefined ? patch.image_model : prev.image_model,
    auto_generate_backgrounds:
      patch.auto_generate_backgrounds !== undefined
        ? patch.auto_generate_backgrounds
        : prev.auto_generate_backgrounds,
  };
}

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
    metadata: DeckMetadataPatchSchema.optional(),
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
    /**
     * For inline images on multi-slot templates (`two_column`), pin the
     * regenerate to a specific slot. Defaults to `"image"` for the
     * single-slot templates and `background` mode.
     */
    slot: z.enum(["image", "left_image", "right_image"]).optional(),
    /** Per-regenerate FluxQ model override; falls back to deck-level. */
    model: z.enum(["flux-schnell", "flux-dev"]).optional(),
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
    // #1047 — brand-kit defaults for per-slide chrome.
    defaultLogoPlacement: z
      .enum(["top-left", "top-right", "bottom-left", "bottom-right", "none"])
      .optional(),
    showSlideNumbers: z.boolean().optional(),
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
    // #1047 — brand-kit defaults; nullable so callers can clear them.
    defaultLogoPlacement: z
      .enum(["top-left", "top-right", "bottom-left", "bottom-right", "none"])
      .nullable()
      .optional(),
    showSlideNumbers: z.boolean().nullable().optional(),
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
  const assetsBaseDir = resolve(deps.assetsBaseDir ?? DEFAULT_ASSETS_DIR);

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
  const reconcileInlineImageAssets = (deckId: string): void => {
    try {
      const patched = deps.pitchRepo.reconcileImageAssetsForDeck(deckId);
      if (patched > 0) {
        audit("system", "pitch.image.assets_reconciled", { deckId, patched });
      }
    } catch (err) {
      logger.warn(
        `[Pitch API] inline image asset reconciliation failed for ${deckId}: ${errMessage(err)}`,
      );
      audit(
        "system",
        "pitch.image.assets_reconcile_failed",
        { deckId, error: errMessage(err) },
        "warn",
      );
    }
  };
  const auditRouteFailure = (
    req: Request,
    status: number,
    error: unknown,
    details: Record<string, unknown> = {},
  ): void => {
    audit(
      "system",
      "pitch.route_failed",
      {
        route: req.originalUrl ?? req.url,
        method: req.method,
        status,
        cause: errMessage(error).slice(0, 500),
        ...details,
      },
      status >= 500 ? "error" : "warn",
    );
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
  // Bulk fan-out is a heavyweight action — cap at 12/hr/IP. Per-deck the
  // sub-issue spec calls for "max 1 / 5s per deck" idempotency; that
  // tighter cap is enforced separately via an in-memory map below.
  const generateAllLimiter = buildLimiter(12, "generate-all images");
  const pdfLimiter = buildLimiter(20, "PDF export");
  const pptxLimiter = buildLimiter(30, "PPTX export");
  const zipLimiter = buildLimiter(30, "ZIP export");
  const mdLimiter = buildLimiter(60, "Markdown export");
  const htmlLimiter = buildLimiter(60, "HTML export");
  const notesLimiter = buildLimiter(20, "speaker-notes PDF");
  const crudLimiter = buildLimiter(600, "API");
  const condenseLimiter = buildLimiter(20, "script condense");
  // Issuing share tokens is cheap but security-sensitive — keep the per-IP
  // ceiling tight so a stolen admin token can't be used to spray hundreds
  // of public links before the operator notices.
  const shareLimiter = buildLimiter(60, "share-token");

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

    try {
      const all = deps.pitchRepo.listDecks();
      const page = all.slice(offset, offset + limit);
      res.json({
        decks: page,
        pagination: { total: all.length, limit, offset },
      });
    } catch (err) {
      logger.error(`[Pitch API] GET /decks failed: ${errMessage(err)}`);
      auditRouteFailure(req, 500, err);
      sendError(res, 500, "internal_error", "could not load pitch decks", {
        route: "/api/admin/pitch/decks",
      });
    }
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
    reconcileInlineImageAssets(req.params.deckId);
    const deck = deps.pitchRepo.getDeck(req.params.deckId);
    if (!deck) {
      auditRouteFailure(req, 404, `deck ${req.params.deckId} not found`, {
        deckId: req.params.deckId,
      });
      sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
      return;
    }
    const slides = deps.pitchRepo.listSlidesForDeck(deck.id);
    res.json({ deck, slides });
  });

  // ────────────────────────────────────────────────────────────────────
  // Sub-issue #992 — Asset-serve endpoint
  //
  // Serves bytes for a `pitch_assets` row (typically a flux-generated
  // background or inline image). Used by:
  //   - the `/render` background URL map (this PR)
  //   - future client-side previews (e.g. the regenerate dialog
  //     thumbnail)
  //
  // Hardening:
  //   - Asset must belong to the URL's deck (404 otherwise — no leakage
  //     of which assetIds exist across decks).
  //   - The resolved `local_path` must lie under `assetsBaseDir`. We
  //     never trust the row blindly; defense-in-depth against any future
  //     code path that might write a path traversal into the table.
  //   - `Cache-Control: no-store` so a regenerated asset isn't served
  //     stale.
  // ────────────────────────────────────────────────────────────────────
  router.get("/decks/:deckId/assets/:assetId", crudLimiter, (req, res) => {
    const { deckId, assetId } = req.params;
    const assets = deps.pitchRepo.listAssetsForDeck(deckId);
    const asset = assets.find((a) => a.id === assetId);
    if (!asset) {
      sendError(res, 404, "not_found", "asset not found");
      return;
    }
    // `listAssetsForDeck` already scopes to deckId, but be explicit.
    if (asset.deck_id !== deckId) {
      sendError(res, 404, "not_found", "asset not found");
      return;
    }
    const absPath = resolve(asset.local_path);
    const rel = relative(assetsBaseDir, absPath);
    if (rel.startsWith("..") || resolve(assetsBaseDir, rel) !== absPath) {
      audit(
        "security",
        "pitch_asset_path_outside_root",
        { deckId, assetId, absPath, assetsBaseDir },
        "warn",
      );
      sendError(res, 404, "not_found", "asset not found");
      return;
    }
    if (!existsSync(absPath)) {
      // Sub-issue #1039 / Epic #1035 AC5 — emit a structured audit
      // entry so a missing-on-disk asset (typically caused by a
      // workspace migration, manual cleanup, or a half-failed flux
      // job) surfaces alongside the other pitch route failures
      // instead of silently 404-ing the client.
      auditRouteFailure(req, 404, "asset file missing", {
        deckId,
        assetId,
        kind: asset.kind,
        localPath: absPath,
      });
      sendError(res, 404, "not_found", "asset file missing");
      return;
    }
    res.setHeader("Content-Type", asset.mime || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(absPath, (err) => {
      if (err && !res.headersSent) {
        sendError(res, 500, "internal_error", "asset send failed");
      }
    });
  });

  // Phase 4 / sub-issue #963 — Reveal HTML render endpoint.
  router.get("/decks/:deckId/render", htmlLimiter, (req, res) => {
    const rawMode = req.query.mode;
    const mode: "embedded" | "present" | "standalone" =
      rawMode === "standalone"
        ? "standalone"
        : rawMode === "present"
          ? "present"
          : "embedded";
    reconcileInlineImageAssets(req.params.deckId);
    const deck = deps.pitchRepo.getDeck(req.params.deckId);
    if (!deck) {
      auditRouteFailure(req, 404, `deck ${req.params.deckId} not found`, {
        deckId: req.params.deckId,
      });
      sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
      return;
    }
    const repoKit = deps.brandKitRepo.getById(deck.brand_kit_id);
    if (!repoKit) {
      auditRouteFailure(req, 404, `brand kit ${deck.brand_kit_id} not found`, {
        deckId: deck.id,
        brandKitId: deck.brand_kit_id,
      });
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
      // Pitch Present iframe asset auth — see comment near
      // `appendTokenToPitchAssetUrls`. Tokenize background image URLs and
      // inline image URLs so the sandboxed iframe can load them via the
      // `?token=` allowlist (no Authorization header reachable from
      // `<img>` / `data-background-image`). No-op when the request was
      // unauthenticated (test harness, future auth modes).
      const accessToken = extractRequestAuthToken(req);
      const backgroundImageUrlBySlideIndex = buildBackgroundImageUrlMap(
        deck.id,
        deps.pitchRepo.listSlidesForDeck(deck.id),
        deps.pitchRepo.listAssetsForDeck(deck.id),
        accessToken,
      );
      if (accessToken) {
        appendTokenToPitchAssetUrls(deck, accessToken);
      }
      // Sub-issue #996 — single-slide thumbnail filter. The query
      // parameter is the slide ROW id (not its position) so the slide-rail
      // can pass the same id it shows in `data-testid`. We resolve it to
      // the array index here because `renderDeckToHtml` keys on index.
      // Unknown slide ids fall through to a full-deck render so a stale
      // tile cannot 404 the whole page.
      const rawSlide = req.query.slide;
      let slideIndex: number | undefined;
      if (typeof rawSlide === "string" && rawSlide.length > 0) {
        const slideRows = deps.pitchRepo.listSlidesForDeck(deck.id);
        const idx = slideRows.findIndex((s) => s.id === rawSlide);
        if (idx >= 0) slideIndex = idx;
      }
      const renderOpts: Parameters<typeof renderDeckToHtml>[3] = {
        backgroundImageUrlBySlideIndex,
      };
      if (slideIndex !== undefined) {
        renderOpts.slideIndex = slideIndex;
      }
      // Bug-fix 2026-04-28 — `?initial=N` boots the embedded Reveal at
      // the slide the user just selected in the rail. Out-of-range or
      // non-numeric values fall through to slide 0.
      const rawInitial = req.query.initial;
      if (typeof rawInitial === "string" && rawInitial.length > 0) {
        const parsed = Number.parseInt(rawInitial, 10);
        if (Number.isInteger(parsed) && parsed >= 0) {
          renderOpts.initialSlideIndex = parsed;
        }
      }
      const { html, slideCount } = renderDeckToHtml(
        deck,
        brandKit,
        mode,
        renderOpts,
      );
      audit("system", "pitch_deck_rendered", {
        deckId: deck.id,
        mode,
        slideCount,
        ...(slideIndex !== undefined ? { slideIndex } : {}),
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
      // #1019: Google Fonts origins (fonts.googleapis.com for the CSS
      // stylesheet, fonts.gstatic.com for the woff2 payload) are now
      // explicitly allowed so the brand-kit `<link>` tags emitted by the
      // renderer don't get blocked. Family names are sanitised through a
      // strict allowlist in the renderer (#1007) so this expansion does
      // not introduce a user-controlled URL surface.
      res.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
          "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
          "img-src 'self' data: https:",
          "font-src 'self' data: https: https://fonts.gstatic.com",
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
      auditRouteFailure(req, 500, err, { deckId: req.params.deckId });
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

  /**
   * True if the error looks like a Decktape/Chromium spawn failure
   * (binary missing, not executable, headless launch crashed). We surface
   * these as 503 with a structured body so the UI can prompt the user to
   * warm the cache instead of showing a generic "PDF export failed" toast.
   */
  const isPdfToolUnavailable = (err: unknown): boolean => {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") return true;
    const msg = errMessage(err).toLowerCase();
    return (
      msg.includes("enoent") ||
      msg.includes("spawn decktape") ||
      msg.includes("decktape: not found") ||
      msg.includes("chromium") && msg.includes("failed")
    );
  };
  const PDF_UNAVAILABLE_DETAIL =
    "Decktape/Chromium failed to start. Run `npx decktape --version` to warm the cache.";

  type DeckCtx = {
    deck: ReturnType<PitchRepository["getDeck"]>;
    brandKit: PitchBrandKit;
  };
  const loadDeckAndKit = (req: Request, res: Response): DeckCtx | null => {
    reconcileInlineImageAssets(req.params.deckId);
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
      // Same Present-iframe asset-auth plumbing as `/render`. Even though
      // the standalone HTML is downloadable, when an operator opens it in
      // a browser tab it loads asset URLs sans Authorization header, so
      // they need the `?token=` query suffix to authenticate.
      const accessToken = extractRequestAuthToken(req);
      const backgroundImageUrlBySlideIndex = buildBackgroundImageUrlMap(
        ctx.deck.id,
        deps.pitchRepo.listSlidesForDeck(ctx.deck.id),
        deps.pitchRepo.listAssetsForDeck(ctx.deck.id),
        accessToken,
      );
      if (accessToken) {
        appendTokenToPitchAssetUrls(ctx.deck, accessToken);
      }
      const { html, slideCount } = renderDeckToHtml(
        ctx.deck,
        ctx.brandKit,
        "standalone",
        { backgroundImageUrlBySlideIndex },
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
      // #1019: Google Fonts origins added to style-src/font-src so brand-
      // kit web fonts load in exported HTML (was a CSP block in production).
      res.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
          "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
          "img-src 'self' data: https:",
          "font-src 'self' data: https: https://fonts.gstatic.com",
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
      // Decktape opens the standalone HTML over `file://`, so we materialise
      // every per-slide background asset into a `data:` URI here. The
      // helper reads each asset's bytes off disk (under `assetsBaseDir`)
      // and base64-encodes them, which produces a fully self-contained
      // PDF — no network fetches, no token plumbing, no surprise 401s
      // from the asset route's auth middleware. Other export paths
      // (`/render`, `/export.html`) keep using the relative asset URLs
      // because they run inside the authenticated app origin.
      const backgroundImageUrlBySlideIndex = await buildBackgroundImageDataUriMap(
        ctx.deck.id,
        deps.pitchRepo.listSlidesForDeck(ctx.deck.id),
        deps.pitchRepo.listAssetsForDeck(ctx.deck.id),
        assetsBaseDir,
      );
      logger.info(
        `[Pitch API] PDF export bg map for deck ${ctx.deck.id}: ${backgroundImageUrlBySlideIndex.size} backgrounds embedded`,
      );
      const { buffer, contentType } = await pdfExporter(ctx.deck, ctx.brandKit, {
        signal: ac.signal,
        backgroundImageUrlBySlideIndex,
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
      if (isPdfToolUnavailable(err)) {
        sendError(res, 503, "pdf_export_unavailable", PDF_UNAVAILABLE_DETAIL);
        return;
      }
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
      if (isPdfToolUnavailable(err)) {
        sendError(res, 503, "pdf_export_unavailable", PDF_UNAVAILABLE_DETAIL);
        return;
      }
      sendError(res, 500, "internal_error", "notes pdf export failed");
    }
  });

  router.patch("/decks/:deckId", crudLimiter, (req, res) => {
    const body = parseBody(UpdateDeckBody, res, req);
    if (!body) return;

    const existingDeck = deps.pitchRepo.getDeck(req.params.deckId);
    if (!existingDeck) {
      sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
      return;
    }

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
        ? mergeDeckMetadata(existingDeck.metadata, body.metadata)
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

  // ── POST /script/condense — AI map-reduce summarization ──────────
  // Pre-processing escape valve for oversize script uploads (up to 2 MB).
  // The persisted `source_script` cap stays at 50 KB; this route runs the
  // raw input through `condenseScript` and returns text suitable for the
  // existing `/decks/draft` pipeline.
  //
  // Body limit is bumped to 2.5 MB ON THIS ROUTE ONLY via per-route
  // `express.json`; the global parser in `src/app.ts` skips this prefix
  // (see `skipGlobalParser`). Do NOT widen the global limit — every other
  // pitch route still uses the 1 MB cap.
  const CondenseScriptBody = z
    .object({
      text: z.string().min(1).max(CONDENSE_HARD_CEILING_BYTES),
      targetBytes: z.number().int().min(5_000).max(50_000).optional(),
      /** Optional LLM model override forwarded to the Copilot wrapper.
       *  When omitted, the wrapper's selected default is used. */
      model: z.string().min(1).max(100).optional(),
    })
    .strict();

  router.post(
    "/script/condense",
    condenseLimiter,
    express.json({ limit: "2.5mb" }),
    // Catch the body-parser's `entity.too.large` synchronously so the
    // client gets a stable structured envelope instead of the default
    // PayloadTooLargeError HTML page.
    (
      err: (Error & { type?: string; status?: number }) | null,
      _req: Request,
      res: Response,
      next: (e?: unknown) => void,
    ) => {
      if (err && (err.type === "entity.too.large" || err.status === 413)) {
        res
          .status(413)
          .json({ error: "script_too_large", maxBytes: CONDENSE_HARD_CEILING_BYTES });
        return;
      }
      next(err ?? undefined);
    },
    async (req: Request, res: Response) => {
      const parsed = CondenseScriptBody.safeParse(req.body);
      if (!parsed.success) {
        // The Zod `max()` rejection for an oversize text field is also a
        // 413 (semantically a payload-too-large), not a 400.
        const tooLarge = parsed.error.issues.some(
          (i) => i.path[0] === "text" && i.code === "too_big",
        );
        if (tooLarge) {
          res
            .status(413)
            .json({ error: "script_too_large", maxBytes: CONDENSE_HARD_CEILING_BYTES });
          return;
        }
        sendError(res, 400, "validation_error", "Request body failed validation", {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
            code: i.code,
          })),
        });
        return;
      }
      const body = parsed.data;
      const targetBytes = body.targetBytes ?? DEFAULT_CONDENSE_TARGET_BYTES;

      try {
        const result = await condenseScript(body.text, deps.copilot, {
          targetBytes,
          ...(body.model ? { model: body.model } : {}),
        });
        audit("system", "pitch.script.condensed", {
          originalBytes: result.originalBytes,
          condensedBytes: result.condensedBytes,
          chunks: result.chunks,
          targetBytes,
        });
        res.status(200).json(result);
      } catch (err) {
        const detail = errMessage(err);
        // The hard-ceiling guard inside `condenseScript` is also reachable
        // here if the per-route body parser somehow let through > 2 MB.
        if (/hard ceiling/i.test(detail)) {
          res
            .status(413)
            .json({ error: "script_too_large", maxBytes: CONDENSE_HARD_CEILING_BYTES });
          return;
        }
        logger.error(`[Pitch API] POST /script/condense failed: ${detail}`);
        res.status(502).json({ error: "condense_failed", detail });
      }
    },
  );

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
        ...(body.options?.model ? { model: body.options.model } : {}),
      });

      // Persist via repo, overriding the title if the caller supplied one.
      const finalTitle = body.title ?? generated.title;
      // Sub-issue #998 — the wizard's `imageStyle` lives on the request
      // options envelope; persist it onto the deck metadata so subsequent
      // bulk re-generation (and the per-slide single-image POST) can
      // resolve it without forcing the client to re-send.
      const persistedMetadata = body.options?.imageStyle
        ? { ...generated.metadata, image_style: body.options.imageStyle }
        : generated.metadata;
      const persisted = deps.pitchRepo.insertDeck({
        id: nanoid(),
        title: finalTitle,
        brand_kit_id: brandKit.id,
        aspect_ratio: generated.aspect_ratio,
        metadata: persistedMetadata,
        slides: generated.slides.map((slide) => ({ id: nanoid(), slide })),
      });
      audit("system", "pitch_deck_created", {
        deckId: persisted.id,
        brandKitId: persisted.brand_kit_id,
        source: "draft",
      });
      emit("pitch:deck:created", { deckId: persisted.id, deck: persisted });

      // Sub-issue #995 — auto-fan-out flux jobs for every image-bearing
      // slide. Default is opt-in (`autoGenerateImages` defaults to `true`
      // in the Zod schema). We *intentionally* do NOT await the fan-out
      // — the user gets a fast 201 response and the UI subscribes to
      // `pitch:image:queued` / `pitch:image:ready` over Socket.IO.
      const autoGen = body.options?.autoGenerateImages ?? true;
      if (autoGen) {
        const slidesForFanout = deps.pitchRepo
          .listSlidesForDeck(persisted.id)
          .map((s) => ({ id: s.id, slide: s.slide }));
        // Schedule on next tick so the HTTP response is flushed first.
        void (async () => {
          try {
            const result = await fanOutImageGeneration({
              deckId: persisted.id,
              slides: slidesForFanout,
              mediaQueueRepo: deps.mediaQueueRepo,
              ...(deps.characterRepo ? { characterRepo: deps.characterRepo } : {}),
              ...(body.options?.imageStyle
                ? { imageStyle: body.options.imageStyle }
                : {}),
              ...(body.options?.imageModel
                ? { imageModel: body.options.imageModel }
                : persisted.metadata.image_model
                ? { imageModel: persisted.metadata.image_model }
                : {}),
              concurrency: 4,
              // Issue #1007 — derive a fallback background image when the
              // AI/user did not author one. Honour the deck-level
              // `auto_generate_backgrounds` toggle (defaults to ON).
              deriveFallbackBackgrounds:
                body.options?.autoGenerateBackgrounds ??
                persisted.metadata.auto_generate_backgrounds ??
                true,
              onEnqueued: (info) => {
                emit("pitch:image:queued", {
                  deckId: persisted.id,
                  slideId: info.slideId,
                  slot: info.slot,
                  jobId: info.jobId,
                  assetId: info.assetId,
                  source: "auto_draft",
                });
              },
              onEnqueueError: (info) => {
                emit("pitch:image:failed", {
                  deckId: persisted.id,
                  slideId: info.slideId,
                  slot: info.slot,
                  error: info.error,
                  source: "auto_draft",
                });
              },
            });
            audit("system", "pitch.images.bulk_enqueued", {
              deckId: persisted.id,
              source: "auto_draft",
              enqueued: result.enqueued,
              skipped: result.skipped,
              total: result.total,
            });
          } catch (err) {
            logger.error(
              `[Pitch API] auto-fan-out failed: ${errMessage(err)}`,
            );
          }
        })();
      }

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

    // Sub-issue #998 \u2014 resolve effective style: per-slide override beats
    // the deck-level default persisted on `metadata.image_style`.
    const deckForStyle = deps.pitchRepo.getDeck(req.params.deckId);
    const deckMeta = deckForStyle?.metadata as
      | { image_style?: string; image_model?: "flux-schnell" | "flux-dev" }
      | undefined;
    const effectiveImageStyle =
      slide.slide.image_style ??
      (typeof deckMeta?.image_style === "string"
        ? (deckMeta.image_style as never)
        : undefined);
    // Per-regenerate model override beats the deck default.
    const effectiveModel = body.model ?? deckMeta?.image_model;
    // Slot resolution: explicit body.slot wins; otherwise inline mode
    // defaults to the generic "image" slot (the right one for
    // single-image templates) and background mode is forced to "image"
    // because background is identified by `kind`, not `slot`.
    const effectiveSlot =
      body.mode === "inline" ? body.slot ?? "image" : "image";

    // Bug-fix (PR #1044 walkthrough Bug #2): the studio's
    // RegenerateImageDialog does not send width/height, so they were
    // dropping through to clampToFluxQRecommendedDims(undefined,
    // undefined) and producing the 1024×576 fallback for every
    // regenerated background. Derive slot-aware defaults so a
    // background regenerate stays at 1920×1080 and a two_column
    // left_image stays at 960×1080. An explicit body.width/height
    // still wins.
    const effectiveKind: "image" | "background" =
      body.mode === "inline" ? "image" : "background";
    const dimsDefault = recommendedDimsForSlot(
      slide.slide.template,
      effectiveSlot,
      effectiveKind,
    );
    const effectiveWidth = body.width ?? dimsDefault.width;
    const effectiveHeight = body.height ?? dimsDefault.height;

    try {
      const result = enqueueSlideImage({
        deckId: req.params.deckId,
        slideId: req.params.slideId,
        prompt: finalPrompt,
        kind: effectiveKind,
        slot: effectiveSlot,
        seed: body.seed,
        width: effectiveWidth,
        height: effectiveHeight,
        mediaQueueRepo: deps.mediaQueueRepo,
        characterRepo: deps.characterRepo,
        ...(effectiveImageStyle ? { imageStyle: effectiveImageStyle } : {}),
        ...(effectiveModel ? { preferredModel: effectiveModel } : {}),
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
        slot: body.mode === "inline" ? effectiveSlot : "background",
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
  // Bulk fan-out — sub-issue #991 ("Generate all images" toolbar button)
  // Idempotent: slides whose image already has a URL are counted as
  // `skipped`. Per-deck cooldown of 5 s prevents accidental double-fire.
  // ────────────────────────────────────────────────────────────────────
  const lastBulkAtByDeck = new Map<string, number>();
  const BULK_COOLDOWN_MS = 5_000;
  // Sub-issue #1039 / Epic #1035 AC3 — accept an optional `slideIds`
  // filter so the slide-rail's per-slide retry control can re-enqueue
  // a single failing slide instead of fanning out across the whole
  // deck. Empty or omitted = all slides (legacy bulk-button behaviour).
  const GenerateAllImagesBody = z
    .object({
      slideIds: z.array(z.string().min(1)).max(200).optional(),
      /** When true, enqueue new background jobs even if a background asset already exists for each slide. */
      regenerateBackgrounds: z.boolean().optional(),
    })
    .strict();

  router.post(
    "/decks/:deckId/images/generate-all",
    generateAllLimiter,
    async (req, res) => {
      const body = parseBody(GenerateAllImagesBody, res, req);
      if (!body) return;
      const deckId = req.params.deckId;
      const deck = deps.pitchRepo.getDeck(deckId);
      if (!deck) {
        sendError(res, 404, "not_found", `deck ${deckId} not found`);
        return;
      }

      // Bug-fix (post-PR-#1041 walkthrough): when the FluxQ sidecar is
      // running but has lost its CUDA accelerator, every enqueued txt2img
      // job fails downstream with "`enable_model_cpu_offload` requires
      // accelerator, but not found" and the user is left staring at a
      // "Retry failed (12)" banner with no idea why. Probe the sidecar's
      // `/gpu-info` once before the fan-out and short-circuit with a
      // structured 503 when GPU is *definitively* unavailable. We do
      // NOT block on probe failure (`undefined` result) — that preserves
      // the legacy best-effort behaviour for environments where the
      // probe is unreachable but jobs may still succeed via a different
      // sidecar configuration. The pre-flight runs BEFORE the cooldown
      // window is armed so a transient outage does not lock the deck
      // out for 5 s.
      const gpuAvailable = await refreshFluxQGpuAvailable();
      if (gpuAvailable === false) {
        audit(
          "system",
          "pitch.images.bulk_blocked_no_gpu",
          { deckId, cachedGpuAvailable: getCachedFluxQGpuAvailable() },
          "warn",
        );
        sendError(
          res,
          503,
          "image_gen_unavailable",
          "Image generation is unavailable: the FluxQ sidecar reports no usable GPU. Verify the CUDA driver is healthy and restart the sidecar before retrying.",
        );
        return;
      }

      const now = Date.now();
      const last = lastBulkAtByDeck.get(deckId) ?? 0;
      if (now - last < BULK_COOLDOWN_MS) {
        const retryMs = BULK_COOLDOWN_MS - (now - last);
        res.setHeader("Retry-After", Math.ceil(retryMs / 1000).toString());
        sendError(res, 429, "rate_limited", "generate-all cooldown active");
        return;
      }
      lastBulkAtByDeck.set(deckId, now);

      reconcileInlineImageAssets(deckId);
      const allSlides = deps.pitchRepo
        .listSlidesForDeck(deckId)
        .map((s) => ({ id: s.id, slide: s.slide }));
      // Sub-issue #1039 / Epic #1035 AC3 — when a `slideIds` filter is
      // present, scope the fan-out to those slides. Unknown ids are
      // dropped silently (matches `generate-all`'s idempotent contract);
      // an empty post-filter list short-circuits with a 404 so callers
      // get a clear signal instead of a 200/0-enqueued no-op.
      const requestedIds = body.slideIds && body.slideIds.length > 0
        ? new Set(body.slideIds)
        : null;
      const slidesForFanout = requestedIds
        ? allSlides.filter((s) => requestedIds.has(s.id))
        : allSlides;
      if (requestedIds && slidesForFanout.length === 0) {
        sendError(
          res,
          404,
          "not_found",
          `no matching slides for deck ${deckId}`,
        );
        return;
      }
      const existingBackgroundSlideIds =
        body.regenerateBackgrounds === true
          ? new Set<string>()
          : new Set(
              deps.pitchRepo
                .listAssetsForDeck(deckId)
                .filter((a) => a.kind === "background" && a.slide_id)
                .map((a) => a.slide_id as string),
            );

      // Sub-issue #998 — honour the deck-level image-style preset
      // persisted on `metadata.image_style` so re-running generate-all
      // produces visually consistent imagery with the original draft.
      const deckMeta = deck.metadata as
        | {
            image_style?: string;
            image_model?: "flux-schnell" | "flux-dev";
            auto_generate_backgrounds?: boolean;
          }
        | undefined;
      const deckImageStyle =
        typeof deckMeta?.image_style === "string"
          ? deckMeta.image_style
          : undefined;

      try {
        const result = await fanOutImageGeneration({
          deckId,
          slides: slidesForFanout,
          mediaQueueRepo: deps.mediaQueueRepo,
          ...(deps.characterRepo ? { characterRepo: deps.characterRepo } : {}),
          ...(deckImageStyle
            ? { imageStyle: deckImageStyle as never }
            : {}),
          ...(deckMeta?.image_model
            ? { imageModel: deckMeta.image_model }
            : {}),
          concurrency: 4,
          existingBackgroundSlideIds,
          // Issue #1007 — derive a fallback background image when the
          // AI/user did not author one. Honour the deck-level
          // `auto_generate_backgrounds` toggle (defaults to ON for
          // back-compat with decks created before the toggle existed).
          deriveFallbackBackgrounds:
            deckMeta?.auto_generate_backgrounds ?? true,
          onEnqueued: (info) => {
            emit("pitch:image:queued", {
              deckId,
              slideId: info.slideId,
              slot: info.slot,
              jobId: info.jobId,
              assetId: info.assetId,
              source: requestedIds ? "slide_retry" : "bulk_button",
            });
          },
          onEnqueueError: (info) => {
            emit("pitch:image:failed", {
              deckId,
              slideId: info.slideId,
              slot: info.slot,
              error: info.error,
              source: requestedIds ? "slide_retry" : "bulk_button",
            });
          },
        });
        audit("tool", "pitch.images.bulk_enqueued", {
          deckId,
          source: requestedIds ? "slide_retry" : "bulk_button",
          enqueued: result.enqueued,
          skipped: result.skipped,
          total: result.total,
          ...(requestedIds ? { slideIds: [...requestedIds] } : {}),
        });
        res.status(200).json(result);
      } catch (err) {
        logger.error(
          `[Pitch API] generate-all failed: ${errMessage(err)}`,
        );
        sendError(
          res,
          503,
          "internal_error",
          `generate-all failed: ${errMessage(err)}`,
        );
      }
    },
  );

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
        defaultLogoPlacement: body.defaultLogoPlacement,
        showSlideNumbers: body.showSlideNumbers,
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

  // ── Sub-issue #1048 ─ Apply brand kit to a deck (re-point + clear overrides) ─
  router.post(
    "/decks/:deckId/apply-brand-kit",
    crudLimiter,
    (req, res) => {
      const Body = z.object({ brandKitId: z.string().min(1) }).strict();
      const body = parseBody(Body, res, req);
      if (!body) return;

      const deck = deps.pitchRepo.getDeck(req.params.deckId);
      if (!deck) {
        sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
        return;
      }
      const kit = deps.brandKitRepo.getById(body.brandKitId);
      if (!kit) {
        sendError(
          res,
          404,
          "not_found",
          `brand kit ${body.brandKitId} not found`,
        );
        return;
      }

      const updated = deps.pitchRepo.updateDeck(req.params.deckId, {
        brand_kit_id: body.brandKitId,
      });
      // Strip per-slide branding overrides so the new kit is the single
      // source of truth. (Slide branding is not currently persisted to DB
      // columns, so this is presently a no-op for the storage layer; the
      // contract still holds for any in-memory deck assemblies.)
      const slides = deps.pitchRepo.listSlidesForDeck(req.params.deckId);
      let slidesCleared = 0;
      for (const row of slides) {
        if (row.slide.branding) {
          const { branding: _drop, ...rest } = row.slide;
          void _drop;
          deps.pitchRepo.updateSlide(row.id, { slide: rest as Slide });
          slidesCleared += 1;
        }
      }
      audit("system", "pitch_deck_brand_kit_applied", {
        deckId: req.params.deckId,
        brandKitId: body.brandKitId,
        slidesCleared,
      });
      emit("pitch:deck:updated", {
        deckId: req.params.deckId,
        deck: updated,
      });
      res.json({ ok: true, deck: updated, slidesCleared });
    },
  );

  // ── Sub-issue #1048 ─ Extract a deck's effective brand kit into a new kit ─
  router.post(
    "/decks/:deckId/extract-brand-kit",
    crudLimiter,
    (req, res) => {
      const Body = z
        .object({ name: z.string().min(1).max(120) })
        .strict();
      const body = parseBody(Body, res, req);
      if (!body) return;

      const deck = deps.pitchRepo.getDeck(req.params.deckId);
      if (!deck) {
        sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
        return;
      }
      const source = deps.brandKitRepo.getById(deck.brand_kit_id);
      if (!source) {
        sendError(
          res,
          404,
          "not_found",
          `brand kit ${deck.brand_kit_id} not found`,
        );
        return;
      }

      const newId = nanoid();
      try {
        const created = deps.brandKitRepo.create({
          id: newId,
          name: body.name,
          primaryColor: source.primaryColor,
          secondaryColor: source.secondaryColor,
          accentColor: source.accentColor,
          fontFamily: source.fontFamily,
          fontHeading: source.fontHeading ?? null,
          fontBody: source.fontBody ?? null,
          footerText: source.footerText ?? null,
          defaultLogoPlacement: source.defaultLogoPlacement ?? null,
          showSlideNumbers: source.showSlideNumbers ?? null,
          logoPath: source.logoPath ?? null,
          watermarkPath: source.watermarkPath ?? null,
          introTemplateId: source.introTemplateId ?? null,
          outroTemplateId: source.outroTemplateId ?? null,
        });
        audit("system", "pitch_deck_brand_kit_extracted", {
          deckId: req.params.deckId,
          newBrandKitId: created.id,
          sourceBrandKitId: source.id,
        });
        emit("pitch:brand-kit:created", { brandKitId: created.id });
        res.status(201).json({
          brandKit: { ...created, isStarter: false },
        });
      } catch (err) {
        const msg = errMessage(err);
        if (/UNIQUE constraint failed/i.test(msg)) {
          sendError(
            res,
            409,
            "conflict",
            `brand kit name "${body.name}" already exists`,
          );
          return;
        }
        sendError(res, 500, "internal_error", `extract failed: ${msg}`);
      }
    },
  );

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

  // ────────────────────────────────────────────────────────────────────
  // Public share-link admin routes (sub-issue #1000)
  //
  // Owner-side surface for issuing / listing / revoking opaque tokens.
  // The actual public read is served by `createPublicShareRouter` mounted
  // at `/p` OUTSIDE the admin auth chain. We deliberately:
  //   - Never echo the raw token in audit logs (only `hashTokenPrefix`).
  //   - Validate the deck exists before issuing, so dangling tokens to
  //     unknown decks are impossible.
  //   - Enforce `:token` looks structurally sane on revoke before
  //     touching the DB — mirrors the public router's defence-in-depth.
  // ────────────────────────────────────────────────────────────────────

  const IssueShareTokenBody = z
    .object({
      // Optional days-until-expiry (1..365). Omit / null → no expiry.
      expiresInDays: z.number().int().positive().max(365).optional(),
    })
    .strict();

  const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
  function isWellFormedToken(t: unknown): t is string {
    return (
      typeof t === "string" &&
      t.length >= 16 &&
      t.length <= 128 &&
      TOKEN_PATTERN.test(t)
    );
  }

  router.post("/decks/:deckId/share", shareLimiter, (req, res) => {
    if (!deps.shareTokenRepo) {
      sendError(res, 500, "internal_error", "share-token repository not configured");
      return;
    }
    const deck = deps.pitchRepo.getDeck(req.params.deckId);
    if (!deck) {
      sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
      return;
    }
    const body = parseBody(IssueShareTokenBody, res, req);
    if (!body) return;
    try {
      const row = deps.shareTokenRepo.issue({
        deckId: deck.id,
        expiresInDays: body.expiresInDays,
      });
      audit(
        "security",
        "pitch_share_token_issued",
        {
          deckId: deck.id,
          tokenIdHash: hashTokenPrefix(row.token),
          expiresAt: row.expires_at,
        },
      );
      // Note: we DO return the raw token here — this is the only chance the
      // owner has to copy it. The endpoint sits behind admin auth so the
      // caller is already trusted; we mark it `Cache-Control: no-store` so
      // intermediaries (and the browser) don't persist it.
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json({
        token: row.token,
        url: `/p/${row.token}`,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      });
    } catch (err) {
      logger.error(
        `[Pitch API] POST /decks/${deck.id}/share failed: ${errMessage(err)}`,
      );
      sendError(res, 500, "internal_error", "could not issue share token");
    }
  });

  router.get("/decks/:deckId/share", shareLimiter, (req, res) => {
    if (!deps.shareTokenRepo) {
      sendError(res, 500, "internal_error", "share-token repository not configured");
      return;
    }
    const deck = deps.pitchRepo.getDeck(req.params.deckId);
    if (!deck) {
      sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
      return;
    }
    const rows = deps.shareTokenRepo.list(deck.id);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      tokens: rows.map((r) => ({
        // We DO surface the raw token in this owner-only listing so the
        // dialog can render copy/revoke controls. The route is admin-auth
        // gated and `Cache-Control: no-store` so the value never persists.
        token: r.token,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        revokedAt: r.revoked_at,
      })),
    });
  });

  router.post(
    "/decks/:deckId/share/:token/revoke",
    shareLimiter,
    (req, res) => {
      if (!deps.shareTokenRepo) {
        sendError(res, 500, "internal_error", "share-token repository not configured");
        return;
      }
      const deck = deps.pitchRepo.getDeck(req.params.deckId);
      if (!deck) {
        sendError(res, 404, "not_found", `deck ${req.params.deckId} not found`);
        return;
      }
      if (!isWellFormedToken(req.params.token)) {
        sendError(res, 400, "bad_request", "malformed token");
        return;
      }
      const ok = deps.shareTokenRepo.revoke(req.params.token);
      if (!ok) {
        // Don't leak whether the token was unknown vs already-revoked —
        // both map to a benign 404 from the owner's perspective.
        sendError(res, 404, "not_found", "token not found or already revoked");
        return;
      }
      audit(
        "security",
        "pitch_share_token_revoked",
        {
          deckId: deck.id,
          tokenIdHash: hashTokenPrefix(req.params.token),
        },
      );
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true });
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
