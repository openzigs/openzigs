import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock webhookAuth to pass through with an attached webhook config
const mockWebhookAuth = vi.fn();
vi.mock("./webhook-auth.js", () => ({
  webhookAuth: (...args: unknown[]) => mockWebhookAuth(...args),
}));

import { createWebhookRouter, type WebhookRouterOptions } from "./webhook-routes.js";

function buildApp(options: WebhookRouterOptions) {
  const app = express();
  app.use(express.json());
  app.use("/", createWebhookRouter(options));
  return app;
}

/** Create a pass-through auth middleware that attaches a webhook config to req */
function passAuthWith(webhook: Record<string, unknown>) {
  mockWebhookAuth.mockReturnValue(
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as unknown as Record<string, unknown>).webhook = webhook;
      next();
    },
  );
}

describe("webhook-routes", () => {
  const mockWebhookManager = {
    authenticateByApiKey: vi.fn(),
    authenticateBySignature: vi.fn(),
    checkRateLimit: vi.fn().mockReturnValue(true),
    recordTrigger: vi.fn(),
    getConfig: vi.fn(),
    getAll: vi.fn(),
  } as unknown as WebhookRouterOptions["webhookManager"];

  const mockTaskEngine = {
    submit: vi.fn().mockReturnValue({ id: "task-123" }),
  } as unknown as WebhookRouterOptions["taskEngine"];

  const mockPromptManager = {
    resolve: vi.fn(),
  } as unknown as WebhookRouterOptions["promptManager"];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST / — missing webhook context", () => {
    it("returns 500 if webhook config is not attached", async () => {
      mockWebhookAuth.mockReturnValue(
        (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
      );

      const app = buildApp({ webhookManager: mockWebhookManager });
      const res = await request(app).post("/").send({});

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Webhook context missing");
    });
  });

  describe("POST / — prompt action", () => {
    it("returns 400 when promptName is missing from actionPayload", async () => {
      passAuthWith({
        id: "wh-1",
        name: "test-hook",
        action: "prompt",
        actionPayload: {},
        enabled: true,
      });

      const app = buildApp({
        webhookManager: mockWebhookManager,
        promptManager: mockPromptManager,
      });
      const res = await request(app).post("/").send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("no promptName");
    });

    it("returns 404 when prompt is not found", async () => {
      passAuthWith({
        id: "wh-1",
        name: "test-hook",
        action: "prompt",
        actionPayload: { promptName: "missing-prompt" },
        enabled: true,
      });
      vi.mocked(mockPromptManager!.resolve).mockReturnValue(null);

      const app = buildApp({
        webhookManager: mockWebhookManager,
        promptManager: mockPromptManager,
      });
      const res = await request(app).post("/").send({});

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("missing-prompt");
    });

    it("submits a task when taskEngine is available", async () => {
      passAuthWith({
        id: "wh-1",
        name: "test-hook",
        action: "prompt",
        actionPayload: { promptName: "deploy-report" },
        enabled: true,
      });
      vi.mocked(mockPromptManager!.resolve).mockReturnValue("Resolved prompt text");

      const app = buildApp({
        webhookManager: mockWebhookManager,
        taskEngine: mockTaskEngine,
        promptManager: mockPromptManager,
      });
      const res = await request(app).post("/").send({ env: "prod" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.taskId).toBe("task-123");
      expect(res.body.prompt).toBe("deploy-report");
      expect(mockWebhookManager.recordTrigger).toHaveBeenCalledWith("wh-1");
    });

    it("returns resolved prompt when taskEngine is not available", async () => {
      passAuthWith({
        id: "wh-1",
        name: "test-hook",
        action: "prompt",
        actionPayload: { promptName: "greet" },
        enabled: true,
      });
      vi.mocked(mockPromptManager!.resolve).mockReturnValue("Hello World");

      const app = buildApp({
        webhookManager: mockWebhookManager,
        promptManager: mockPromptManager,
      });
      const res = await request(app).post("/").send({});

      expect(res.status).toBe(200);
      expect(res.body.resolved).toBe("Hello World");
    });
  });

  describe("POST / — goal action", () => {
    it("submits a goal task when taskEngine is available", async () => {
      passAuthWith({
        id: "wh-2",
        name: "ci-hook",
        action: "goal",
        actionPayload: { goal: "Run deployment" },
        enabled: true,
      });

      const app = buildApp({
        webhookManager: mockWebhookManager,
        taskEngine: mockTaskEngine,
      });
      const res = await request(app).post("/").send({ branch: "main" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.taskId).toBe("task-123");
      expect(vi.mocked(mockTaskEngine!.submit)).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: "webhook",
          goal: "Run deployment",
        }),
        { mode: "background" },
      );
    });

    it("falls back to default goal when not specified", async () => {
      passAuthWith({
        id: "wh-3",
        name: "auto-hook",
        action: "goal",
        actionPayload: {},
        enabled: true,
      });

      const app = buildApp({
        webhookManager: mockWebhookManager,
        taskEngine: mockTaskEngine,
      });
      const res = await request(app).post("/").send({});

      expect(res.status).toBe(200);
      expect(vi.mocked(mockTaskEngine!.submit)).toHaveBeenCalledWith(
        expect.objectContaining({ goal: "Execute webhook payload" }),
        expect.anything(),
      );
    });

    it("returns goal json when taskEngine is not available", async () => {
      passAuthWith({
        id: "wh-2",
        name: "ci-hook",
        action: "goal",
        actionPayload: { goal: "Review code" },
        enabled: true,
      });

      const app = buildApp({ webhookManager: mockWebhookManager });
      const res = await request(app).post("/").send({});

      expect(res.status).toBe(200);
      expect(res.body.goal).toBe("Review code");
    });
  });

  describe("POST / — unknown action", () => {
    it("returns 400 for unknown action types", async () => {
      passAuthWith({
        id: "wh-4",
        name: "bad-hook",
        action: "unknown-action",
        actionPayload: {},
        enabled: true,
      });

      const app = buildApp({ webhookManager: mockWebhookManager });
      const res = await request(app).post("/").send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Unknown webhook action");
    });
  });

  describe("POST / — error handling", () => {
    it("returns 500 when handler throws", async () => {
      passAuthWith({
        id: "wh-5",
        name: "error-hook",
        action: "prompt",
        actionPayload: { promptName: "crash" },
        enabled: true,
      });
      vi.mocked(mockPromptManager!.resolve).mockImplementation(() => {
        throw new Error("kaboom");
      });

      const app = buildApp({
        webhookManager: mockWebhookManager,
        promptManager: mockPromptManager,
      });
      const res = await request(app).post("/").send({});

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("kaboom");
    });
  });
});
