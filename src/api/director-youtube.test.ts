import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { createDirectorRouter } from "./director.js";
import type { DirectorRouterOptions } from "./director.js";
import { ToolRegistry } from "../mcp/tool-registry.js";
import type { ToolDefinition } from "../mcp/tool-registry.js";
import { z } from "zod";

// ── Mocks ────────────────────────────────────────────────────

let testDb: Database.Database;

vi.mock("../productivity/database.js", () => ({
  getDatabase: () => testDb,
}));

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("nanoid", () => ({
  nanoid: (n?: number) => "yt-test-id-1234".slice(0, n ?? 12),
}));

vi.mock("../video/templates/template-registry.js", () => ({
  createTemplateRegistry: () => ({
    getAll: () => [],
    get: () => undefined,
  }),
}));

vi.mock("../video/assets/asset-manager.js", () => ({
  AssetManager: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue({ results: [], total: 0 }),
    download: vi.fn().mockResolvedValue({ filePath: "/tmp/test.mp3", asset: { id: "a1" } }),
    getLocalAssets: vi.fn().mockReturnValue([]),
    remove: vi.fn().mockResolvedValue(true),
  })),
}));

vi.mock("../config/user-model.js", () => ({
  getUserSelectedModel: vi.fn().mockResolvedValue("gpt-4o"),
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
    CREATE TABLE IF NOT EXISTS youtube_publishes (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      video_id TEXT,
      video_url TEXT,
      title TEXT NOT NULL,
      privacy_status TEXT NOT NULL DEFAULT 'private',
      published_at TEXT,
      status TEXT NOT NULL DEFAULT 'uploading',
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (draft_id) REFERENCES director_drafts(id) ON DELETE CASCADE
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

function createMockToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry({ statePath: "/tmp/test-yt-route-tools.json" });
  const mockTool: ToolDefinition = {
    name: "yt_upload_video",
    description: "Upload video",
    inputSchema: { type: "object", properties: {} },
    zodSchema: z.object({}),
    handler: vi.fn().mockResolvedValue({
      text: JSON.stringify({
        success: true,
        data: { video_id: "yt-vid-123", url: "https://www.youtube.com/watch?v=yt-vid-123" },
      }),
      isError: false,
    }),
    category: "social",
    riskLevel: "medium",
    source: "youtube",
  };
  registry.registerTool(mockTool);
  return registry;
}

function buildApp(overrides: Partial<DirectorRouterOptions> = {}) {
  const app = express();
  app.use(express.json());

  const opts: DirectorRouterOptions = {
    copilot: createMockCopilot(),
    toolRegistry: createMockToolRegistry(),
    config: {
      enabled: true,
      outputDir: "/tmp/openzigs-test-output",
      defaultTemplate: "Minimalist",
      assets: {
        localLibraryPath: "/tmp/openzigs-test-assets",
        downloadCachePath: "/tmp/openzigs-test-cache",
        pixabayApiKey: "",
        jamendoClientId: "",
        pexelsApiKey: "",
      },
    },
    ...overrides,
  };

  app.use("/director", createDirectorRouter(opts));
  return app;
}

function seedDraft(manifest?: Record<string, unknown>) {
  const now = new Date().toISOString();
  testDb.prepare(
    `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "draft-yt-1",
    "My Video Title",
    JSON.stringify(manifest ?? {
      projectTitle: "My Video Title",
      composition: { width: 1920, height: 1080, fps: 30 },
      timeline: [
        { type: "title_card", title: "Intro", durationInFrames: 90, scriptText: "Welcome to our show" },
        { type: "image_scene", title: "Topic One", durationInFrames: 300, scriptText: "Today we cover topic one" },
        { type: "image_scene", title: "Topic Two", durationInFrames: 450, scriptText: "Now let's discuss topic two" },
        { type: "outro_card", title: "Outro", durationInFrames: 90, scriptText: "Thanks for watching" },
      ],
    }),
    "ai",
    now,
    now,
  );
}

// ── Tests ────────────────────────────────────────────────────

describe("Director API — YouTube Routes", () => {
  beforeEach(() => {
    testDb = initTestDb();
  });

  describe("GET /youtube/categories", () => {
    it("returns YouTube video categories", async () => {
      const app = buildApp();
      const res = await request(app).get("/director/youtube/categories").expect(200);

      expect(res.body.categories).toBeInstanceOf(Array);
      expect(res.body.categories.length).toBeGreaterThan(0);
      expect(res.body.categories[0]).toHaveProperty("id");
      expect(res.body.categories[0]).toHaveProperty("name");

      // Check some known categories
      const ids = res.body.categories.map((c: { id: string }) => c.id);
      expect(ids).toContain("28"); // Science & Technology
      expect(ids).toContain("22"); // People & Blogs
      expect(ids).toContain("27"); // Education
    });
  });

  describe("POST /youtube/publish", () => {
    it("rejects missing draftId", async () => {
      const app = buildApp();
      const res = await request(app)
        .post("/director/youtube/publish")
        .send({ title: "Test" })
        .expect(400);

      expect(res.body.error).toContain("draftId");
    });

    it("rejects missing title", async () => {
      const app = buildApp();
      const res = await request(app)
        .post("/director/youtube/publish")
        .send({ draftId: "draft-1" })
        .expect(400);

      expect(res.body.error).toContain("title");
    });

    it("returns failed when video file does not exist", async () => {
      seedDraft();
      const app = buildApp();
      const res = await request(app)
        .post("/director/youtube/publish")
        .send({
          draftId: "draft-yt-1",
          filePath: "/nonexistent/video.mp4",
          title: "Test Upload",
        })
        .expect(200);

      expect(res.body.status).toBe("failed");
      expect(res.body.error).toContain("Video file not found");
    });

    it("returns 503 when no tool registry", async () => {
      const app = buildApp({ toolRegistry: undefined });
      const res = await request(app)
        .post("/director/youtube/publish")
        .send({ draftId: "draft-1", title: "Test" })
        .expect(503);

      expect(res.body.error).toContain("Tool registry");
    });
  });

  describe("GET /youtube/publish/:draftId/status", () => {
    it("returns none when no publishes exist", async () => {
      const app = buildApp();
      const res = await request(app)
        .get("/director/youtube/publish/draft-yt-1/status")
        .expect(200);

      expect(res.body.status).toBe("none");
    });

    it("returns latest status after a publish attempt", async () => {
      seedDraft();
      const now = new Date().toISOString();
      testDb.prepare(
        `INSERT INTO youtube_publishes (id, draft_id, video_id, video_url, title, privacy_status, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("pub-test-1", "draft-yt-1", "vid-abc", "https://youtube.com/watch?v=vid-abc", "My Video", "public", "published", now, now);

      const app = buildApp();
      const res = await request(app)
        .get("/director/youtube/publish/draft-yt-1/status")
        .expect(200);

      expect(res.body.status).toBe("published");
      expect(res.body.videoId).toBe("vid-abc");
    });
  });

  describe("GET /youtube/publish/:draftId/history", () => {
    it("returns empty history", async () => {
      const app = buildApp();
      const res = await request(app)
        .get("/director/youtube/publish/draft-yt-1/history")
        .expect(200);

      expect(res.body.publishes).toEqual([]);
    });

    it("returns publish history", async () => {
      seedDraft();
      const now = new Date().toISOString();
      testDb.prepare(
        `INSERT INTO youtube_publishes (id, draft_id, title, privacy_status, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("pub-h-1", "draft-yt-1", "V1", "private", "failed", now, now);
      testDb.prepare(
        `INSERT INTO youtube_publishes (id, draft_id, title, privacy_status, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("pub-h-2", "draft-yt-1", "V2", "public", "published", now, now);

      const app = buildApp();
      const res = await request(app)
        .get("/director/youtube/publish/draft-yt-1/history")
        .expect(200);

      expect(res.body.publishes).toHaveLength(2);
    });
  });

  describe("POST /youtube/generate-metadata", () => {
    it("rejects missing draftId", async () => {
      const app = buildApp();
      const res = await request(app)
        .post("/director/youtube/generate-metadata")
        .send({})
        .expect(400);

      expect(res.body.error).toContain("draftId");
    });

    it("returns 404 for nonexistent draft", async () => {
      const app = buildApp();
      const res = await request(app)
        .post("/director/youtube/generate-metadata")
        .send({ draftId: "nonexistent" })
        .expect(404);

      expect(res.body.error).toContain("Draft not found");
    });

    it("generates metadata when copilot returns valid JSON", async () => {
      seedDraft();

      const mockCopilot = createMockCopilot();
      // Make chat return an async generator
      const seoResponse = JSON.stringify({
        title: "Amazing Video About Topics",
        description: "A great video covering important stuff. #tech #trends",
        tags: ["tech", "trends", "tutorial"],
        suggestedCategory: "Science & Technology",
      });

      (mockCopilot.chat as ReturnType<typeof vi.fn>).mockImplementation(function* () {
        yield seoResponse;
      });

      const app = buildApp({ copilot: mockCopilot });
      const res = await request(app)
        .post("/director/youtube/generate-metadata")
        .send({ draftId: "draft-yt-1" })
        .expect(200);

      expect(res.body.title).toBe("Amazing Video About Topics");
      expect(res.body.tags).toContain("tech");
      expect(res.body.suggestedCategory).toBe("Science & Technology");
      expect(res.body.chapters).toBeTruthy(); // Should have auto-generated chapters
    });
  });
});
