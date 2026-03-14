import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { createOutboxRouter } from "./outbox.js";
import { OutboxRepository } from "../outbox/outbox-repository.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let repo: OutboxRepository;
let app: express.Express;

beforeEach(() => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  repo = new OutboxRepository(db);
  repo.migrate();

  app = express();
  app.use(express.json());
  app.use("/outbox", createOutboxRouter({ outboxRepo: repo }));
});

const VALID_ITEM = {
  platform: "twitter",
  scheduled_time: new Date(Date.now() + 60_000).toISOString(),
  agent_context: "Post about new feature launch",
  asset_type: "image",
};

const VALID_ITEM_WITH_CONTENT = {
  platform: "pinterest",
  scheduled_time: new Date(Date.now() + 60_000).toISOString(),
  agent_context: "Pin this markdown content with banner image",
  title: "My Pinterest Post",
  content_body: "# Hello\nSome markdown content",
  attachments: [
    { filePath: "/home/user/banner.png", filename: "banner.png", assetType: "image" },
  ],
};

describe("Outbox API", () => {
  describe("POST /outbox", () => {
    it("creates an item successfully", async () => {
      const res = await request(app).post("/outbox").send(VALID_ITEM).expect(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.platform).toBe("twitter");
      expect(res.body.status).toBe("pending");
      expect(res.body.agentContext).toBe("Post about new feature launch");
    });

    it("rejects missing platform", async () => {
      await request(app).post("/outbox").send({
        scheduled_time: VALID_ITEM.scheduled_time,
        agent_context: VALID_ITEM.agent_context,
        asset_type: VALID_ITEM.asset_type,
      }).expect(400);
    });

    it("rejects invalid scheduled_time", async () => {
      await request(app).post("/outbox").send({ ...VALID_ITEM, scheduled_time: "not-a-date" }).expect(400);
    });

    it("rejects empty agent_context", async () => {
      await request(app).post("/outbox").send({ ...VALID_ITEM, agent_context: "" }).expect(400);
    });

    it("creates an item with title, content_body, and attachments", async () => {
      const res = await request(app).post("/outbox").send(VALID_ITEM_WITH_CONTENT).expect(201);
      expect(res.body.title).toBe("My Pinterest Post");
      expect(res.body.contentBody).toBe("# Hello\nSome markdown content");
      expect(res.body.attachments).toHaveLength(1);
      expect(res.body.attachments[0].filename).toBe("banner.png");
    });

    it("creates a text-only item without attachments", async () => {
      const res = await request(app).post("/outbox").send({
        platform: "twitter",
        scheduled_time: new Date(Date.now() + 60_000).toISOString(),
        agent_context: "Tweet this",
        title: "Quick tweet",
        content_body: "Just shipped a new feature!",
      }).expect(201);
      expect(res.body.title).toBe("Quick tweet");
      expect(res.body.contentBody).toBe("Just shipped a new feature!");
      expect(res.body.attachments).toEqual([]);
    });
  });

  describe("GET /outbox", () => {
    it("returns empty list initially", async () => {
      const res = await request(app).get("/outbox").expect(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it("returns created items", async () => {
      await request(app).post("/outbox").send(VALID_ITEM);
      await request(app).post("/outbox").send({ ...VALID_ITEM, platform: "pinterest" });
      const res = await request(app).get("/outbox").expect(200);
      expect(res.body.items).toHaveLength(2);
    });

    it("filters by platform", async () => {
      await request(app).post("/outbox").send(VALID_ITEM);
      await request(app).post("/outbox").send({ ...VALID_ITEM, platform: "pinterest" });
      const res = await request(app).get("/outbox?platform=twitter").expect(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].platform).toBe("twitter");
    });

    it("filters by status", async () => {
      await request(app).post("/outbox").send(VALID_ITEM);
      const res = await request(app).get("/outbox?status=published").expect(200);
      expect(res.body.items).toHaveLength(0);
    });
  });

  describe("GET /outbox/stats", () => {
    it("returns zeroes initially", async () => {
      const res = await request(app).get("/outbox/stats").expect(200);
      expect(res.body.total).toBe(0);
      expect(res.body.pending).toBe(0);
    });

    it("reflects created item", async () => {
      await request(app).post("/outbox").send(VALID_ITEM);
      const res = await request(app).get("/outbox/stats").expect(200);
      expect(res.body.pending).toBe(1);
      expect(res.body.total).toBe(1);
    });
  });

  describe("GET /outbox/:id", () => {
    it("returns a single item", async () => {
      const created = await request(app).post("/outbox").send(VALID_ITEM).expect(201);
      const res = await request(app).get(`/outbox/${created.body.id}`).expect(200);
      expect(res.body.id).toBe(created.body.id);
    });

    it("returns 404 for missing item", async () => {
      await request(app).get("/outbox/nonexistent-id").expect(404);
    });
  });

  describe("POST /outbox/:id/retry", () => {
    it("retries a failed item", async () => {
      const pastItem = { ...VALID_ITEM, scheduled_time: new Date(Date.now() - 60_000).toISOString() };
      const created = await request(app).post("/outbox").send(pastItem).expect(201);
      // Move to processing then failed via repo
      repo.claimPending(10); // moves to processing
      repo.markFailed(created.body.id, "timeout");

      const res = await request(app).post(`/outbox/${created.body.id}/retry`).expect(200);
      expect(res.body.status).toBe("pending");
      expect(res.body.retryCount).toBe(1);
    });

    it("rejects retry for non-failed item", async () => {
      const created = await request(app).post("/outbox").send(VALID_ITEM).expect(201);
      await request(app).post(`/outbox/${created.body.id}/retry`).expect(400);
    });
  });

  describe("POST /outbox/:id/cancel", () => {
    it("cancels a pending item", async () => {
      const created = await request(app).post("/outbox").send(VALID_ITEM).expect(201);
      const res = await request(app).post(`/outbox/${created.body.id}/cancel`).expect(200);
      expect(res.body.status).toBe("canceled");
    });

    it("rejects cancel for published item", async () => {
      const pastItem = { ...VALID_ITEM, scheduled_time: new Date(Date.now() - 60_000).toISOString() };
      const created = await request(app).post("/outbox").send(pastItem).expect(201);
      repo.claimPending(10); // moves to processing
      repo.markPublished(created.body.id, "https://x.com/post/1");
      await request(app).post(`/outbox/${created.body.id}/cancel`).expect(400);
    });
  });

  describe("DELETE /outbox/:id", () => {
    it("deletes an item", async () => {
      const created = await request(app).post("/outbox").send(VALID_ITEM).expect(201);
      await request(app).delete(`/outbox/${created.body.id}`).expect(200);
      await request(app).get(`/outbox/${created.body.id}`).expect(404);
    });

    it("returns 404 for missing item", async () => {
      await request(app).delete("/outbox/nonexistent").expect(404);
    });
  });

  describe("GET /outbox/browse", () => {
    it("lists files in the home directory by default", async () => {
      const res = await request(app).get("/outbox/browse").expect(200);
      expect(res.body.dir).toBeDefined();
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.parent).toBeDefined();
    });

    it("lists files in a specific directory", async () => {
      const res = await request(app).get("/outbox/browse?dir=" + encodeURIComponent(process.env.HOME || "~")).expect(200);
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    it("returns 403 for paths outside home directory", async () => {
      await request(app).get("/outbox/browse?dir=/etc").expect(403);
    });
  });
});
