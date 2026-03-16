import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { createOutboxRouter } from "./outbox.js";
import { OutboxRepository } from "../outbox/outbox-repository.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../video/generators/image-gen-service.js", () => ({
  ImageGenService: class {
    static async loadUserImageGenConfig() { return {}; }
    async generateImage(_prompt: string) {
      return {
        filePath: `/tmp/openzigs-image-gen/generated-${Date.now()}.png`,
        provider: "local" as const,
        generationTimeMs: 100,
        width: 1024,
        height: 1024,
      };
    }
  },
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

/** Helper to create an Express app with a mock CopilotWrapper for generate-preview tests. */
function createAppWithCopilot(
  aiResponse?: string,
  chatSpy?: ReturnType<typeof vi.fn>,
  opts?: { mediaQueueRepo?: Record<string, unknown> },
) {
  const mockCopilot = {
    async *chat(message: string, options?: Record<string, unknown>) {
      if (chatSpy) chatSpy(message, options);
      yield aiResponse ?? "";
    },
  };
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = WAL");
  testDb.pragma("foreign_keys = ON");
  const testRepo = new OutboxRepository(testDb);
  testRepo.migrate();

  const testApp = express();
  testApp.use(express.json());
  testApp.use("/outbox", createOutboxRouter({
    outboxRepo: testRepo,
    copilotWrapper: mockCopilot as any,
    ...(opts?.mediaQueueRepo ? { mediaQueueRepo: opts.mediaQueueRepo as any } : {}),
  }));
  return testApp;
}

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

  describe("POST /outbox/generate-preview", () => {
    it("returns 503 when copilotWrapper is not provided", async () => {
      // Default app has no copilotWrapper
      const res = await request(app)
        .post("/outbox/generate-preview")
        .send({ url: "https://example.com", platforms: ["twitter"] })
        .expect(503);
      expect(res.body.error).toContain("AI backend is not available");
    });

    it("returns 400 for missing URL", async () => {
      const aiApp = createAppWithCopilot();
      await request(aiApp)
        .post("/outbox/generate-preview")
        .send({ platforms: ["twitter"] })
        .expect(400);
    });

    it("returns 400 for empty platforms array", async () => {
      const aiApp = createAppWithCopilot();
      await request(aiApp)
        .post("/outbox/generate-preview")
        .send({ url: "https://example.com", platforms: [] })
        .expect(400);
    });

    it("returns 400 for invalid platform name", async () => {
      const aiApp = createAppWithCopilot();
      await request(aiApp)
        .post("/outbox/generate-preview")
        .send({ url: "https://example.com", platforms: ["tiktok"] })
        .expect(400);
    });

    it("calls copilotWrapper.chat and returns parsed JSON", async () => {
      const aiApp = createAppWithCopilot(
        JSON.stringify({ previews: { twitter: { text: "Check this out!" } } }),
      );
      const res = await request(aiApp)
        .post("/outbox/generate-preview")
        .send({ url: "https://example.com/article", platforms: ["twitter"] })
        .expect(200);
      expect(res.body.previews.twitter.text).toBe("Check this out!");
    });

    it("handles markdown-fenced JSON from AI", async () => {
      const aiApp = createAppWithCopilot(
        "```json\n" + JSON.stringify({ previews: { linkedin: { text: "Great article" } } }) + "\n```",
      );
      const res = await request(aiApp)
        .post("/outbox/generate-preview")
        .send({ url: "https://example.com", platforms: ["linkedin"] })
        .expect(200);
      expect(res.body.previews.linkedin.text).toBe("Great article");
    });

    it("returns 502 when AI returns no JSON", async () => {
      const aiApp = createAppWithCopilot("I don't know what you want");
      await request(aiApp)
        .post("/outbox/generate-preview")
        .send({ url: "https://example.com", platforms: ["twitter"] })
        .expect(502);
    });

    it("includes imagePrompt and generatedImages when imageSource is generate", async () => {
      const aiApp = createAppWithCopilot(
        JSON.stringify({
          previews: { twitter: { text: "New post!" } },
          imagePrompt: "A futuristic cityscape",
        }),
      );
      const res = await request(aiApp)
        .post("/outbox/generate-preview")
        .send({ url: "https://example.com", platforms: ["twitter"], imageSource: "generate" })
        .expect(200);
      expect(res.body.imagePrompt).toBe("A futuristic cityscape");
      expect(Array.isArray(res.body.generatedImages)).toBe(true);
      expect(res.body.generatedImages.length).toBe(1);
      expect(res.body.generatedImages[0]).toMatch(/^\/api\/queue\/assets\/file\//);
    });

    it("passes model override to copilot chat", async () => {
      const chatSpy = vi.fn();
      const aiApp = createAppWithCopilot(
        JSON.stringify({ previews: { twitter: { text: "ok" } } }),
        chatSpy,
      );
      await request(aiApp)
        .post("/outbox/generate-preview")
        .send({ url: "https://example.com", platforms: ["twitter"], model: "gpt-4o" })
        .expect(200);
      expect(chatSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ model: "gpt-4o" }),
      );
    });
  });

  describe("GET /outbox/connected-platforms", () => {
    it("returns platform list with connection status", async () => {
      const aiApp = createAppWithCopilot();
      const res = await request(aiApp).get("/outbox/connected-platforms").expect(200);
      expect(Array.isArray(res.body.platforms)).toBe(true);
      expect(res.body.platforms.length).toBeGreaterThan(0);
      for (const p of res.body.platforms) {
        expect(p).toHaveProperty("platform");
        expect(p).toHaveProperty("connected");
      }
    });

    it("marks reddit as connected when credentials are set", async () => {
      process.env.REDDIT_CLIENT_ID = "test-id";
      process.env.REDDIT_CLIENT_SECRET = "test-secret";
      const aiApp = createAppWithCopilot();
      const res = await request(aiApp).get("/outbox/connected-platforms").expect(200);
      const reddit = res.body.platforms.find((p: { platform: string }) => p.platform === "reddit");
      expect(reddit).toBeDefined();
      expect(reddit.connected).toBe(true);
      delete process.env.REDDIT_CLIENT_ID;
      delete process.env.REDDIT_CLIENT_SECRET;
    });

    it("works even without copilotWrapper", async () => {
      const res = await request(app).get("/outbox/connected-platforms").expect(200);
      expect(Array.isArray(res.body.platforms)).toBe(true);
    });
  });

  describe("PATCH /outbox/:id", () => {
    it("updates title and content_body on a pending item", async () => {
      const created = await request(app).post("/outbox").send(VALID_ITEM_WITH_CONTENT).expect(201);
      const res = await request(app)
        .patch(`/outbox/${created.body.id}`)
        .send({ title: "Updated Title", content_body: "Updated body" })
        .expect(200);
      expect(res.body.title).toBe("Updated Title");
      expect(res.body.contentBody).toBe("Updated body");
    });

    it("updates scheduled_time", async () => {
      const created = await request(app).post("/outbox").send(VALID_ITEM).expect(201);
      const newTime = new Date(Date.now() + 120_000).toISOString();
      const res = await request(app)
        .patch(`/outbox/${created.body.id}`)
        .send({ scheduled_time: newTime })
        .expect(200);
      expect(new Date(res.body.scheduledTime).getTime()).toBeCloseTo(new Date(newTime).getTime(), -2);
    });

    it("updates agent_context", async () => {
      const created = await request(app).post("/outbox").send(VALID_ITEM).expect(201);
      const res = await request(app)
        .patch(`/outbox/${created.body.id}`)
        .send({ agent_context: "New context" })
        .expect(200);
      expect(res.body.agentContext).toBe("New context");
    });

    it("rejects update of processing item", async () => {
      const pastItem = { ...VALID_ITEM, scheduled_time: new Date(Date.now() - 60_000).toISOString() };
      const created = await request(app).post("/outbox").send(pastItem).expect(201);
      repo.claimPending(10);
      await request(app)
        .patch(`/outbox/${created.body.id}`)
        .send({ title: "Nope" })
        .expect(400);
    });

    it("rejects update of published item", async () => {
      const pastItem = { ...VALID_ITEM, scheduled_time: new Date(Date.now() - 60_000).toISOString() };
      const created = await request(app).post("/outbox").send(pastItem).expect(201);
      repo.claimPending(10);
      repo.markPublished(created.body.id, "https://x.com/post/1");
      await request(app)
        .patch(`/outbox/${created.body.id}`)
        .send({ title: "Nope" })
        .expect(400);
    });

    it("returns 400 for nonexistent id", async () => {
      await request(app)
        .patch("/outbox/nonexistent-id")
        .send({ title: "Nope" })
        .expect(400);
    });

    it("rejects invalid scheduled_time format", async () => {
      const created = await request(app).post("/outbox").send(VALID_ITEM).expect(201);
      await request(app)
        .patch(`/outbox/${created.body.id}`)
        .send({ scheduled_time: "not-a-date" })
        .expect(400);
    });

    it("allows updating a canceled item", async () => {
      const created = await request(app).post("/outbox").send(VALID_ITEM).expect(201);
      await request(app).post(`/outbox/${created.body.id}/cancel`).expect(200);
      const res = await request(app)
        .patch(`/outbox/${created.body.id}`)
        .send({ agent_context: "Revised plan" })
        .expect(200);
      expect(res.body.agentContext).toBe("Revised plan");
    });
  });

  describe("POST /outbox/batch", () => {
    it("creates multiple items", async () => {
      const res = await request(app)
        .post("/outbox/batch")
        .send({
          items: [
            VALID_ITEM,
            { ...VALID_ITEM, platform: "pinterest", agent_context: "Pin it" },
            { ...VALID_ITEM, platform: "linkedin", agent_context: "Share professionally" },
          ],
        })
        .expect(201);
      expect(res.body.count).toBe(3);
      expect(res.body.items).toHaveLength(3);
      expect(res.body.items[0].platform).toBe("twitter");
      expect(res.body.items[1].platform).toBe("pinterest");
      expect(res.body.items[2].platform).toBe("linkedin");
    });

    it("rejects empty items array", async () => {
      await request(app)
        .post("/outbox/batch")
        .send({ items: [] })
        .expect(400);
    });

    it("rejects when any item has invalid platform", async () => {
      await request(app)
        .post("/outbox/batch")
        .send({
          items: [
            VALID_ITEM,
            { ...VALID_ITEM, platform: "myspace" },
          ],
        })
        .expect(400);
    });

    it("validates each item schema independently", async () => {
      await request(app)
        .post("/outbox/batch")
        .send({
          items: [
            VALID_ITEM,
            { platform: "twitter", scheduled_time: VALID_ITEM.scheduled_time, agent_context: "" },
          ],
        })
        .expect(400);
    });

    it("creates items with content fields", async () => {
      const res = await request(app)
        .post("/outbox/batch")
        .send({ items: [VALID_ITEM_WITH_CONTENT, VALID_ITEM_WITH_CONTENT] })
        .expect(201);
      expect(res.body.count).toBe(2);
      for (const item of res.body.items) {
        expect(item.title).toBe("My Pinterest Post");
        expect(item.contentBody).toBe("# Hello\nSome markdown content");
      }
    });

    it("all created items are visible in list", async () => {
      await request(app)
        .post("/outbox/batch")
        .send({ items: [VALID_ITEM, { ...VALID_ITEM, platform: "linkedin", agent_context: "LI post" }] })
        .expect(201);
      const list = await request(app).get("/outbox").expect(200);
      expect(list.body.total).toBe(2);
    });
  });

  describe("POST /outbox/save-images", () => {
    it("returns 503 when mediaQueueRepo is not provided", async () => {
      const aiApp = createAppWithCopilot();
      const res = await request(aiApp)
        .post("/outbox/save-images")
        .send({ images: [{ url: "https://example.com/img.jpg" }] })
        .expect(503);
      expect(res.body.error).toContain("Gallery is not available");
    });

    it("returns 400 for empty images array", async () => {
      const mockRepo = { createAsset: vi.fn().mockReturnValue("asset-1") };
      const aiApp = createAppWithCopilot(undefined, undefined, { mediaQueueRepo: mockRepo });
      await request(aiApp)
        .post("/outbox/save-images")
        .send({ images: [] })
        .expect(400);
    });

    it("returns 400 for invalid image URL", async () => {
      const mockRepo = { createAsset: vi.fn().mockReturnValue("asset-1") };
      const aiApp = createAppWithCopilot(undefined, undefined, { mediaQueueRepo: mockRepo });
      await request(aiApp)
        .post("/outbox/save-images")
        .send({ images: [{ url: "not-a-url" }] })
        .expect(400);
    });
  });
});
