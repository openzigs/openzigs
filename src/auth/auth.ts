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
  admin: 2
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

const extractToken = (req: Request) => {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  // Fallback: accept token as query param for media elements (img/video/audio)
  // that cannot send Authorization headers.
  const qToken = req.query?.token;
  if (typeof qToken === "string" && qToken) {
    return qToken;
  }
  return "";
};

const resolveRole = (config: AuthConfig): Role => {
  return config.role ?? "admin";
};

export const createAuthMiddleware = (config: AuthConfig) => {
  const limiter = new FailedAuthLimiter(config.rateLimit.windowMs, config.rateLimit.max);

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
    const isMatch = tokenBuffer.length === expectedBuffer.length
      && timingSafeEqual(tokenBuffer, expectedBuffer);
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
    const role = ((req as unknown as Record<string, unknown>).userRole as Role | undefined) ?? "viewer";
    if (!hasPermission(role, requiredRole)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return next();
  };
};
