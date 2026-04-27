/**
 * Public share-link router (Epic #990 / sub-issue #1000).
 *
 * Mounted at `/p` OUTSIDE the admin auth middleware. Exposes exactly
 * one route — `GET /p/:token` — which serves the deck via the existing
 * Reveal.js renderer in standalone (presenter) mode after looking the
 * token up in `pitch_share_tokens`.
 *
 * Hardening:
 *  - Per-IP rate limit (30 req/min) prevents token brute-forcing.
 *  - Generic `404` for every failure mode (unknown / revoked / expired /
 *    repo missing) so callers can't enumerate which condition failed.
 *  - Tokens are never reflected in error pages or audit logs — only
 *    `hashTokenPrefix` (first 8 hex chars of SHA-256) is logged.
 *  - The renderer already runs slide content through `sanitizeRichText` /
 *    `escapeHtml`. We do NOT bypass that path: we hit the same
 *    `renderDeckToHtml` the admin route uses.
 *  - CSP mirrors the admin `/render` route.
 */
import { Router, type Request, type Response } from "express";
import rateLimit, {
  type RateLimitRequestHandler,
} from "express-rate-limit";
import type { BrandKitRepository } from "../video/brand-kit.js";
import { logger } from "../logging/logger.js";
import type { AuditLogger } from "../logging/audit-logger.js";
import type { PitchRepository } from "../pitch/pitch-repository.js";
import { renderDeckToHtml } from "../pitch/pitch-renderer.js";
import {
  ShareTokenRepository,
  hashTokenPrefix,
} from "../pitch/share-token-repository.js";
import {
  buildBackgroundImageUrlMap,
  repoToPitchBrandKit,
} from "./pitch.js";

export interface PublicShareDeps {
  pitchRepo: PitchRepository;
  brandKitRepo: BrandKitRepository;
  shareTokenRepo: ShareTokenRepository;
  auditLogger?: AuditLogger;
  /** Override rate limit for tests (default: 30/min). */
  rateLimit?: { windowMs?: number; max?: number };
}

const PRESENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "img-src 'self' data: https:",
  "font-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

const NOT_FOUND_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Deck not found</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0b0d12;color:#e5e7eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  main{text-align:center;max-width:24rem;padding:2rem}
  h1{font-size:1.5rem;font-weight:600;margin:0 0 .5rem}
  p{color:#9ca3af;margin:0}
</style>
</head><body><main>
<h1>Deck not found</h1>
<p>This share link is invalid, has been revoked, or has expired.</p>
</main></body></html>`;

export function createPublicShareRouter(
  deps: PublicShareDeps,
): Router {
  const router = Router();

  const limiter: RateLimitRequestHandler = rateLimit({
    windowMs: deps.rateLimit?.windowMs ?? 60 * 1000,
    max: deps.rateLimit?.max ?? 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).type("text/html").send(NOT_FOUND_HTML);
    },
  });

  const audit = (
    event: string,
    details: Record<string, unknown>,
  ): void => {
    if (!deps.auditLogger) return;
    void deps.auditLogger
      .log({
        level: "info",
        category: "security",
        event,
        details,
      })
      .catch((err) => {
        logger.warn(
          `[PublicShare] audit log failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  };

  function notFound(res: Response): void {
    res.status(404).type("text/html").send(NOT_FOUND_HTML);
  }

  router.get(
    "/:token",
    limiter,
    (req: Request, res: Response) => {
      const { token } = req.params;
      // Cheap structural sanity check — the real security gate is the
      // primary-key lookup. Rejecting obviously malformed tokens early
      // avoids needless DB hits and keeps the audit log clean.
      if (
        typeof token !== "string" ||
        token.length < 16 ||
        token.length > 128 ||
        !/^[A-Za-z0-9_-]+$/.test(token)
      ) {
        notFound(res);
        return;
      }

      const row = deps.shareTokenRepo.lookupActive(token);
      if (!row) {
        audit("pitch_share_lookup_miss", {
          tokenIdHash: hashTokenPrefix(token),
        });
        notFound(res);
        return;
      }

      const deck = deps.pitchRepo.getDeck(row.deck_id);
      if (!deck) {
        // Deck deleted out from under the token (FK is CASCADE so this
        // shouldn't normally happen, but stay defensive).
        notFound(res);
        return;
      }
      const repoKit = deps.brandKitRepo.getById(deck.brand_kit_id);
      if (!repoKit) {
        notFound(res);
        return;
      }

      try {
        const brandKit = repoToPitchBrandKit(repoKit);
        const backgroundImageUrlBySlideIndex = buildBackgroundImageUrlMap(
          deck.id,
          deps.pitchRepo.listSlidesForDeck(deck.id),
          deps.pitchRepo.listAssetsForDeck(deck.id),
        );
        const { html } = renderDeckToHtml(
          deck,
          brandKit,
          "standalone",
          { backgroundImageUrlBySlideIndex },
        );
        audit("pitch_share_lookup_hit", {
          deckId: deck.id,
          tokenIdHash: hashTokenPrefix(token),
        });
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Security-Policy", PRESENT_CSP);
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
        res.send(html);
      } catch (err) {
        logger.error(
          `[PublicShare] render failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Still return the generic 404 — never leak internals to a
        // public visitor.
        notFound(res);
      }
    },
  );

  return router;
}
