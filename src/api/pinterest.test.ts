import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { PinterestTrackerRepository } from "../mcp/tools/pinterest-tracker.js";

// Mock heavy dependencies
vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Create an in-memory database for testing
let testDb: InstanceType<typeof Database>;

vi.mock("../productivity/database.js", () => ({
  getDatabase: () => testDb,
}));

// Mock the fs module (synchronous methods used by pinterest.ts)
const mockFs = {
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
};

vi.mock("node:fs", () => ({
  default: {
    existsSync: (...args: unknown[]) => mockFs.existsSync(...args),
    readdirSync: (...args: unknown[]) => mockFs.readdirSync(...args),
    statSync: (...args: unknown[]) => mockFs.statSync(...args),
    readFileSync: (...args: unknown[]) => mockFs.readFileSync(...args),
    mkdirSync: (...args: unknown[]) => mockFs.mkdirSync(...args),
  },
  existsSync: (...args: unknown[]) => mockFs.existsSync(...args),
  readdirSync: (...args: unknown[]) => mockFs.readdirSync(...args),
  statSync: (...args: unknown[]) => mockFs.statSync(...args),
  readFileSync: (...args: unknown[]) => mockFs.readFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockFs.mkdirSync(...args),
}));

// Import AFTER mocks are set up
import { createPinterestRouter } from "./pinterest.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  const router = createPinterestRouter();
  app.use("/pinterest", router);
  return app;
}

describe("Pinterest API router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testDb = new Database(":memory:");
    testDb.pragma("journal_mode = WAL");
    testDb.pragma("foreign_keys = ON");
    new PinterestTrackerRepository(testDb).migrate();
  });

  afterEach(() => {
    try { testDb.close(); } catch { /* ignore */ }
  });

  // ── GET /reports ──────────────────────────────────────────

  describe("GET /reports", () => {
    it("returns empty array when reports dir does not exist", async () => {
      mockFs.existsSync.mockReturnValue(false);
      const app = buildApp();
      const res = await request(app).get("/pinterest/reports");
      expect(res.status).toBe(200);
      expect(res.body.reports).toEqual([]);
    });

    it("returns sorted reports with metadata", async () => {
      mockFs.existsSync.mockImplementation((p: string) => {
        if (p.endsWith(".json")) return true;
        return true; // reports dir exists
      });
      mockFs.readdirSync.mockReturnValue([
        "seo-analysis-my-pin-2026-03-09T15-44-04.md",
        "keyword-metrics-cooking-2026-03-10T10-00-00.md",
      ]);
      mockFs.statSync.mockReturnValue({ size: 1234, mtime: new Date("2026-03-09") });

      const app = buildApp();
      const res = await request(app).get("/pinterest/reports");
      expect(res.status).toBe(200);
      expect(res.body.reports).toHaveLength(2);
      // Newest first
      expect(res.body.reports[0].type).toBe("keyword-metrics");
      expect(res.body.reports[0].hasJson).toBe(true);
      expect(res.body.reports[1].type).toBe("seo-analysis");
    });

    it("extracts report type from filename", async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(["analytics-board-2026-01-01T00-00-00.md"]);
      mockFs.statSync.mockReturnValue({ size: 500, mtime: new Date() });

      const app = buildApp();
      const res = await request(app).get("/pinterest/reports");
      expect(res.body.reports[0].type).toBe("analytics");
    });

    it("uses unknown type for unrecognized filenames", async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(["random-file.md"]);
      mockFs.statSync.mockReturnValue({ size: 100, mtime: new Date() });

      const app = buildApp();
      const res = await request(app).get("/pinterest/reports");
      expect(res.body.reports[0].type).toBe("unknown");
    });
  });

  // ── GET /reports/:filename ──────────────────────────────────

  describe("GET /reports/:filename", () => {
    it("returns JSON data when JSON file exists", async () => {
      mockFs.existsSync.mockImplementation((p: string) => p.endsWith(".json"));
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ score: 85 }));

      const app = buildApp();
      const res = await request(app).get("/pinterest/reports/my-report");
      expect(res.status).toBe(200);
      expect(res.body.format).toBe("json");
      expect(res.body.data.score).toBe(85);
    });

    it("falls back to markdown when JSON parse fails", async () => {
      mockFs.existsSync.mockImplementation((p: string) => {
        if (p.endsWith(".json")) return true;
        if (p.endsWith(".md")) return true;
        return false;
      });
      // JSON parse will fail
      mockFs.readFileSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith(".json")) throw new Error("parse error");
        return "# Report\nContent here";
      });

      const app = buildApp();
      const res = await request(app).get("/pinterest/reports/my-report");
      expect(res.status).toBe(200);
      expect(res.body.format).toBe("markdown");
      expect(res.body.content).toContain("# Report");
    });

    it("returns markdown when no JSON exists", async () => {
      mockFs.existsSync.mockImplementation((p: string) => p.endsWith(".md"));
      mockFs.readFileSync.mockReturnValue("# SEO Report");

      const app = buildApp();
      const res = await request(app).get("/pinterest/reports/seo-report");
      expect(res.status).toBe(200);
      expect(res.body.format).toBe("markdown");
    });

    it("returns 404 when neither file exists", async () => {
      mockFs.existsSync.mockReturnValue(false);

      const app = buildApp();
      const res = await request(app).get("/pinterest/reports/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Report not found");
    });

    it("sanitizes filename to prevent path traversal", async () => {
      mockFs.existsSync.mockReturnValue(false);

      const app = buildApp();
      const res = await request(app).get("/pinterest/reports/../../etc/passwd");
      expect(res.status).toBe(404);
      // path.basename strips the traversal
    });
  });

  // ── GET /status ──────────────────────────────────────────

  describe("GET /status", () => {
    it("returns disconnected when no token", async () => {
      delete process.env.PINTEREST_ACCESS_TOKEN;
      mockFs.existsSync.mockReturnValue(false);

      const app = buildApp();
      const res = await request(app).get("/pinterest/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.reportCount).toBe(0);
    });

    it("returns connected with report count", async () => {
      process.env.PINTEREST_ACCESS_TOKEN = "test-token";
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(["report1.md", "report2.md", "data.json"]);

      const app = buildApp();
      const res = await request(app).get("/pinterest/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.reportCount).toBe(2); // only .md files

      delete process.env.PINTEREST_ACCESS_TOKEN;
    });
  });

  // ── Tracker: Pins ─────────────────────────────────────────

  describe("Tracker: Tracked Pins", () => {
    it("GET /tracker/pins returns empty list initially", async () => {
      const app = buildApp();
      const res = await request(app).get("/pinterest/tracker/pins");
      expect(res.status).toBe(200);
      expect(res.body.pins).toEqual([]);
    });

    it("POST /tracker/pins creates a tracked pin", async () => {
      const app = buildApp();
      const res = await request(app).post("/pinterest/tracker/pins").send({
        pin_id: "pin-001",
        title: "Test Pin",
        topic: "AI",
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const list = await request(app).get("/pinterest/tracker/pins");
      expect(list.body.pins).toHaveLength(1);
      expect(list.body.pins[0].pin_id).toBe("pin-001");
      expect(list.body.pins[0].title).toBe("Test Pin");
    });

    it("POST /tracker/pins returns 400 when pin_id missing", async () => {
      const app = buildApp();
      const res = await request(app).post("/pinterest/tracker/pins").send({ title: "No ID" });
      expect(res.status).toBe(400);
    });

    it("GET /tracker/pins/:pinId returns pin summary", async () => {
      const app = buildApp();
      await request(app).post("/pinterest/tracker/pins").send({ pin_id: "pin-001", title: "Test" });
      const res = await request(app).get("/pinterest/tracker/pins/pin-001");
      expect(res.status).toBe(200);
      expect(res.body.pin.pin_id).toBe("pin-001");
      expect(res.body.totalSnapshots).toBe(0);
    });

    it("GET /tracker/pins/:pinId returns 404 for unknown pin", async () => {
      const app = buildApp();
      const res = await request(app).get("/pinterest/tracker/pins/nope");
      expect(res.status).toBe(404);
    });

    it("DELETE /tracker/pins/:pinId removes a pin", async () => {
      const app = buildApp();
      await request(app).post("/pinterest/tracker/pins").send({ pin_id: "pin-001" });
      const res = await request(app).delete("/pinterest/tracker/pins/pin-001");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const list = await request(app).get("/pinterest/tracker/pins");
      expect(list.body.pins).toHaveLength(0);
    });

    it("DELETE /tracker/pins/:pinId returns 404 for unknown pin", async () => {
      const app = buildApp();
      const res = await request(app).delete("/pinterest/tracker/pins/nope");
      expect(res.status).toBe(404);
    });

    it("PATCH /tracker/pins/:pinId/status updates status", async () => {
      const app = buildApp();
      await request(app).post("/pinterest/tracker/pins").send({ pin_id: "pin-001" });
      const res = await request(app).patch("/pinterest/tracker/pins/pin-001/status").send({ status: "paused" });
      expect(res.status).toBe(200);

      const detail = await request(app).get("/pinterest/tracker/pins/pin-001");
      expect(detail.body.pin.status).toBe("paused");
    });

    it("PATCH /tracker/pins/:pinId/status returns 400 for invalid status", async () => {
      const app = buildApp();
      await request(app).post("/pinterest/tracker/pins").send({ pin_id: "pin-001" });
      const res = await request(app).patch("/pinterest/tracker/pins/pin-001/status").send({ status: "invalid" });
      expect(res.status).toBe(400);
    });

    it("GET /tracker/pins filters by status query param", async () => {
      const app = buildApp();
      await request(app).post("/pinterest/tracker/pins").send({ pin_id: "pin-001", status: "active" });
      await request(app).post("/pinterest/tracker/pins").send({ pin_id: "pin-002", status: "paused" });

      const active = await request(app).get("/pinterest/tracker/pins?status=active");
      expect(active.body.pins).toHaveLength(1);
      expect(active.body.pins[0].pin_id).toBe("pin-001");
    });
  });

  // ── Tracker: Snapshots ────────────────────────────────────

  describe("Tracker: Snapshots", () => {
    it("POST /tracker/pins/:pinId/snapshots adds a snapshot", async () => {
      const app = buildApp();
      await request(app).post("/pinterest/tracker/pins").send({ pin_id: "pin-001" });
      const res = await request(app).post("/pinterest/tracker/pins/pin-001/snapshots").send({
        impressions: 100,
        pin_clicks: 10,
        saves: 5,
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.id).toBeGreaterThan(0);
    });

    it("GET /tracker/pins/:pinId/snapshots returns snapshot history", async () => {
      const app = buildApp();
      await request(app).post("/pinterest/tracker/pins").send({ pin_id: "pin-001" });
      await request(app).post("/pinterest/tracker/pins/pin-001/snapshots").send({ impressions: 50 });
      await request(app).post("/pinterest/tracker/pins/pin-001/snapshots").send({ impressions: 100 });

      const res = await request(app).get("/pinterest/tracker/pins/pin-001/snapshots");
      expect(res.status).toBe(200);
      expect(res.body.snapshots).toHaveLength(2);
    });

    it("GET /tracker/pins/:pinId/snapshots respects limit param", async () => {
      const app = buildApp();
      await request(app).post("/pinterest/tracker/pins").send({ pin_id: "pin-001" });
      for (let i = 0; i < 5; i++) {
        await request(app).post("/pinterest/tracker/pins/pin-001/snapshots").send({ impressions: i * 10 });
      }
      const res = await request(app).get("/pinterest/tracker/pins/pin-001/snapshots?limit=2");
      expect(res.body.snapshots).toHaveLength(2);
    });
  });

  // ── Tracker: Content Ideas ────────────────────────────────

  describe("Tracker: Content Ideas", () => {
    it("GET /tracker/ideas returns empty list initially", async () => {
      const app = buildApp();
      const res = await request(app).get("/pinterest/tracker/ideas");
      expect(res.status).toBe(200);
      expect(res.body.ideas).toEqual([]);
    });

    it("POST /tracker/ideas creates a content idea", async () => {
      const app = buildApp();
      const res = await request(app).post("/pinterest/tracker/ideas").send({
        topic: "AI",
        suggested_title: "Top 10 AI Tools",
        target_keywords: ["ai tools", "ai apps"],
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const list = await request(app).get("/pinterest/tracker/ideas");
      expect(list.body.ideas).toHaveLength(1);
      expect(list.body.ideas[0].suggested_title).toBe("Top 10 AI Tools");
    });

    it("POST /tracker/ideas returns 400 when topic missing", async () => {
      const app = buildApp();
      const res = await request(app).post("/pinterest/tracker/ideas").send({ suggested_title: "Title" });
      expect(res.status).toBe(400);
    });

    it("PATCH /tracker/ideas/:id/status updates idea status", async () => {
      const app = buildApp();
      const createRes = await request(app).post("/pinterest/tracker/ideas").send({
        topic: "AI",
        suggested_title: "Test",
      });
      const id = createRes.body.id;

      const res = await request(app).patch(`/pinterest/tracker/ideas/${id}/status`).send({ status: "created" });
      expect(res.status).toBe(200);

      const list = await request(app).get("/pinterest/tracker/ideas?status=created");
      expect(list.body.ideas).toHaveLength(1);
    });

    it("PATCH /tracker/ideas/:id/status returns 400 for invalid status", async () => {
      const app = buildApp();
      const res = await request(app).patch("/pinterest/tracker/ideas/1/status").send({ status: "invalid" });
      expect(res.status).toBe(400);
    });

    it("DELETE /tracker/ideas/:id removes an idea", async () => {
      const app = buildApp();
      const createRes = await request(app).post("/pinterest/tracker/ideas").send({
        topic: "AI",
        suggested_title: "Delete Me",
      });
      const res = await request(app).delete(`/pinterest/tracker/ideas/${createRes.body.id}`);
      expect(res.status).toBe(200);

      const list = await request(app).get("/pinterest/tracker/ideas");
      expect(list.body.ideas).toHaveLength(0);
    });

    it("DELETE /tracker/ideas/:id returns 404 for nonexistent", async () => {
      const app = buildApp();
      const res = await request(app).delete("/pinterest/tracker/ideas/999");
      expect(res.status).toBe(404);
    });
  });

  // ── Tracker: Seed ─────────────────────────────────────────

  describe("Tracker: Seed", () => {
    it("POST /tracker/seed creates test pins, snapshots, and ideas", async () => {
      const app = buildApp();
      const res = await request(app).post("/pinterest/tracker/seed");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.pins).toBe(5);
      expect(res.body.snapshots).toBe(155); // 5 pins * 31 days
      expect(res.body.ideas).toBe(4);

      // Verify data persisted
      const pinsRes = await request(app).get("/pinterest/tracker/pins");
      expect(pinsRes.body.pins.length).toBe(5);

      const ideasRes = await request(app).get("/pinterest/tracker/ideas");
      expect(ideasRes.body.ideas.length).toBe(4);
    });
  });
});
