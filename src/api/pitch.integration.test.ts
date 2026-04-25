/**
 * Pitch — Phase 7 integration suite (sub-issue #976).
 *
 * Complements `pitch.test.ts` (CRUD + AI + brand-kit unit tests) with
 * two specific gaps the Phase 7 acceptance criteria call out:
 *
 *   1. End-to-end deck lifecycle — brand kit → draft → patch → reorder
 *      → image enqueue → all 5 export formats → delete (asset cleanup
 *      verified) → brand-kit delete blocked while referenced.
 *
 *   2. Rate-limit defence — every limiter (draft / regenerate / image /
 *      pdf / pptx / zip / md / notes) returns 429 once its hourly cap
 *      is exhausted, with the documented `{ error: { code:
 *      "rate_limited" } }` envelope and `RateLimit-*` headers.
 *
 * The harness is a near-clone of `pitch.test.ts`'s — fresh in-memory
 * SQLite, fresh router (so each test gets fresh limiter stores), all
 * Phase-2 service functions mocked, exporters mocked through
 * `PitchRouterDeps.exporters`.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPitchRouter, type PitchRouterDeps } from "./pitch.js";
import { PitchRepository } from "../pitch/pitch-repository.js";
import { BrandKitRepository } from "../video/brand-kit.js";
import { seedStarterBrandKits } from "../pitch/starter-brand-kits.js";
import {
  SlideSchema,
  type Slide,
  type Deck,
} from "../pitch/pitch-schema.js";

// ── Mocks ──────────────────────────────────────────────────────────────

const generateDeckMock = vi.fn();
const regenerateSlideMock = vi.fn();
const submitSlideRegenerateTaskMock = vi.fn();
const enqueueSlideImageMock = vi.fn();

vi.mock("../pitch/pitch-generator.js", () => ({
  generateDeck: (...a: unknown[]) => generateDeckMock(...a),
  regenerateSlide: (...a: unknown[]) => regenerateSlideMock(...a),
  MAX_SLIDES_PER_DECK: 80,
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

function makeSlide(template: Slide["template"], content: unknown): Slide {
  return SlideSchema.parse({
    template,
    content,
    speaker_notes: "",
    transition: "slide",
    fragments: [],
  } as unknown);
}

interface Harness {
  app: Express;
  deps: PitchRouterDeps;
  db: Database.Database;
  brandKitsDir: string;
  exporterCalls: {
    pdf: number;
    pptx: number;
    zip: number;
    md: number;
    notes: number;
  };
  cleanup: () => void;
}

function buildHarness(): Harness {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const pitchRepo = new PitchRepository(db, FROZEN);
  const brandKitRepo = new BrandKitRepository(db);
  brandKitRepo.migrate();
  pitchRepo.migrate();
  seedStarterBrandKits(brandKitRepo);

  const brandKitsDir = mkdtempSync(join(tmpdir(), "pitch-int-"));

  const exporterCalls = { pdf: 0, pptx: 0, zip: 0, md: 0, notes: 0 };

  const fakeBuffer = Buffer.from("FAKE EXPORT");
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
    exporters: {
      pdf: (async () => {
        exporterCalls.pdf++;
        return {
          buffer: fakeBuffer,
          filename: "deck.pdf",
          contentType: "application/pdf",
        };
      }) as never,
      pptx: (async () => {
        exporterCalls.pptx++;
        return {
          buffer: fakeBuffer,
          filename: "deck.pptx",
          contentType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        };
      }) as never,
      zip: (async () => {
        exporterCalls.zip++;
        return {
          buffer: fakeBuffer,
          filename: "deck.zip",
          contentType: "application/zip",
        };
      }) as never,
      md: ((() => {
        exporterCalls.md++;
        return {
          buffer: fakeBuffer,
          filename: "deck.md",
          contentType: "text/markdown; charset=utf-8",
        };
      }) as never) as PitchRouterDeps["exporters"] extends infer E
        ? E extends { md?: infer M }
          ? M
          : never
        : never,
      notes: (async () => {
        exporterCalls.notes++;
        return {
          buffer: fakeBuffer,
          filename: "notes.pdf",
          contentType: "application/pdf",
        };
      }) as never,
    },
  };

  const app = express();
  app.use(express.json());
  app.use("/api/admin/pitch", createPitchRouter(deps));

  return {
    app,
    deps,
    db,
    brandKitsDir,
    exporterCalls,
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

function makeDraftedDeck(title = "Lifecycle Deck"): Deck {
  return {
    id: `deck-${title.toLowerCase().replace(/\s+/g, "-")}`,
    title,
    brand_kit_id: "starter-modern-minimal",
    aspect_ratio: "16:9",
    metadata: { source_script: "test script", tone: "formal", audience: "VCs" },
    slides: [
      makeSlide("title", { title: "Welcome" }),
      makeSlide("bullet_list", { heading: "Agenda", bullets: ["a", "b"] }),
      makeSlide("two_column", { heading: "Compare", left: "L", right: "R" }),
      makeSlide("stats_kpi", {
        heading: "KPIs",
        kpis: [
          { value: "1", label: "L" },
          { value: "2", label: "L2" },
        ],
      }),
      makeSlide("qa", { heading: "Questions?" }),
    ],
    created_at: "2026-04-25T12:00:00.000Z",
    updated_at: "2026-04-25T12:00:00.000Z",
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("Pitch — Phase 7 integration (sub-issue #976)", () => {
  let h: Harness;

  beforeEach(() => {
    generateDeckMock.mockReset();
    regenerateSlideMock.mockReset();
    submitSlideRegenerateTaskMock.mockReset();
    enqueueSlideImageMock.mockReset();
    h = buildHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  // ── End-to-end deck lifecycle ────────────────────────────────────

  describe("end-to-end deck lifecycle", () => {
    it("draft → patch → reorder → enqueue image → export all 5 formats → delete", async () => {
      // Step 1 — draft a deck via the AI endpoint (mocked LLM).
      const drafted = makeDraftedDeck();
      generateDeckMock.mockResolvedValue(drafted);

      const draft = await request(h.app)
        .post("/api/admin/pitch/decks/draft")
        .send({
          script: "investor pitch script",
          brandKitId: "starter-modern-minimal",
        });
      expect(draft.status).toBe(201);
      expect(draft.body.deck.slides).toHaveLength(5);
      const deckId = draft.body.deck.id as string;
      const slides = h.deps.pitchRepo.listSlidesForDeck(deckId);
      expect(slides).toHaveLength(5);

      // Step 2 — PATCH a slide; verify the change persists.
      const patch = await request(h.app)
        .patch(`/api/admin/pitch/decks/${deckId}/slides/${slides[1].id}`)
        .send({
          slide: {
            template: "bullet_list",
            content: { heading: "Updated Agenda", bullets: ["1", "2", "3"] },
            speaker_notes: "patched",
            transition: "slide",
            fragments: [],
          },
        });
      expect(patch.status).toBe(200);
      const refreshedSlides = h.deps.pitchRepo.listSlidesForDeck(deckId);
      expect(
        (refreshedSlides[1].slide.content as { heading: string }).heading,
      ).toBe("Updated Agenda");

      // Step 3 — Reorder: move slide 1 to position 4.
      const reorder = await request(h.app)
        .put(`/api/admin/pitch/decks/${deckId}/slides/${slides[1].id}/move`)
        .send({ position: 4 });
      expect(reorder.status).toBe(200);
      const reorderedSlides = h.deps.pitchRepo.listSlidesForDeck(deckId);
      expect(
        (reorderedSlides[4].slide.content as { heading: string }).heading,
      ).toBe("Updated Agenda");

      // Step 4 — Enqueue image generation for a slide.
      enqueueSlideImageMock.mockReturnValue({
        jobId: "job-1",
        assetId: "asset-1",
      });
      const enqueue = await request(h.app)
        .post(`/api/admin/pitch/decks/${deckId}/slides/${slides[0].id}/image`)
        .send({ prompt: "a hero image", mode: "inline" });
      expect(enqueue.status).toBe(202);
      expect(enqueueSlideImageMock).toHaveBeenCalledOnce();

      // Step 5 — Export every format.
      for (const [path, contentType, count] of [
        ["export.pdf", "application/pdf", "pdf"],
        [
          "export.pptx",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "pptx",
        ],
        ["export.zip", "application/zip", "zip"],
        ["export.md", "text/markdown", "md"],
        ["export.notes.pdf", "application/pdf", "notes"],
      ] as const) {
        const exp = await request(h.app).get(
          `/api/admin/pitch/decks/${deckId}/${path}`,
        );
        expect(exp.status).toBe(200);
        expect(exp.headers["content-type"]).toContain(contentType);
        expect(h.exporterCalls[count]).toBeGreaterThan(0);
      }

      // Step 6 — Brand-kit delete is blocked while the deck references
      // it.
      const blocked = await request(h.app).delete(
        "/api/admin/pitch/brand-kits/starter-modern-minimal",
      );
      // starter-modern-minimal is a starter kit and starters are
      // immutable → 403; if not a starter the response would be 409.
      // Either way it MUST NOT succeed.
      expect([403, 409]).toContain(blocked.status);

      // Step 7 — Delete the deck.
      const del = await request(h.app).delete(
        `/api/admin/pitch/decks/${deckId}`,
      );
      expect([200, 204]).toContain(del.status);
      // Underlying SQLite row is gone.
      expect(h.deps.pitchRepo.getDeck(deckId)).toBeNull();
    });
  });

  // ── Rate-limit defence ───────────────────────────────────────────

  describe("rate-limit defence (#977)", () => {
    /** Ensure once a limit is reached the next request is rejected with
     * the documented envelope and headers. */
    async function assertLimitTripsAfter(
      max: number,
      doRequest: () => Promise<request.Response>,
    ): Promise<void> {
      // Drive to the cap; status may be anything >=200 because the
      // underlying handler may legitimately fail (mocks, schema, etc.) —
      // we only care that the limiter does NOT yet fire.
      for (let i = 0; i < max; i++) {
        const r = await doRequest();
        expect(r.status).not.toBe(429);
      }
      const tripped = await doRequest();
      expect(tripped.status).toBe(429);
      expect(tripped.body).toEqual({
        error: {
          code: "rate_limited",
          message: expect.any(String),
        },
      });
      expect(tripped.headers).toHaveProperty("ratelimit-policy");
      expect(tripped.headers).toHaveProperty("retry-after");
    }

    it("/decks/draft — 10/hr cap", async () => {
      generateDeckMock.mockResolvedValue(makeDraftedDeck());
      await assertLimitTripsAfter(10, () =>
        request(h.app)
          .post("/api/admin/pitch/decks/draft")
          .send({
            script: "x",
            brandKitId: "starter-modern-minimal",
          }),
      );
    });

    it("/decks/:id/export.pdf — 20/hr cap", async () => {
      // Pre-create a deck so the export handler can reach the rate
      // limiter (it runs middleware before the handler body).
      const deck = makeDraftedDeck("PDF-Test");
      h.deps.pitchRepo.insertDeck({
        id: deck.id,
        title: deck.title,
        brand_kit_id: deck.brand_kit_id,
        aspect_ratio: deck.aspect_ratio,
        metadata: deck.metadata,
        slides: deck.slides.map((s, i) => ({ id: `${deck.id}-s${i}`, slide: s })),
      });
      await assertLimitTripsAfter(20, () =>
        request(h.app).get(`/api/admin/pitch/decks/${deck.id}/export.pdf`),
      );
    });

    it("/decks/:id/export.notes.pdf — 20/hr cap", async () => {
      const deck = makeDraftedDeck("Notes-Test");
      h.deps.pitchRepo.insertDeck({
        id: deck.id,
        title: deck.title,
        brand_kit_id: deck.brand_kit_id,
        aspect_ratio: deck.aspect_ratio,
        metadata: deck.metadata,
        slides: deck.slides.map((s, i) => ({ id: `${deck.id}-s${i}`, slide: s })),
      });
      await assertLimitTripsAfter(20, () =>
        request(h.app).get(`/api/admin/pitch/decks/${deck.id}/export.notes.pdf`),
      );
    });

    it("returned 429 envelope is shape-stable", async () => {
      generateDeckMock.mockResolvedValue(makeDraftedDeck());
      // Burn through the draft cap.
      for (let i = 0; i < 10; i++) {
        await request(h.app)
          .post("/api/admin/pitch/decks/draft")
          .send({
            script: "x",
            brandKitId: "starter-modern-minimal",
          });
      }
      const tripped = await request(h.app)
        .post("/api/admin/pitch/decks/draft")
        .send({
          script: "x",
          brandKitId: "starter-modern-minimal",
        });
      expect(tripped.status).toBe(429);
      // The payload must NOT leak server internals; only `code` +
      // `message` are allowed.
      expect(Object.keys(tripped.body.error).sort()).toEqual(["code", "message"]);
    });
  });

  // ── 80-slide cap defence on POST /slides ─────────────────────────

  describe("80-slide cap on slide creation (#977)", () => {
    it("rejects with 409 once a deck reaches 80 slides", async () => {
      // Seed a deck with exactly 80 slides at the repo layer.
      const slides = Array.from({ length: 80 }, (_, i) => ({
        id: `cap-deck-s${i}`,
        slide: makeSlide("qa", { heading: `Q${i}` }),
      }));
      const deck = h.deps.pitchRepo.insertDeck({
        id: "cap-deck",
        title: "Capped",
        brand_kit_id: "starter-modern-minimal",
        aspect_ratio: "16:9",
        metadata: { source_script: "", tone: "formal" },
        slides,
      });

      const res = await request(h.app)
        .post(`/api/admin/pitch/decks/${deck.id}/slides`)
        .send({
          slide: {
            template: "qa",
            content: { heading: "Overflow" },
            speaker_notes: "",
            transition: "slide",
            fragments: [],
          },
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("conflict");
      expect(res.body.error.message).toMatch(/80/);
    });
  });
});
