const RAW_API_BASE = process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "";
const AUTH_TOKEN = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";

// Guard: if API_BASE origin differs from the browser origin (different
// host OR port, e.g. Cloudflare tunnel, or dev server on a non-default port),
// ignore it and use relative paths so Next.js rewrites proxy the request.
function resolveApiBase(): string {
  if (!RAW_API_BASE) return "";
  if (typeof window === "undefined") return RAW_API_BASE;
  try {
    const base = new URL(RAW_API_BASE);
    if (base.origin !== window.location.origin) {
      return "";
    }
  } catch {
    /* malformed URL, use as-is */
  }
  return RAW_API_BASE;
}

const API_BASE = resolveApiBase();

export const buildUrl = (path: string): string => {
  if (!API_BASE) {
    return path;
  }
  return `${API_BASE}${path}`;
};

/**
 * Build a URL for media elements (<img>, <video>, <audio>) that cannot
 * send Authorization headers. Appends the auth token as a query parameter
 * so Express's extractToken() fallback can authenticate the request.
 */
export const buildMediaUrl = (path: string): string => {
  const base = buildUrl(path);
  if (!AUTH_TOKEN) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}token=${encodeURIComponent(AUTH_TOKEN)}`;
};

const PITCH_ASSET_URL_RE =
  /^\/api\/admin\/pitch\/decks\/[A-Za-z0-9_-]+\/assets\/[A-Za-z0-9_-]+(?:[?#][^"'\s<>]*)?$/;

export const authorizeRenderedMedia = (html: string): string => {
  if (!AUTH_TOKEN) return html;
  return html.replace(
    /(\s(?:src|href|data-background-image)=["'])(\/api\/admin\/pitch\/decks\/[A-Za-z0-9_-]+\/assets\/[A-Za-z0-9_-]+(?:[?#][^"'\s<>]*)?)(["'])/g,
    (match, prefix: string, rawUrl: string, suffix: string) => {
      if (!PITCH_ASSET_URL_RE.test(rawUrl)) return match;
      if (/[?&]token=/.test(rawUrl)) return match;
      const separator = rawUrl.includes("?") ? "&" : "?";
      return `${prefix}${rawUrl}${separator}token=${encodeURIComponent(AUTH_TOKEN)}${suffix}`;
    },
  );
};

export const fetchJson = async <T>(
  path: string,
  options?: RequestInit,
): Promise<T> => {
  const headers = new Headers(options?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (AUTH_TOKEN) {
    headers.set("Authorization", `Bearer ${AUTH_TOKEN}`);
  }

  const url = buildUrl(path);
  let response: Response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Network request failed for ${url}: ${message}`);
  }

  if (!response.ok) {
    const text = await response.text();
    let detail = text || response.statusText || `HTTP ${response.status}`;
    let parsedBody: unknown = undefined;
    try {
      parsedBody = JSON.parse(text);
      const parsed = parsedBody as {
        error?: { message?: string; code?: string; details?: unknown };
      };
      if (parsed?.error?.message) {
        detail = parsed.error.code
          ? `${parsed.error.message} (${parsed.error.code})`
          : parsed.error.message;
      }
    } catch {
      // non-JSON error body; keep the raw text/status
    }
    const err = new Error(
      `${url} failed with ${response.status}: ${detail}`,
    ) as Error & {
      status?: number;
      errorBody?: unknown;
    };
    err.status = response.status;
    err.errorBody = parsedBody;
    throw err;
  }
  return response.json() as Promise<T>;
};

/**
 * Fetch a binary response (audio, images, etc.) with auth headers.
 * Returns the raw Response so callers can read .blob(), .arrayBuffer(), etc.
 */
export const fetchWithAuth = async (
  path: string,
  options?: RequestInit,
): Promise<Response> => {
  const headers = new Headers(options?.headers);
  if (AUTH_TOKEN) {
    headers.set("Authorization", `Bearer ${AUTH_TOKEN}`);
  }

  const url = buildUrl(path);
  const response = await fetch(url, { ...options, headers });
  return response;
};
