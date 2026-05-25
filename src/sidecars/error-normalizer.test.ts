import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SidecarProxyError,
  normalizeSidecarError,
  sidecarFetch,
} from "./error-normalizer.js";
import { errorFixtures } from "./__fixtures__/error-fixtures.js";

describe("normalizeSidecarError — fixture table", () => {
  for (const fx of errorFixtures) {
    it(`normalizes fixture: ${fx.name}`, () => {
      const result = normalizeSidecarError(fx.input, fx.status);
      expect(result.userMessage).toBe(fx.expectedUserMessage);
      expect(result.raw).toBe(fx.input);
      if (fx.expectedCode !== undefined) {
        expect(result.code).toBe(fx.expectedCode);
      }
      // userMessage must never contain raw Traceback noise.
      expect(result.userMessage).not.toMatch(
        /Traceback \(most recent call last\)/,
      );
      // userMessage must never expose Python file paths from the trace lines.
      expect(result.userMessage).not.toMatch(/^\s*File "/);
      expect(result.userMessage.length).toBeGreaterThan(0);
      expect(result.userMessage.length).toBeLessThanOrEqual(500);
    });
  }
});

describe("normalizeSidecarError — defensive edge cases", () => {
  it("handles non-string body via String() coercion", () => {
    const result = normalizeSidecarError(undefined as unknown as string, 500);
    expect(result.userMessage).toBe("Sidecar returned HTTP 500 with no body.");
  });

  it("returns a non-empty message even when JSON has no recognizable keys", () => {
    const result = normalizeSidecarError('{"foo":"bar"}', 500);
    expect(result.userMessage.length).toBeGreaterThan(0);
  });

  it("truncates excessively long messages", () => {
    const long = "x".repeat(2000);
    const result = normalizeSidecarError(long, 500);
    expect(result.userMessage.length).toBe(500);
    expect(result.userMessage.endsWith("…")).toBe(true);
  });

  it("does not infinite-loop on circular-ish double-escaped JSON", () => {
    // Pathological deeply-nested escaped strings — depth cap saves us.
    let nested = '"deepest"';
    for (let i = 0; i < 20; i++) {
      nested = JSON.stringify(nested);
    }
    const wrapped = `{"error":${nested}}`;
    const result = normalizeSidecarError(wrapped, 500);
    expect(result.userMessage.length).toBeGreaterThan(0);
  });

  it("preserves bare exception class names as the message", () => {
    const result = normalizeSidecarError(
      'Traceback (most recent call last):\n  File "x.py", line 1\nValueError',
      500,
    );
    expect(result.userMessage).toBe("ValueError");
  });

  it("captures status when provided", () => {
    expect(normalizeSidecarError("{}", 502).status).toBe(502);
  });

  it("treats whitespace-only body as empty", () => {
    expect(normalizeSidecarError("   \n  ", 500).userMessage).toBe(
      "Sidecar returned HTTP 500 with no body.",
    );
  });

  it("handles array root with non-validation shape", () => {
    const result = normalizeSidecarError('["just","strings"]', 500);
    expect(result.userMessage).toBe("just");
  });

  it("extracts hint and code from the standardized envelope", () => {
    const result = normalizeSidecarError(
      '{"error":{"code":"oom","message":"Need 24GB","hint":"Use remote node"}}',
    );
    expect(result.code).toBe("oom");
    expect(result.hint).toBe("Use remote node");
    expect(result.userMessage).toBe("Need 24GB");
  });

  it("returns generic message when JSON has no recognized error key", () => {
    const result = normalizeSidecarError('{"foo":{"bar":{"baz":"qux"}}}', 500);
    expect(result.userMessage).toContain("HTTP 500");
    expect(result.userMessage).not.toContain("baz");
  });

  it("returns generic message when JSON has no recognized error key and no status", () => {
    const result = normalizeSidecarError('{"foo":"bar"}');
    expect(result.userMessage).toBe(
      "Sidecar returned an error response with no message.",
    );
  });
});

describe("SidecarProxyError", () => {
  it("serializes with code + hint when present", () => {
    const err = new SidecarProxyError({
      userMessage: "boom",
      code: "oom",
      hint: "try remote",
      raw: "{}",
      status: 507,
    });
    expect(err.status).toBe(507);
    expect(err.toJSON()).toEqual({
      error: "boom",
      code: "oom",
      hint: "try remote",
    });
  });

  it("uses default status when envelope has none", () => {
    const err = new SidecarProxyError({
      userMessage: "x",
      raw: "",
    });
    expect(err.status).toBe(502);
  });

  it("omits code and hint when absent", () => {
    const err = new SidecarProxyError({
      userMessage: "x",
      raw: "",
      status: 500,
    });
    expect(err.toJSON()).toEqual({ error: "x" });
  });
});

describe("sidecarFetch", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns the response on 2xx", async () => {
    const fakeResponse = { ok: true, status: 200 } as unknown as Response;
    globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse);
    const result = await sidecarFetch("http://x/y");
    expect(result).toBe(fakeResponse);
  });

  it("throws SidecarProxyError on non-2xx with normalized message", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve('{"error":"out of memory"}'),
    } as unknown as Response);
    await expect(sidecarFetch("http://x/y")).rejects.toMatchObject({
      name: "SidecarProxyError",
      status: 503,
      message: "out of memory",
    });
  });

  it("handles response.text() rejecting", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 504,
      text: () => Promise.reject(new Error("read failed")),
    } as unknown as Response);
    await expect(sidecarFetch("http://x/y")).rejects.toMatchObject({
      status: 504,
      message: "Sidecar returned HTTP 504 with no body.",
    });
  });
});
