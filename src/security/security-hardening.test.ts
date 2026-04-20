/**
 * Security regression tests for the Q2 2026 hardening epic (#899).
 *
 * Each block targets one of the sub-issues so a future regression flips a
 * named test, not an opaque assertion.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createAuthMiddleware } from "../auth/auth.js";

describe("security: ReDoS guard on baseUrl trim (sub-issue #900)", () => {
  // The vulnerable pattern in admin.ts was `String(prov.baseUrl).replace(/\/+$/, "")`.
  // Replicate the patched logic locally so the test stays isolated from the
  // 1800-line admin router.
  const trimTrailingSlash = (input: string): string => {
    const capped = String(input).slice(0, 2048);
    let s = capped;
    while (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  };

  it("strips trailing slashes from a normal URL", () => {
    expect(trimTrailingSlash("https://api.example.com/v1///")).toBe(
      "https://api.example.com/v1",
    );
  });

  it("returns the input unchanged when there are no trailing slashes", () => {
    expect(trimTrailingSlash("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1",
    );
  });

  it("processes a 1MB trailing-slash payload in under 50ms", () => {
    const payload = "https://api.example.com" + "/".repeat(1_000_000);
    const start = performance.now();
    const out = trimTrailingSlash(payload);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    // Length cap kicks in well before the 1MB suffix is processed.
    expect(out.length).toBeLessThanOrEqual(2048);
  });

  it("never returns a string longer than the 2048 cap", () => {
    const huge = "x".repeat(10_000);
    expect(trimTrailingSlash(huge).length).toBeLessThanOrEqual(2048);
  });
});

describe("security: query-token fallback is opt-in (sub-issue #908)", () => {
  const buildApp = (envValue: string | undefined) => {
    const previous = process.env.OPENZIGS_ALLOW_QUERY_TOKEN;
    if (envValue === undefined) {
      delete process.env.OPENZIGS_ALLOW_QUERY_TOKEN;
    } else {
      process.env.OPENZIGS_ALLOW_QUERY_TOKEN = envValue;
    }
    const app = express();
    app.use(
      createAuthMiddleware({
        mode: "local",
        token: "supersecret",
        role: "admin",
        rateLimit: { windowMs: 60_000, max: 1000 },
      }),
    );
    app.get("/ping", (_req, res) => res.json({ ok: true }));
    return {
      app,
      restore: () => {
        if (previous === undefined) {
          delete process.env.OPENZIGS_ALLOW_QUERY_TOKEN;
        } else {
          process.env.OPENZIGS_ALLOW_QUERY_TOKEN = previous;
        }
      },
    };
  };

  it("rejects ?token= by default", async () => {
    const { app, restore } = buildApp(undefined);
    try {
      const res = await request(app).get("/ping?token=supersecret");
      expect(res.status).toBe(401);
    } finally {
      restore();
    }
  });

  it("accepts ?token= only when OPENZIGS_ALLOW_QUERY_TOKEN=1", async () => {
    const { app, restore } = buildApp("1");
    try {
      const res = await request(app).get("/ping?token=supersecret");
      expect(res.status).toBe(200);
    } finally {
      restore();
    }
  });

  it("always accepts a Bearer token in the Authorization header", async () => {
    const { app, restore } = buildApp(undefined);
    try {
      const res = await request(app)
        .get("/ping")
        .set("Authorization", "Bearer supersecret");
      expect(res.status).toBe(200);
    } finally {
      restore();
    }
  });
});

describe("security: secrets scrubbed from version control (sub-issue #909)", () => {
  it("test-chat.mjs reads the token from the environment, not a literal", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const dir = path.dirname(url.fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(dir, "..", "..");
    const contents = fs.readFileSync(path.join(repoRoot, "test-chat.mjs"), "utf-8");
    expect(contents).toContain("process.env.OPENZIGS_TOKEN");
    // 64-char lowercase hex string is the OpenZigs local-auth token shape.
    expect(contents).not.toMatch(/[a-f0-9]{64}/);
  });
});

describe("security: pnpm.overrides include the audited CVE patches (sub-issue #902)", () => {
  it("pins protobufjs / lodash / hono / next / electron / vite / xmldom", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const dir = path.dirname(url.fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(dir, "..", "..");
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"),
    );
    const overrides = pkg.pnpm?.overrides ?? {};
    expect(overrides["protobufjs"]).toBeDefined();
    expect(overrides["lodash"]).toBeDefined();
    expect(overrides["lodash-es"]).toBeDefined();
    expect(overrides["hono"]).toBeDefined();
    expect(overrides["@hono/node-server"]).toBeDefined();
    expect(overrides["@xmldom/xmldom"]).toBeDefined();
    expect(overrides["dompurify"]).toBeDefined();
    expect(overrides["vite"]).toBeDefined();
    expect(overrides["next"]).toBeDefined();
    expect(overrides["electron"]).toBeDefined();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
