import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "../../logging/logger.js";
import type { SocialPlatform } from "./types.js";

export interface WebhookSecretConfig {
  /** TWITTER_API_SECRET — used for X-Twitter-Webhooks-Signature (HMAC-SHA256, base64) */
  twitter?: string;
  /** FACEBOOK_APP_SECRET — used for X-Hub-Signature-256 (HMAC-SHA256, hex) on Instagram & Facebook */
  meta?: string;
}

/**
 * Verify a webhook payload signature for the given platform.
 *
 * @returns `true`  — signature valid
 * @returns `false` — signature missing or invalid (reject the request)
 * @returns `null`  — no secret configured for this platform (caller decides policy)
 */
export function verifyWebhookSignature(
  platform: SocialPlatform,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secrets: WebhookSecretConfig,
): boolean | null {
  switch (platform) {
    case "twitter":
      return verifyTwitterSignature(rawBody, headers, secrets.twitter);
    case "instagram":
    case "facebook":
      return verifyMetaSignature(rawBody, headers, secrets.meta);
    // Platforms that use polling, not inbound webhooks — no signature scheme.
    case "reddit":
    case "youtube":
    case "tiktok":
    case "linkedin":
      return null;
    default:
      logger.warn(`[WebhookSignature] Unknown platform: ${platform as string}`);
      return null;
  }
}

/**
 * Twitter webhook: `X-Twitter-Webhooks-Signature` = `sha256=<base64 HMAC-SHA256>`.
 * @see https://developer.x.com/en/docs/twitter-api/enterprise/account-activity-api/guides/securing-webhooks
 */
function verifyTwitterSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret?: string,
): boolean | null {
  if (!secret) return null;

  const signature = headers["x-twitter-webhooks-signature"];
  if (typeof signature !== "string") {
    logger.warn("[WebhookSignature] Twitter webhook missing X-Twitter-Webhooks-Signature header");
    return false;
  }

  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("base64");
  return safeCompare(expected, signature);
}

/**
 * Meta (Instagram / Facebook): `X-Hub-Signature-256` = `sha256=<hex HMAC-SHA256>`.
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
 */
function verifyMetaSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret?: string,
): boolean | null {
  if (!secret) return null;

  const signature = headers["x-hub-signature-256"];
  if (typeof signature !== "string") {
    logger.warn("[WebhookSignature] Meta webhook missing X-Hub-Signature-256 header");
    return false;
  }

  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeCompare(expected, signature);
}

/** Timing-safe string comparison to prevent timing attacks on signature matching. */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
