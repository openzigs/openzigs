/**
 * Tests for the new claim/cancel endpoints added in Epic #910 (#841/#842).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createSeoRouter } from "./seo.js";

vi.mock("../mcp/tools/seo/audit-history.js", () => ({
  AuditHistoryRepository: vi.fn().mockImplementation(() => ({
    listSnapshots: vi.fn().mockReturnValue([]),
    listAll: vi.fn().mockReturnValue([]),
    getSnapshot: vi.fn().mockReturnValue(null),
    compareLatest: vi.fn().mockReturnValue(null),
  })),
}));
vi.mock("../mcp/tools/seo/report-export.js", () => ({
  exportAudit: vi.fn(),
}));
vi.mock("../mcp/tools/seo/competitive-discover.js", () => ({
  discoverCompetitorsFromAudit: vi.fn(),
}));
vi.mock("../logging/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

interface MockHandler {
  claimCrawlForClient: ReturnType<typeof vi.fn>;
  cancelCrawl: ReturnType<typeof vi.fn>;
  getCrawlStats: ReturnType<typeof vi.fn>;
}

function createAppWithHandler(handler?: MockHandler) {
  const mockDb = {} as import("better-sqlite3").Database;
  const app = express();
  app.use(express.json());
  app.use(
    "/api/seo",
    createSeoRouter({
      db: mockDb,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      firecrawlWebhookHandler: handler as any,
    }),
  );
  return app;
}

describe("POST /api/seo/audit/claim (#841)", () => {
  let handler: MockHandler;
  beforeEach(() => {
    handler = {
      claimCrawlForClient: vi.fn(),
      cancelCrawl: vi.fn(),
      getCrawlStats: vi.fn().mockReturnValue(null),
    };
  });

  it("claims a URL for a clientId", async () => {
    const app = createAppWithHandler(handler);
    const res = await request(app).post("/api/seo/audit/claim").send({
      url: "https://example.com",
      clientId: "abc-123",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "claimed", clientId: "abc-123" });
    expect(handler.claimCrawlForClient).toHaveBeenCalledWith(
      "https://example.com",
      "abc-123",
    );
  });

  it("normalizes URL when missing scheme", async () => {
    const app = createAppWithHandler(handler);
    const res = await request(app).post("/api/seo/audit/claim").send({
      url: "example.com",
      clientId: "abc",
    });
    expect(res.status).toBe(200);
    expect(handler.claimCrawlForClient).toHaveBeenCalledWith(
      "https://example.com",
      "abc",
    );
  });

  it("rejects missing fields", async () => {
    const app = createAppWithHandler(handler);
    const res = await request(app).post("/api/seo/audit/claim").send({
      url: "https://example.com",
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid clientId format", async () => {
    const app = createAppWithHandler(handler);
    const res = await request(app).post("/api/seo/audit/claim").send({
      url: "https://example.com",
      clientId: "<script>alert(1)</script>",
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid URL", async () => {
    const app = createAppWithHandler(handler);
    const res = await request(app).post("/api/seo/audit/claim").send({
      url: "ftp://nope",
      clientId: "abc",
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when handler is not configured", async () => {
    const app = createAppWithHandler(undefined);
    const res = await request(app).post("/api/seo/audit/claim").send({
      url: "https://example.com",
      clientId: "abc",
    });
    expect(res.status).toBe(503);
  });
});

describe("POST /api/seo/audit/:jobId/cancel (#842)", () => {
  let handler: MockHandler;
  beforeEach(() => {
    handler = {
      claimCrawlForClient: vi.fn(),
      cancelCrawl: vi.fn().mockReturnValue(true),
      // No clientId on stats → ownership check passes (any caller may cancel).
      getCrawlStats: vi.fn().mockReturnValue(null),
    };
  });

  it("cancels an in-progress job", async () => {
    const app = createAppWithHandler(handler);
    const res = await request(app).post("/api/seo/audit/abc123def456/cancel");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "cancelled" });
    expect(handler.cancelCrawl).toHaveBeenCalledWith("abc123def456");
  });

  it("returns 404 for unknown job", async () => {
    handler.cancelCrawl = vi.fn().mockReturnValue(false);
    const app = createAppWithHandler(handler);
    const res = await request(app).post("/api/seo/audit/deadbeef/cancel");
    expect(res.status).toBe(404);
  });

  it("rejects invalid jobId format", async () => {
    const app = createAppWithHandler(handler);
    const res = await request(app).post("/api/seo/audit/not-hex!/cancel");
    expect(res.status).toBe(400);
  });

  it("returns 503 when handler unavailable", async () => {
    const app = createAppWithHandler(undefined);
    const res = await request(app).post("/api/seo/audit/abc/cancel");
    expect(res.status).toBe(503);
  });

  it("returns 403 when clientId does not match crawl owner", async () => {
    handler.getCrawlStats = vi.fn().mockReturnValue({ clientId: "owner-123" });
    const app = createAppWithHandler(handler);
    const res = await request(app)
      .post("/api/seo/audit/abc123def456/cancel")
      .send({ clientId: "intruder-999" });
    expect(res.status).toBe(403);
    expect(handler.cancelCrawl).not.toHaveBeenCalled();
  });

  it("allows cancel when clientId matches crawl owner", async () => {
    handler.getCrawlStats = vi.fn().mockReturnValue({ clientId: "owner-123" });
    const app = createAppWithHandler(handler);
    const res = await request(app)
      .post("/api/seo/audit/abc123def456/cancel")
      .send({ clientId: "owner-123" });
    expect(res.status).toBe(200);
  });
});
