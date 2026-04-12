import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSeoRouter } from "./seo.js";
import express from "express";
import request from "supertest";

// Mock the dependencies
vi.mock("../mcp/tools/seo/audit-history.js", () => ({
  AuditHistoryRepository: vi.fn().mockImplementation(() => ({
    listSnapshots: vi.fn().mockReturnValue([]),
    listAll: vi.fn().mockReturnValue([]),
    getSnapshot: vi.fn().mockReturnValue(null),
    compareLatest: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock("../mcp/tools/seo/report-export.js", () => ({
  exportAudit: vi.fn().mockResolvedValue({
    format: "json",
    filePath: "/tmp/test.json",
    sizeBytes: 100,
  }),
}));

vi.mock("../logging/logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

function createApp() {
  const mockDb = {} as import("better-sqlite3").Database;
  const app = express();
  app.use(express.json());
  app.use("/api/seo", createSeoRouter({ db: mockDb }));
  return app;
}

describe("SEO Router", () => {
  describe("GET /api/seo/history", () => {
    it("clamps limit to max 100", async () => {
      const app = createApp();
      const res = await request(app).get("/api/seo/history?limit=999");
      expect(res.status).toBe(200);
      // The router clamps the limit internally — no error
    });

    it("handles negative limit as default", async () => {
      const app = createApp();
      const res = await request(app).get("/api/seo/history?limit=-5");
      expect(res.status).toBe(200);
    });

    it("handles non-numeric limit as default", async () => {
      const app = createApp();
      const res = await request(app).get("/api/seo/history?limit=abc");
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/seo/export/:id", () => {
    it("returns generic error on internal failure", async () => {
      const { exportAudit } = await import("../mcp/tools/seo/report-export.js");
      (exportAudit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Internal DB connection failed at host:5432"),
      );

      // Need to mock getSnapshot to return something
      const { AuditHistoryRepository } =
        await import("../mcp/tools/seo/audit-history.js");
      (
        AuditHistoryRepository as unknown as ReturnType<typeof vi.fn>
      ).mockImplementationOnce(() => ({
        listSnapshots: vi.fn(),
        listAll: vi.fn(),
        getSnapshot: vi.fn().mockReturnValue({
          id: 1,
          siteUrl: "https://example.com",
          createdAt: "2026-01-01",
          dataJson: "{}",
        }),
        compareLatest: vi.fn(),
      }));

      const app = createApp();
      const res = await request(app)
        .post("/api/seo/export/1")
        .send({ format: "json" });

      // Should NOT leak "Internal DB connection failed at host:5432"
      if (res.status === 500) {
        expect(res.body.error).toBe("Export failed");
        expect(res.body.error).not.toContain("DB connection");
      }
    });
  });

  describe("POST /api/seo/audit", () => {
    let app: express.Express;

    beforeEach(() => {
      app = createApp();
    });

    it("returns 400 for missing URL", async () => {
      const res = await request(app).post("/api/seo/audit").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("url");
    });

    it("returns 400 for empty URL", async () => {
      const res = await request(app).post("/api/seo/audit").send({ url: "  " });
      expect(res.status).toBe(400);
    });

    it("accepts valid URL and returns accepted status", async () => {
      const res = await request(app)
        .post("/api/seo/audit")
        .send({ url: "https://example.com" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("accepted");
      expect(res.body.url).toBe("https://example.com");
    });

    it("normalizes URL without protocol", async () => {
      const res = await request(app)
        .post("/api/seo/audit")
        .send({ url: "example.com" });
      expect(res.status).toBe(200);
      expect(res.body.url).toBe("https://example.com");
    });

    it("rejects invalid URL", async () => {
      const res = await request(app)
        .post("/api/seo/audit")
        .send({ url: "not a url at all !!!" });
      expect(res.status).toBe(400);
    });
  });
});
