import { describe, it, expect } from "vitest";
import { ByokTester, BYOK_PROVIDERS } from "./byok-tester.js";

const mkResponse = (status: number, statusText = ""): Response =>
  new Response("", { status, statusText });

const fakeFetch = (status: number, statusText = ""): typeof fetch =>
  (async () => mkResponse(status, statusText)) as unknown as typeof fetch;

describe("ByokTester", () => {
  it("exposes the four supported providers", () => {
    expect(BYOK_PROVIDERS).toEqual(["openai", "anthropic", "google", "groq"]);
  });

  it("rejects an unknown provider without calling fetch", async () => {
    let called = false;
    const tester = new ByokTester({
      fetchImpl: (async () => {
        called = true;
        return mkResponse(200);
      }) as unknown as typeof fetch,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await tester.test("nope" as any, "k");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Unknown provider/);
    expect(called).toBe(false);
  });

  it("rejects an empty API key without calling fetch", async () => {
    let called = false;
    const tester = new ByokTester({
      fetchImpl: (async () => {
        called = true;
        return mkResponse(200);
      }) as unknown as typeof fetch,
    });
    const r = await tester.test("openai", "   ");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Missing/);
    expect(called).toBe(false);
  });

  it("returns ok=true with humanized OK message on 200", async () => {
    const tester = new ByokTester({ fetchImpl: fakeFetch(200) });
    const r = await tester.test("openai", "sk-test");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.message).toMatch(/OK \(200\)/);
  });

  it("humanizes 401 as invalid/unauthorized", async () => {
    const tester = new ByokTester({ fetchImpl: fakeFetch(401) });
    const r = await tester.test("openai", "bad");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Invalid or unauthorized/);
  });

  it("humanizes 403 as invalid/unauthorized", async () => {
    const tester = new ByokTester({ fetchImpl: fakeFetch(403) });
    const r = await tester.test("groq", "bad");
    expect(r.message).toMatch(/Invalid or unauthorized/);
  });

  it("humanizes 429 as rate-limited", async () => {
    const tester = new ByokTester({ fetchImpl: fakeFetch(429) });
    const r = await tester.test("anthropic", "k");
    expect(r.message).toMatch(/Rate-limited/);
  });

  it("humanizes other failures with status text", async () => {
    const tester = new ByokTester({
      fetchImpl: fakeFetch(500, "Internal Server Error"),
    });
    const r = await tester.test("google", "k");
    expect(r.message).toMatch(/500/);
    expect(r.message).toMatch(/Internal Server Error/);
  });

  it("never echoes the API key in the result", async () => {
    const secret = "sk-SUPER-SECRET-KEY";
    const tester = new ByokTester({ fetchImpl: fakeFetch(401) });
    const r = await tester.test("openai", secret);
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it("reports latency from injected clock", async () => {
    let t = 1000;
    const tester = new ByokTester({
      fetchImpl: fakeFetch(200),
      now: () => {
        const v = t;
        t += 50;
        return v;
      },
    });
    const r = await tester.test("openai", "k");
    expect(r.latencyMs).toBe(50);
  });

  it("handles network errors gracefully", async () => {
    const tester = new ByokTester({
      fetchImpl: (async () => {
        throw new Error("ENOTFOUND");
      }) as unknown as typeof fetch,
    });
    const r = await tester.test("openai", "k");
    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
    expect(r.message).toMatch(/ENOTFOUND/);
  });

  it("calls the correct endpoint per provider", async () => {
    const urls: string[] = [];
    const tester = new ByokTester({
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return mkResponse(200);
      }) as unknown as typeof fetch,
    });
    await tester.test("openai", "k");
    await tester.test("anthropic", "k");
    await tester.test("google", "k");
    await tester.test("groq", "k");
    expect(urls[0]).toMatch(/api\.openai\.com/);
    expect(urls[1]).toMatch(/api\.anthropic\.com/);
    expect(urls[2]).toMatch(/generativelanguage\.googleapis\.com/);
    expect(urls[3]).toMatch(/api\.groq\.com/);
  });

  it("URL-encodes the Google API key in the query string", async () => {
    let captured = "";
    const tester = new ByokTester({
      fetchImpl: (async (url: string) => {
        captured = url;
        return mkResponse(200);
      }) as unknown as typeof fetch,
    });
    await tester.test("google", "key with spaces&special");
    expect(captured).toContain("key%20with%20spaces%26special");
  });
});
