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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPitchRouter, type PitchRouterDeps } from "./pitch.js";
import { PitchRepository } from "../pitch/pitch-repository.js";
import { BrandKitRepository } from "../video/brand-kit.js";
import { seedStarterBrandKits } from "../pitch/starter-brand-kits.js";
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
    // 1×1 PNG (valid signature)
    const PNG_BYTES = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082",
      "hex",
    );

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
});
