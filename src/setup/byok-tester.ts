/**
 * BYOK key tester — performs a real "ping" call against each supported LLM
 * provider to validate that a user-supplied API key actually works.
 *
 * Issue #1118 (epic AC: "Test this key" must validate, not just format-check).
 *
 * Probes:
 *   openai    — GET https://api.openai.com/v1/models
 *   anthropic — POST https://api.anthropic.com/v1/messages (1-token Haiku call)
 *   google    — GET https://generativelanguage.googleapis.com/v1beta/models
 *   groq      — GET https://api.groq.com/openai/v1/models
 *
 * Keys are passed in-process and never logged. The API key never appears in
 * the result object, only the boolean `ok`, the latency, and a sanitized
 * `message` string for display.
 */

export type ByokProvider = "openai" | "anthropic" | "google" | "groq";

export const BYOK_PROVIDERS: ByokProvider[] = [
  "openai",
  "anthropic",
  "google",
  "groq",
];

export interface ByokTestResult {
  provider: ByokProvider;
  ok: boolean;
  latencyMs: number;
  status: number | null;
  message: string;
}

export interface ByokTesterOptions {
  /** Inject `fetch` for tests. */
  fetchImpl?: typeof fetch;
  /** Inject `now()` for deterministic latency in tests. */
  now?: () => number;
}

export class ByokTester {
  private fetchImpl: typeof fetch;
  private now: () => number;

  constructor(options: ByokTesterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  async test(provider: ByokProvider, apiKey: string): Promise<ByokTestResult> {
    if (!BYOK_PROVIDERS.includes(provider)) {
      return {
        provider,
        ok: false,
        latencyMs: 0,
        status: null,
        message: `Unknown provider: ${provider}`,
      };
    }
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      return {
        provider,
        ok: false,
        latencyMs: 0,
        status: null,
        message: "Missing API key",
      };
    }
    const trimmed = apiKey.trim();
    const start = this.now();
    try {
      const { status, ok, message } = await this.probe(provider, trimmed);
      return {
        provider,
        ok,
        status,
        latencyMs: this.now() - start,
        message,
      };
    } catch (err) {
      return {
        provider,
        ok: false,
        status: null,
        latencyMs: this.now() - start,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async probe(
    provider: ByokProvider,
    apiKey: string,
  ): Promise<{ status: number; ok: boolean; message: string }> {
    switch (provider) {
      case "openai": {
        const res = await this.fetchImpl("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        return { status: res.status, ok: res.ok, message: humanize(res) };
      }
      case "anthropic": {
        const res = await this.fetchImpl(
          "https://api.anthropic.com/v1/messages",
          {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "claude-3-haiku-20240307",
              max_tokens: 1,
              messages: [{ role: "user", content: "ping" }],
            }),
          },
        );
        return { status: res.status, ok: res.ok, message: humanize(res) };
      }
      case "google": {
        const res = await this.fetchImpl(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        );
        return { status: res.status, ok: res.ok, message: humanize(res) };
      }
      case "groq": {
        const res = await this.fetchImpl(
          "https://api.groq.com/openai/v1/models",
          { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        return { status: res.status, ok: res.ok, message: humanize(res) };
      }
    }
  }
}

function humanize(res: Response): string {
  if (res.ok) return `OK (${res.status})`;
  if (res.status === 401 || res.status === 403)
    return "Invalid or unauthorized API key";
  if (res.status === 429) return "Rate-limited — key works but quota exceeded";
  return `Provider returned ${res.status} ${res.statusText}`;
}
