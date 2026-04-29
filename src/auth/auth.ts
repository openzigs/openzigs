import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { AuthConfig } from "../config/index.js";

export type Role = "viewer" | "operator" | "admin";

type RateLimitState = {
  count: number;
  resetAt: number;
};

const roleRank: Record<Role, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
};

const hasPermission = (role: Role, required: Role) => {
  return roleRank[role] >= roleRank[required];
};

class FailedAuthLimiter {
  private state = new Map<string, RateLimitState>();
  private windowMs: number;
  private max: number;

  constructor(windowMs: number, max: number) {
    this.windowMs = windowMs;
    this.max = max;
  }

  isBlocked(key: string, now: number) {
    const current = this.state.get(key);
    if (!current) {
      return false;
    }
    if (now >= current.resetAt) {
      this.state.delete(key);
      return false;
    }
    return current.count >= this.max;
  }

  registerFailure(key: string, now: number) {
    const current = this.state.get(key);
    if (!current || now >= current.resetAt) {
      this.state.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    current.count += 1;
  }

  reset(key: string) {
    this.state.delete(key);
  }
}

/**
 * Paths served as raw media files (used in <img>/<video>/<audio> src attributes).
 * Browsers cannot send Authorization headers for these elements, so the auth
 * token must be accepted via the ?token= query param on these specific routes.
 * The scope is deliberately narrow: only asset-file-serve endpoints, not the
 * entire API surface (sub-issue #908 trade-off).
 */
const ASSET_FILE_PATH_RE = /^\/assets\/(?:[^/]+\/file|file\/.+)$/;

/**
 * Pitch deck render route — same OWASP token-in-URL trade-off as
 * `ASSET_FILE_PATH_RE` (sub-issue #908). The Present button (see
 * `ui/app/pitch/[deckId]/page.tsx` `PresentButton`) opens the rendered
 * HTML in a new tab via `<a href>` navigation, which cannot carry an
 * Authorization header. Without this allowlist entry the request falls
 * through to bearer-only auth and 401s (Bug #3 / issue #1011).
 *
 * Trade-off (accepted): the token will appear in browser history, the
 * tab's `Referer` header for any outbound asset requests embedded in the
 * rendered HTML, and any reverse-proxy access logs in front of the API.
 * The scope is intentionally narrow (this single route family) and the
 * existing `?token=` precedent is set by PR #1003. A cleaner long-term
 * fix would be a Next.js page that mounts the deck in an authenticated
 * iframe with the token sent via header — left as future work.
 */
const PITCH_RENDER_PATH_RE =
  /^\/api\/admin\/pitch\/decks\/[a-zA-Z0-9_-]+\/render(?:\/[^?]*)?$/;

const extractToken = (req: Request) => {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  // Accept ?token= for known media-serving endpoints or when the global opt-in
  // is set. Media file paths (/assets/:id/file, /assets/file/:filename) use
  // this because <img>/<video>/<audio> elements cannot send Authorization
  // headers. The pitch render route is allowed for the same reason — the
  // Present button opens the deck in a new tab via <a href> (issue #1011).
  // For all other paths this remains disabled to avoid token leakage via
  // proxy logs, browser history, and Referer headers (sub-issue #908).
  const allowQueryToken =
    ASSET_FILE_PATH_RE.test(req.path) ||
    PITCH_RENDER_PATH_RE.test(req.path) ||
    process.env.OPENZIGS_ALLOW_QUERY_TOKEN === "1";
  if (allowQueryToken) {
    const qToken = req.query?.token;
    if (typeof qToken === "string" && qToken) {
      return qToken;
    }
  }
  return "";
};

const resolveRole = (config: AuthConfig): Role => {
  return config.role ?? "admin";
};

export const createAuthMiddleware = (config: AuthConfig) => {
  const limiter = new FailedAuthLimiter(
    config.rateLimit.windowMs,
    config.rateLimit.max,
  );

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? req.socket.remoteAddress;
    if (!key) {
      return res.status(400).json({ error: "Could not determine client IP" });
    }

    if (limiter.isBlocked(key, now)) {
      return res.status(429).json({ error: "Too Many Requests" });
    }

    if (config.mode !== "local") {
      return res.status(501).json({ error: "Auth mode not implemented" });
    }

    const token = extractToken(req);
    const expectedToken = config.token ?? "";
    if (!token || !expectedToken) {
      limiter.registerFailure(key, now);
      return res.status(401).json({ error: "Unauthorized" });
    }

    const tokenBuffer = Buffer.from(token);
    const expectedBuffer = Buffer.from(expectedToken);
    const isMatch =
      tokenBuffer.length === expectedBuffer.length &&
      timingSafeEqual(tokenBuffer, expectedBuffer);
    if (!isMatch) {
      limiter.registerFailure(key, now);
      return res.status(401).json({ error: "Unauthorized" });
    }

    limiter.reset(key);
    (req as unknown as Record<string, unknown>).userRole = resolveRole(config);
    return next();
  };
};

export const checkRole = (requiredRole: Role) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const role =
      ((req as unknown as Record<string, unknown>).userRole as
        | Role
        | undefined) ?? "viewer";
    if (!hasPermission(role, requiredRole)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return next();
  };
};
