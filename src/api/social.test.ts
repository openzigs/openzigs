import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createSocialRouter } from "./social.js";
import type { SocialRouterOptions } from "./social.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../config/user-model.js", () => ({
  getUserSelectedModel: vi.fn().mockResolvedValue("gpt-5-mini"),
}));

function createMockRepository() {
  const contacts = new Map<string, Record<string, unknown>>();
  contacts.set("c1", {
    id: "c1",
    platform: "twitter",
    username: "test_user",
    tags: "",
  });

  const rules = new Map<string, Record<string, unknown>>();
  rules.set("r1", {
    id: "r1",
    name: "AutoDM",
    platform: "twitter",
    enabled: 1,
    dm_template: "Hi!",
  });

  return {
    getStats: vi.fn(() => ({
      totalContacts: 1,
      totalMessages: 5,
      totalHandoffs: 0,
    })),
    listContacts: vi.fn(() => ({
      contacts: Array.from(contacts.values()),
      total: contacts.size,
    })),
    exportContactsCsv: vi.fn(() => "id,username\nc1,test_user"),
    getContact: vi.fn((id: string) => contacts.get(id) ?? null),
    updateContact: vi.fn((_id: string, data: Record<string, unknown>) => ({
      ...contacts.get("c1"),
      ...data,
    })),
    addTag: vi.fn((id: string, _tag: string) => contacts.get(id) ?? null),
    removeTag: vi.fn((id: string, _tag: string) => contacts.get(id) ?? null),
    getMessages: vi.fn(() => []),
    getRecentActivity: vi.fn(() => []),
    listRules: vi.fn(() => Array.from(rules.values())),
    createRule: vi.fn((data: Record<string, unknown>) => ({
      id: "r-new",
      ...data,
    })),
    getRule: vi.fn((id: string) => rules.get(id) ?? null),
    updateRule: vi.fn((id: string, data: Record<string, unknown>) => ({
      ...rules.get(id),
      ...data,
    })),
    deleteRule: vi.fn((id: string) => rules.has(id)),
    getAutomationLog: vi.fn(() => []),
    getAnalytics: vi.fn(() => [
      {
        platform: "twitter",
        total_conversations: 10,
        total_messages_in: 20,
        total_messages_out: 15,
        avg_response_time_ms: 500,
        auto_reply_rate: 0.75,
        escalation_rate: 0.1,
        leads_captured: 2,
      },
    ]),
    getLeads: vi.fn(() => [
      {
        id: "c1",
        platform: "twitter",
        username: "test_user",
        email: "test@example.com",
        phone: null,
        lead_captured_at: "2026-01-01T00:00:00Z",
      },
    ]),
    getFollowUpSteps: vi.fn(() => [
      {
        id: "fs1",
        rule_id: "r1",
        step_order: 0,
        delay_seconds: 3600,
        message_template: "Follow up!",
      },
    ]),
    createFollowUpStep: vi.fn(
      (_ruleId: string, data: Record<string, unknown>) => ({
        id: "fs-new",
        rule_id: "r1",
        ...data,
      }),
    ),
    deleteFollowUpStep: vi.fn((id: string) => id === "fs1"),
  };
}

function createMockIngestion() {
  return {
    getRegisteredPlatforms: vi.fn(() => ["twitter"]),
    getActivePollers: vi.fn(() => []),
    getAllPollHealth: vi.fn(() => ({})),
    handleWebhook: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockBrain() {
  return {
    setBrandVoice: vi.fn(),
    getVoiceLearning: vi.fn().mockReturnValue({
      getExampleCount: vi.fn().mockReturnValue(0),
      recordApprovedReply: vi.fn(),
    }),
  };
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

function createMockCopilot(responseText: string) {
  return {
    chat: vi.fn(async function* () {
      yield responseText;
    }),
    listModels: vi.fn().mockResolvedValue([]),
  };
}

function buildAppWithCopilot(response: string) {
  const app = express();
  app.use(express.json());
  const copilot = createMockCopilot(response);
  const opts = {
    repository: createMockRepository(),
    ingestion: createMockIngestion(),
    brain: createMockBrain(),
    handoff: createMockHandoff(),
    ruleEngine: {},
    config: { enabled: true, confidenceThreshold: "medium", connections: {} },
    copilot,
  } as unknown as SocialRouterOptions;
  app.use("/social", createSocialRouter(opts));
  return { app, opts, copilot };
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
      const res = await request(app).get(
        "/social/contacts?platform=invalid_platform",
      );
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
      const res = await request(app)
        .patch("/social/contacts/c1")
        .send({ tags: "vip" });
      expect(res.status).toBe(200);
    });

    it("returns 404 for missing contact", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .patch("/social/contacts/missing")
        .send({ tags: "vip" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /contacts/:id/tags", () => {
    it("adds a tag", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/social/contacts/c1/tags")
        .send({ tag: "vip" });
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
      (
        opts.repository as unknown as ReturnType<typeof createMockRepository>
      ).deleteRule.mockReturnValue(false);
      const res = await request(app).delete("/social/rules/missing");
      expect(res.status).toBe(404);
    });
  });

  // ── Handoff ────────────────────────────────────────────────

  describe("POST /handoff/:contactId/close", () => {
    it("closes a handoff", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/social/handoff/c1/close")
        .send({ resolution: "Resolved" });
      expect(res.status).toBe(200);
    });
  });

  // ── Webhooks ───────────────────────────────────────────────

  describe("POST /webhooks/:platform", () => {
    it("accepts webhook payload", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/social/webhooks/twitter")
        .send({ object: "twitter" });
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
      (
        opts.repository as unknown as ReturnType<typeof createMockRepository>
      ).getStats.mockImplementation(() => {
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
      expect(
        (opts.repository as unknown as ReturnType<typeof createMockRepository>)
          .listContacts,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, pageSize: 10 }),
      );
    });

    it("passes search and tag params", async () => {
      const { app, opts } = buildApp();
      await request(app).get("/social/contacts?search=foo&tag=vip");
      expect(
        (opts.repository as unknown as ReturnType<typeof createMockRepository>)
          .listContacts,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ search: "foo", tag: "vip" }),
      );
    });

    it("passes handoffActive=true filter", async () => {
      const { app, opts } = buildApp();
      await request(app).get("/social/contacts?handoffActive=true");
      expect(
        (opts.repository as unknown as ReturnType<typeof createMockRepository>)
          .listContacts,
      ).toHaveBeenCalledWith(expect.objectContaining({ handoffActive: true }));
    });

    it("passes handoffActive=false filter", async () => {
      const { app, opts } = buildApp();
      await request(app).get("/social/contacts?handoffActive=false");
      expect(
        (opts.repository as unknown as ReturnType<typeof createMockRepository>)
          .listContacts,
      ).toHaveBeenCalledWith(expect.objectContaining({ handoffActive: false }));
    });

    it("returns 500 when listContacts throws", async () => {
      const { app, opts } = buildApp();
      (
        opts.repository as unknown as ReturnType<typeof createMockRepository>
      ).listContacts.mockImplementation(() => {
        throw new Error("DB error");
      });
      const res = await request(app).get("/social/contacts");
      expect(res.status).toBe(500);
    });
  });

  describe("GET /contacts/export — error path", () => {
    it("returns 500 when exportContactsCsv throws", async () => {
      const { app, opts } = buildApp();
      (
        opts.repository as unknown as ReturnType<typeof createMockRepository>
      ).exportContactsCsv.mockImplementation(() => {
        throw new Error("DB error");
      });
      const res = await request(app).get("/social/contacts/export");
      expect(res.status).toBe(500);
    });
  });

  describe("PATCH /contacts/:id — validation", () => {
    it("rejects unknown fields (strict schema)", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .patch("/social/contacts/c1")
        .send({ badField: "x" });
      expect(res.status).toBe(400);
    });

    it("updates notes field", async () => {
      const { app, opts } = buildApp();
      const res = await request(app)
        .patch("/social/contacts/c1")
        .send({ notes: "VIP customer" });
      expect(res.status).toBe(200);
      expect(
        (opts.repository as unknown as ReturnType<typeof createMockRepository>)
          .updateContact,
      ).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ notes: "VIP customer" }),
      );
    });
  });

  describe("POST /contacts/:id/tags — not found", () => {
    it("returns 404 when addTag returns null", async () => {
      const { app, opts } = buildApp();
      (
        opts.repository as unknown as ReturnType<typeof createMockRepository>
      ).addTag.mockReturnValue(null);
      const res = await request(app)
        .post("/social/contacts/missing/tags")
        .send({ tag: "vip" });
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
      (
        opts.repository as unknown as ReturnType<typeof createMockRepository>
      ).removeTag.mockReturnValue(null);
      const res = await request(app).delete(
        "/social/contacts/missing/tags/vip",
      );
      expect(res.status).toBe(404);
    });
  });

  describe("GET /contacts/:id/messages — with params", () => {
    it("passes limit and offset to repository", async () => {
      const { app, opts } = buildApp();
      await request(app).get("/social/contacts/c1/messages?limit=5&offset=10");
      expect(
        (opts.repository as unknown as ReturnType<typeof createMockRepository>)
          .getMessages,
      ).toHaveBeenCalledWith("c1", 5, 10);
    });
  });

  describe("GET /activity — error path", () => {
    it("returns 500 when getRecentActivity throws", async () => {
      const { app, opts } = buildApp();
      (
        opts.repository as unknown as ReturnType<typeof createMockRepository>
      ).getRecentActivity.mockImplementation(() => {
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
      expect(
        (opts.repository as unknown as ReturnType<typeof createMockRepository>)
          .listRules,
      ).toHaveBeenCalledWith("twitter");
    });

    it("returns 500 when listRules throws", async () => {
      const { app, opts } = buildApp();
      (
        opts.repository as unknown as ReturnType<typeof createMockRepository>
      ).listRules.mockImplementation(() => {
        throw new Error("DB error");
      });
      const res = await request(app).get("/social/rules");
      expect(res.status).toBe(500);
    });
  });

  describe("POST /rules — error path", () => {
    it("returns 500 when createRule throws", async () => {
      const { app, opts } = buildApp();
      (
        opts.repository as unknown as ReturnType<typeof createMockRepository>
      ).createRule.mockImplementation(() => {
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
      const res = await request(app)
        .patch("/social/rules/r1")
        .send({ name: "Updated" });
      expect(res.status).toBe(200);
    });

    it("returns 404 for missing rule", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .patch("/social/rules/missing")
        .send({ name: "Updated" });
      expect(res.status).toBe(404);
    });

    it("rejects invalid schema fields", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .patch("/social/rules/r1")
        .send({ badField: 123 });
      expect(res.status).toBe(400);
    });

    it("returns 500 when updateRule throws", async () => {
      const { app, opts } = buildApp();
      (
        opts.repository as unknown as ReturnType<typeof createMockRepository>
      ).updateRule.mockImplementation(() => {
        throw new Error("DB error");
      });
      const res = await request(app)
        .patch("/social/rules/r1")
        .send({ name: "Updated" });
      expect(res.status).toBe(500);
    });
  });

  // GET /rules/log — now registered before /rules/:id so it's reachable
  describe("GET /rules/log", () => {
    it("returns automation log entries", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/rules/log");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("log");
    });
  });

  describe("POST /handoff/:contactId/close — error paths", () => {
    it("returns 404 when handoff not found", async () => {
      const { app, opts } = buildApp();
      (
        opts.handoff as unknown as ReturnType<typeof createMockHandoff>
      ).closeHandoff.mockResolvedValue(false);
      const res = await request(app).post("/social/handoff/c1/close").send({});
      expect(res.status).toBe(404);
    });

    it("returns 500 when closeHandoff throws", async () => {
      const { app, opts } = buildApp();
      (
        opts.handoff as unknown as ReturnType<typeof createMockHandoff>
      ).closeHandoff.mockRejectedValue(new Error("fail"));
      const res = await request(app).post("/social/handoff/c1/close").send({});
      expect(res.status).toBe(500);
    });
  });

  describe("PUT /brand-voice", () => {
    it("returns 503 when brandVoiceService is not provided", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .put("/social/brand-voice")
        .send({ brandVoiceId: "v1" });
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

  describe("GET /stats — connection status", () => {
    it("shows all 8 platforms in connections", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/stats");
      expect(res.status).toBe(200);
      const platforms = res.body.connections.map(
        (c: { platform: string }) => c.platform,
      );
      expect(platforms).toContain("twitter");
      expect(platforms).toContain("linkedin");
      expect(platforms).toContain("reddit");
      expect(platforms).toContain("youtube");
      expect(platforms).toContain("tiktok");
      expect(platforms).toContain("instagram");
      expect(platforms).toContain("facebook");
      expect(platforms).toContain("pinterest");
      expect(platforms).toHaveLength(8);
    });

    it("shows platform as connected when adapter registered and token present", async () => {
      const app = express();
      app.use(express.json());
      const opts = {
        repository: createMockRepository(),
        ingestion: {
          getRegisteredPlatforms: vi.fn(() => ["twitter", "reddit"]),
          getActivePollers: vi.fn(() => []),
          getAllPollHealth: vi.fn(() => ({})),
          handleWebhook: vi.fn().mockResolvedValue(undefined),
        },
        brain: createMockBrain(),
        handoff: createMockHandoff(),
        ruleEngine: {},
        config: {
          enabled: true,
          confidenceThreshold: "medium",
          connections: {
            twitter: {
              enabled: true,
              accessToken: "tw-token",
              mode: "webhook",
            },
            reddit: {
              enabled: true,
              accessToken: "rd-token",
              mode: "polling",
              pollIntervalSeconds: 120,
            },
            youtube: { enabled: false, accessToken: "", mode: "polling" },
          },
        },
      } as unknown as SocialRouterOptions;
      app.use("/social", createSocialRouter(opts));

      const res = await request(app).get("/social/stats");
      expect(res.status).toBe(200);

      const connections = res.body.connections as Array<{
        platform: string;
        connected: boolean;
        configured: boolean;
      }>;
      const twitter = connections.find((c) => c.platform === "twitter");
      expect(twitter?.connected).toBe(true);
      expect(twitter?.configured).toBe(true);

      const reddit = connections.find((c) => c.platform === "reddit");
      expect(reddit?.connected).toBe(true);
      expect(reddit?.configured).toBe(true);

      const youtube = connections.find((c) => c.platform === "youtube");
      expect(youtube?.connected).toBe(false);
      expect(youtube?.configured).toBe(false);

      const linkedin = connections.find((c) => c.platform === "linkedin");
      expect(linkedin?.connected).toBe(false);
    });

    it("shows platform as not connected without adapter registration", async () => {
      const app = express();
      app.use(express.json());
      const opts = {
        repository: createMockRepository(),
        ingestion: {
          getRegisteredPlatforms: vi.fn(() => []),
          getActivePollers: vi.fn(() => []),
          getAllPollHealth: vi.fn(() => ({})),
          handleWebhook: vi.fn().mockResolvedValue(undefined),
        },
        brain: createMockBrain(),
        handoff: createMockHandoff(),
        ruleEngine: {},
        config: {
          enabled: true,
          confidenceThreshold: "medium",
          connections: {
            reddit: { enabled: true, accessToken: "token", mode: "polling" },
          },
        },
      } as unknown as SocialRouterOptions;
      app.use("/social", createSocialRouter(opts));

      const res = await request(app).get("/social/stats");
      const reddit = res.body.connections.find(
        (c: { platform: string }) => c.platform === "reddit",
      );
      expect(reddit?.connected).toBe(false);
      expect(reddit?.configured).toBe(true);
    });
  });

  // ── Analytics ──────────────────────────────────────────────

  describe("GET /analytics", () => {
    it("returns analytics data", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/analytics");
      expect(res.status).toBe(200);
      expect(res.body.analytics).toHaveLength(1);
      expect(res.body.analytics[0].platform).toBe("twitter");
      expect(res.body.analytics[0].total_conversations).toBe(10);
    });

    it("passes since filter to repository", async () => {
      const { app, opts } = buildApp();
      await request(app).get("/social/analytics?since=2026-01-01T00:00:00Z");
      expect(
        (opts.repository as unknown as ReturnType<typeof createMockRepository>)
          .getAnalytics,
      ).toHaveBeenCalledWith("2026-01-01T00:00:00Z");
    });

    it("returns 500 when getAnalytics throws", async () => {
      const { app, opts } = buildApp();
      (
        opts.repository as unknown as ReturnType<typeof createMockRepository>
      ).getAnalytics.mockImplementation(() => {
        throw new Error("DB error");
      });
      const res = await request(app).get("/social/analytics");
      expect(res.status).toBe(500);
    });
  });

  // ── Leads ──────────────────────────────────────────────────

  describe("GET /leads", () => {
    it("returns leads list", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/leads");
      expect(res.status).toBe(200);
      expect(res.body.leads).toHaveLength(1);
      expect(res.body.leads[0].email).toBe("test@example.com");
    });

    it("passes platform filter", async () => {
      const { app, opts } = buildApp();
      await request(app).get(
        "/social/leads?platform=twitter&limit=10&offset=5",
      );
      expect(
        (opts.repository as unknown as ReturnType<typeof createMockRepository>)
          .getLeads,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ platform: "twitter", limit: 10, offset: 5 }),
      );
    });

    it("clamps limit to 200 max", async () => {
      const { app, opts } = buildApp();
      await request(app).get("/social/leads?limit=999");
      expect(
        (opts.repository as unknown as ReturnType<typeof createMockRepository>)
          .getLeads,
      ).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
    });

    it("returns 500 when getLeads throws", async () => {
      const { app, opts } = buildApp();
      (
        opts.repository as unknown as ReturnType<typeof createMockRepository>
      ).getLeads.mockImplementation(() => {
        throw new Error("DB error");
      });
      const res = await request(app).get("/social/leads");
      expect(res.status).toBe(500);
    });
  });

  // ── Follow-Up Steps ────────────────────────────────────────

  describe("GET /rules/:ruleId/follow-ups", () => {
    it("returns follow-up steps for a rule", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/social/rules/r1/follow-ups");
      expect(res.status).toBe(200);
      expect(res.body.steps).toHaveLength(1);
      expect(res.body.steps[0].delay_seconds).toBe(3600);
    });

    it("returns 500 when getFollowUpSteps throws", async () => {
      const { app, opts } = buildApp();
      (
        opts.repository as unknown as ReturnType<typeof createMockRepository>
      ).getFollowUpSteps.mockImplementation(() => {
        throw new Error("DB error");
      });
      const res = await request(app).get("/social/rules/r1/follow-ups");
      expect(res.status).toBe(500);
    });
  });

  describe("POST /rules/:ruleId/follow-ups", () => {
    it("creates a follow-up step", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/social/rules/r1/follow-ups").send({
        stepOrder: 0,
        delaySeconds: 3600,
        messageTemplate: "Hey {{username}}, just following up!",
      });
      expect(res.status).toBe(201);
      expect(res.body.rule_id).toBe("r1");
    });

    it("returns 404 for missing rule", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .post("/social/rules/missing/follow-ups")
        .send({
          stepOrder: 0,
          delaySeconds: 3600,
          messageTemplate: "Hello!",
        });
      expect(res.status).toBe(404);
    });

    it("rejects invalid body schema", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/social/rules/r1/follow-ups").send({
        stepOrder: -1,
        delaySeconds: 0, // min 1
        messageTemplate: "",
      });
      expect(res.status).toBe(400);
    });

    it("rejects delay exceeding 7 days", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/social/rules/r1/follow-ups").send({
        stepOrder: 0,
        delaySeconds: 700000, // > 604800
        messageTemplate: "Too late!",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /rules/:ruleId/follow-ups/:stepId", () => {
    it("deletes a follow-up step", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/social/rules/r1/follow-ups/fs1");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 404 for missing step", async () => {
      const { app } = buildApp();
      const res = await request(app).delete(
        "/social/rules/r1/follow-ups/missing",
      );
      expect(res.status).toBe(404);
    });
  });

  describe("POST /rules/generate", () => {
    const validRule = JSON.stringify({
      name: "Lead Capture DM",
      platform: "instagram",
      keywords: ["pricing", "interested"],
      dm_template: "Hey {{username}}, thanks for your interest!",
      comment_reply_template: "Check your DMs!",
      dm_delay_seconds: 30,
      max_triggers_per_user: 3,
      auto_tag: "lead",
      use_ai_reply: false,
      ai_reply_context: null,
    });

    it("generates a rule from description", async () => {
      const { app, copilot } = buildAppWithCopilot(validRule);
      const res = await request(app).post("/social/rules/generate").send({
        description: "Capture leads who ask about pricing on Instagram",
      });
      expect(res.status).toBe(200);
      expect(res.body.rule).toBeDefined();
      expect(res.body.rule.name).toBe("Lead Capture DM");
      expect(res.body.rule.platform).toBe("instagram");
      expect(copilot.chat).toHaveBeenCalledTimes(1);
    });

    it("accepts optional platform and model", async () => {
      const { app, copilot } = buildAppWithCopilot(validRule);
      const res = await request(app).post("/social/rules/generate").send({
        description: "Auto-reply to comments",
        platform: "twitter",
        model: "gpt-5",
      });
      expect(res.status).toBe(200);
      expect(copilot.chat).toHaveBeenCalledWith(
        expect.stringContaining("twitter"),
        expect.objectContaining({ model: "gpt-5" }),
      );
    });

    it("returns 503 when copilot unavailable", async () => {
      const { app } = buildApp(); // no copilot
      const res = await request(app)
        .post("/social/rules/generate")
        .send({ description: "Generate a rule" });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/copilot/i);
    });

    it("returns 400 for empty description", async () => {
      const { app } = buildAppWithCopilot(validRule);
      const res = await request(app)
        .post("/social/rules/generate")
        .send({ description: "" });
      expect(res.status).toBe(400);
    });

    it("returns 400 for missing description", async () => {
      const { app } = buildAppWithCopilot(validRule);
      const res = await request(app).post("/social/rules/generate").send({});
      expect(res.status).toBe(400);
    });

    it("strips markdown fences from response", async () => {
      const fenced = "```json\n" + validRule + "\n```";
      const { app } = buildAppWithCopilot(fenced);
      const res = await request(app)
        .post("/social/rules/generate")
        .send({ description: "Generate a rule for leads" });
      expect(res.status).toBe(200);
      expect(res.body.rule.name).toBe("Lead Capture DM");
    });

    it("normalizes keywords array to JSON string", async () => {
      const { app } = buildAppWithCopilot(validRule);
      const res = await request(app)
        .post("/social/rules/generate")
        .send({ description: "A pricing rule" });
      expect(res.status).toBe(200);
      // keywords should be serialized to JSON string
      expect(typeof res.body.rule.keywords).toBe("string");
      expect(JSON.parse(res.body.rule.keywords as string)).toEqual([
        "pricing",
        "interested",
      ]);
    });

    it("normalizes use_ai_reply boolean to integer", async () => {
      const aiRule = JSON.stringify({
        name: "AI DM",
        platform: "twitter",
        keywords: ["help"],
        dm_template: "Hi!",
        comment_reply_template: null,
        dm_delay_seconds: 0,
        max_triggers_per_user: 1,
        auto_tag: null,
        use_ai_reply: true,
        ai_reply_context: "Be helpful and friendly",
      });
      const { app } = buildAppWithCopilot(aiRule);
      const res = await request(app)
        .post("/social/rules/generate")
        .send({ description: "AI powered support rule" });
      expect(res.status).toBe(200);
      expect(res.body.rule.use_ai_reply).toBe(1);
      expect(res.body.rule.ai_reply_context).toBe("Be helpful and friendly");
    });

    it("returns 500 for invalid JSON from copilot", async () => {
      const { app } = buildAppWithCopilot("This is not valid JSON at all.");
      const res = await request(app)
        .post("/social/rules/generate")
        .send({ description: "Some rule" });
      expect(res.status).toBe(500);
    });
  });
});
