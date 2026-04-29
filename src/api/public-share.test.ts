/**
 * Tests for the public share-link router (Epic #990 / sub-issue #1000).
 *
 * Coverage targets:
 *   - 404 on unknown / revoked / expired / malformed tokens (no
 *     enumeration leakage)
 *   - 200 + sanitised HTML on a valid token
 *   - Rate-limit (429) when the per-IP cap is exceeded
 *   - XSS regression: malicious slide content is escaped, not executed
 *   - No raw token written to the response or audit log
 */
import express, { type Express } from "express";
import Database from "better-sqlite3";
import request from "supertest";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createPublicShareRouter } from "./public-share.js";
import { PitchRepository } from "../pitch/pitch-repository.js";
import {
  ShareTokenRepository,
  hashTokenPrefix,
} from "../pitch/share-token-repository.js";
import { BrandKitRepository } from "../video/brand-kit.js";
import { seedStarterBrandKits } from "../pitch/starter-brand-kits.js";
import type { Slide } from "../pitch/pitch-schema.js";

const FROZEN = () => new Date("2026-04-27T12:00:00Z");

function buildSlide(overrides: Partial<Slide> = {}): Slide {
  return {
    template: "bullet_list",
    content: {
      heading: "Hello",
      bullets: ["Alpha", "Beta"],
    },
    speaker_notes: "",
    transition: "slide",
    fragments: [],
    ...overrides,
  } as Slide;
}

interface Harness {
  app: Express;
  shareTokenRepo: ShareTokenRepository;
  pitchRepo: PitchRepository;
  brandKitRepo: BrandKitRepository;
  db: Database.Database;
  auditLog: Array<{ event: string; details: Record<string, unknown> }>;
  cleanup: () => void;
}

function buildHarness(opts: { rateLimit?: { max: number; windowMs?: number } } = {}): Harness {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const brandKitRepo = new BrandKitRepository(db);
  brandKitRepo.migrate();
  seedStarterBrandKits(brandKitRepo);

  const pitchRepo = new PitchRepository(db, FROZEN);
  pitchRepo.migrate();

  const shareTokenRepo = new ShareTokenRepository(db);
  shareTokenRepo.migrate();

  const auditLog: Array<{ event: string; details: Record<string, unknown> }> = [];
  const auditLogger = {
    log: vi.fn(async (entry: { event: string; details: Record<string, unknown> }) => {
      auditLog.push({ event: entry.event, details: entry.details });
    }),
  } as unknown as Parameters<typeof createPublicShareRouter>[0]["auditLogger"];

  const router = createPublicShareRouter({
    pitchRepo,
    brandKitRepo,
    shareTokenRepo,
    auditLogger,
    rateLimit: opts.rateLimit ?? { max: 1000 },
  });

  const app = express();
  app.use("/p", router);

  return {
    app,
    shareTokenRepo,
    pitchRepo,
    brandKitRepo,
    db,
    auditLog,
    cleanup: () => db.close(),
  };
}

function makeDeck(
  h: Harness,
  slideOverrides: Partial<Slide> = {},
  deckId = "deck-public-1",
): string {
  const kit = h.brandKitRepo.getAll()[0];
  h.pitchRepo.insertDeck({
    id: deckId,
    title: "Public Deck",
    brand_kit_id: kit.id,
    aspect_ratio: "16:9",
    metadata: { source_script: "", tone: "formal" },
    slides: [{ id: `${deckId}-slide-1`, slide: buildSlide(slideOverrides) }],
  });
  return deckId;
}

describe("createPublicShareRouter", () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });
  afterEach(() => {
    h.cleanup();
  });

  it("returns 200 and the deck HTML for an active token", async () => {
    const deckId = makeDeck(h);
    const { token } = h.shareTokenRepo.issue({ deckId });
    const res = await request(h.app).get(`/p/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["x-robots-tag"]).toContain("noindex");
    expect(res.text).toContain("Hello"); // slide heading rendered
  });

  it("CSP allows Google Fonts (#1019)", async () => {
    const deckId = makeDeck(h);
    const { token } = h.shareTokenRepo.issue({ deckId });
    const res = await request(h.app).get(`/p/${token}`);
    expect(res.status).toBe(200);
    const csp = res.headers["content-security-policy"] ?? "";
    expect(csp).toMatch(/style-src[^;]*https:\/\/fonts\.googleapis\.com/);
    expect(csp).toMatch(/font-src[^;]*https:\/\/fonts\.gstatic\.com/);
  });

  it("returns 404 with a generic page for an unknown token", async () => {
    const res = await request(h.app).get(`/p/${"a".repeat(43)}`);
    expect(res.status).toBe(404);
    expect(res.text).toContain("Deck not found");
  });

  it("returns 404 for a revoked token (and same body as unknown — no enumeration)", async () => {
    const deckId = makeDeck(h);
    const { token } = h.shareTokenRepo.issue({ deckId });
    h.shareTokenRepo.revoke(token);
    const revoked = await request(h.app).get(`/p/${token}`);
    const unknown = await request(h.app).get(`/p/${"x".repeat(43)}`);
    expect(revoked.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(revoked.text).toBe(unknown.text);
  });

  it("returns 404 for an expired token", async () => {
    const deckId = makeDeck(h);
    let now = new Date("2026-04-27T12:00:00Z");
    const repo = new ShareTokenRepository(h.db, () => now);
    const row = repo.issue({ deckId, expiresInDays: 1 });
    // Re-mount the router with this clock-aware repo so the lookup uses
    // the same `now()` we control.
    const app = express();
    app.use(
      "/p",
      createPublicShareRouter({
        pitchRepo: h.pitchRepo,
        brandKitRepo: h.brandKitRepo,
        shareTokenRepo: repo,
        rateLimit: { max: 1000 },
      }),
    );
    const fresh = await request(app).get(`/p/${row.token}`);
    expect(fresh.status).toBe(200);
    now = new Date(now.getTime() + 2 * 86_400_000);
    const expired = await request(app).get(`/p/${row.token}`);
    expect(expired.status).toBe(404);
  });

  it("rejects malformed tokens with 404 (no DB hit)", async () => {
    const lookupSpy = vi.spyOn(h.shareTokenRepo, "lookupActive");
    const cases = [
      "/p/short",
      "/p/has spaces in it that are too long to be a token",
      `/p/${"!".repeat(43)}`, // invalid chars
    ];
    for (const path of cases) {
      const res = await request(h.app).get(path);
      expect(res.status).toBe(404);
    }
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it("escapes script tags injected via slide content (no XSS)", async () => {
    const deckId = makeDeck(h, {
      content: {
        heading: '<script>window.__pwned=1</script>',
        bullets: ['<img src=x onerror=alert(1)>'],
      },
    });
    const { token } = h.shareTokenRepo.issue({ deckId });
    const res = await request(h.app).get(`/p/${token}`);
    expect(res.status).toBe(200);
    // The literal `<script>` from slide content must not survive verbatim.
    // (The renderer's standalone HTML legitimately contains its own
    // `<script src="...">` tags from reveal.js, so we look for the
    // injected payload's UNIQUE marker rather than the bare tag name.)
    expect(res.text).not.toContain("window.__pwned");
    expect(res.text).not.toContain("onerror=alert");
  });

  it("never logs the raw token (only its hash prefix)", async () => {
    const deckId = makeDeck(h);
    const { token } = h.shareTokenRepo.issue({ deckId });
    await request(h.app).get(`/p/${token}`);
    for (const entry of h.auditLog) {
      expect(JSON.stringify(entry)).not.toContain(token);
    }
    const hits = h.auditLog.filter((e) => e.event === "pitch_share_lookup_hit");
    expect(hits).toHaveLength(1);
    expect(hits[0].details.tokenIdHash).toBe(hashTokenPrefix(token));
  });

  it("rate-limits brute-force attempts with 429", async () => {
    const limited = buildHarness({ rateLimit: { max: 2, windowMs: 60_000 } });
    try {
      const a = await request(limited.app).get(`/p/${"a".repeat(43)}`);
      const b = await request(limited.app).get(`/p/${"b".repeat(43)}`);
      const c = await request(limited.app).get(`/p/${"c".repeat(43)}`);
      expect(a.status).toBe(404);
      expect(b.status).toBe(404);
      expect(c.status).toBe(429);
    } finally {
      limited.cleanup();
    }
  });
});
