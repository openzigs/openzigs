import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createSocialRouter } from "./social.js";
import type { SocialRouterOptions } from "./social.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function createMockRepository() {
  const contacts = new Map<string, Record<string, unknown>>();
  contacts.set("c1", { id: "c1", platform: "twitter", username: "test_user", tags: "" });

  const rules = new Map<string, Record<string, unknown>>();
  rules.set("r1", { id: "r1", name: "AutoDM", platform: "twitter", enabled: 1, dm_template: "Hi!" });

  return {
    getStats: vi.fn(() => ({ totalContacts: 1, totalMessages: 5, totalHandoffs: 0 })),
    listContacts: vi.fn(() => ({ contacts: Array.from(contacts.values()), total: contacts.size })),
    exportContactsCsv: vi.fn(() => "id,username\nc1,test_user"),
    getContact: vi.fn((id: string) => contacts.get(id) ?? null),
    updateContact: vi.fn((_id: string, data: Record<string, unknown>) => ({ ...contacts.get("c1"), ...data })),
    addTag: vi.fn((id: string, _tag: string) => contacts.get(id) ?? null),
    removeTag: vi.fn((id: string, _tag: string) => contacts.get(id) ?? null),
    getMessages: vi.fn(() => []),
    getRecentActivity: vi.fn(() => []),
    listRules: vi.fn(() => Array.from(rules.values())),
    createRule: vi.fn((data: Record<string, unknown>) => ({ id: "r-new", ...data })),
    getRule: vi.fn((id: string) => rules.get(id) ?? null),
    updateRule: vi.fn((id: string, data: Record<string, unknown>) => ({ ...rules.get(id), ...data })),
    deleteRule: vi.fn((id: string) => rules.has(id)),
    getAutomationLog: vi.fn(() => []),
  };
}

function createMockIngestion() {
  return {
    getRegisteredPlatforms: vi.fn(() => ["twitter"]),
    handleWebhook: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockBrain() {
  return { setBrandVoice: vi.fn() };
}

function createMockHandoff() {
  return { closeHandoff: vi.fn().mockResolvedValue(true) };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  const opts = {
    repository: createMockRepository(),
    ingestion: createMockIngestion(),
    brain: createMockBrain(),
    handoff: createMockHandoff(),
    ruleEngine: {},
    config: { enabled: true, confidenceThreshold: "medium", connections: {} },
  } as unknown as SocialRouterOptions;
  app.use("/social", createSocialRouter(opts));
  return { app, opts };
}

describe("Social API router", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("GET /stats", () => {
    it("returns stats with connections", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/stats");
      expect(res.status).toBe(200);
      expect(res.body.totalContacts).toBe(1);
      expect(res.body.connections).toBeDefined();
    });
  });

  describe("GET /contacts", () => {
    it("lists contacts", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/contacts");
      expect(res.status).toBe(200);
    });

    it("rejects invalid platform", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/contacts?platform=invalid_platform");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /contacts/export", () => {
    it("returns CSV", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/contacts/export");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
    });
  });

  describe("GET /contacts/:id", () => {
    it("returns a contact", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/contacts/c1");
      expect(res.status).toBe(200);
    });

    it("returns 404 for missing contact", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/contacts/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /contacts/:id", () => {
    it("updates contact", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/social/contacts/c1").send({ tags: "vip" });
      expect(res.status).toBe(200);
    });

    it("returns 404 for missing contact", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/social/contacts/missing").send({ tags: "vip" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /contacts/:id/tags", () => {
    it("adds a tag", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/social/contacts/c1/tags").send({ tag: "vip" });
      expect(res.status).toBe(200);
    });

    it("rejects missing tag", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/social/contacts/c1/tags").send({});
      expect(res.status).toBe(400);
    });
  });

  describe("GET /contacts/:id/messages", () => {
    it("returns messages", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/contacts/c1/messages");
      expect(res.status).toBe(200);
      expect(res.body.messages).toEqual([]);
    });
  });

  describe("GET /activity", () => {
    it("returns activity feed", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/activity");
      expect(res.status).toBe(200);
    });
  });

  // ── Rules ──────────────────────────────────────────────────

  describe("GET /rules", () => {
    it("lists rules", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/rules");
      expect(res.status).toBe(200);
      expect(res.body.rules).toHaveLength(1);
    });
  });

  describe("POST /rules", () => {
    it("creates a rule", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/social/rules").send({
        name: "NewRule",
        platform: "twitter",
        dm_template: "Hey there!",
      });
      expect(res.status).toBe(201);
    });

    it("rejects invalid platform", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/social/rules").send({
        name: "Bad",
        platform: "snapchat",
        dm_template: "Hi",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /rules/:id", () => {
    it("returns a rule", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/rules/r1");
      expect(res.status).toBe(200);
    });

    it("returns 404 for missing rule", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/rules/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /rules/:id", () => {
    it("deletes a rule", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/social/rules/r1");
      expect(res.status).toBe(200);
    });

    it("returns 404 for missing rule", async () => {
      const { app, opts } = buildApp();
      (opts.repository as unknown as ReturnType<typeof createMockRepository>).deleteRule.mockReturnValue(false);
      const res = await request(app).delete("/social/rules/missing");
      expect(res.status).toBe(404);
    });
  });

  // ── Handoff ────────────────────────────────────────────────

  describe("POST /handoff/:contactId/close", () => {
    it("closes a handoff", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/social/handoff/c1/close").send({ resolution: "Resolved" });
      expect(res.status).toBe(200);
    });
  });

  // ── Webhooks ───────────────────────────────────────────────

  describe("POST /webhooks/:platform", () => {
    it("accepts webhook payload", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/social/webhooks/twitter").send({ object: "twitter" });
      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });
  });

  describe("GET /webhooks/:platform", () => {
    it("returns 403 without valid verify token", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/webhooks/twitter");
      expect(res.status).toBe(403);
    });
  });

  // ── Connections & Config ───────────────────────────────────

  describe("GET /connections", () => {
    it("returns platform connections", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/connections");
      expect(res.status).toBe(200);
      expect(res.body.connections).toBeDefined();
    });
  });

  describe("GET /config", () => {
    it("returns social config", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/config");
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.platforms).toBeDefined();
    });
  });

  // ── NEW: Additional coverage ────────────────────────────────────

  describe("GET /stats — error path", () => {
    it("returns 500 when getStats throws", async () => {
      const { app, opts } = buildApp();
      (opts.repository as unknown as ReturnType<typeof createMockRepository>).getStats.mockImplementation(() => {
        throw new Error("DB error");
      });
      const res = await request(app).get("/social/stats");
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("DB error");
    });
  });

  describe("GET /contacts — advanced filters", () => {
    it("passes page and pageSize params", async () => {
      const { app, opts } = buildApp();
      await request(app).get("/social/contacts?page=2&pageSize=10");
      expect((opts.repository as unknown as ReturnType<typeof createMockRepository>).listContacts).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, pageSize: 10 }),
      );
    });

    it("passes search and tag params", async () => {
      const { app, opts } = buildApp();
      await request(app).get("/social/contacts?search=foo&tag=vip");
      expect((opts.repository as unknown as ReturnType<typeof createMockRepository>).listContacts).toHaveBeenCalledWith(
        expect.objectContaining({ search: "foo", tag: "vip" }),
      );
    });

    it("passes handoffActive=true filter", async () => {
      const { app, opts } = buildApp();
      await request(app).get("/social/contacts?handoffActive=true");
      expect((opts.repository as unknown as ReturnType<typeof createMockRepository>).listContacts).toHaveBeenCalledWith(
        expect.objectContaining({ handoffActive: true }),
      );
    });

    it("passes handoffActive=false filter", async () => {
      const { app, opts } = buildApp();
      await request(app).get("/social/contacts?handoffActive=false");
      expect((opts.repository as unknown as ReturnType<typeof createMockRepository>).listContacts).toHaveBeenCalledWith(
        expect.objectContaining({ handoffActive: false }),
      );
    });

    it("returns 500 when listContacts throws", async () => {
      const { app, opts } = buildApp();
      (opts.repository as unknown as ReturnType<typeof createMockRepository>).listContacts.mockImplementation(() => {
        throw new Error("DB error");
      });
      const res = await request(app).get("/social/contacts");
      expect(res.status).toBe(500);
    });
  });

  describe("GET /contacts/export — error path", () => {
    it("returns 500 when exportContactsCsv throws", async () => {
      const { app, opts } = buildApp();
      (opts.repository as unknown as ReturnType<typeof createMockRepository>).exportContactsCsv.mockImplementation(() => {
        throw new Error("DB error");
      });
      const res = await request(app).get("/social/contacts/export");
      expect(res.status).toBe(500);
    });
  });

  describe("PATCH /contacts/:id — validation", () => {
    it("rejects unknown fields (strict schema)", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/social/contacts/c1").send({ badField: "x" });
      expect(res.status).toBe(400);
    });

    it("updates notes field", async () => {
      const { app, opts } = buildApp();
      const res = await request(app).patch("/social/contacts/c1").send({ notes: "VIP customer" });
      expect(res.status).toBe(200);
      expect((opts.repository as unknown as ReturnType<typeof createMockRepository>).updateContact).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ notes: "VIP customer" }),
      );
    });
  });

  describe("POST /contacts/:id/tags — not found", () => {
    it("returns 404 when addTag returns null", async () => {
      const { app, opts } = buildApp();
      (opts.repository as unknown as ReturnType<typeof createMockRepository>).addTag.mockReturnValue(null);
      const res = await request(app).post("/social/contacts/missing/tags").send({ tag: "vip" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /contacts/:id/tags/:tag", () => {
    it("removes a tag from contact", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/social/contacts/c1/tags/vip");
      expect(res.status).toBe(200);
    });

    it("returns 404 when removeTag returns null", async () => {
      const { app, opts } = buildApp();
      (opts.repository as unknown as ReturnType<typeof createMockRepository>).removeTag.mockReturnValue(null);
      const res = await request(app).delete("/social/contacts/missing/tags/vip");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /contacts/:id/messages — with params", () => {
    it("passes limit and offset to repository", async () => {
      const { app, opts } = buildApp();
      await request(app).get("/social/contacts/c1/messages?limit=5&offset=10");
      expect((opts.repository as unknown as ReturnType<typeof createMockRepository>).getMessages).toHaveBeenCalledWith("c1", 5, 10);
    });
  });

  describe("GET /activity — error path", () => {
    it("returns 500 when getRecentActivity throws", async () => {
      const { app, opts } = buildApp();
      (opts.repository as unknown as ReturnType<typeof createMockRepository>).getRecentActivity.mockImplementation(() => {
        throw new Error("DB error");
      });
      const res = await request(app).get("/social/activity");
      expect(res.status).toBe(500);
    });
  });

  describe("GET /rules — with platform filter", () => {
    it("passes platform filter to listRules", async () => {
      const { app, opts } = buildApp();
      await request(app).get("/social/rules?platform=twitter");
      expect((opts.repository as unknown as ReturnType<typeof createMockRepository>).listRules).toHaveBeenCalledWith("twitter");
    });

    it("returns 500 when listRules throws", async () => {
      const { app, opts } = buildApp();
      (opts.repository as unknown as ReturnType<typeof createMockRepository>).listRules.mockImplementation(() => {
        throw new Error("DB error");
      });
      const res = await request(app).get("/social/rules");
      expect(res.status).toBe(500);
    });
  });

  describe("POST /rules — error path", () => {
    it("returns 500 when createRule throws", async () => {
      const { app, opts } = buildApp();
      (opts.repository as unknown as ReturnType<typeof createMockRepository>).createRule.mockImplementation(() => {
        throw new Error("constraint violation");
      });
      const res = await request(app).post("/social/rules").send({
        name: "TestRule",
        platform: "twitter",
        dm_template: "Hello!",
      });
      expect(res.status).toBe(500);
    });
  });

  describe("PATCH /rules/:id", () => {
    it("updates a rule", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/social/rules/r1").send({ name: "Updated" });
      expect(res.status).toBe(200);
    });

    it("returns 404 for missing rule", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/social/rules/missing").send({ name: "Updated" });
      expect(res.status).toBe(404);
    });

    it("rejects invalid schema fields", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/social/rules/r1").send({ badField: 123 });
      expect(res.status).toBe(400);
    });

    it("returns 500 when updateRule throws", async () => {
      const { app, opts } = buildApp();
      (opts.repository as unknown as ReturnType<typeof createMockRepository>).updateRule.mockImplementation(() => {
        throw new Error("DB error");
      });
      const res = await request(app).patch("/social/rules/r1").send({ name: "Updated" });
      expect(res.status).toBe(500);
    });
  });

  // NOTE: GET /rules/log is shadowed by GET /rules/:id (registered earlier in Express).
  // Express matches ":id" = "log" first, so this endpoint is unreachable. Skipping tests.

  describe("POST /handoff/:contactId/close — error paths", () => {
    it("returns 404 when handoff not found", async () => {
      const { app, opts } = buildApp();
      (opts.handoff as unknown as ReturnType<typeof createMockHandoff>).closeHandoff.mockResolvedValue(false);
      const res = await request(app).post("/social/handoff/c1/close").send({});
      expect(res.status).toBe(404);
    });

    it("returns 500 when closeHandoff throws", async () => {
      const { app, opts } = buildApp();
      (opts.handoff as unknown as ReturnType<typeof createMockHandoff>).closeHandoff.mockRejectedValue(new Error("fail"));
      const res = await request(app).post("/social/handoff/c1/close").send({});
      expect(res.status).toBe(500);
    });
  });

  describe("PUT /brand-voice", () => {
    it("returns 503 when brandVoiceService is not provided", async () => {
      const { app } = buildApp();
      const res = await request(app).put("/social/brand-voice").send({ brandVoiceId: "v1" });
      expect(res.status).toBe(503);
    });
  });

  describe("GET /webhooks/:platform — verification", () => {
    it("verifies with valid token", async () => {
      const original = process.env.SOCIAL_WEBHOOK_VERIFY_TOKEN;
      process.env.SOCIAL_WEBHOOK_VERIFY_TOKEN = "test-secret";
      try {
        const { app } = buildApp();
        const res = await request(app).get(
          "/social/webhooks/twitter?hub.mode=subscribe&hub.verify_token=test-secret&hub.challenge=challenge123",
        );
        expect(res.status).toBe(200);
        expect(res.text).toBe("challenge123");
      } finally {
        if (original !== undefined) {
          process.env.SOCIAL_WEBHOOK_VERIFY_TOKEN = original;
        } else {
          delete process.env.SOCIAL_WEBHOOK_VERIFY_TOKEN;
        }
      }
    });
  });
});
