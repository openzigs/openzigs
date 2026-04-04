/**
 * Cloudflare Access JWT validation middleware.
 *
 * When a request arrives with the `CF-Access-JWT-Assertion` header, this
 * middleware validates the JWT against the Cloudflare Access JWKS endpoint.
 * Direct/localhost requests (no CF headers) pass through untouched.
 *
 * Config fields (optional — existing installs won't have them):
 *   tunnel.cfAccessTeamDomain  — e.g. "openzigs" → openzigs.cloudflareaccess.com
 *   tunnel.cfAccessAudience    — Application Audience Tag (string or string[])
 */

import type { Request, Response, NextFunction } from "express";
import type { webcrypto } from "node:crypto";
import { logger } from "../logging/logger.js";

// ── Types ───────────────────────────────────────────────────

interface JwksKey {
  kty: string;
  kid: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

interface JwksResponse {
  keys: JwksKey[];
}

interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  email?: string;
  [key: string]: unknown;
}

// ── JWKS Cache ──────────────────────────────────────────────

interface CachedJwks {
  keys: JwksKey[];
  fetchedAt: number;
}

const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour
let jwksCache: CachedJwks | null = null;
let teamDomainWarned = false;

// Exposed for testing
export const _resetCache = () => {
  jwksCache = null;
  teamDomainWarned = false;
};

// Allow injecting a custom fetch for testing
export let _fetchFn: typeof globalThis.fetch = globalThis.fetch;
export const _setFetchFn = (fn: typeof globalThis.fetch) => {
  _fetchFn = fn;
};

// ── Base64url helpers ───────────────────────────────────────

const base64urlDecode = (input: string): Uint8Array => {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
};

const base64urlToJson = <T>(input: string): T => {
  const bytes = base64urlDecode(input);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
};

// ── JWKS Fetch ──────────────────────────────────────────────

const fetchJwks = async (teamDomain: string): Promise<JwksKey[]> => {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }

  const url = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const response = await _fetchFn(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch JWKS from ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as JwksResponse;
  jwksCache = { keys: data.keys, fetchedAt: now };
  return data.keys;
};

// ── RSA Signature Verification (Web Crypto) ─────────────────

const importRsaKey = async (jwk: JwksKey): Promise<webcrypto.CryptoKey> => {
  return globalThis.crypto.subtle.importKey(
    "jwk",
    {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
      alg: "RS256",
      ext: true,
    },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
};

const verifyJwt = async (
  token: string,
  keys: JwksKey[],
  audience?: string | string[],
): Promise<JwtPayload> => {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }

  const header = base64urlToJson<JwtHeader>(parts[0]);
  if (header.alg !== "RS256") {
    throw new Error(`Unsupported JWT algorithm: ${header.alg}`);
  }

  // Find matching key
  const key = header.kid ? keys.find((k) => k.kid === header.kid) : keys[0];
  if (!key) {
    throw new Error(`No matching JWKS key found for kid: ${header.kid}`);
  }

  // Verify signature
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64urlDecode(parts[2]);
  const cryptoKey = await importRsaKey(key);

  const valid = await globalThis.crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    signature,
    signingInput,
  );
  if (!valid) {
    throw new Error("Invalid JWT signature");
  }

  // Decode and validate payload
  const payload = base64urlToJson<JwtPayload>(parts[1]);

  // Check expiry
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("JWT has expired");
  }

  // Check audience if configured
  if (audience) {
    const allowedAuds = Array.isArray(audience) ? audience : [audience];
    const tokenAuds = Array.isArray(payload.aud)
      ? payload.aud
      : payload.aud
        ? [payload.aud]
        : [];
    const hasMatch = tokenAuds.some((a) => allowedAuds.includes(a));
    if (!hasMatch) {
      throw new Error("JWT audience mismatch");
    }
  }

  return payload;
};

// ── Middleware ───────────────────────────────────────────────

export interface CfAccessConfig {
  cfAccessTeamDomain?: string;
  cfAccessAudience?: string | string[];
}

export const cfAccessGuard = (config: CfAccessConfig) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const jwtToken = req.headers["cf-access-jwt-assertion"] as
      | string
      | undefined;
    const cfEmail = req.headers["cf-access-authenticated-user-email"] as
      | string
      | undefined;

    // No CF headers — direct/localhost request, skip validation
    if (!jwtToken && !cfEmail) {
      return next();
    }

    // CF headers present but no JWT to validate — allow through
    // (email-only header means Access proxy stripped the JWT, which is unusual)
    if (!jwtToken) {
      return next();
    }

    const teamDomain = config.cfAccessTeamDomain;
    if (!teamDomain) {
      if (!teamDomainWarned) {
        logger.warn(
          "[CfAccess] CF-Access-JWT-Assertion header present but tunnel.cfAccessTeamDomain is not configured — skipping JWT validation",
        );
        teamDomainWarned = true;
      }
      return next();
    }

    try {
      const keys = await fetchJwks(teamDomain);
      const payload = await verifyJwt(
        jwtToken,
        keys,
        config.cfAccessAudience || undefined,
      );
      (req as unknown as Record<string, unknown>).cfAccessEmail =
        payload.email ?? cfEmail ?? "";
      return next();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[CfAccess] JWT validation failed: ${message}`);
      return res
        .status(403)
        .json({ error: "Cloudflare Access validation failed" });
    }
  };
};
