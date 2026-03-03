import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { createDirectorRouter } from "./director.js";
import type { DirectorRouterOptions } from "./director.js";

// ── Mocks ────────────────────────────────────────────────────

// Mock getDatabase to use in-memory SQLite
let testDb: Database.Database;

vi.mock("../productivity/database.js", () => ({
  getDatabase: () => testDb,
}));

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("nanoid", () => ({
  nanoid: () => "test-nano-id-123",
}));

vi.mock("../video/templates/template-registry.js", () => ({
  createTemplateRegistry: () => ({
    getAll: () => [
      {
        id: "Minimalist",
        name: "Minimalist",
        description: "Clean and simple",
        aspectRatio: "16:9",
        defaultComposition: { width: 1920, height: 1080, fps: 30 },
        defaultTransition: "crossfade",
        defaultTransitionDuration: 15,
        captionsEnabled: false,
        defaultCaptionStyle: null,
        tags: ["clean"],
        titleCardBackground: null,
        fontFamily: "Inter",
      },
    ],
    get: (id: string) =>
      id === "Minimalist"
        ? {
            id: "Minimalist",
            name: "Minimalist",
            description: "Clean and simple",
            aspectRatio: "16:9",
            defaultComposition: { width: 1920, height: 1080, fps: 30 },
            defaultTransition: "crossfade",
            defaultTransitionDuration: 15,
            captionsEnabled: false,
            defaultCaptionStyle: null,
            tags: ["clean"],
            titleCardBackground: null,
            fontFamily: "Inter",
          }
        : undefined,
  }),
}));

vi.mock("../video/assets/asset-manager.js", () => ({
  AssetManager: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue({ results: [{ id: "r1", name: "Track 1" }], total: 1 }),
    download: vi.fn().mockResolvedValue({ filePath: "/tmp/test-download.mp3", asset: { id: "a1", name: "Downloaded Track" } }),
    getLocalAssets: vi.fn().mockReturnValue([{ id: "local1", name: "My Song", filePath: "/lib/song.mp3" }]),
    remove: vi.fn().mockResolvedValue(true),
  })),
}));

// ── Helpers ──────────────────────────────────────────────────

function initTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS director_drafts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      manifest TEXT NOT NULL,
      thumbnail TEXT,
      production_mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
    );
    CREATE TABLE IF NOT EXISTS director_renders (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      quality TEXT NOT NULL DEFAULT 'standard',
      status TEXT NOT NULL DEFAULT 'queued',
      output_path TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (draft_id) REFERENCES director_drafts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS director_draft_versions (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      label TEXT NOT NULL,
      manifest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (draft_id) REFERENCES director_drafts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS voice_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      ref_audio_path TEXT NOT NULL DEFAULT '',
      ref_text TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'en',
      top_p REAL NOT NULL DEFAULT 0.8,
      temperature REAL NOT NULL DEFAULT 1.0,
      text_split_method TEXT NOT NULL DEFAULT 'cut5',
      speed_factor REAL NOT NULL DEFAULT 1.0,
      repetition_penalty REAL NOT NULL DEFAULT 1.35,
      top_k INTEGER NOT NULL DEFAULT 15,
      sample_steps INTEGER NOT NULL DEFAULT 32,
      engine_type TEXT NOT NULL DEFAULT 'sovits',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function createMockCopilot() {
  return {
    chat: vi.fn(),
    isAuthenticated: vi.fn().mockReturnValue(true),
  } as unknown as DirectorRouterOptions["copilot"];
}

function createMockRenderOrchestrator() {
  const jobs = new Map<string, {
    id: string;
    status: string;
    progress: number;
    manifest: { projectTitle: string; templateId: string };
    outputPath: string | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
    durationSec: number | null;
    fileSizeBytes: number | null;
  }>();

  return {
    submit: vi.fn().mockResolvedValue("job-001"),
    getJob: vi.fn((id: string) => jobs.get(id) ?? null),
    listJobs: vi.fn(() => Array.from(jobs.values())),
    abort: vi.fn().mockReturnValue(true),
    _jobs: jobs,
  };
}

function buildApp(overrides: Partial<DirectorRouterOptions> = {}) {
  const app = express();
  app.use(express.json());

  const opts: DirectorRouterOptions = {
    copilot: createMockCopilot(),
    config: {
      enabled: true,
      outputDir: "/tmp/openzigs-test-output",
      defaultTemplate: "Minimalist",
      assets: {
        localLibraryPath: "/tmp/openzigs-test-assets",
        downloadCachePath: "/tmp/openzigs-test-cache",
        pixabayApiKey: "pk-test-1234",
        jamendoClientId: "jm-test-5678",
        pexelsApiKey: "px-test-9012",
      },
    },
    ...overrides,
  };

  const router = createDirectorRouter(opts);
  app.use("/director", router);
  return { app, opts };
}

// ── Tests ────────────────────────────────────────────────────

describe("Director API router", () => {
  beforeEach(() => {
    testDb = initTestDb();
  });

  afterEach(() => {
    testDb?.close();
  });

  // ── GET /narration/directives ────────────────────────────

  describe("GET /narration/directives", () => {
    it("returns directives and voices", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/director/narration/directives");
      expect(res.status).toBe(200);
      expect(res.body.directives).toBeDefined();
      expect(Array.isArray(res.body.directives)).toBe(true);
      expect(res.body.directives.length).toBeGreaterThan(0);
      expect(res.body.directives[0]).toHaveProperty("tag");
      expect(res.body.voices).toBeDefined();
      expect(Array.isArray(res.body.voices)).toBe(true);
      expect(res.body.voices[0]).toHaveProperty("id");
      expect(res.body.voices[0]).toHaveProperty("language");
      expect(res.body.voices[0]).toHaveProperty("gender");
    });
  });

  // ── GET /config ──────────────────────────────────────────

  describe("GET /config", () => {
    it("returns masked configuration", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/director/config");
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.defaultTemplate).toBe("Minimalist");
      // API keys should be masked
      expect(res.body.pixabayApiKey).toBe("••••1234");
      expect(res.body.jamendoClientId).toBe("••••5678");
      expect(res.body.pexelsApiKey).toBe("••••9012");
      expect(res.body.pixabayConfigured).toBe(true);
      expect(res.body.jamendoConfigured).toBe(true);
      expect(res.body.pexelsConfigured).toBe(true);
    });

    it("shows empty keys when not configured", async () => {
      const { app } = buildApp({
        config: {
          enabled: false,
          outputDir: "/tmp/test",
          defaultTemplate: "Corporate",
          assets: {
            localLibraryPath: "/tmp/test",
            downloadCachePath: "/tmp/test",
            pixabayApiKey: "",
            jamendoClientId: "",
            pexelsApiKey: "",
          },
        },
      });
      const res = await request(app).get("/director/config");
      expect(res.status).toBe(200);
      expect(res.body.pixabayApiKey).toBe("");
      expect(res.body.pixabayConfigured).toBe(false);
    });
  });

  // ── PUT /config ──────────────────────────────────────────

  describe("PUT /config", () => {
    it("updates runtime config", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .put("/director/config")
        .send({ pixabayApiKey: "new-key-xyz", defaultModel: "gpt-4o" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify it took effect
      const getRes = await request(app).get("/director/config");
      expect(getRes.body.pixabayApiKey).toBe("••••-xyz");
      expect(getRes.body.defaultModel).toBe("gpt-4o");
    });
  });

  // ── Drafts CRUD ──────────────────────────────────────────

  describe("POST /drafts", () => {
    it("creates a draft with valid manifest", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/drafts").send({
        title: "My Video",
        manifest: { projectTitle: "Test", timeline: [] },
        productionMode: "presentation",
      });
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("test-nano-id-123");
      expect(res.body.title).toBe("My Video");
      expect(res.body.status).toBe("draft");
    });

    it("rejects missing manifest", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/drafts").send({
        productionMode: "presentation",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("manifest");
    });

    it("rejects missing productionMode", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/drafts").send({
        manifest: { timeline: [] },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("productionMode");
    });

    it("defaults title to 'Untitled Draft'", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/drafts").send({
        manifest: { timeline: [] },
        productionMode: "highlight",
      });
      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Untitled Draft");
    });
  });

  describe("GET /drafts", () => {
    it("returns empty list initially", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/director/drafts");
      expect(res.status).toBe(200);
      expect(res.body.drafts).toEqual([]);
    });

    it("returns created drafts", async () => {
      const { app } = buildApp();
      // Insert a draft directly
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d1", "Draft One", '{"timeline":[]}', "presentation", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");

      const res = await request(app).get("/director/drafts");
      expect(res.status).toBe(200);
      expect(res.body.drafts).toHaveLength(1);
      expect(res.body.drafts[0].id).toBe("d1");
      expect(res.body.drafts[0].title).toBe("Draft One");
      expect(res.body.drafts[0].productionMode).toBe("presentation");
    });
  });

  describe("GET /drafts/:id", () => {
    it("returns 404 for missing draft", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/director/drafts/nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns draft with parsed manifest", async () => {
      const { app } = buildApp();
      const manifest = { projectTitle: "Test", timeline: [{ type: "image_scene" }] };
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d2", "Draft Two", JSON.stringify(manifest), "script", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");

      const res = await request(app).get("/director/drafts/d2");
      expect(res.status).toBe(200);
      expect(res.body.manifest).toEqual(manifest);
      expect(res.body.title).toBe("Draft Two");
    });
  });

  describe("PUT /drafts/:id", () => {
    beforeEach(() => {
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-put", "Original", '{}', "highlight", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");
    });

    it("returns 404 for missing draft", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/director/drafts/missing").send({ title: "X" });
      expect(res.status).toBe(404);
    });

    it("updates title and manifest", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/director/drafts/d-put").send({
        title: "Updated",
        manifest: { newKey: true },
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify
      const row = testDb.prepare("SELECT title, manifest FROM director_drafts WHERE id = ?").get("d-put") as { title: string; manifest: string };
      expect(row.title).toBe("Updated");
      expect(JSON.parse(row.manifest)).toEqual({ newKey: true });
    });

    it("does nothing when no fields provided", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/director/drafts/d-put").send({});
      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Nothing to update");
    });
  });

  describe("DELETE /drafts/:id", () => {
    it("returns 404 for missing draft", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/director/drafts/missing");
      expect(res.status).toBe(404);
    });

    it("deletes existing draft", async () => {
      const { app } = buildApp();
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-del", "ToDelete", '{}', "highlight", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");

      const res = await request(app).delete("/director/drafts/d-del");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const row = testDb.prepare("SELECT id FROM director_drafts WHERE id = ?").get("d-del");
      expect(row).toBeUndefined();
    });
  });

  // ── Draft Versions ───────────────────────────────────────

  describe("POST /drafts/:id/versions", () => {
    it("returns 404 for missing draft", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/drafts/missing/versions").send({});
      expect(res.status).toBe(404);
    });

    it("creates a version snapshot", async () => {
      const { app } = buildApp();
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-ver", "Versioned", '{"v":1}', "presentation", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");

      const res = await request(app)
        .post("/director/drafts/d-ver/versions")
        .send({ label: "Checkpoint 1" });
      expect(res.status).toBe(201);
      expect(res.body.label).toBe("Checkpoint 1");
    });
  });

  describe("GET /drafts/:id/versions", () => {
    it("returns empty list when no versions exist", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/director/drafts/any/versions");
      expect(res.status).toBe(200);
      expect(res.body.versions).toEqual([]);
    });

    it("lists saved versions", async () => {
      const { app } = buildApp();
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-v2", "V", '{}', "highlight", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");
      testDb.prepare(
        `INSERT INTO director_draft_versions (id, draft_id, label, manifest, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run("v1", "d-v2", "v1", '{"old":true}', "2025-01-01T01:00:00Z");

      const res = await request(app).get("/director/drafts/d-v2/versions");
      expect(res.status).toBe(200);
      expect(res.body.versions).toHaveLength(1);
      expect(res.body.versions[0].label).toBe("v1");
    });
  });

  describe("POST /drafts/:id/versions/:versionId/restore", () => {
    it("returns 404 for missing version", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/drafts/d1/versions/v-missing/restore")
        .send({});
      expect(res.status).toBe(404);
    });

    it("restores a version", async () => {
      const { app } = buildApp();
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-rest", "D", '{"v":2}', "presentation", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");
      testDb.prepare(
        `INSERT INTO director_draft_versions (id, draft_id, label, manifest, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run("v-old", "d-rest", "old", '{"v":1}', "2025-01-01T00:00:00Z");

      const res = await request(app)
        .post("/director/drafts/d-rest/versions/v-old/restore")
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.manifest).toEqual({ v: 1 });

      // Verify DB
      const row = testDb.prepare("SELECT manifest FROM director_drafts WHERE id = ?").get("d-rest") as { manifest: string };
      expect(JSON.parse(row.manifest)).toEqual({ v: 1 });
    });
  });

  // ── Draft Renders ────────────────────────────────────────

  describe("GET /drafts/:id/renders", () => {
    it("returns empty list with no renders", async () => {
      const { app } = buildApp();
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-ren", "D", '{}', "presentation", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");

      const res = await request(app).get("/director/drafts/d-ren/renders");
      expect(res.status).toBe(200);
      expect(res.body.renders).toEqual([]);
    });

    it("lists renders for a draft", async () => {
      const { app } = buildApp();
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-r2", "D", '{}', "presentation", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");
      testDb.prepare(
        `INSERT INTO director_renders (id, draft_id, job_id, quality, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("r1", "d-r2", "j1", "high", "complete", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

      const res = await request(app).get("/director/drafts/d-r2/renders");
      expect(res.status).toBe(200);
      expect(res.body.renders).toHaveLength(1);
      expect(res.body.renders[0].quality).toBe("high");
    });
  });

  // ── Render Jobs ──────────────────────────────────────────

  describe("GET /jobs", () => {
    it("returns empty list without renderOrchestrator", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/director/jobs");
      expect(res.status).toBe(200);
      expect(res.body.jobs).toEqual([]);
    });

    it("returns job list from renderOrchestrator", async () => {
      const mockOrch = createMockRenderOrchestrator();
      mockOrch._jobs.set("j1", {
        id: "j1",
        status: "rendering",
        progress: 50,
        manifest: { projectTitle: "Test", templateId: "Minimalist" },
        outputPath: null,
        error: null,
        createdAt: new Date("2025-01-01T00:00:00Z"),
        updatedAt: new Date("2025-01-02T00:00:00Z"),
        durationSec: 120,
        fileSizeBytes: null,
      });

      const { app } = buildApp({ renderOrchestrator: mockOrch as unknown as DirectorRouterOptions["renderOrchestrator"] });
      const res = await request(app).get("/director/jobs");
      expect(res.status).toBe(200);
      expect(res.body.jobs).toHaveLength(1);
      expect(res.body.jobs[0].id).toBe("j1");
      expect(res.body.jobs[0].progress).toBe(50);
    });
  });

  describe("GET /jobs/:id", () => {
    it("returns 404 without renderOrchestrator", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/director/jobs/j1");
      expect(res.status).toBe(404);
    });

    it("returns 404 for unknown job", async () => {
      const mockOrch = createMockRenderOrchestrator();
      const { app } = buildApp({ renderOrchestrator: mockOrch as unknown as DirectorRouterOptions["renderOrchestrator"] });
      const res = await request(app).get("/director/jobs/unknown");
      expect(res.status).toBe(404);
    });

    it("returns job details", async () => {
      const mockOrch = createMockRenderOrchestrator();
      mockOrch._jobs.set("j2", {
        id: "j2",
        status: "complete",
        progress: 100,
        manifest: { projectTitle: "Done", templateId: "Corporate" },
        outputPath: "/out/video.mp4",
        error: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-02"),
        durationSec: 60,
        fileSizeBytes: 1024000,
      });

      const { app } = buildApp({ renderOrchestrator: mockOrch as unknown as DirectorRouterOptions["renderOrchestrator"] });
      const res = await request(app).get("/director/jobs/j2");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("complete");
      expect(res.body.outputPath).toBe("/out/video.mp4");
    });
  });

  describe("POST /jobs/:id/abort", () => {
    it("returns 503 without renderOrchestrator", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/jobs/j1/abort");
      expect(res.status).toBe(503);
    });

    it("aborts a job", async () => {
      const mockOrch = createMockRenderOrchestrator();
      const { app } = buildApp({ renderOrchestrator: mockOrch as unknown as DirectorRouterOptions["renderOrchestrator"] });
      const res = await request(app).post("/director/jobs/j1/abort");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockOrch.abort).toHaveBeenCalledWith("j1");
    });
  });

  // ── POST /render ─────────────────────────────────────────

  describe("POST /render", () => {
    it("returns 503 without renderOrchestrator", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/render").send({ manifest: {} });
      expect(res.status).toBe(503);
    });

    it("rejects missing manifest", async () => {
      const mockOrch = createMockRenderOrchestrator();
      const { app } = buildApp({ renderOrchestrator: mockOrch as unknown as DirectorRouterOptions["renderOrchestrator"] });
      const res = await request(app).post("/director/render").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("manifest");
    });

    it("submits render job with quality preset", async () => {
      const mockOrch = createMockRenderOrchestrator();
      mockOrch._jobs.set("job-001", {
        id: "job-001",
        status: "queued",
        progress: 0,
        manifest: { projectTitle: "T", templateId: "M" },
        outputPath: null,
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        durationSec: null,
        fileSizeBytes: null,
      });

      const { app } = buildApp({ renderOrchestrator: mockOrch as unknown as DirectorRouterOptions["renderOrchestrator"] });
      const res = await request(app).post("/director/render").send({
        manifest: { projectTitle: "Render Test", timeline: [] },
        quality: "high",
      });
      expect(res.status).toBe(200);
      expect(res.body.jobId).toBe("job-001");
      expect(res.body.crf).toBe(18);
    });

    it("records render in history when draftId is provided", async () => {
      const mockOrch = createMockRenderOrchestrator();
      mockOrch._jobs.set("job-001", {
        id: "job-001",
        status: "queued",
        progress: 0,
        manifest: { projectTitle: "T", templateId: "M" },
        outputPath: null,
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        durationSec: null,
        fileSizeBytes: null,
      });

      const { app } = buildApp({ renderOrchestrator: mockOrch as unknown as DirectorRouterOptions["renderOrchestrator"] });

      // Create draft first
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-rq", "D", '{}', "presentation", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");

      const res = await request(app).post("/director/render").send({
        manifest: { projectTitle: "T", timeline: [] },
        draftId: "d-rq",
      });
      expect(res.status).toBe(200);

      const rows = testDb.prepare("SELECT * FROM director_renders WHERE draft_id = ?").all("d-rq") as Array<{ draft_id: string }>;
      expect(rows).toHaveLength(1);
    });
  });

  // ── Validation for heavy routes ──────────────────────────

  describe("POST /produce", () => {
    it("rejects invalid mode", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/produce").send({ mode: "invalid" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("mode");
    });

    it("rejects highlight mode without clips", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/produce").send({ mode: "highlight" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("clips");
    });

    it("rejects presentation mode without inputFile", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/produce")
        .send({ mode: "presentation" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("inputFile");
    });
  });

  describe("POST /assets/search", () => {
    it("rejects missing query", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/assets/search").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("query");
    });
  });

  describe("POST /assets/download", () => {
    it("rejects missing fields", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/assets/download").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("previewUrl");
    });
  });

  describe("POST /assets/upload", () => {
    it("rejects missing filePath", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/assets/upload").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("filePath");
    });
  });

  describe("POST /enhance", () => {
    it("rejects missing imagePath", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/enhance").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("imagePath");
    });

    it("rejects missing prompt", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/enhance")
        .send({ imagePath: "/tmp/test.jpg" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("prompt");
    });
  });

  describe("POST /thumbnail", () => {
    it("rejects missing manifestPath", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/thumbnail").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("manifestPath");
    });

    it("rejects missing outputDir", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/thumbnail")
        .send({ manifestPath: "/tmp/manifest.json" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("outputDir");
    });
  });

  describe("POST /shorts", () => {
    it("rejects missing sourceVideo", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/shorts").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("sourceVideo");
    });
  });

  describe("POST /blog-to-video", () => {
    it("rejects missing url", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/blog-to-video").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("url");
    });

    it("rejects non-http URLs", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/blog-to-video")
        .send({ url: "ftp://example.com" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("http");
    });

    it("rejects invalid URLs", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/blog-to-video")
        .send({ url: "not a url" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid");
    });
  });

  describe("POST /scenes/:sceneIndex/regenerate", () => {
    it("rejects invalid scene index", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/scenes/abc/regenerate")
        .send({ prompt: "test" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid scene index");
    });

    it("rejects missing prompt", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/scenes/0/regenerate")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("prompt");
    });
  });

  describe("POST /scenes/:sceneIndex/rewrite-script", () => {
    it("rejects invalid scene index", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/scenes/abc/rewrite-script")
        .send({ draftId: "d1" });
      expect(res.status).toBe(400);
    });

    it("rejects missing draftId", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/scenes/0/rewrite-script")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("draftId");
    });

    it("returns 404 for missing draft", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/scenes/0/rewrite-script")
        .send({ draftId: "nonexistent" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /assets/placement", () => {
    it("rejects missing script", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/assets/placement").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("script");
    });

    it("rejects empty assets array", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/assets/placement").send({
        script: "Hello world",
        assets: [],
        videoDurationSec: 30,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("assets");
    });

    it("rejects invalid videoDurationSec", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/assets/placement").send({
        script: "Hello world",
        assets: [{ id: "1", path: "/a.png" }],
        videoDurationSec: -5,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("videoDurationSec");
    });

    it("rejects more than 20 assets", async () => {
      const { app } = buildApp();
      const assets = Array.from({ length: 21 }, (_, i) => ({ id: String(i), path: `/${i}.png` }));
      const res = await request(app).post("/director/assets/placement").send({
        script: "Hello world",
        assets,
        videoDurationSec: 60,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("20");
    });
  });

  describe("POST /assets/overlay", () => {
    it("rejects missing backgroundPath", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/assets/overlay").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("backgroundPath");
    });

    it("rejects empty placements", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/assets/overlay").send({
        backgroundPath: "/tmp/bg.mp4",
        placements: [],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("placements");
    });
  });

  describe("POST /assets/ingest", () => {
    it("rejects missing filePath", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/assets/ingest").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("filePath");
    });
  });

  describe("POST /files/upload", () => {
    it("rejects invalid kind", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/files/upload?kind=executable")
        .set("Content-Type", "application/octet-stream")
        .send(Buffer.from("test"));
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("kind");
    });
  });

  describe("POST /files/upload-asset", () => {
    it("rejects invalid kind", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/files/upload-asset?kind=audio")
        .set("Content-Type", "application/octet-stream")
        .send(Buffer.from("test"));
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("kind");
    });

    it("rejects empty body", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/files/upload-asset?kind=image")
        .set("Content-Type", "application/octet-stream");
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("file bytes");
    });
  });

  // ── Additional coverage tests ───────────────────────────

  describe("PUT /config edge cases", () => {
    it("updates jamendo and pexels keys", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .put("/director/config")
        .send({ jamendoClientId: "new-jamendo", pexelsApiKey: "new-pexels" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const getRes = await request(app).get("/director/config");
      expect(getRes.body.jamendoClientId).toContain("••••");
      expect(getRes.body.pexelsApiKey).toContain("••••");
    });

    it("updates defaultModel", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .put("/director/config")
        .send({ defaultModel: "claude-sonnet-4" });
      expect(res.status).toBe(200);
      const getRes = await request(app).get("/director/config");
      expect(getRes.body.defaultModel).toBe("claude-sonnet-4");
    });
  });

  describe("POST /files/upload success paths", () => {
    it("uploads video file successfully", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/files/upload?kind=video")
        .set("Content-Type", "application/octet-stream")
        .set("x-file-name", "test-vid.mp4")
        .send(Buffer.from("fake video bytes"));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.kind).toBe("video");
      expect(res.body.fileName).toContain("test-vid.mp4");
      expect(res.body.size).toBe(16);
    });

    it("uploads script file successfully", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/files/upload?kind=script")
        .set("Content-Type", "application/octet-stream")
        .set("x-file-name", "my script.txt")
        .send(Buffer.from("hello world"));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.kind).toBe("script");
      expect(res.body.fileName).toContain("my_script.txt");
    });

    it("returns 400 for empty upload body", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/files/upload?kind=video")
        .set("Content-Type", "application/octet-stream");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /files/:fileName", () => {
    it("returns 404 for non-existent file", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/director/files/nonexistent-file-xyz.mp4");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /drafts - additional fields", () => {
    beforeEach(() => {
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-extra", "ExtraDraft", '{"old":true}', "presentation", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");
    });

    it("updates status field", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .put("/director/drafts/d-extra")
        .send({ status: "published" });
      expect(res.status).toBe(200);
      const row = testDb.prepare("SELECT status FROM director_drafts WHERE id = ?").get("d-extra") as { status: string };
      expect(row.status).toBe("published");
    });

    it("updates thumbnail field", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .put("/director/drafts/d-extra")
        .send({ thumbnail: "/tmp/thumb.jpg" });
      expect(res.status).toBe(200);
      const row = testDb.prepare("SELECT thumbnail FROM director_drafts WHERE id = ?").get("d-extra") as { thumbnail: string };
      expect(row.thumbnail).toBe("/tmp/thumb.jpg");
    });
  });

  describe("DELETE /drafts - cascade", () => {
    it("cascades delete to versions and renders", async () => {
      const { app } = buildApp();
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-casc", "Cascade", '{}', "highlight", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");
      testDb.prepare(
        `INSERT INTO director_draft_versions (id, draft_id, label, manifest, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run("v-casc", "d-casc", "v1", '{}', "2025-01-01T00:00:00Z");
      testDb.prepare(
        `INSERT INTO director_renders (id, draft_id, job_id, quality, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("r-casc", "d-casc", "j1", "standard", "queued", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

      const res = await request(app).delete("/director/drafts/d-casc");
      expect(res.status).toBe(200);
      const versions = testDb.prepare("SELECT * FROM director_draft_versions WHERE draft_id = ?").all("d-casc");
      expect(versions).toHaveLength(0);
      const renders = testDb.prepare("SELECT * FROM director_renders WHERE draft_id = ?").all("d-casc");
      expect(renders).toHaveLength(0);
    });
  });

  describe("POST /drafts/:id/versions - auto label", () => {
    it("uses auto-generated label when none provided", async () => {
      const { app } = buildApp();
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-auto", "AutoLabel", '{"v":1}', "presentation", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");

      const res = await request(app)
        .post("/director/drafts/d-auto/versions")
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.label).toBeDefined();
      expect(res.body.label.length).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════
  // ── Expanded coverage tests (batch 2) ─────────────────────
  // ══════════════════════════════════════════════════════════

  // ── GET /templates ──────────────────────────────────────

  describe("GET /templates", () => {
    it("returns template list with defaultTemplate", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/director/templates");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.templates)).toBe(true);
      expect(res.body.defaultTemplate).toBe("Minimalist");
    });

    it("includes expected template fields", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/director/templates");
      expect(res.status).toBe(200);
      expect(res.body.templates.length).toBeGreaterThan(0);
      const t = res.body.templates[0];
      expect(t).toHaveProperty("id");
      expect(t).toHaveProperty("name");
      expect(t).toHaveProperty("description");
      expect(t).toHaveProperty("aspectRatio");
    });
  });

  describe("GET /templates/:id", () => {
    it("returns a known template", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/director/templates/Minimalist");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("Minimalist");
    });

    it("returns 404 for unknown template", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/director/templates/DoesNotExist");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });

  // ── Asset manager routes ────────────────────────────────

  describe("POST /assets/search - success", () => {
    it("returns search results for valid query", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/assets/search")
        .send({ query: "ambient music" });
      expect(res.status).toBe(200);
      expect(res.body.results).toBeDefined();
    });
  });

  describe("POST /assets/download - success", () => {
    it("downloads asset with valid parameters", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/assets/download")
        .send({
          id: "track-1",
          name: "Test Track",
          source: "pixabay",
          previewUrl: "https://example.com/track.mp3",
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.filePath).toBeDefined();
    });
  });

  describe("GET /assets/local", () => {
    it("returns local assets list", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/director/assets/local");
      expect(res.status).toBe(200);
      expect(res.body.assets).toBeDefined();
      expect(typeof res.body.total).toBe("number");
    });
  });

  describe("DELETE /assets/:id", () => {
    it("removes an asset", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/director/assets/some-asset-id");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ── Config edge cases ──────────────────────────────────

  describe("GET /config - template variable pattern", () => {
    it("shows unconfigured for keys starting with ${", async () => {
      const { app } = buildApp({
        config: {
          enabled: true,
          outputDir: "/tmp/test",
          defaultTemplate: "Minimalist",
          assets: {
            localLibraryPath: "/tmp/test",
            downloadCachePath: "/tmp/test",
            pixabayApiKey: "${PIXABAY_KEY}",
            jamendoClientId: "",
            pexelsApiKey: "",
          },
        },
      });
      const res = await request(app).get("/director/config");
      expect(res.status).toBe(200);
      expect(res.body.pixabayConfigured).toBe(false);
    });

    it("includes defaultModel field", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/director/config");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("defaultModel");
    });
  });

  describe("PUT /config - more edge cases", () => {
    it("handles empty body as no-op", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/director/config").send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("updates only pexels key", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .put("/director/config")
        .send({ pexelsApiKey: "new-pexels-key" });
      expect(res.status).toBe(200);
      const getRes = await request(app).get("/director/config");
      expect(getRes.body.pexelsApiKey).toBe("••••-key");
      expect(getRes.body.pexelsConfigured).toBe(true);
    });
  });

  // ── Enhance security guards ────────────────────────────

  describe("POST /enhance - security", () => {
    it("rejects path outside allowed directories", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/enhance")
        .send({ imagePath: "/etc/passwd", prompt: "enhance this" });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Access denied");
    });

    it("returns 404 for non-existent file in allowed dir", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/enhance")
        .send({
          imagePath: "/tmp/openzigs-test-output/nonexistent-image-test-xyz.jpg",
          prompt: "enhance this",
        });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });

  // ── Thumbnail security guards ──────────────────────────

  describe("POST /thumbnail - security", () => {
    it("rejects manifestPath outside allowed dirs", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/thumbnail")
        .send({
          manifestPath: "/etc/passwd",
          outputDir: "/tmp/openzigs-test-output",
        });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("manifestPath");
    });

    it("rejects outputDir outside allowed dirs", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/thumbnail")
        .send({
          manifestPath: "/tmp/openzigs-test-output/manifest.json",
          outputDir: "/etc",
        });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("outputDir");
    });
  });

  // ── Assets upload security ─────────────────────────────

  describe("POST /assets/upload - security", () => {
    it("rejects path outside allowed directories", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/assets/upload")
        .send({ filePath: "/etc/passwd" });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Access denied");
    });

    it("returns 404 for non-existent file in allowed dir", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/assets/upload")
        .send({ filePath: "/tmp/openzigs-test-output/no-such-file.mp3" });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });

    it("expands tilde path and returns 404 for non-existent", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/assets/upload")
        .send({ filePath: "~/nonexistent-upload-test-xyz-999.mp3" });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });

  // ── Assets ingest ──────────────────────────────────────

  describe("POST /assets/ingest - file validation", () => {
    it("returns 404 for non-existent file", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/assets/ingest")
        .send({ filePath: "/tmp/nonexistent-video-ingest-test.mp4" });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });

  // ── GET /renders ───────────────────────────────────────

  describe("GET /renders", () => {
    it("returns empty renders when no drafts exist", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/director/renders");
      expect(res.status).toBe(200);
      expect(res.body.renders).toEqual([]);
    });

    it("returns renders with draft and render data", async () => {
      const { app } = buildApp();
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-rlist", "Render List Draft", '{}', "presentation", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");
      testDb.prepare(
        `INSERT INTO director_renders (id, draft_id, job_id, quality, status, output_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("r-list1", "d-rlist", "j-list1", "high", "complete", "/tmp/output.mp4", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

      const res = await request(app).get("/director/renders");
      expect(res.status).toBe(200);
      expect(res.body.renders).toHaveLength(1);
      expect(res.body.renders[0].draftId).toBe("d-rlist");
      expect(res.body.renders[0].draftTitle).toBe("Render List Draft");
      expect(res.body.renders[0].quality).toBe("high");
    });

    it("enriches render with live orchestrator data", async () => {
      const mockOrch = createMockRenderOrchestrator();
      mockOrch._jobs.set("j-live", {
        id: "j-live",
        status: "rendering",
        progress: 75,
        manifest: { projectTitle: "Live", templateId: "M" },
        outputPath: null,
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        durationSec: null,
        fileSizeBytes: null,
      });

      const { app } = buildApp({ renderOrchestrator: mockOrch as unknown as DirectorRouterOptions["renderOrchestrator"] });
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-live", "Live Draft", '{}', "presentation", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");
      testDb.prepare(
        `INSERT INTO director_renders (id, draft_id, job_id, quality, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("r-live", "d-live", "j-live", "standard", "queued", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

      const res = await request(app).get("/director/renders");
      expect(res.status).toBe(200);
      expect(res.body.renders[0].status).toBe("rendering");
    });
  });

  // ── GET /renders/:jobId/download ───────────────────────

  describe("GET /renders/:jobId/download", () => {
    it("returns 404 when no render record found", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/director/renders/unknown-job/download");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });

    it("returns 404 when output_path is null", async () => {
      const { app } = buildApp();
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-dl", "Download", '{}', "presentation", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");
      testDb.prepare(
        `INSERT INTO director_renders (id, draft_id, job_id, quality, status, output_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("r-dl", "d-dl", "j-dl", "standard", "queued", null, "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

      const res = await request(app).get("/director/renders/j-dl/download");
      expect(res.status).toBe(404);
    });

    it("returns 404 when render file does not exist on disk", async () => {
      const { app } = buildApp();
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-dl2", "Download2", '{}', "presentation", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");
      testDb.prepare(
        `INSERT INTO director_renders (id, draft_id, job_id, quality, status, output_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("r-dl2", "d-dl2", "j-dl2", "standard", "complete", "/tmp/nonexistent-render-xyz.mp4", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

      const res = await request(app).get("/director/renders/j-dl2/download");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found on disk");
    });
  });

  // ── POST /drafts/:id/thumbnail ─────────────────────────

  describe("POST /drafts/:id/thumbnail", () => {
    it("returns 404 for missing draft", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/drafts/nonexistent/thumbnail")
        .send({});
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });

  // ── POST /shorts - additional ─────────────────────────

  describe("POST /shorts - additional", () => {
    it("returns 404 when source video file not found", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/shorts")
        .send({ sourceVideo: "/tmp/nonexistent-shorts-video-xyz.mp4" });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });

    it("returns 503 when voice service not available", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/shorts")
        .send({ sourceVideo: "/dev/null" });
      expect(res.status).toBe(503);
      expect(res.body.error).toContain("VoiceService");
    });
  });

  // ── POST /scenes/rewrite-script - additional ──────────

  describe("POST /scenes/:sceneIndex/rewrite-script - additional", () => {
    it("returns 400 for scene index out of range", async () => {
      const { app } = buildApp();
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-rewrite", "RewriteDraft", JSON.stringify({
        timeline: [{ type: "image_scene", scriptText: "Hello world" }],
      }), "presentation", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");

      const res = await request(app)
        .post("/director/scenes/99/rewrite-script")
        .send({ draftId: "d-rewrite" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("out of range");
    });
  });

  // ── POST /render - quality presets ─────────────────────

  describe("POST /render - quality presets", () => {
    it("draft quality maps to crf 32", async () => {
      const mockOrch = createMockRenderOrchestrator();
      const { app } = buildApp({ renderOrchestrator: mockOrch as unknown as DirectorRouterOptions["renderOrchestrator"] });
      const res = await request(app).post("/director/render").send({
        manifest: { projectTitle: "T", timeline: [] },
        quality: "draft",
      });
      expect(res.status).toBe(200);
      expect(res.body.crf).toBe(32);
    });

    it("lossless quality maps to crf 0", async () => {
      const mockOrch = createMockRenderOrchestrator();
      const { app } = buildApp({ renderOrchestrator: mockOrch as unknown as DirectorRouterOptions["renderOrchestrator"] });
      const res = await request(app).post("/director/render").send({
        manifest: { projectTitle: "T", timeline: [] },
        quality: "lossless",
      });
      expect(res.status).toBe(200);
      expect(res.body.crf).toBe(0);
    });

    it("explicit crf overrides quality preset", async () => {
      const mockOrch = createMockRenderOrchestrator();
      const { app } = buildApp({ renderOrchestrator: mockOrch as unknown as DirectorRouterOptions["renderOrchestrator"] });
      const res = await request(app).post("/director/render").send({
        manifest: { projectTitle: "T", timeline: [] },
        quality: "high",
        crf: 10,
      });
      expect(res.status).toBe(200);
      expect(res.body.crf).toBe(10);
    });

    it("does not record render history without draftId", async () => {
      const mockOrch = createMockRenderOrchestrator();
      const { app } = buildApp({ renderOrchestrator: mockOrch as unknown as DirectorRouterOptions["renderOrchestrator"] });
      const res = await request(app).post("/director/render").send({
        manifest: { projectTitle: "T", timeline: [] },
      });
      expect(res.status).toBe(200);
      const rows = testDb.prepare("SELECT * FROM director_renders").all();
      expect(rows).toHaveLength(0);
    });
  });

  // ── POST /drafts - additional ─────────────────────────

  describe("POST /drafts - additional", () => {
    it("creates draft with thumbnail field", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/drafts").send({
        title: "With Thumb",
        manifest: { timeline: [] },
        productionMode: "presentation",
        thumbnail: "/tmp/thumb.jpg",
      });
      expect(res.status).toBe(200);
      const row = testDb.prepare("SELECT thumbnail FROM director_drafts WHERE id = ?")
        .get(res.body.id) as { thumbnail: string };
      expect(row.thumbnail).toBe("/tmp/thumb.jpg");
    });

    it("defaults title for whitespace-only input", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/drafts").send({
        title: "   ",
        manifest: { timeline: [] },
        productionMode: "presentation",
      });
      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Untitled Draft");
    });
  });

  // ── PUT /drafts/:id - additional ──────────────────────

  describe("PUT /drafts/:id - additional", () => {
    beforeEach(() => {
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-put2", "Original2", '{"old":true}', "highlight", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");
    });

    it("updates only manifest", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .put("/director/drafts/d-put2")
        .send({ manifest: { updated: true } });
      expect(res.status).toBe(200);
      const row = testDb.prepare("SELECT title, manifest FROM director_drafts WHERE id = ?")
        .get("d-put2") as { title: string; manifest: string };
      expect(row.title).toBe("Original2");
      expect(JSON.parse(row.manifest)).toEqual({ updated: true });
    });

    it("updates all fields simultaneously", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .put("/director/drafts/d-put2")
        .send({
          title: "New Title",
          manifest: { new: "manifest" },
          status: "published",
          thumbnail: "/thumb.jpg",
        });
      expect(res.status).toBe(200);
      const row = testDb.prepare("SELECT title, manifest, status, thumbnail FROM director_drafts WHERE id = ?")
        .get("d-put2") as { title: string; manifest: string; status: string; thumbnail: string };
      expect(row.title).toBe("New Title");
      expect(JSON.parse(row.manifest)).toEqual({ new: "manifest" });
      expect(row.status).toBe("published");
      expect(row.thumbnail).toBe("/thumb.jpg");
    });
  });

  // ── GET /drafts/:id - corrupt manifest ─────────────────

  describe("GET /drafts/:id - corrupt manifest", () => {
    it("returns null manifest for corrupt JSON", async () => {
      const { app } = buildApp();
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-bad", "Bad Manifest", "{{not json}}", "presentation", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");

      const res = await request(app).get("/director/drafts/d-bad");
      expect(res.status).toBe(200);
      expect(res.body.manifest).toBeNull();
      expect(res.body.title).toBe("Bad Manifest");
    });
  });

  // ── GET /drafts - sorting ─────────────────────────────

  describe("GET /drafts - sorting", () => {
    it("returns drafts sorted by updated_at desc", async () => {
      const { app } = buildApp();
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-old", "Old", '{}', "highlight", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-new", "New", '{}', "presentation", "2025-01-02T00:00:00Z", "2025-01-02T00:00:00Z", "draft");

      const res = await request(app).get("/director/drafts");
      expect(res.status).toBe(200);
      expect(res.body.drafts).toHaveLength(2);
      expect(res.body.drafts[0].id).toBe("d-new");
      expect(res.body.drafts[1].id).toBe("d-old");
    });
  });

  // ── POST /drafts/:id/versions - multiple ──────────────

  describe("POST /drafts/:id/versions - multiple", () => {
    it("creates multiple versions for same draft", async () => {
      const { app } = buildApp();
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-mv", "MultiVersion", '{"v":1}', "presentation", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");

      const res1 = await request(app)
        .post("/director/drafts/d-mv/versions")
        .send({ label: "Version 1" });
      expect(res1.status).toBe(201);

      testDb.prepare("UPDATE director_drafts SET manifest = ? WHERE id = ?")
        .run('{"v":2}', "d-mv");

      const res2 = await request(app)
        .post("/director/drafts/d-mv/versions")
        .send({ label: "Version 2" });
      expect(res2.status).toBe(201);

      const listRes = await request(app).get("/director/drafts/d-mv/versions");
      expect(listRes.body.versions).toHaveLength(2);
    });
  });

  // ── GET /drafts/:id/renders - enriched ─────────────────

  describe("GET /drafts/:id/renders - enriched", () => {
    it("enriches render with live orchestrator status", async () => {
      const mockOrch = createMockRenderOrchestrator();
      mockOrch._jobs.set("j-enrich", {
        id: "j-enrich",
        status: "rendering",
        progress: 60,
        manifest: { projectTitle: "E", templateId: "M" },
        outputPath: null,
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        durationSec: null,
        fileSizeBytes: null,
      });

      const { app } = buildApp({ renderOrchestrator: mockOrch as unknown as DirectorRouterOptions["renderOrchestrator"] });
      testDb.prepare(
        `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("d-enrich", "Enrich", '{}', "presentation", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "draft");
      testDb.prepare(
        `INSERT INTO director_renders (id, draft_id, job_id, quality, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run("r-en", "d-enrich", "j-enrich", "standard", "queued", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

      const res = await request(app).get("/director/drafts/d-enrich/renders");
      expect(res.status).toBe(200);
      expect(res.body.renders[0].status).toBe("rendering");
      expect(res.body.renders[0].progress).toBe(60);
    });
  });

  // ── POST /files/upload - additional ────────────────────

  describe("POST /files/upload - additional", () => {
    it("uploads audio file successfully", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/files/upload?kind=audio")
        .set("Content-Type", "application/octet-stream")
        .set("x-file-name", "song.wav")
        .send(Buffer.from("audio data"));
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("audio");
      expect(res.body.fileName).toContain("song.wav");
    });

    it("defaults filename when x-file-name header missing", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/files/upload?kind=video")
        .set("Content-Type", "application/octet-stream")
        .send(Buffer.from("video data"));
      expect(res.status).toBe(200);
      expect(res.body.fileName).toContain("upload.bin");
    });

    it("decodes url-encoded x-file-name header", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/files/upload?kind=video")
        .set("Content-Type", "application/octet-stream")
        .set("x-file-name", encodeURIComponent("my video.mp4"))
        .send(Buffer.from("video data"));
      expect(res.status).toBe(200);
      expect(res.body.fileName).toContain("my_video.mp4");
    });
  });

  // ── POST /files/upload-asset - additional ──────────────

  describe("POST /files/upload-asset - additional", () => {
    it("defaults kind to image when not specified", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/files/upload-asset")
        .set("Content-Type", "application/octet-stream")
        .set("x-file-name", "photo.jpg")
        .send(Buffer.from("image data"));
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("image");
    });
  });

  // ── POST /produce - additional validation ──────────────

  describe("POST /produce - additional validation", () => {
    it("rejects script mode without clips", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/produce")
        .send({ mode: "script" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("clips");
    });

    it("rejects highlight mode with empty clips array", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/produce")
        .send({ mode: "highlight", clips: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("clips");
    });
  });

  // ── POST /scenes/regenerate - additional ───────────────

  describe("POST /scenes/:sceneIndex/regenerate - additional", () => {
    it("rejects negative scene index", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/director/scenes/-1/regenerate")
        .send({ prompt: "test" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid scene index");
    });
  });

  // ── POST /render - codec and edge cases ────────────────

  describe("POST /render - codec", () => {
    it("passes custom codec in response", async () => {
      const mockOrch = createMockRenderOrchestrator();
      const { app } = buildApp({ renderOrchestrator: mockOrch as unknown as DirectorRouterOptions["renderOrchestrator"] });
      const res = await request(app).post("/director/render").send({
        manifest: { projectTitle: "T", timeline: [] },
        codec: "h265",
      });
      expect(res.status).toBe(200);
      expect(res.body.codec).toBe("h265");
    });
  });

  // ── POST /assets/placement - additional validation ─────

  describe("POST /assets/placement - additional validation", () => {
    it("rejects whitespace-only script", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/assets/placement").send({
        script: "   ",
        assets: [{ id: "1", path: "/a.png" }],
        videoDurationSec: 30,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("script");
    });

    it("rejects null assets", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/assets/placement").send({
        script: "Hello world",
        assets: null,
        videoDurationSec: 30,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("assets");
    });

    it("rejects zero videoDurationSec", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/director/assets/placement").send({
        script: "Hello world",
        assets: [{ id: "1", path: "/a.png" }],
        videoDurationSec: 0,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("videoDurationSec");
    });
  });
});
