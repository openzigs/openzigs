import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWebhookTools } from "./webhook-tools.js";
import type { WebhookManager } from "../../webhooks/webhook-manager.js";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function createMockWebhookManager(overrides: Partial<WebhookManager> = {}): WebhookManager {
  return {
    create: vi.fn().mockReturnValue({
      webhook: { id: "wh-1", name: "Test Hook", enabled: true },
      apiKey: "key-abc123",
    }),
    list: vi.fn().mockReturnValue([
      { id: "wh-1", name: "Test Hook", enabled: true },
    ]),
    get: vi.fn().mockReturnValue({ id: "wh-1", name: "Test Hook", enabled: true }),
    delete: vi.fn().mockReturnValue(true),
    toggle: vi.fn().mockReturnValue({ id: "wh-1", name: "Test Hook", enabled: false }),
    ...overrides,
  } as unknown as WebhookManager;
}

function getHandler(managerOverrides: Partial<WebhookManager> = {}) {
  const manager = createMockWebhookManager(managerOverrides);
  const tools = createWebhookTools({ webhookManager: manager });
  return { handler: tools[0].handler, manager };
}

describe("webhook-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates tool with correct metadata", () => {
    const tools = createWebhookTools({ webhookManager: createMockWebhookManager() });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("manage-webhooks");
    expect(tools[0].riskLevel).toBe("high");
  });

  // ── create ──────────────────────────────────────────────────

  describe("create action", () => {
    it("creates a webhook", async () => {
      const { handler, manager } = getHandler();
      const result = await handler({
        action: "create",
        name: "My Hook",
        action_type: "prompt",
        action_payload: { prompt: "run tests" },
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.text);
      expect(parsed.webhook.id).toBe("wh-1");
      expect(parsed.api_key).toBe("key-abc123");
      expect(manager.create).toHaveBeenCalledWith({
        name: "My Hook",
        action: "prompt",
        actionPayload: { prompt: "run tests" },
        allowedIps: undefined,
        rateLimit: 10,
      });
    });

    it("returns error when missing required fields", async () => {
      const { handler } = getHandler();
      const result = await handler({ action: "create", name: "Hook" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("required");
    });

    it("passes custom rate limit and allowed IPs", async () => {
      const { handler, manager } = getHandler();
      await handler({
        action: "create",
        name: "Hook",
        action_type: "goal",
        action_payload: { goal: "deploy" },
        rate_limit: 5,
        allowed_ips: ["10.0.0.0/8"],
      });
      expect(manager.create).toHaveBeenCalledWith(
        expect.objectContaining({
          rateLimit: 5,
          allowedIps: ["10.0.0.0/8"],
        }),
      );
    });
  });

  // ── list ──────────────────────────────────────────────────

  describe("list action", () => {
    it("returns list of webhooks", async () => {
      const { handler } = getHandler();
      const result = await handler({ action: "list" });
      const parsed = JSON.parse(result.text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe("Test Hook");
    });
  });

  // ── get ──────────────────────────────────────────────────

  describe("get action", () => {
    it("returns a webhook by id", async () => {
      const { handler } = getHandler();
      const result = await handler({ action: "get", id: "wh-1" });
      const parsed = JSON.parse(result.text);
      expect(parsed.id).toBe("wh-1");
    });

    it("returns error when id missing", async () => {
      const { handler } = getHandler();
      const result = await handler({ action: "get" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("required");
    });

    it("returns error when webhook not found", async () => {
      const { handler } = getHandler({ get: vi.fn().mockReturnValue(null) });
      const result = await handler({ action: "get", id: "missing" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not found");
    });
  });

  // ── delete ──────────────────────────────────────────────────

  describe("delete action", () => {
    it("deletes a webhook", async () => {
      const { handler } = getHandler();
      const result = await handler({ action: "delete", id: "wh-1" });
      expect(result.text).toContain("deleted");
    });

    it("returns error when id missing", async () => {
      const { handler } = getHandler();
      const result = await handler({ action: "delete" });
      expect(result.isError).toBe(true);
    });

    it("returns error when webhook not found", async () => {
      const { handler } = getHandler({ delete: vi.fn().mockReturnValue(false) });
      const result = await handler({ action: "delete", id: "missing" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not found");
    });
  });

  // ── toggle ──────────────────────────────────────────────────

  describe("toggle action", () => {
    it("toggles a webhook", async () => {
      const { handler } = getHandler();
      const result = await handler({ action: "toggle", id: "wh-1", enabled: false });
      const parsed = JSON.parse(result.text);
      expect(parsed.enabled).toBe(false);
    });

    it("returns error when id or enabled missing", async () => {
      const { handler } = getHandler();
      const result = await handler({ action: "toggle", id: "wh-1" });
      expect(result.isError).toBe(true);
    });

    it("returns error when webhook not found", async () => {
      const { handler } = getHandler({ toggle: vi.fn().mockReturnValue(null) });
      const result = await handler({ action: "toggle", id: "missing", enabled: true });
      expect(result.isError).toBe(true);
    });
  });
});
