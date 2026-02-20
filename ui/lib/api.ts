const RAW_API_BASE = process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "";
const AUTH_TOKEN = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";

// Guard: if API_BASE points at localhost but the browser is on a different
// origin (e.g. Cloudflare tunnel), ignore it and use relative paths so
// Next.js rewrites proxy the request server-side.
function resolveApiBase(): string {
  if (!RAW_API_BASE) return "";
  if (typeof window === "undefined") return RAW_API_BASE;
  try {
    const baseHost = new URL(RAW_API_BASE).hostname;
    if (
      (baseHost === "localhost" || baseHost === "127.0.0.1") &&
      window.location.hostname !== "localhost" &&
      window.location.hostname !== "127.0.0.1"
    ) {
      return "";
    }
  } catch { /* malformed URL, use as-is */ }
  return RAW_API_BASE;
}

const API_BASE = resolveApiBase();

export const buildUrl = (path: string): string => {
  if (!API_BASE) {
    return path;
  }
  return `${API_BASE}${path}`;
};

export const fetchJson = async <T>(path: string, options?: RequestInit): Promise<T> => {
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
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<T>;
};
