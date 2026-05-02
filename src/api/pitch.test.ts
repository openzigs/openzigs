/**
 * Pitch REST router — supertest integration suite.
 *
 * Coverage targets (Phase 3 acceptance criteria):
 *   - Router scaffold + factory wiring (#961)
 *   - Auth guard at the mount point (#961)
 *   - Deck + slide CRUD happy + error paths (#959)
 *   - AI endpoints with mocked Phase-2 service functions (#962)
 *   - Brand kit endpoints incl. starter immutability + delete-blocked-when-referenced (#966)
 *   - Logo upload — happy path, reject non-image, reject oversize (#966)
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";

import { createPitchRouter, type PitchRouterDeps } from "./pitch.js";
import { PitchRepository } from "../pitch/pitch-repository.js";
import { BrandKitRepository } from "../video/brand-kit.js";
import { seedStarterBrandKits } from "../pitch/starter-brand-kits.js";
import { ShareTokenRepository } from "../pitch/share-token-repository.js";
import {
  DeckSchema,
  SlideSchema,
  type Slide,
} from "../pitch/pitch-schema.js";

// ── Mocks for Phase-2 service functions ────────────────────────────────

const generateDeckMock = vi.fn();
const regenerateSlideMock = vi.fn();
const submitSlideRegenerateTaskMock = vi.fn();
const enqueueSlideImageMock = vi.fn();
const fanOutImageGenerationMock = vi.fn();

vi.mock("../pitch/pitch-generator.js", () => ({
  generateDeck: (...a: unknown[]) => generateDeckMock(...a),
  regenerateSlide: (...a: unknown[]) => regenerateSlideMock(...a),
}));

vi.mock("../pitch/pitch-regenerate.js", () => ({
  submitSlideRegenerateTask: (...a: unknown[]) =>
    submitSlideRegenerateTaskMock(...a),
}));

vi.mock("../pitch/pitch-image-service.js", () => ({
  enqueueSlideImage: (...a: unknown[]) => enqueueSlideImageMock(...a),
}));

vi.mock("../pitch/image-fanout.js", () => ({
  fanOutImageGeneration: (...a: unknown[]) => fanOutImageGenerationMock(...a),
}));

const refreshFluxQGpuAvailableMock = vi.fn();

vi.mock("../pitch/fluxq-recommended-dims.js", () => ({
  refreshFluxQGpuAvailable: (...a: unknown[]) =>
    refreshFluxQGpuAvailableMock(...a),
  getCachedFluxQGpuAvailable: () => undefined,
}));

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Helpers ────────────────────────────────────────────────────────────

const FROZEN = () => new Date("2026-04-25T12:00:00Z");

function createInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function buildSampleSlide(overrides: Partial<Slide> = {}): Slide {
  return SlideSchema.parse({
    template: "title",
    content: { title: "Sample Title" },
    speaker_notes: "",
    transition: "slide",
    fragments: [],
    ...overrides,
  });
}

function buildBulletSlide(heading: string, bullet: string): Slide {
  return SlideSchema.parse({
    template: "bullet_list",
    content: { heading, bullets: [bullet] },
    speaker_notes: "",
    transition: "slide",
    fragments: [],
  });
}

interface TestHarness {
  app: Express;
  deps: PitchRouterDeps;
  db: Database.Database;
  brandKitsDir: string;
  cleanup: () => void;
}

function buildHarness(): TestHarness {
  const db = createInMemoryDb();
  const pitchRepo = new PitchRepository(db, FROZEN);
  const brandKitRepo = new BrandKitRepository(db);
  brandKitRepo.migrate();
  pitchRepo.migrate();
  seedStarterBrandKits(brandKitRepo);

  const shareTokenRepo = new ShareTokenRepository(db, FROZEN);
  shareTokenRepo.migrate();

  const brandKitsDir = mkdtempSync(join(tmpdir(), "pitch-test-"));

  const deps: PitchRouterDeps = {
    pitchRepo,
    brandKitRepo,
    copilot: {
      chat: vi.fn(),
      isAuthenticated: vi.fn().mockReturnValue(true),
    } as unknown as PitchRouterDeps["copilot"],
    taskEngine: {
      submit: vi.fn(),
    } as unknown as PitchRouterDeps["taskEngine"],
    mediaQueueRepo: {
      createJob: vi.fn(),
    } as unknown as PitchRouterDeps["mediaQueueRepo"],
    shareTokenRepo,
    brandKitsDir,
  };

  const app = express();
  app.use(express.json());
  app.use("/api/admin/pitch", createPitchRouter(deps));

  return {
    app,
    deps,
    db,
    brandKitsDir,
    cleanup: () => {
      db.close();
      try {
        rmSync(brandKitsDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

// Helper to create a real custom brand kit (not a starter).
function createCustomKit(harness: TestHarness, name = "Custom Kit"): string {
  return harness.deps.brandKitRepo.create({
    id: `custom-${name.replace(/\s+/g, "-").toLowerCase()}`,
    name,
    primaryColor: "#112233",
    secondaryColor: "#445566",
    accentColor: "#778899",
    fontFamily: "Inter",
    fontHeading: "Inter",
    fontBody: "Inter",
    footerText: null,
    logoPath: null,
    watermarkPath: null,
    introTemplateId: null,
    outroTemplateId: null,
  }).id;
}

function createDeck(
  harness: TestHarness,
  brandKitId: string,
  title = "Test Deck",
): { deckId: string; slideId: string } {
  const slide = buildSampleSlide();
  const deck = harness.deps.pitchRepo.insertDeck({
    id: `deck-${title.replace(/\s+/g, "-").toLowerCase()}`,
    title,
    brand_kit_id: brandKitId,
    aspect_ratio: "16:9",
    metadata: { source_script: "", tone: "formal" },
    slides: [{ id: `slide-${title}-1`, slide }],
  });
  const slides = harness.deps.pitchRepo.listSlidesForDeck(deck.id);
  return { deckId: deck.id, slideId: slides[0].id };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("Pitch REST router", () => {
  let harness: TestHarness;

  beforeEach(() => {
    generateDeckMock.mockReset();
    regenerateSlideMock.mockReset();
    submitSlideRegenerateTaskMock.mockReset();
    enqueueSlideImageMock.mockReset();
    fanOutImageGenerationMock.mockReset();
    fanOutImageGenerationMock.mockResolvedValue({
      enqueued: 0,
      skipped: 0,
      total: 0,
    });
    refreshFluxQGpuAvailableMock.mockReset();
    // Default: probe is unreachable / undecided. Tests that need a
    // definitive false (no GPU) must override this per-case.
    refreshFluxQGpuAvailableMock.mockResolvedValue(undefined);
    harness = buildHarness();
  });

  afterEach(() => {
    harness.cleanup();
  });

  // ── #961 — scaffold / auth ──────────────────────────────────────────

  describe("scaffold + auth (#961)", () => {
    it("createPitchRouter returns an express Router", () => {
      const r = createPitchRouter(harness.deps);
      expect(typeof r).toBe("function"); // express.Router is a callable function
      expect(typeof (r as unknown as { use: unknown }).use).toBe("function");
    });

    it("rejects unauthenticated requests when wrapped in authMiddleware", async () => {
      // Build a fresh app with the real auth middleware in front of the router.
      const { createAuthMiddleware } = await import("../auth/auth.js");
      const auth = createAuthMiddleware({
        mode: "local",
        token: "secret-test-token",
        rateLimit: { windowMs: 1_000, max: 100 },
      });
      const app = express();
      app.use(express.json());
      app.use("/api/admin/pitch", auth, createPitchRouter(harness.deps));

      const r1 = await request(app).get("/api/admin/pitch/decks");
      expect(r1.status).toBe(401);

      const r2 = await request(app)
        .get("/api/admin/pitch/decks")
        .set("Authorization", "Bearer wrong-token");
      expect(r2.status).toBe(401);

      const r3 = await request(app)
        .get("/api/admin/pitch/decks")
        .set("Authorization", "Bearer secret-test-token");
      expect(r3.status).toBe(200);
    });
  });

  // ── #959 — deck CRUD ────────────────────────────────────────────────

  describe("deck CRUD (#959)", () => {
    it("GET /decks lists decks with pagination", async () => {
      const kitId = createCustomKit(harness);
      createDeck(harness, kitId, "Deck A");
      createDeck(harness, kitId, "Deck B");

      const res = await request(harness.app).get("/api/admin/pitch/decks");
      expect(res.status).toBe(200);
      expect(res.body.decks).toHaveLength(2);
      expect(res.body.pagination).toEqual({ total: 2, limit: 50, offset: 0 });

      const paged = await request(harness.app).get(
        "/api/admin/pitch/decks?limit=1&offset=1",
      );
      expect(paged.status).toBe(200);
      expect(paged.body.decks).toHaveLength(1);
      expect(paged.body.pagination).toEqual({ total: 2, limit: 1, offset: 1 });
    });

    it("GET /decks skips a malformed legacy row instead of returning 500", async () => {
      const kitId = createCustomKit(harness);
      createDeck(harness, kitId, "Good Deck");
      harness.db.prepare(
        `INSERT INTO pitch_decks (id, title, brand_kit_id, aspect_ratio, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "bad-legacy",
        "Bad Legacy",
        kitId,
        "16:9",
        JSON.stringify({ source_script: "" }),
        FROZEN().toISOString(),
        FROZEN().toISOString(),
      );

      const res = await request(harness.app).get("/api/admin/pitch/decks");
      expect(res.status).toBe(200);
      expect(res.body.decks).toHaveLength(1);
      expect(res.body.decks[0].id).toBe("deck-good-deck");
    });

    it("GET /decks returns a structured error envelope if the repository throws", async () => {
      vi.spyOn(harness.deps.pitchRepo, "listDecks").mockImplementation(() => {
        throw new Error("database is locked");
      });
      const res = await request(harness.app).get("/api/admin/pitch/decks");
      expect(res.status).toBe(500);
      expect(res.body.error).toMatchObject({
        code: "internal_error",
        message: "could not load pitch decks",
      });
      expect(res.body.error.details.route).toBe("/api/admin/pitch/decks");
    });

    it("POST /decks creates a deck (with placeholder slide)", async () => {
      const kitId = createCustomKit(harness);
      const res = await request(harness.app)
        .post("/api/admin/pitch/decks")
        .send({ title: "Brand New", brand_kit_id: kitId });
      expect(res.status).toBe(201);
      expect(res.body.deck.title).toBe("Brand New");
      expect(res.body.deck.slides).toHaveLength(1);
      expect(res.body.deck.slides[0].template).toBe("title");
      // Verify the deck round-trips through DeckSchema.
      expect(() => DeckSchema.parse(res.body.deck)).not.toThrow();
    });

    it("POST /decks returns 404 when brand_kit_id is unknown", async () => {
      const res = await request(harness.app)
        .post("/api/admin/pitch/decks")
        .send({ title: "X", brand_kit_id: "no-such-kit" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    });

    it("POST /decks returns 400 on schema violation (missing title)", async () => {
      const kitId = createCustomKit(harness);
      const res = await request(harness.app)
        .post("/api/admin/pitch/decks")
        .send({ brand_kit_id: kitId });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("POST /decks rejects unknown fields (.strict)", async () => {
      const kitId = createCustomKit(harness);
      const res = await request(harness.app)
        .post("/api/admin/pitch/decks")
        .send({ title: "X", brand_kit_id: kitId, evil: "field" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("GET /decks/:deckId returns deck + slides", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app).get(
        `/api/admin/pitch/decks/${deckId}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.deck.id).toBe(deckId);
      expect(res.body.slides).toHaveLength(1);
    });

    it("GET /decks/:deckId reconciles existing inline image assets into slide URLs", async () => {
      const kitId = createCustomKit(harness);
      const slide = SlideSchema.parse({
        template: "image_caption",
        content: {
          image: { prompt: "a robot", url: null, alt: "robot" },
          caption: "Robot",
        },
        speaker_notes: "",
        transition: "slide",
        fragments: [],
      });
      const deck = harness.deps.pitchRepo.insertDeck({
        id: "deck-inline-assets",
        title: "Inline Assets",
        brand_kit_id: kitId,
        aspect_ratio: "16:9",
        metadata: { source_script: "", tone: "formal" },
        slides: [{ id: "slide-inline-assets", slide }],
      });
      harness.deps.pitchRepo.insertAsset({
        id: "asset-inline",
        deck_id: deck.id,
        slide_id: "slide-inline-assets",
        kind: "image",
        source: "fluxq",
        prompt: "a robot",
        local_path: join(harness.brandKitsDir, "asset-inline.png"),
        mime: "image/png",
        width: 16,
        height: 16,
        created_at: FROZEN().toISOString(),
      });

      const res = await request(harness.app).get(
        `/api/admin/pitch/decks/${deck.id}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.slides[0].slide.content.image.url).toBe(
        `/api/admin/pitch/decks/${deck.id}/assets/asset-inline`,
      );
    });

    it("GET /decks/:deckId returns 404 for unknown deck", async () => {
      const res = await request(harness.app).get("/api/admin/pitch/decks/nope");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    });

    it("PATCH /decks/:deckId updates title", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app)
        .patch(`/api/admin/pitch/decks/${deckId}`)
        .send({ title: "Renamed" });
      expect(res.status).toBe(200);
      expect(res.body.deck.title).toBe("Renamed");
    });

    it("PATCH /decks/:deckId returns 400 on empty body", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app)
        .patch(`/api/admin/pitch/decks/${deckId}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it("PATCH /decks/:deckId returns 404 for unknown brand kit", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app)
        .patch(`/api/admin/pitch/decks/${deckId}`)
        .send({ brand_kit_id: "missing" });
      expect(res.status).toBe(404);
    });

    it("DELETE /decks/:deckId cascades through slides + assets", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app).delete(
        `/api/admin/pitch/decks/${deckId}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(harness.deps.pitchRepo.getDeck(deckId)).toBeNull();
      expect(harness.deps.pitchRepo.listSlidesForDeck(deckId)).toHaveLength(0);
    });

    it("DELETE /decks/:deckId returns 404 for unknown deck", async () => {
      const res = await request(harness.app).delete(
        "/api/admin/pitch/decks/nope",
      );
      expect(res.status).toBe(404);
    });
  });

  // ── #959 — slide CRUD ────────────────────────────────────────────────

  describe("slide CRUD (#959)", () => {
    it("POST /decks/:deckId/slides appends a slide", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides`)
        .send({ slide: buildBulletSlide("New", "First bullet") });
      expect(res.status).toBe(201);
      expect(res.body.slide.slide.template).toBe("bullet_list");

      const slides = harness.deps.pitchRepo.listSlidesForDeck(deckId);
      expect(slides).toHaveLength(2);
      expect(slides[1].slide.template).toBe("bullet_list");
    });

    it("POST /decks/:deckId/slides at position=0 inserts at the front", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides`)
        .send({ slide: buildBulletSlide("Front", "x"), position: 0 });
      expect(res.status).toBe(201);
      const slides = harness.deps.pitchRepo.listSlidesForDeck(deckId);
      expect(slides[0].slide.template).toBe("bullet_list");
      expect(slides[1].slide.template).toBe("title");
    });

    it("POST /decks/:deckId/slides returns 404 for unknown deck", async () => {
      const res = await request(harness.app)
        .post("/api/admin/pitch/decks/missing/slides")
        .send({ slide: buildSampleSlide() });
      expect(res.status).toBe(404);
    });

    it("POST /decks/:deckId/slides returns 400 on invalid slide", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides`)
        .send({ slide: { template: "title", content: {} } }); // missing title
      expect(res.status).toBe(400);
    });

    it("PATCH /decks/:deckId/slides/:slideId edits content", async () => {
      const kitId = createCustomKit(harness);
      const { deckId, slideId } = createDeck(harness, kitId);
      const res = await request(harness.app)
        .patch(`/api/admin/pitch/decks/${deckId}/slides/${slideId}`)
        .send({
          slide: buildSampleSlide({
            content: { title: "Edited Title" },
          } as Partial<Slide>),
        });
      expect(res.status).toBe(200);
      expect((res.body.slide.slide.content as { title: string }).title).toBe(
        "Edited Title",
      );
    });

    it("PATCH /decks/:deckId/slides/:slideId returns 404 for wrong deck", async () => {
      const kitId = createCustomKit(harness);
      const { slideId } = createDeck(harness, kitId);
      const res = await request(harness.app)
        .patch(`/api/admin/pitch/decks/wrong-deck/slides/${slideId}`)
        .send({ slide: buildSampleSlide() });
      expect(res.status).toBe(404);
    });

    it("PUT /decks/:deckId/slides/:slideId/move reorders slides", async () => {
      const kitId = createCustomKit(harness);
      const { deckId, slideId } = createDeck(harness, kitId);
      // Append a second slide
      await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides`)
        .send({ slide: buildBulletSlide("B", "b") });
      // Move the first slide to position 1
      const res = await request(harness.app)
        .put(`/api/admin/pitch/decks/${deckId}/slides/${slideId}/move`)
        .send({ position: 1 });
      expect(res.status).toBe(200);
      const slides = harness.deps.pitchRepo.listSlidesForDeck(deckId);
      expect(slides.map((s) => s.id)).toEqual([res.body.slides[0], slideId]);
    });

    it("DELETE /decks/:deckId/slides/:slideId removes a slide", async () => {
      const kitId = createCustomKit(harness);
      const { deckId, slideId } = createDeck(harness, kitId);
      // Append second so deletion is allowed.
      await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides`)
        .send({ slide: buildBulletSlide("B", "b") });
      const res = await request(harness.app).delete(
        `/api/admin/pitch/decks/${deckId}/slides/${slideId}`,
      );
      expect(res.status).toBe(200);
      expect(harness.deps.pitchRepo.getSlide(slideId)).toBeNull();
    });

    it("DELETE /decks/:deckId/slides/:slideId blocks deleting last slide", async () => {
      const kitId = createCustomKit(harness);
      const { deckId, slideId } = createDeck(harness, kitId);
      const res = await request(harness.app).delete(
        `/api/admin/pitch/decks/${deckId}/slides/${slideId}`,
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("conflict");
    });
  });

  // ── #963 (Phase 4) — Render endpoint ─────────────────────────────────

  describe("render endpoint (#963)", () => {
    it("GET /decks/:deckId/render returns embedded HTML by default", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app).get(
        `/api/admin/pitch/decks/${deckId}/render`,
      );
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.text).toContain('class="pitch-deck-wrap pitch-deck-wrap--embedded"');
      expect(res.text).toContain('class="reveal"');
      // Embedded mode now emits a full HTML document so the editor canvas /
      // slide-rail iframes can mount Reveal.js without the host page needing
      // to load reveal.css separately. (Bug fix 2026-04-28.)
      expect(res.text.startsWith("<!doctype html>")).toBe(true);
      expect(res.text).toContain("reveal.js@5/dist/reveal.css");
    });

    it("GET /decks/:deckId/render?mode=standalone returns full HTML doc", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app).get(
        `/api/admin/pitch/decks/${deckId}/render?mode=standalone`,
      );
      expect(res.status).toBe(200);
      expect(res.text.startsWith("<!doctype html>")).toBe(true);
      expect(res.text).toContain("reveal.js@5/dist/reveal.css");
    });

    it("forwards `?initial=N` to the renderer (selection navigation, 2026-04-28)", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app).get(
        `/api/admin/pitch/decks/${deckId}/render?initial=1`,
      );
      expect(res.status).toBe(200);
      // The embedded init script navigates to the requested slide; the
      // renderer clamps to the available slide range so even a tiny deck
      // (1 slide) gets clamped to index 0 — the call still appears.
      expect(res.text).toContain("deck.slide(");
    });

    it("returns 404 when deck not found", async () => {
      const res = await request(harness.app).get(
        "/api/admin/pitch/decks/missing/render",
      );
      expect(res.status).toBe(404);
    });

    it("CSP allows Google Fonts (#1019)", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app).get(
        `/api/admin/pitch/decks/${deckId}/render?mode=present`,
      );
      expect(res.status).toBe(200);
      const csp = res.headers["content-security-policy"] ?? "";
      expect(csp).toContain("style-src");
      expect(csp).toMatch(/style-src[^;]*https:\/\/fonts\.googleapis\.com/);
      expect(csp).toContain("font-src");
      expect(csp).toMatch(/font-src[^;]*https:\/\/fonts\.gstatic\.com/);
    });

    it("export.html CSP also allows Google Fonts (#1019)", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app).get(
        `/api/admin/pitch/decks/${deckId}/export.html`,
      );
      expect(res.status).toBe(200);
      const csp = res.headers["content-security-policy"] ?? "";
      expect(csp).toMatch(/style-src[^;]*https:\/\/fonts\.googleapis\.com/);
      expect(csp).toMatch(/font-src[^;]*https:\/\/fonts\.gstatic\.com/);
    });

    it("returns 404 when deck's brand kit is missing", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      // Force the deck to point at a non-existent brand kit. Bypass the
      // foreign-key guard with a direct SQL update — production code
      // can't reach this state, but the route's defensive 404 is worth covering.
      harness.db.pragma("foreign_keys = OFF");
      try {
        harness.db
          .prepare(`UPDATE pitch_decks SET brand_kit_id = ? WHERE id = ?`)
          .run("missing-kit", deckId);
      } finally {
        harness.db.pragma("foreign_keys = ON");
      }
      const res = await request(harness.app).get(
        `/api/admin/pitch/decks/${deckId}/render`,
      );
      expect(res.status).toBe(404);
    });
  });

  // ── #962 — AI endpoints ──────────────────────────────────────────────

  describe("AI endpoints (#962)", () => {
    it("POST /decks/draft calls generateDeck and persists the result", async () => {
      const kitId = createCustomKit(harness);
      generateDeckMock.mockResolvedValue({
        id: "ignored-by-router",
        title: "Generated Title",
        brand_kit_id: kitId,
        aspect_ratio: "16:9",
        slides: [buildSampleSlide()],
        metadata: { source_script: "src", tone: "formal" },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      });

      const res = await request(harness.app)
        .post("/api/admin/pitch/decks/draft")
        .send({ script: "Hello world", brandKitId: kitId });

      expect(res.status).toBe(201);
      expect(generateDeckMock).toHaveBeenCalledTimes(1);
      // Persisted deck must have a NEW id (not ignored-by-router).
      expect(res.body.deck.id).not.toBe("ignored-by-router");
      expect(res.body.deck.title).toBe("Generated Title");
      expect(harness.deps.pitchRepo.getDeck(res.body.deck.id)).not.toBeNull();
    });

    it("POST /decks/draft returns 404 for unknown brand kit", async () => {
      const res = await request(harness.app)
        .post("/api/admin/pitch/decks/draft")
        .send({ script: "x", brandKitId: "missing" });
      expect(res.status).toBe(404);
      expect(generateDeckMock).not.toHaveBeenCalled();
    });

    it("POST /decks/draft returns 502 when generator throws", async () => {
      const kitId = createCustomKit(harness);
      generateDeckMock.mockRejectedValue(new Error("LLM down"));
      const res = await request(harness.app)
        .post("/api/admin/pitch/decks/draft")
        .send({ script: "x", brandKitId: kitId });
      expect(res.status).toBe(502);
    });

    it("POST .../regenerate enqueues a task and returns the taskId", async () => {
      const kitId = createCustomKit(harness);
      const { deckId, slideId } = createDeck(harness, kitId);
      submitSlideRegenerateTaskMock.mockReturnValue({
        task: { id: "task-xyz" },
        prompt: "regen prompt",
      });

      const res = await request(harness.app)
        .post(
          `/api/admin/pitch/decks/${deckId}/slides/${slideId}/regenerate`,
        )
        .send({ instruction: "make it punchier" });

      expect(res.status).toBe(202);
      expect(res.body.taskId).toBe("task-xyz");
      expect(submitSlideRegenerateTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          deckId,
          slideId,
          hint: "make it punchier",
        }),
      );
    });

    it("POST .../regenerate returns 404 for unknown slide", async () => {
      const res = await request(harness.app)
        .post("/api/admin/pitch/decks/d/slides/s/regenerate")
        .send({});
      expect(res.status).toBe(404);
    });

    it("POST .../enhance polishes a slide and persists", async () => {
      const kitId = createCustomKit(harness);
      const { deckId, slideId } = createDeck(harness, kitId);
      const polished = buildSampleSlide({
        content: { title: "Polished" },
      } as Partial<Slide>);
      regenerateSlideMock.mockResolvedValue(polished);

      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides/${slideId}/enhance`)
        .send({ instruction: "tighten" });

      expect(res.status).toBe(200);
      expect((res.body.slide.slide.content as { title: string }).title).toBe(
        "Polished",
      );
      expect(regenerateSlideMock).toHaveBeenCalledTimes(1);
      // Hint should include the user instruction.
      const call = regenerateSlideMock.mock.calls[0][0] as { hint: string };
      expect(call.hint).toContain("tighten");
    });

    it("POST .../image enqueues a FluxQ job (inline mode)", async () => {
      const kitId = createCustomKit(harness);
      const { deckId, slideId } = createDeck(harness, kitId);
      enqueueSlideImageMock.mockReturnValue({
        jobId: "job-123",
        assetId: "asset-456",
        payload: {},
      });

      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides/${slideId}/image`)
        .send({
          prompt: "a robot painting",
          mode: "inline",
          loraTriggerWord: "lora_trigger",
        });

      expect(res.status).toBe(202);
      expect(res.body.jobId).toBe("job-123");
      expect(res.body.assetId).toBe("asset-456");
      const args = enqueueSlideImageMock.mock.calls[0][0] as {
        prompt: string;
        kind: string;
      };
      expect(args.prompt).toBe("lora_trigger a robot painting");
      expect(args.kind).toBe("image");
    });

    it("POST .../image with mode=background maps to kind=background", async () => {
      const kitId = createCustomKit(harness);
      const { deckId, slideId } = createDeck(harness, kitId);
      enqueueSlideImageMock.mockReturnValue({
        jobId: "j",
        assetId: "a",
        payload: {},
      });
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides/${slideId}/image`)
        .send({ prompt: "moody backdrop", mode: "background" });
      expect(res.status).toBe(202);
      const args = enqueueSlideImageMock.mock.calls[0][0] as { kind: string };
      expect(args.kind).toBe("background");
    });

    it("POST .../image returns 400 on invalid mode", async () => {
      const kitId = createCustomKit(harness);
      const { deckId, slideId } = createDeck(harness, kitId);
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides/${slideId}/image`)
        .send({ prompt: "x", mode: "wrong" });
      expect(res.status).toBe(400);
    });
  });

  // ── #995 + #991 — bulk image fan-out ────────────────────────────────

  describe("bulk image fan-out (#995, #991)", () => {
    it("POST /decks/draft kicks off fanOutImageGeneration by default (#995)", async () => {
      const kitId = createCustomKit(harness);
      generateDeckMock.mockResolvedValue({
        id: "x",
        title: "T",
        brand_kit_id: kitId,
        aspect_ratio: "16:9",
        slides: [buildSampleSlide()],
        metadata: { source_script: "s", tone: "formal" },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      });
      fanOutImageGenerationMock.mockResolvedValue({
        enqueued: 1,
        skipped: 0,
        total: 1,
      });
      const res = await request(harness.app)
        .post("/api/admin/pitch/decks/draft")
        .send({ script: "x", brandKitId: kitId });
      expect(res.status).toBe(201);
      // Allow the next-tick fan-out to run.
      await new Promise((r) => setImmediate(r));
      expect(fanOutImageGenerationMock).toHaveBeenCalledTimes(1);
      const args = fanOutImageGenerationMock.mock.calls[0]?.[0] as {
        deckId: string;
        concurrency: number;
      };
      expect(args.deckId).toBe(res.body.deck.id);
      expect(args.concurrency).toBe(4);
    });

    it("POST /decks/draft skips fan-out when autoGenerateImages=false", async () => {
      const kitId = createCustomKit(harness);
      generateDeckMock.mockResolvedValue({
        id: "x",
        title: "T",
        brand_kit_id: kitId,
        aspect_ratio: "16:9",
        slides: [buildSampleSlide()],
        metadata: { source_script: "s", tone: "formal" },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      });
      const res = await request(harness.app)
        .post("/api/admin/pitch/decks/draft")
        .send({
          script: "x",
          brandKitId: kitId,
          options: { autoGenerateImages: false },
        });
      expect(res.status).toBe(201);
      await new Promise((r) => setImmediate(r));
      expect(fanOutImageGenerationMock).not.toHaveBeenCalled();
    });

    it("POST /decks/:id/images/generate-all returns counts (#991)", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      fanOutImageGenerationMock.mockResolvedValue({
        enqueued: 3,
        skipped: 1,
        total: 4,
      });
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/images/generate-all`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ enqueued: 3, skipped: 1, total: 4 });
      expect(fanOutImageGenerationMock).toHaveBeenCalledTimes(1);
    });

    it("POST .../images/generate-all returns 404 for unknown deck", async () => {
      const res = await request(harness.app)
        .post("/api/admin/pitch/decks/missing/images/generate-all")
        .send({});
      expect(res.status).toBe(404);
      expect(fanOutImageGenerationMock).not.toHaveBeenCalled();
    });

    it("POST .../images/generate-all rejects non-empty body (.strict())", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/images/generate-all`)
        .send({ extraField: 1 });
      expect(res.status).toBe(400);
    });

    it("POST .../images/generate-all enforces 5s per-deck cooldown", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      fanOutImageGenerationMock.mockResolvedValue({
        enqueued: 0,
        skipped: 0,
        total: 0,
      });
      const r1 = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/images/generate-all`)
        .send({});
      expect(r1.status).toBe(200);
      const r2 = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/images/generate-all`)
        .send({});
      expect(r2.status).toBe(429);
      expect(fanOutImageGenerationMock).toHaveBeenCalledTimes(1);
    });

    it("POST .../images/generate-all returns 503 when fan-out throws", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      fanOutImageGenerationMock.mockRejectedValue(new Error("flux down"));
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/images/generate-all`)
        .send({});
      expect(res.status).toBe(503);
    });

    // Sub-issue #1039 / Epic #1035 AC3 — `slideIds` filter scopes the
    // fan-out to a single slide so the slide-rail per-slide retry
    // control doesn't fan out across the entire deck.
    it("POST .../images/generate-all forwards slideIds filter to fanOutImageGeneration (#1039)", async () => {
      const kitId = createCustomKit(harness);
      const { deckId, slideId } = createDeck(harness, kitId);
      // Add a second slide so the filter actually narrows the slate.
      const secondSlide = SlideSchema.parse({
        template: "title",
        content: { title: "Second" },
        speaker_notes: "",
        transition: "slide",
        fragments: [],
      });
      const created = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides`)
        .send({ slide: secondSlide });
      expect(created.status).toBe(201);
      fanOutImageGenerationMock.mockResolvedValue({
        enqueued: 1,
        skipped: 0,
        total: 1,
      });
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/images/generate-all`)
        .send({ slideIds: [slideId] });
      expect(res.status).toBe(200);
      expect(fanOutImageGenerationMock).toHaveBeenCalledTimes(1);
      const args = fanOutImageGenerationMock.mock.calls[0]?.[0] as {
        slides: Array<{ id: string }>;
      };
      expect(args.slides.map((s) => s.id)).toEqual([slideId]);
    });

    it("POST .../images/generate-all returns 404 when slideIds match nothing (#1039)", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/images/generate-all`)
        .send({ slideIds: ["does-not-exist"] });
      expect(res.status).toBe(404);
      expect(fanOutImageGenerationMock).not.toHaveBeenCalled();
    });

    // Bug-fix (post-PR-#1041 walkthrough): pre-flight FluxQ /gpu-info
    // probe must short-circuit the bulk fan-out with a structured 503
    // when the sidecar reports no usable GPU, instead of enqueueing N
    // doomed jobs that all fail with `enable_model_cpu_offload requires
    // accelerator, but not found`.
    it("returns 503 image_gen_unavailable when FluxQ reports no GPU", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      refreshFluxQGpuAvailableMock.mockResolvedValue(false);
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/images/generate-all`)
        .send({});
      expect(res.status).toBe(503);
      expect(res.body.error?.code).toBe("image_gen_unavailable");
      expect(fanOutImageGenerationMock).not.toHaveBeenCalled();
    });

    it("does NOT arm the cooldown when pre-flight short-circuits with 503", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      refreshFluxQGpuAvailableMock.mockResolvedValueOnce(false);
      const r1 = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/images/generate-all`)
        .send({});
      expect(r1.status).toBe(503);
      // Subsequent request after GPU comes back online should be allowed
      // through (no 429), proving the cooldown was not armed.
      refreshFluxQGpuAvailableMock.mockResolvedValueOnce(true);
      fanOutImageGenerationMock.mockResolvedValueOnce({
        enqueued: 1,
        skipped: 0,
        total: 1,
      });
      const r2 = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/images/generate-all`)
        .send({});
      expect(r2.status).toBe(200);
    });

    it("continues with fan-out when GPU probe returns undefined (unreachable)", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      refreshFluxQGpuAvailableMock.mockResolvedValue(undefined);
      fanOutImageGenerationMock.mockResolvedValue({
        enqueued: 2,
        skipped: 0,
        total: 2,
      });
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/images/generate-all`)
        .send({});
      expect(res.status).toBe(200);
      expect(fanOutImageGenerationMock).toHaveBeenCalledTimes(1);
    });
  });

  // ── #966 — brand kits + logo upload ─────────────────────────────────

  describe("brand kits (#966)", () => {
    it("GET /brand-kits lists kits including starter flag", async () => {
      createCustomKit(harness, "MyKit");
      const res = await request(harness.app).get(
        "/api/admin/pitch/brand-kits",
      );
      expect(res.status).toBe(200);
      const starters = res.body.brandKits.filter(
        (k: { isStarter: boolean }) => k.isStarter,
      );
      const customs = res.body.brandKits.filter(
        (k: { isStarter: boolean }) => !k.isStarter,
      );
      expect(starters.length).toBeGreaterThanOrEqual(8);
      expect(customs.length).toBe(1);
    });

    it("POST /brand-kits creates a custom kit", async () => {
      const res = await request(harness.app)
        .post("/api/admin/pitch/brand-kits")
        .send({
          name: "My Kit",
          primaryColor: "#aabbcc",
          secondaryColor: "#ddeeff",
          accentColor: "#001122",
        });
      expect(res.status).toBe(201);
      expect(res.body.brandKit.isStarter).toBe(false);
    });

    it("POST /brand-kits returns 400 on bad hex color", async () => {
      const res = await request(harness.app)
        .post("/api/admin/pitch/brand-kits")
        .send({ name: "X", primaryColor: "blue" });
      expect(res.status).toBe(400);
    });

    it("GET /brand-kits/:id returns a single kit", async () => {
      const id = createCustomKit(harness);
      const res = await request(harness.app).get(
        `/api/admin/pitch/brand-kits/${id}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.brandKit.id).toBe(id);
    });

    it("PATCH /brand-kits/:id on a starter returns 403", async () => {
      const res = await request(harness.app)
        .patch("/api/admin/pitch/brand-kits/starter-modern-minimal")
        .send({ name: "Hijacked" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    });

    it("PATCH /brand-kits/:id updates a custom kit", async () => {
      const id = createCustomKit(harness);
      const res = await request(harness.app)
        .patch(`/api/admin/pitch/brand-kits/${id}`)
        .send({ name: "Renamed" });
      expect(res.status).toBe(200);
      expect(res.body.brandKit.name).toBe("Renamed");
    });

    it("DELETE /brand-kits/:id on a starter returns 403", async () => {
      const res = await request(harness.app).delete(
        "/api/admin/pitch/brand-kits/starter-modern-minimal",
      );
      expect(res.status).toBe(403);
    });

    it("DELETE /brand-kits/:id returns 409 when referenced by a deck", async () => {
      const id = createCustomKit(harness);
      createDeck(harness, id);
      const res = await request(harness.app).delete(
        `/api/admin/pitch/brand-kits/${id}`,
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("conflict");
      expect(res.body.error.details.deckId).toBeDefined();
    });

    it("DELETE /brand-kits/:id removes an unreferenced custom kit", async () => {
      const id = createCustomKit(harness);
      const res = await request(harness.app).delete(
        `/api/admin/pitch/brand-kits/${id}`,
      );
      expect(res.status).toBe(200);
      expect(harness.deps.brandKitRepo.getById(id)).toBeNull();
    });
  });

  describe("logo upload (#966)", () => {
    // Real PNG bytes generated via sharp so the post-upload re-encode
    // pipeline (PR #980 hardening) has valid input to work with.
    let PNG_BYTES: Buffer;
    beforeAll(async () => {
      PNG_BYTES = await sharp({
        create: {
          width: 1,
          height: 1,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 1 },
        },
      })
        .png()
        .toBuffer();
    });

    it("POST /brand-kits/:id/logo accepts a PNG and updates logoPath", async () => {
      const id = createCustomKit(harness);
      const res = await request(harness.app)
        .post(`/api/admin/pitch/brand-kits/${id}/logo`)
        .attach("logo", PNG_BYTES, {
          filename: "logo.png",
          contentType: "image/png",
        });
      expect(res.status).toBe(200);
      expect(res.body.logo.mime).toBe("image/png");
      expect(res.body.logo.path).toMatch(/logo\.png$/);
      expect(existsSync(res.body.logo.path)).toBe(true);
      const updated = harness.deps.brandKitRepo.getById(id);
      expect(updated?.logoPath).toBe(res.body.logo.path);
    });

    it("POST /brand-kits/:id/logo returns 400 for non-image MIME", async () => {
      const id = createCustomKit(harness);
      const res = await request(harness.app)
        .post(`/api/admin/pitch/brand-kits/${id}/logo`)
        .attach("logo", Buffer.from("evil"), {
          filename: "bad.exe",
          contentType: "application/octet-stream",
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    });

    it("POST /brand-kits/:id/logo rejects oversize files (multer cap)", async () => {
      const id = createCustomKit(harness);
      const huge = Buffer.alloc(2 * 1024 * 1024 + 1, 0x89);
      const res = await request(harness.app)
        .post(`/api/admin/pitch/brand-kits/${id}/logo`)
        .attach("logo", huge, {
          filename: "huge.png",
          contentType: "image/png",
        });
      expect(res.status).toBe(413);
    });

    it("POST /brand-kits/:id/logo on starter returns 403", async () => {
      const res = await request(harness.app)
        .post("/api/admin/pitch/brand-kits/starter-modern-minimal/logo")
        .attach("logo", PNG_BYTES, {
          filename: "logo.png",
          contentType: "image/png",
        });
      expect(res.status).toBe(403);
    });

    it("POST /brand-kits/:id/logo returns 404 for unknown kit", async () => {
      const res = await request(harness.app)
        .post("/api/admin/pitch/brand-kits/no-such/logo")
        .attach("logo", PNG_BYTES, {
          filename: "logo.png",
          contentType: "image/png",
        });
      expect(res.status).toBe(404);
    });

    it("POST /brand-kits/:id/logo returns 400 when no file is attached", async () => {
      const id = createCustomKit(harness);
      const res = await request(harness.app).post(
        `/api/admin/pitch/brand-kits/${id}/logo`,
      );
      expect(res.status).toBe(400);
    });
  });

  // ── Additional branch-coverage tests ────────────────────────────────

  describe("branch coverage edge cases", () => {
    it("GET /decks falls back to defaults when limit/offset are NaN", async () => {
      const res = await request(harness.app).get(
        "/api/admin/pitch/decks?limit=abc&offset=xyz",
      );
      expect(res.status).toBe(200);
      expect(res.body.pagination).toEqual({ total: 0, limit: 50, offset: 0 });
    });

    it("PATCH /decks/:deckId accepts metadata + aspect_ratio updates", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app)
        .patch(`/api/admin/pitch/decks/${deckId}`)
        .send({
          aspect_ratio: "4:3",
          metadata: {
            source_script: "fresh",
            tone: "casual",
            audience: "founders",
            estimated_minutes: 5,
          },
        });
      expect(res.status).toBe(200);
      expect(res.body.deck.aspect_ratio).toBe("4:3");
      expect(res.body.deck.metadata.tone).toBe("casual");
    });

    it("PATCH /decks/:deckId returns 404 when deck does not exist", async () => {
      const res = await request(harness.app)
        .patch("/api/admin/pitch/decks/no-such-deck")
        .send({ title: "X" });
      expect(res.status).toBe(404);
    });

    it("PUT .../move returns 404 when deck has no slides", async () => {
      const res = await request(harness.app)
        .put("/api/admin/pitch/decks/no-deck/slides/no-slide/move")
        .send({ position: 0 });
      expect(res.status).toBe(404);
    });

    it("PUT .../move returns 404 when slide is not in deck", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app)
        .put(`/api/admin/pitch/decks/${deckId}/slides/wrong-slide/move`)
        .send({ position: 0 });
      expect(res.status).toBe(404);
    });

    it("PUT .../move returns ok with no changes when target == current position", async () => {
      const kitId = createCustomKit(harness);
      const { deckId, slideId } = createDeck(harness, kitId);
      const res = await request(harness.app)
        .put(`/api/admin/pitch/decks/${deckId}/slides/${slideId}/move`)
        .send({ position: 0 });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("DELETE slide returns 404 when slide belongs to a different deck", async () => {
      const kitId = createCustomKit(harness);
      const { slideId } = createDeck(harness, kitId, "Other");
      const res = await request(harness.app).delete(
        `/api/admin/pitch/decks/wrong-deck/slides/${slideId}`,
      );
      expect(res.status).toBe(404);
    });

    it("POST .../enhance returns 404 when deck does not exist", async () => {
      const res = await request(harness.app)
        .post("/api/admin/pitch/decks/missing/slides/missing/enhance")
        .send({});
      expect(res.status).toBe(404);
    });

    it("POST .../enhance returns 404 when slide does not exist in deck", async () => {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId);
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides/no-slide/enhance`)
        .send({});
      expect(res.status).toBe(404);
    });

    it("POST .../enhance returns 502 when generator throws", async () => {
      const kitId = createCustomKit(harness);
      const { deckId, slideId } = createDeck(harness, kitId);
      regenerateSlideMock.mockRejectedValue(new Error("LLM offline"));
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides/${slideId}/enhance`)
        .send({});
      expect(res.status).toBe(502);
    });

    it("POST .../enhance uses default polish hint when no instruction given", async () => {
      const kitId = createCustomKit(harness);
      const { deckId, slideId } = createDeck(harness, kitId);
      regenerateSlideMock.mockResolvedValue(buildSampleSlide());
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides/${slideId}/enhance`)
        .send({});
      expect(res.status).toBe(200);
      const call = regenerateSlideMock.mock.calls[0][0] as { hint: string };
      expect(call.hint).toMatch(/Polish & enhance/i);
    });

    it("POST .../image returns 404 when slide does not exist", async () => {
      const res = await request(harness.app)
        .post("/api/admin/pitch/decks/no-deck/slides/no-slide/image")
        .send({ prompt: "hi there", mode: "inline" });
      expect(res.status).toBe(404);
    });

    it("POST .../image without LoRA trigger uses raw prompt", async () => {
      const kitId = createCustomKit(harness);
      const { deckId, slideId } = createDeck(harness, kitId);
      enqueueSlideImageMock.mockReturnValue({
        jobId: "j",
        assetId: "a",
        payload: {},
      });
      await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides/${slideId}/image`)
        .send({ prompt: "raw prompt", mode: "inline" });
      const args = enqueueSlideImageMock.mock.calls[0][0] as { prompt: string };
      expect(args.prompt).toBe("raw prompt");
    });

    it("POST .../image returns 400 when enqueue throws", async () => {
      const kitId = createCustomKit(harness);
      const { deckId, slideId } = createDeck(harness, kitId);
      enqueueSlideImageMock.mockImplementation(() => {
        throw new Error("queue full");
      });
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides/${slideId}/image`)
        .send({ prompt: "valid prompt", mode: "inline" });
      expect(res.status).toBe(400);
    });

    it("POST .../regenerate returns 500 when submit throws", async () => {
      const kitId = createCustomKit(harness);
      const { deckId, slideId } = createDeck(harness, kitId);
      submitSlideRegenerateTaskMock.mockImplementation(() => {
        throw new Error("queue down");
      });
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides/${slideId}/regenerate`)
        .send({});
      expect(res.status).toBe(500);
    });

    it("POST /brand-kits returns 409 on UNIQUE name collision", async () => {
      await request(harness.app)
        .post("/api/admin/pitch/brand-kits")
        .send({ name: "Dup Kit", primaryColor: "#aabbcc" });
      const res = await request(harness.app)
        .post("/api/admin/pitch/brand-kits")
        .send({ name: "Dup Kit", primaryColor: "#aabbcc" });
      expect(res.status).toBe(409);
    });

    it("GET /brand-kits/:id returns 404 for unknown kit", async () => {
      const res = await request(harness.app).get(
        "/api/admin/pitch/brand-kits/missing",
      );
      expect(res.status).toBe(404);
    });

    it("PATCH /brand-kits/:id returns 404 for unknown custom kit", async () => {
      const res = await request(harness.app)
        .patch("/api/admin/pitch/brand-kits/missing")
        .send({ name: "X" });
      expect(res.status).toBe(404);
    });

    it("DELETE /brand-kits/:id returns 404 for unknown kit", async () => {
      const res = await request(harness.app).delete(
        "/api/admin/pitch/brand-kits/missing",
      );
      expect(res.status).toBe(404);
    });
  });

  // ── Logo content-sniffing + sharp re-encode (PR #980 review) ────────

  describe("logo content sniffing + re-encode", () => {
    // Real PNG bytes from sharp — for the "lying jpeg" mismatch test we need
    // sharp's `metadata()` to actually identify the bytes as PNG.
    let PNG_BYTES: Buffer;
    beforeAll(async () => {
      PNG_BYTES = await sharp({
        create: {
          width: 1,
          height: 1,
          channels: 4,
          background: { r: 0, g: 0, b: 255, alpha: 1 },
        },
      })
        .png()
        .toBuffer();
    });

    it("rejects non-image bytes labelled image/png (sniff mismatch)", async () => {
      const id = createCustomKit(harness);
      // Shell-script bytes claiming to be a PNG. `sharp` will fail to decode
      // these and the route must reject before anything is written to disk.
      const evil = Buffer.from("#!/bin/sh\nrm -rf /\n", "utf8");
      const res = await request(harness.app)
        .post(`/api/admin/pitch/brand-kits/${id}/logo`)
        .attach("logo", evil, {
          filename: "evil.png",
          contentType: "image/png",
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
      const kit = harness.deps.brandKitRepo.getById(id);
      expect(kit?.logoPath).toBeNull();
    });

    it("rejects mismatched format (PNG bytes labelled image/jpeg)", async () => {
      const id = createCustomKit(harness);
      const res = await request(harness.app)
        .post(`/api/admin/pitch/brand-kits/${id}/logo`)
        .attach("logo", PNG_BYTES, {
          filename: "lying.jpg",
          contentType: "image/jpeg",
        });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/does not match claimed MIME/i);
    });

    it("rejects SVG uploads outright (stored-XSS sink)", async () => {
      const id = createCustomKit(harness);
      const svgXss = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        "utf8",
      );
      const res = await request(harness.app)
        .post(`/api/admin/pitch/brand-kits/${id}/logo`)
        .attach("logo", svgXss, {
          filename: "evil.svg",
          contentType: "image/svg+xml",
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
      expect(res.body.error.details?.allowed).not.toContain("image/svg+xml");
    });

    it("rejects GIF uploads (no longer in allow-list)", async () => {
      const id = createCustomKit(harness);
      const gif = Buffer.concat([
        Buffer.from("GIF87a", "ascii"),
        Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]),
      ]);
      const res = await request(harness.app)
        .post(`/api/admin/pitch/brand-kits/${id}/logo`)
        .attach("logo", gif, {
          filename: "anim.gif",
          contentType: "image/gif",
        });
      expect(res.status).toBe(400);
    });
  });

  // ── Audit logging + Socket.IO emits (PR #980 review) ────────────────

  describe("audit + Socket.IO wiring", () => {
    interface MockedHarness extends TestHarness {
      auditLog: ReturnType<typeof vi.fn>;
      ioEmit: ReturnType<typeof vi.fn>;
    }

    function buildMockedHarness(): MockedHarness {
      const base = buildHarness();
      const auditLog = vi.fn().mockResolvedValue(undefined);
      const ioEmit = vi.fn();
      const auditLogger = { log: auditLog } as unknown as PitchRouterDeps["auditLogger"];
      const io = { emit: ioEmit } as unknown as PitchRouterDeps["io"];
      const newDeps: PitchRouterDeps = {
        ...base.deps,
        auditLogger,
        io,
      };
      const app2 = express();
      app2.use(express.json());
      app2.use("/api/admin/pitch", createPitchRouter(newDeps));
      return {
        ...base,
        app: app2,
        deps: newDeps,
        auditLog,
        ioEmit,
      };
    }

    let h: MockedHarness;
    beforeEach(() => {
      h = buildMockedHarness();
    });
    afterEach(() => {
      h.cleanup();
    });

    it("emits pitch:deck:created + audit on POST /decks", async () => {
      const kitId = createCustomKit(h);
      const res = await request(h.app)
        .post("/api/admin/pitch/decks")
        .send({ title: "Em Deck", brand_kit_id: kitId });
      expect(res.status).toBe(201);
      expect(h.ioEmit).toHaveBeenCalledWith(
        "pitch:deck:created",
        expect.objectContaining({ deckId: expect.any(String) }),
      );
      expect(h.auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "system",
          event: "pitch_deck_created",
        }),
      );
    });

    it("emits pitch:deck:updated on PATCH /decks/:id", async () => {
      const kitId = createCustomKit(h);
      const { deckId } = createDeck(h, kitId);
      h.ioEmit.mockClear();
      h.auditLog.mockClear();
      const res = await request(h.app)
        .patch(`/api/admin/pitch/decks/${deckId}`)
        .send({ title: "renamed" });
      expect(res.status).toBe(200);
      expect(h.ioEmit).toHaveBeenCalledWith(
        "pitch:deck:updated",
        expect.objectContaining({ deckId }),
      );
      expect(h.auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "system",
          event: "pitch_deck_updated",
        }),
      );
    });

    it("emits pitch:deck:deleted on DELETE /decks/:id", async () => {
      const kitId = createCustomKit(h);
      const { deckId } = createDeck(h, kitId);
      h.ioEmit.mockClear();
      h.auditLog.mockClear();
      const res = await request(h.app).delete(
        `/api/admin/pitch/decks/${deckId}`,
      );
      expect(res.status).toBe(200);
      expect(h.ioEmit).toHaveBeenCalledWith(
        "pitch:deck:deleted",
        expect.objectContaining({ deckId }),
      );
      expect(h.auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ event: "pitch_deck_deleted" }),
      );
    });

    it("emits pitch:slide:created/updated/moved/deleted across slide CRUD", async () => {
      const kitId = createCustomKit(h);
      const { deckId, slideId } = createDeck(h, kitId);
      const secondSlide = SlideSchema.parse({
        template: "title",
        content: { title: "Second" },
        speaker_notes: "",
        transition: "slide",
        fragments: [],
      });
      const created = await request(h.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides`)
        .send({ slide: secondSlide });
      expect(created.status).toBe(201);
      expect(h.ioEmit).toHaveBeenCalledWith(
        "pitch:slide:created",
        expect.objectContaining({ deckId }),
      );

      const newId = created.body.slide.id;
      h.ioEmit.mockClear();

      const moved = await request(h.app)
        .put(`/api/admin/pitch/decks/${deckId}/slides/${newId}/move`)
        .send({ position: 0 });
      expect(moved.status).toBe(200);
      expect(h.ioEmit).toHaveBeenCalledWith(
        "pitch:slide:moved",
        expect.objectContaining({ deckId, slideId: newId }),
      );

      h.ioEmit.mockClear();
      const patched = await request(h.app)
        .patch(`/api/admin/pitch/decks/${deckId}/slides/${slideId}`)
        .send({ slide: secondSlide });
      expect(patched.status).toBe(200);
      expect(h.ioEmit).toHaveBeenCalledWith(
        "pitch:slide:updated",
        expect.objectContaining({ deckId, slideId }),
      );

      h.ioEmit.mockClear();
      const deleted = await request(h.app).delete(
        `/api/admin/pitch/decks/${deckId}/slides/${slideId}`,
      );
      expect(deleted.status).toBe(200);
      expect(h.ioEmit).toHaveBeenCalledWith(
        "pitch:slide:deleted",
        expect.objectContaining({ deckId, slideId }),
      );
    });

    it("emits pitch:brand-kit:created/updated/deleted across brand-kit CRUD", async () => {
      const create = await request(h.app)
        .post("/api/admin/pitch/brand-kits")
        .send({ name: "Auditable Kit" });
      expect(create.status).toBe(201);
      const id = create.body.brandKit.id;
      expect(h.ioEmit).toHaveBeenCalledWith(
        "pitch:brand-kit:created",
        expect.objectContaining({ brandKitId: id }),
      );

      h.ioEmit.mockClear();
      const patch = await request(h.app)
        .patch(`/api/admin/pitch/brand-kits/${id}`)
        .send({ name: "Renamed Kit" });
      expect(patch.status).toBe(200);
      expect(h.ioEmit).toHaveBeenCalledWith(
        "pitch:brand-kit:updated",
        expect.objectContaining({ brandKitId: id }),
      );

      h.ioEmit.mockClear();
      const del = await request(h.app).delete(
        `/api/admin/pitch/brand-kits/${id}`,
      );
      expect(del.status).toBe(200);
      expect(h.ioEmit).toHaveBeenCalledWith(
        "pitch:brand-kit:deleted",
        expect.objectContaining({ brandKitId: id }),
      );
    });

    it("emits pitch:slide:regenerate-queued (#962)", async () => {
      const kitId = createCustomKit(h);
      const { deckId, slideId } = createDeck(h, kitId);
      submitSlideRegenerateTaskMock.mockReturnValue({ task: { id: "task-77" } });
      h.ioEmit.mockClear();
      const res = await request(h.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides/${slideId}/regenerate`)
        .send({});
      expect(res.status).toBe(202);
      expect(h.ioEmit).toHaveBeenCalledWith(
        "pitch:slide:regenerate-queued",
        expect.objectContaining({ taskId: "task-77" }),
      );
      expect(h.auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "tool",
          event: "pitch_slide_regenerate_queued",
        }),
      );
    });

    it("emits pitch:image:queued for the image enqueue route (#962)", async () => {
      const kitId = createCustomKit(h);
      const { deckId, slideId } = createDeck(h, kitId);
      enqueueSlideImageMock.mockReturnValue({
        jobId: "job-1",
        assetId: "asset-1",
      });
      h.ioEmit.mockClear();
      const res = await request(h.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides/${slideId}/image`)
        .send({ prompt: "a cat sitting", mode: "background" });
      expect(res.status).toBe(202);
      expect(h.ioEmit).toHaveBeenCalledWith(
        "pitch:image:queued",
        expect.objectContaining({ jobId: "job-1", assetId: "asset-1" }),
      );
      expect(h.auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "tool",
          event: "pitch_image_queued",
        }),
      );
    });

    it("emits pitch:draft:started + pitch:deck:created for /decks/draft (#962)", async () => {
      const kitId = createCustomKit(h);
      generateDeckMock.mockResolvedValue({
        title: "Generated",
        aspect_ratio: "16:9",
        metadata: { source_script: "...", tone: "formal" },
        slides: [
          SlideSchema.parse({
            template: "title",
            content: { title: "Hi" },
            speaker_notes: "",
            transition: "slide",
            fragments: [],
          }),
        ],
      });
      h.ioEmit.mockClear();
      const res = await request(h.app)
        .post("/api/admin/pitch/decks/draft")
        .send({ script: "the story", brandKitId: kitId });
      expect(res.status).toBe(201);
      const events = h.ioEmit.mock.calls.map((c) => c[0]);
      expect(events).toContain("pitch:draft:started");
      expect(events).toContain("pitch:deck:created");
    });

    it("audit logs a security event when logo upload is rejected", async () => {
      const id = createCustomKit(h);
      h.auditLog.mockClear();
      const res = await request(h.app)
        .post(`/api/admin/pitch/brand-kits/${id}/logo`)
        .attach("logo", Buffer.from("x"), {
          filename: "x.bin",
          contentType: "application/octet-stream",
        });
      expect(res.status).toBe(400);
      expect(h.auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "security",
          event: "pitch_logo_upload_rejected",
          level: "warn",
        }),
      );
    });

    it("audit logs a security event when starter brand-kit mutation is blocked", async () => {
      h.auditLog.mockClear();
      const res = await request(h.app)
        .patch("/api/admin/pitch/brand-kits/starter-modern-minimal")
        .send({ name: "no" });
      expect(res.status).toBe(403);
      expect(h.auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "security",
          event: "pitch_brand_kit_mutation_blocked",
        }),
      );
    });

    // Sub-issue #1039 / Epic #1035 AC5 — when an asset row exists but
    // its `local_path` is missing on disk (workspace migration, manual
    // cleanup, half-failed flux job), the 404 response must be paired
    // with a structured `pitch.route_failed` audit entry so SREs can
    // diagnose the gap instead of guessing from a silent client error.
    it("audit logs pitch.route_failed when an asset file is missing on disk", async () => {
      // The default test harness routes asset paths through the user's
      // real `~/.openzigs/pitch/assets` dir, so a phantom file in
      // `tmpdir()` would trigger the path-traversal guard *before* the
      // missing-file branch we're trying to exercise. Build a scoped
      // router whose `assetsBaseDir` matches the phantom file's parent.
      const isolatedAssetsDir = mkdtempSync(join(tmpdir(), "pitch-audit-"));
      try {
        const scopedAuditLog = vi.fn().mockResolvedValue(undefined);
        const scopedDeps: PitchRouterDeps = {
          ...h.deps,
          assetsBaseDir: isolatedAssetsDir,
          auditLogger: {
            log: scopedAuditLog,
          } as unknown as PitchRouterDeps["auditLogger"],
        };
        const scopedApp = express();
        scopedApp.use(express.json());
        scopedApp.use("/api/admin/pitch", createPitchRouter(scopedDeps));

        const kitId = createCustomKit(h);
        const { deckId, slideId } = createDeck(h, kitId);
        const phantom = join(isolatedAssetsDir, "asset-phantom-audit.png");
        // intentionally do NOT write the file
        h.deps.pitchRepo.insertAsset({
          id: "asset-phantom-audit",
          deck_id: deckId,
          slide_id: slideId,
          kind: "background",
          source: "fluxq",
          prompt: null,
          local_path: phantom,
          mime: "image/png",
          width: 16,
          height: 16,
          created_at: FROZEN().toISOString(),
        });
        scopedAuditLog.mockClear();
        const res = await request(scopedApp).get(
          `/api/admin/pitch/decks/${deckId}/assets/asset-phantom-audit`,
        );
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("not_found");
        expect(scopedAuditLog).toHaveBeenCalledWith(
          expect.objectContaining({
            category: "system",
            event: "pitch.route_failed",
            level: "warn",
            details: expect.objectContaining({
              method: "GET",
              status: 404,
              cause: "asset file missing",
              deckId,
              assetId: "asset-phantom-audit",
              kind: "background",
              localPath: phantom,
            }),
          }),
        );
      } finally {
        try {
          rmSync(isolatedAssetsDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    });
  });

  // ── Repo-side EXISTS check for brand-kit deletion (PR #980 review) ──

  describe("brand-kit delete uses SQL EXISTS path", () => {
    it("findFirstDeckIdByBrandKit returns referencing deck id (or null)", () => {
      const kitId = createCustomKit(harness);
      expect(harness.deps.pitchRepo.findFirstDeckIdByBrandKit(kitId)).toBeNull();
      const { deckId } = createDeck(harness, kitId);
      expect(harness.deps.pitchRepo.findFirstDeckIdByBrandKit(kitId)).toBe(deckId);
      expect(
        harness.deps.pitchRepo.findFirstDeckIdByBrandKit("non-existent"),
      ).toBeNull();
    });

    it("DELETE /brand-kits/:id consults the EXISTS query (no full scan)", async () => {
      const kitId = createCustomKit(harness);
      createDeck(harness, kitId);
      const spy = vi.spyOn(harness.deps.pitchRepo, "findFirstDeckIdByBrandKit");
      const listSpy = vi.spyOn(harness.deps.pitchRepo, "listDecks");
      const res = await request(harness.app).delete(
        `/api/admin/pitch/brand-kits/${kitId}`,
      );
      expect(res.status).toBe(409);
      expect(spy).toHaveBeenCalledWith(kitId);
      expect(listSpy).not.toHaveBeenCalled();
    });
  });

  // ── Phase 6 — Export endpoints (#972 #973 #974) ─────────────────────

  describe("export endpoints (Phase 6)", () => {
    function buildExportHarness() {
      const pdf = vi.fn().mockResolvedValue({
        buffer: Buffer.from("%PDF-1.4 stub"),
        filename: "ignored.pdf",
        contentType: "application/pdf",
      });
      const pptx = vi.fn().mockResolvedValue({
        buffer: Buffer.from("PK\x03\x04 pptx"),
        filename: "ignored.pptx",
        contentType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      });
      const zip = vi.fn().mockResolvedValue({
        buffer: Buffer.from("PK\x03\x04 zip"),
        filename: "ignored.zip",
        contentType: "application/zip",
      });
      const md = vi.fn().mockReturnValue({
        buffer: Buffer.from("# md"),
        filename: "ignored.md",
        contentType: "text/markdown; charset=utf-8",
      });
      const notes = vi.fn().mockResolvedValue({
        buffer: Buffer.from("%PDF-1.4 notes"),
        filename: "ignored-notes.pdf",
        contentType: "application/pdf",
      });

      const exporters = { pdf, pptx, zip, md, notes };
      const newDeps: PitchRouterDeps = { ...harness.deps, exporters };
      const app = express();
      app.use(express.json());
      app.use("/api/admin/pitch", createPitchRouter(newDeps));
      return { app, exporters };
    }

    async function setupDeck(): Promise<string> {
      const kitId = createCustomKit(harness);
      const { deckId } = createDeck(harness, kitId, "Export Demo");
      return deckId;
    }

    it("GET export.md returns markdown with sanitized filename", async () => {
      const deckId = await setupDeck();
      const { app, exporters } = buildExportHarness();
      const res = await request(app).get(`/api/admin/pitch/decks/${deckId}/export.md`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/markdown");
      expect(res.headers["content-disposition"]).toBe(
        'attachment; filename="Export_Demo.md"',
      );
      expect(exporters.md).toHaveBeenCalledOnce();
    });

    it("GET export.zip streams a zip buffer", async () => {
      const deckId = await setupDeck();
      const { app, exporters } = buildExportHarness();
      const res = await request(app).get(`/api/admin/pitch/decks/${deckId}/export.zip`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/zip");
      expect(res.headers["content-disposition"]).toBe(
        'attachment; filename="Export_Demo.zip"',
      );
      expect(exporters.zip).toHaveBeenCalledOnce();
    });

    it("GET export.pptx streams a pptx buffer", async () => {
      const deckId = await setupDeck();
      const { app, exporters } = buildExportHarness();
      const res = await request(app).get(`/api/admin/pitch/decks/${deckId}/export.pptx`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("presentationml");
      expect(exporters.pptx).toHaveBeenCalledOnce();
    });

    it("GET export.pdf streams a pdf buffer", async () => {
      const deckId = await setupDeck();
      const { app, exporters } = buildExportHarness();
      const res = await request(app).get(`/api/admin/pitch/decks/${deckId}/export.pdf`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      expect(exporters.pdf).toHaveBeenCalledOnce();
    });

    it("GET export.notes.pdf streams a notes pdf buffer with -notes suffix", async () => {
      const deckId = await setupDeck();
      const { app, exporters } = buildExportHarness();
      const res = await request(app).get(
        `/api/admin/pitch/decks/${deckId}/export.notes.pdf`,
      );
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      expect(res.headers["content-disposition"]).toBe(
        'attachment; filename="Export_Demo-notes.pdf"',
      );
      expect(exporters.notes).toHaveBeenCalledOnce();
    });

    it("GET export.html returns standalone HTML", async () => {
      const deckId = await setupDeck();
      const { app } = buildExportHarness();
      const res = await request(app).get(`/api/admin/pitch/decks/${deckId}/export.html`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.text).toContain("<!doctype html>");
    });

    it("returns 404 for unknown deck on every export route", async () => {
      const { app } = buildExportHarness();
      for (const ext of ["pdf", "pptx", "zip", "md", "notes.pdf", "html"]) {
        const res = await request(app).get(`/api/admin/pitch/decks/missing/export.${ext}`);
        expect(res.status, `ext=${ext}`).toBe(404);
      }
    });

    it("returns 500 with generic message when an exporter throws", async () => {
      const deckId = await setupDeck();
      const exporters = {
        pdf: vi.fn().mockRejectedValue(new Error("decktape exited 1")),
        pptx: vi.fn().mockRejectedValue(new Error("pptxgen blew up")),
        zip: vi.fn().mockRejectedValue(new Error("archiver fail")),
        md: vi.fn().mockImplementation(() => {
          throw new Error("md fail");
        }),
        notes: vi.fn().mockRejectedValue(new Error("notes fail")),
      };
      const newDeps: PitchRouterDeps = { ...harness.deps, exporters };
      const app = express();
      app.use(express.json());
      app.use("/api/admin/pitch", createPitchRouter(newDeps));

      for (const ext of ["pdf", "pptx", "zip", "md", "notes.pdf"]) {
        const res = await request(app).get(`/api/admin/pitch/decks/${deckId}/export.${ext}`);
        expect(res.status, `ext=${ext}`).toBe(500);
        // Generic — never leak the underlying message.
        expect(res.body.error.message, `ext=${ext}`).not.toMatch(/decktape|pptxgen|archiver/);
      }
    });

    it("returns 503 pdf_export_unavailable when decktape spawn fails (ENOENT)", async () => {
      const deckId = await setupDeck();
      // Mimic what `child_process.spawn` rejects with when the binary is
      // missing — message includes 'spawn decktape ENOENT' AND `code` is
      // set to 'ENOENT'. Either signal alone is sufficient for the
      // detection helper; we set both to prove the contract.
      const enoentErr = Object.assign(new Error("spawn decktape ENOENT"), {
        code: "ENOENT",
      });
      const exporters = {
        pdf: vi.fn().mockRejectedValue(enoentErr),
        pptx: vi.fn(),
        zip: vi.fn(),
        md: vi.fn(),
        notes: vi.fn().mockRejectedValue(enoentErr),
      };
      const newDeps: PitchRouterDeps = { ...harness.deps, exporters };
      const app = express();
      app.use(express.json());
      app.use("/api/admin/pitch", createPitchRouter(newDeps));

      const pdfRes = await request(app).get(
        `/api/admin/pitch/decks/${deckId}/export.pdf`,
      );
      expect(pdfRes.status).toBe(503);
      expect(pdfRes.body.error.code).toBe("pdf_export_unavailable");
      expect(pdfRes.body.error.message).toMatch(/decktape/i);

      const notesRes = await request(app).get(
        `/api/admin/pitch/decks/${deckId}/export.notes.pdf`,
      );
      expect(notesRes.status).toBe(503);
      expect(notesRes.body.error.code).toBe("pdf_export_unavailable");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Sub-issue #992 — asset-serve endpoint
  // ─────────────────────────────────────────────────────────────────
  describe("asset-serve endpoint (#992)", () => {
    let assetsBaseDir: string;
    let app: Express;
    let deckId: string;
    let slideId: string;

    beforeEach(() => {
      assetsBaseDir = mkdtempSync(join(tmpdir(), "pitch-assets-"));
      const newDeps: PitchRouterDeps = { ...harness.deps, assetsBaseDir };
      app = express();
      app.use(express.json());
      app.use("/api/admin/pitch", createPitchRouter(newDeps));
      const kitId = createCustomKit(harness, "asset bg kit");
      const ids = createDeck(harness, kitId, "Asset Deck");
      deckId = ids.deckId;
      slideId = ids.slideId;
    });

    afterEach(() => {
      try {
        rmSync(assetsBaseDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });

    function writeAsset(opts: {
      assetId: string;
      slideId: string | null;
      kind: "background" | "image";
      created_at?: string;
      bytes?: Buffer;
      relativePath?: string;
    }): string {
      const bytes = opts.bytes ?? Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const rel =
        opts.relativePath ?? `${deckId}/${opts.assetId}.png`;
      const abs = join(assetsBaseDir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
      harness.deps.pitchRepo.insertAsset({
        id: opts.assetId,
        deck_id: deckId,
        slide_id: opts.slideId,
        kind: opts.kind,
        source: "fluxq",
        prompt: "test",
        local_path: abs,
        mime: "image/png",
        width: 16,
        height: 16,
        created_at: opts.created_at ?? "2026-04-25T00:00:00Z",
      });
      return abs;
    }

    it("serves the asset bytes with Content-Type and no-store cache", async () => {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      writeAsset({
        assetId: "asset-good",
        slideId,
        kind: "background",
        bytes,
      });

      const res = await request(app).get(
        `/api/admin/pitch/decks/${deckId}/assets/asset-good`,
      );
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/image\/png/);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(Buffer.from(res.body).equals(bytes)).toBe(true);
    });

    it("returns 404 when the asset id does not exist", async () => {
      const res = await request(app).get(
        `/api/admin/pitch/decks/${deckId}/assets/does-not-exist`,
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    });

    it("returns 404 when the asset belongs to a different deck", async () => {
      const otherKit = createCustomKit(harness, "other kit");
      const otherIds = createDeck(harness, otherKit, "Other Deck");
      writeAsset({
        assetId: "asset-other",
        slideId: otherIds.slideId,
        kind: "background",
      });
      // The repo row was created with deck_id=this.deckId (writeAsset hard-codes it),
      // so to actually exercise the cross-deck guard we directly insert into the
      // OTHER deck and try to fetch it via THIS deck's URL.
      const otherAbs = join(assetsBaseDir, `${otherIds.deckId}-cross.png`);
      writeFileSync(otherAbs, Buffer.from([1, 2, 3]));
      harness.deps.pitchRepo.insertAsset({
        id: "asset-cross-deck",
        deck_id: otherIds.deckId,
        slide_id: otherIds.slideId,
        kind: "background",
        source: "fluxq",
        prompt: null,
        local_path: otherAbs,
        mime: "image/png",
        width: 16,
        height: 16,
        created_at: "2026-04-25T00:00:00Z",
      });
      const res = await request(app).get(
        `/api/admin/pitch/decks/${deckId}/assets/asset-cross-deck`,
      );
      expect(res.status).toBe(404);
    });

    it("returns 404 when the asset's local_path escapes assetsBaseDir", async () => {
      const escape = mkdtempSync(join(tmpdir(), "pitch-escape-"));
      const escAbs = join(escape, "evil.png");
      writeFileSync(escAbs, Buffer.from([9, 9, 9]));
      harness.deps.pitchRepo.insertAsset({
        id: "asset-escape",
        deck_id: deckId,
        slide_id: slideId,
        kind: "background",
        source: "fluxq",
        prompt: null,
        local_path: escAbs,
        mime: "image/png",
        width: 16,
        height: 16,
        created_at: "2026-04-25T00:00:00Z",
      });
      const res = await request(app).get(
        `/api/admin/pitch/decks/${deckId}/assets/asset-escape`,
      );
      expect(res.status).toBe(404);
      try {
        rmSync(escape, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });

    it("returns 404 when the file on disk is missing even though the row exists", async () => {
      const phantom = join(assetsBaseDir, `${deckId}/asset-phantom.png`);
      // intentionally do NOT write the file
      harness.deps.pitchRepo.insertAsset({
        id: "asset-phantom",
        deck_id: deckId,
        slide_id: slideId,
        kind: "background",
        source: "fluxq",
        prompt: null,
        local_path: phantom,
        mime: "image/png",
        width: 16,
        height: 16,
        created_at: "2026-04-25T00:00:00Z",
      });
      const res = await request(app).get(
        `/api/admin/pitch/decks/${deckId}/assets/asset-phantom`,
      );
      expect(res.status).toBe(404);
    });

    it("the /render endpoint emits data-background-image referencing the asset URL", async () => {
      writeAsset({
        assetId: "asset-bg-render",
        slideId,
        kind: "background",
      });
      const res = await request(app).get(
        `/api/admin/pitch/decks/${deckId}/render`,
      );
      expect(res.status).toBe(200);
      expect(res.text).toContain(
        `data-background-image="/api/admin/pitch/decks/${deckId}/assets/asset-bg-render"`,
      );
    });

    it("the /render endpoint picks the most-recent background per slide", async () => {
      writeAsset({
        assetId: "asset-old",
        slideId,
        kind: "background",
        created_at: "2026-04-01T00:00:00Z",
      });
      writeAsset({
        assetId: "asset-new",
        slideId,
        kind: "background",
        created_at: "2026-04-25T00:00:00Z",
      });
      const res = await request(app).get(
        `/api/admin/pitch/decks/${deckId}/render`,
      );
      expect(res.status).toBe(200);
      expect(res.text).toContain("asset-new");
      expect(res.text).not.toContain("asset-old");
    });

    // ── Pitch Present iframe asset-auth (background images) ──────────
    //
    // The Present route mounts /render?mode=present in a sandboxed iframe;
    // <img>/data-background-image cannot send Authorization headers, so
    // the asset URLs MUST carry ?token=<bearer> to clear the auth
    // middleware allowlist.

    it("/render?mode=present appends ?token= to background URLs when authed via Bearer", async () => {
      writeAsset({
        assetId: "asset-bg-present",
        slideId,
        kind: "background",
      });
      const res = await request(app)
        .get(`/api/admin/pitch/decks/${deckId}/render?mode=present`)
        .set("Authorization", "Bearer secret-bearer-1");
      expect(res.status).toBe(200);
      expect(res.text).toContain(
        `data-background-image="/api/admin/pitch/decks/${deckId}/assets/asset-bg-present?token=${encodeURIComponent("secret-bearer-1")}"`,
      );
    });

    it("/render?mode=present accepts ?token= query auth and propagates it to background URLs", async () => {
      writeAsset({
        assetId: "asset-bg-q",
        slideId,
        kind: "background",
      });
      const queryToken = "shared-link-token";
      const res = await request(app).get(
        `/api/admin/pitch/decks/${deckId}/render?mode=present&token=${encodeURIComponent(queryToken)}`,
      );
      expect(res.status).toBe(200);
      expect(res.text).toContain(
        `data-background-image="/api/admin/pitch/decks/${deckId}/assets/asset-bg-q?token=${encodeURIComponent(queryToken)}"`,
      );
    });

    it("/render?mode=embedded also tokenizes background URLs (editor preview iframe)", async () => {
      writeAsset({
        assetId: "asset-bg-emb",
        slideId,
        kind: "background",
      });
      const res = await request(app)
        .get(`/api/admin/pitch/decks/${deckId}/render?mode=embedded`)
        .set("Authorization", "Bearer emb-token");
      expect(res.status).toBe(200);
      expect(res.text).toContain(
        `data-background-image="/api/admin/pitch/decks/${deckId}/assets/asset-bg-emb?token=emb-token"`,
      );
    });

    it("/render does NOT append ?token= when the request was unauthenticated", async () => {
      writeAsset({
        assetId: "asset-bg-noauth",
        slideId,
        kind: "background",
      });
      const res = await request(app).get(
        `/api/admin/pitch/decks/${deckId}/render?mode=present`,
      );
      expect(res.status).toBe(200);
      expect(res.text).toContain(
        `data-background-image="/api/admin/pitch/decks/${deckId}/assets/asset-bg-noauth"`,
      );
      // Critical: never emit a literal `?token=` (would be empty/broken).
      expect(res.text).not.toContain("?token=");
    });

    it("/render tokenizes inline image URLs that point at the local asset route, but NOT third-party https URLs", async () => {
      // Build a deck with a bullet-list slide whose `image.url` points at
      // a local asset, plus a two-column slide whose `right_image.url`
      // points at a third-party CDN. Only the local URL should be
      // tokenized; the CDN URL must be left alone (would leak the bearer).
      const kitId = createCustomKit(harness, "inline-image kit");
      const localAssetUrl = `/api/admin/pitch/decks/inline-deck/assets/asset-inline-1`;
      const cdnUrl = "https://cdn.example.com/external.png";
      const inlineDeck = harness.deps.pitchRepo.insertDeck({
        id: "inline-deck",
        title: "Inline Deck",
        brand_kit_id: kitId,
        aspect_ratio: "16:9",
        metadata: { source_script: "", tone: "formal" },
        slides: [
          {
            id: "inline-s1",
            slide: SlideSchema.parse({
              template: "bullet_list",
              content: {
                heading: "Local",
                bullets: ["b1"],
                image: { prompt: "local image", url: localAssetUrl, alt: "alt" },
              },
              speaker_notes: "",
              transition: "slide",
              fragments: [],
            }),
          },
          {
            id: "inline-s2",
            slide: SlideSchema.parse({
              template: "two_column",
              content: {
                heading: "Mixed",
                left: "L",
                right: "R",
                right_image: { prompt: "cdn image", url: cdnUrl, alt: "cdn" },
              },
              speaker_notes: "",
              transition: "slide",
              fragments: [],
            }),
          },
        ],
      });
      const res = await request(app)
        .get(`/api/admin/pitch/decks/${inlineDeck.id}/render?mode=present`)
        .set("Authorization", "Bearer inline-token");
      expect(res.status).toBe(200);
      // Local asset URL: tokenized.
      expect(res.text).toContain(
        `${localAssetUrl}?token=inline-token`,
      );
      // CDN URL: untouched.
      expect(res.text).toContain(`src="${cdnUrl}"`);
      expect(res.text).not.toContain(`${cdnUrl}?token=`);
      expect(res.text).not.toContain(`${cdnUrl}&token=`);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // appendTokenToAssetUrl — direct unit tests (PR #1041 follow-up)
  // ─────────────────────────────────────────────────────────────────
  describe("appendTokenToAssetUrl (direct)", () => {
    it("appends ?token=<encoded> to a matching pitch asset path with no query string", async () => {
      const { appendTokenToAssetUrl } = await import("./pitch.js");
      const url = "/api/admin/pitch/decks/deck-abc/assets/asset-xyz";
      expect(appendTokenToAssetUrl(url, "tok 1+&")).toBe(
        `${url}?token=${encodeURIComponent("tok 1+&")}`,
      );
    });

    it("preserves an existing query string and appends &token=<encoded>", async () => {
      const { appendTokenToAssetUrl } = await import("./pitch.js");
      const url = "/api/admin/pitch/decks/deck-abc/assets/asset-xyz?v=2";
      expect(appendTokenToAssetUrl(url, "abc")).toBe(
        "/api/admin/pitch/decks/deck-abc/assets/asset-xyz?v=2&token=abc",
      );
    });

    it("returns a non-matching URL unchanged (does NOT leak the token to third-party origins)", async () => {
      const { appendTokenToAssetUrl } = await import("./pitch.js");
      const url = "https://cdn.example.com/foo.png";
      expect(appendTokenToAssetUrl(url, "tok")).toBe(url);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Sub-issue #992 — buildBackgroundImageUrlMap pure-function tests
  // ─────────────────────────────────────────────────────────────────
  describe("buildBackgroundImageUrlMap (#992)", () => {
    it("returns an empty map when there are no assets", async () => {
      const { buildBackgroundImageUrlMap } = await import("./pitch.js");
      expect(
        buildBackgroundImageUrlMap("d", [{ id: "s1", position: 0 }], []).size,
      ).toBe(0);
    });

    it("ignores assets whose kind is not background", async () => {
      const { buildBackgroundImageUrlMap } = await import("./pitch.js");
      const map = buildBackgroundImageUrlMap(
        "d",
        [{ id: "s1", position: 0 }],
        [
          {
            id: "a1",
            slide_id: "s1",
            kind: "image",
            created_at: "2026-04-25T00:00:00Z",
          },
        ],
      );
      expect(map.size).toBe(0);
    });

    it("ignores assets whose slide_id is null or unknown", async () => {
      const { buildBackgroundImageUrlMap } = await import("./pitch.js");
      const map = buildBackgroundImageUrlMap(
        "d",
        [{ id: "s1", position: 0 }],
        [
          {
            id: "a1",
            slide_id: null,
            kind: "background",
            created_at: "2026-04-25T00:00:00Z",
          },
          {
            id: "a2",
            slide_id: "s-unknown",
            kind: "background",
            created_at: "2026-04-25T00:00:00Z",
          },
        ],
      );
      expect(map.size).toBe(0);
    });

    it("picks the latest background per slide and keys by position", async () => {
      const { buildBackgroundImageUrlMap } = await import("./pitch.js");
      const map = buildBackgroundImageUrlMap(
        "deck-7",
        [
          { id: "s-alpha", position: 0 },
          { id: "s-beta", position: 1 },
        ],
        [
          {
            id: "a-old",
            slide_id: "s-alpha",
            kind: "background",
            created_at: "2026-04-01T00:00:00Z",
          },
          {
            id: "a-new",
            slide_id: "s-alpha",
            kind: "background",
            created_at: "2026-04-25T00:00:00Z",
          },
          {
            id: "a-beta",
            slide_id: "s-beta",
            kind: "background",
            created_at: "2026-04-10T00:00:00Z",
          },
        ],
      );
      expect(map.get(0)).toBe(
        "/api/admin/pitch/decks/deck-7/assets/a-new",
      );
      expect(map.get(1)).toBe(
        "/api/admin/pitch/decks/deck-7/assets/a-beta",
      );
    });

    it("URL-encodes the deck and asset ids", async () => {
      const { buildBackgroundImageUrlMap } = await import("./pitch.js");
      const map = buildBackgroundImageUrlMap(
        "deck/with space",
        [{ id: "slide?", position: 0 }],
        [
          {
            id: "a&special",
            slide_id: "slide?",
            kind: "background",
            created_at: "2026-04-25T00:00:00Z",
          },
        ],
      );
      expect(map.get(0)).toBe(
        "/api/admin/pitch/decks/deck%2Fwith%20space/assets/a%26special",
      );
    });

    it("appends ?token=<encoded> when accessToken is supplied", async () => {
      const { buildBackgroundImageUrlMap } = await import("./pitch.js");
      const map = buildBackgroundImageUrlMap(
        "deck-1",
        [{ id: "s1", position: 0 }],
        [
          {
            id: "asset-1",
            slide_id: "s1",
            kind: "background",
            created_at: "2026-04-25T00:00:00Z",
          },
        ],
        "secret-token",
      );
      expect(map.get(0)).toBe(
        "/api/admin/pitch/decks/deck-1/assets/asset-1?token=secret-token",
      );
    });

    it("URL-encodes a token containing reserved characters (security)", async () => {
      const { buildBackgroundImageUrlMap } = await import("./pitch.js");
      // A token containing `&` and `?` would otherwise inject extra
      // query params or smuggle path segments.
      const evilToken = "abc&injected=1?slide=999";
      const map = buildBackgroundImageUrlMap(
        "deck-1",
        [{ id: "s1", position: 0 }],
        [
          {
            id: "asset-1",
            slide_id: "s1",
            kind: "background",
            created_at: "2026-04-25T00:00:00Z",
          },
        ],
        evilToken,
      );
      const url = map.get(0)!;
      expect(url).toBe(
        `/api/admin/pitch/decks/deck-1/assets/asset-1?token=${encodeURIComponent(evilToken)}`,
      );
      // Sanity: the raw `&` and `?` must NOT appear in the final URL
      // outside of the leading `?token=` separator.
      expect(url.split("?token=")[1]).not.toMatch(/[&?]/);
    });

    it("omits the token suffix when accessToken is undefined or empty", async () => {
      const { buildBackgroundImageUrlMap } = await import("./pitch.js");
      const args = [
        "deck-1",
        [{ id: "s1", position: 0 }],
        [
          {
            id: "asset-1",
            slide_id: "s1",
            kind: "background",
            created_at: "2026-04-25T00:00:00Z",
          },
        ],
      ] as const;
      const noToken = buildBackgroundImageUrlMap(...args);
      const emptyToken = buildBackgroundImageUrlMap(...args, "");
      expect(noToken.get(0)).toBe(
        "/api/admin/pitch/decks/deck-1/assets/asset-1",
      );
      expect(emptyToken.get(0)).toBe(
        "/api/admin/pitch/decks/deck-1/assets/asset-1",
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Share-token admin routes (sub-issue #1000)
  // ──────────────────────────────────────────────────────────────────

  describe("Share-token admin routes (#1000)", () => {
    async function makeShareDeck(): Promise<string> {
      const kit = harness.deps.brandKitRepo.getAll()[0];
      const create = await request(harness.app)
        .post("/api/admin/pitch/decks")
        .send({ title: "Share Deck", brand_kit_id: kit.id });
      return create.body.deck.id as string;
    }

    it("POST /decks/:deckId/share issues a token (43 chars, base64url)", async () => {
      const deckId = await makeShareDeck();
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/share`)
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.body.url).toBe(`/p/${res.body.token}`);
      expect(res.body.expiresAt).toBeNull();
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("POST /decks/:deckId/share computes expiresAt when expiresInDays is set", async () => {
      const deckId = await makeShareDeck();
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/share`)
        .send({ expiresInDays: 7 });
      expect(res.status).toBe(201);
      expect(typeof res.body.expiresAt).toBe("number");
      expect(res.body.expiresAt - res.body.createdAt).toBe(
        7 * 24 * 60 * 60 * 1000,
      );
    });

    it("POST /decks/:deckId/share rejects unknown deck with 404", async () => {
      const res = await request(harness.app)
        .post("/api/admin/pitch/decks/does-not-exist/share")
        .send({});
      expect(res.status).toBe(404);
    });

    it("POST /decks/:deckId/share rejects unknown body fields (.strict())", async () => {
      const deckId = await makeShareDeck();
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/share`)
        .send({ extra: "nope" });
      expect(res.status).toBe(400);
    });

    it("GET /decks/:deckId/share lists tokens newest-first with revocation state", async () => {
      const deckId = await makeShareDeck();
      const a = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/share`)
        .send({});
      const b = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/share`)
        .send({});
      // Revoke `a` so we can assert revokedAt surfaces.
      await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/share/${a.body.token}/revoke`)
        .send({});
      const list = await request(harness.app).get(
        `/api/admin/pitch/decks/${deckId}/share`,
      );
      expect(list.status).toBe(200);
      expect(list.body.tokens).toHaveLength(2);
      const tokens = list.body.tokens as Array<{
        token: string;
        revokedAt: number | null;
      }>;
      const aRow = tokens.find((t) => t.token === a.body.token);
      const bRow = tokens.find((t) => t.token === b.body.token);
      expect(aRow?.revokedAt).not.toBeNull();
      expect(bRow?.revokedAt).toBeNull();
    });

    it("GET /decks/:deckId/share returns 404 for unknown deck", async () => {
      const res = await request(harness.app).get(
        "/api/admin/pitch/decks/does-not-exist/share",
      );
      expect(res.status).toBe(404);
    });

    it("POST revoke flips revokedAt and is idempotent (second call → 404)", async () => {
      const deckId = await makeShareDeck();
      const issued = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/share`)
        .send({});
      const first = await request(harness.app)
        .post(
          `/api/admin/pitch/decks/${deckId}/share/${issued.body.token}/revoke`,
        )
        .send({});
      const second = await request(harness.app)
        .post(
          `/api/admin/pitch/decks/${deckId}/share/${issued.body.token}/revoke`,
        )
        .send({});
      expect(first.status).toBe(200);
      expect(second.status).toBe(404);
    });

    it("POST revoke rejects malformed tokens with 400", async () => {
      const deckId = await makeShareDeck();
      const res = await request(harness.app)
        .post(`/api/admin/pitch/decks/${deckId}/share/!!!shortbad/revoke`)
        .send({});
      expect(res.status).toBe(400);
    });
  });
});
