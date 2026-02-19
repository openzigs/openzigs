const API_BASE = process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "";
const AUTH_TOKEN = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";

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
