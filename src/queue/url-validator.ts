/**
 * Issue #1090 — SSRF protection for user-supplied node URLs.
 *
 * Validates `networkNodeUrl` values before OpenZigs makes outbound requests
 * to them. Blocks loopback, link-local, cloud-metadata, and (by default)
 * RFC1918 ranges. Users opt back in to RFC1918 per-node via `allowLan: true`.
 *
 * The validator resolves hostnames via DNS and checks every IP returned by
 * that resolution. This blocks split-horizon answers in the validation step;
 * call sites still need outbound-request hardening such as redirect bounds
 * because the later fetch performs its own DNS resolution.
 */

import dns from "node:dns/promises";
import net from "node:net";

export interface ValidateOptions {
  /** When true, RFC1918 / private ranges are permitted. Loopback + link-local remain blocked. */
  allowLan?: boolean;
  /**
   * Override DNS resolution. Used by tests to avoid real network calls.
   * Should mirror the shape of `dns.promises.lookup(host, { all: true })`.
   */
  resolver?: (
    host: string,
  ) => Promise<Array<{ address: string; family: number }>>;
}

export class SsrfBlockedError extends Error {
  readonly code = "SSRF_BLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

export class LanNotAllowedError extends Error {
  readonly code = "LAN_NOT_ALLOWED";
  constructor(message: string) {
    super(message);
    this.name = "LanNotAllowedError";
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
]);

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Test whether a textual IPv4 / IPv6 address is in the loopback range.
 *  - IPv4: `127.0.0.0/8` and `0.0.0.0/8`
 *  - IPv6: `::1`
 */
export function isLoopback(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const first = parseInt(ip.split(".")[0] ?? "", 10);
    return first === 127 || first === 0;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
    // IPv4-mapped IPv6 e.g. ::ffff:127.0.0.1
    const v4MappedMatch = normalized.match(/^::ffff:([0-9.]+)$/);
    if (v4MappedMatch) {
      return isLoopback(v4MappedMatch[1]);
    }
  }
  return false;
}

/** AWS / GCP / Azure cloud metadata + IPv6 link-local. */
export function isLinkLocal(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((p) => parseInt(p, 10));
    return parts[0] === 169 && parts[1] === 254;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    // fe80::/10
    return /^fe[89ab][0-9a-f]?:/i.test(normalized);
  }
  return false;
}

/**
 * RFC1918 (`10/8`, `172.16/12`, `192.168/16`) plus the IPv6 unique-local
 * `fc00::/7` range.
 */
export function isPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((p) => parseInt(p, 10));
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    // fc00::/7 — first byte 0xfc or 0xfd
    return /^f[cd][0-9a-f]{2}:/i.test(normalized);
  }
  return false;
}

function classifyAddress(
  ip: string,
): "loopback" | "link-local" | "private" | "public" {
  if (isLoopback(ip)) return "loopback";
  if (isLinkLocal(ip)) return "link-local";
  if (isPrivate(ip)) return "private";
  return "public";
}

async function defaultResolver(
  host: string,
): Promise<Array<{ address: string; family: number }>> {
  return dns.lookup(host, { all: true });
}

export interface ValidatedUrl {
  url: URL;
  /** Resolved IPs and their classification (for telemetry / debug). */
  resolved: Array<{ address: string; classification: string }>;
}

/**
 * Validate a URL before OpenZigs makes outbound requests to it.
 *
 * @throws {SsrfBlockedError} loopback, link-local, cloud-metadata, blocked hostname
 * @throws {LanNotAllowedError} RFC1918 / private without `allowLan: true`
 */
export async function validateNodeUrl(
  rawUrl: string,
  options: ValidateOptions = {},
): Promise<ValidatedUrl> {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new SsrfBlockedError("URL is empty or not a string");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`Malformed URL: ${rawUrl}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new SsrfBlockedError(
      `Protocol not allowed: ${url.protocol} (only http: and https: are permitted)`,
    );
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname) {
    throw new SsrfBlockedError("URL has no hostname");
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new SsrfBlockedError(
      `Hostname is blocked (cloud metadata or loopback alias): ${hostname}`,
    );
  }

  // Resolve hostname (or wrap a literal IP in the same shape).
  let resolved: Array<{ address: string; family: number }>;
  if (net.isIP(hostname)) {
    resolved = [{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }];
  } else {
    const resolver = options.resolver ?? defaultResolver;
    try {
      resolved = await resolver(hostname);
    } catch (err) {
      throw new SsrfBlockedError(
        `DNS resolution failed for ${hostname}: ${(err as Error).message}`,
      );
    }
    if (resolved.length === 0) {
      throw new SsrfBlockedError(`No DNS records for ${hostname}`);
    }
  }

  const classifications = resolved.map((r) => ({
    address: r.address,
    classification: classifyAddress(r.address),
  }));

  // Check every IP from this DNS answer so mixed public/private responses
  // cannot slip through validation.
  for (const r of classifications) {
    if (r.classification === "loopback" || r.classification === "link-local") {
      throw new SsrfBlockedError(
        `Address ${r.address} (${r.classification}) is always blocked — ${hostname}`,
      );
    }
    if (r.classification === "private" && !options.allowLan) {
      throw new LanNotAllowedError(
        `Address ${r.address} is on a private LAN range — set allowLan: true on this node to permit it (${hostname})`,
      );
    }
  }

  return { url, resolved: classifications };
}

/**
 * Synchronous predicate used by config-load migration to decide whether an
 * existing URL would currently fail SSRF guarding because it points to a
 * private LAN host. We auto-set `allowLan: true` for those so existing setups
 * keep working after upgrade.
 */
export function isLikelyLanUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    if (!hostname) return false;
    if (hostname === "localhost") return true;
    if (!net.isIP(hostname)) return false;
    return isPrivate(hostname) || isLoopback(hostname);
  } catch {
    return false;
  }
}
