/**
 * Shared URL validation utilities for SSRF protection.
 *
 * Issue #467: Prevents server-side request forgery by blocking requests
 * to private/internal networks, cloud metadata endpoints, and non-HTTP protocols.
 */

/**
 * Validate that a webhook/outbound URL is safe to fetch.
 * Blocks private/internal IPs, metadata endpoints, and non-HTTP protocols.
 */
export function isAllowedWebhookUrl(urlString: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return false;
  // Block 0.0.0.0
  if (hostname === "0.0.0.0") return false;
  // Block AWS/GCP/Azure metadata endpoints
  if (hostname === "169.254.169.254" || hostname === "metadata.google.internal") return false;
  // Block link-local
  if (hostname.startsWith("169.254.")) return false;
  // Block private IPv4 ranges
  if (hostname.startsWith("10.")) return false;
  if (hostname.startsWith("192.168.")) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
  // Block IPv6 link-local
  if (hostname.startsWith("[fe80:") || hostname.startsWith("[fc") || hostname.startsWith("[fd"))
    return false;

  return true;
}
