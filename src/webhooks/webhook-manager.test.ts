import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { WebhookManager } from "./webhook-manager.js";

describe("WebhookManager", () => {
  let manager: WebhookManager;

  beforeEach(() => {
    manager = new WebhookManager();
  });

  it("creates a webhook with API key", () => {
    const { webhook, apiKey } = manager.create({
      name: "test-hook",
      action: "prompt",
      actionPayload: { promptName: "daily-summary" },
    });

    expect(webhook.id).toBeDefined();
    expect(webhook.name).toBe("test-hook");
    expect(webhook.enabled).toBe(true);
    expect(webhook.secret).toBeDefined();
    expect(webhook.triggerCount).toBe(0);
    expect(apiKey).toMatch(/^whk_/);
  });

  it("lists all webhooks", () => {
    manager.create({ name: "a", action: "prompt", actionPayload: {} });
    manager.create({ name: "b", action: "goal", actionPayload: {} });
    expect(manager.list()).toHaveLength(2);
  });

  it("gets a webhook by ID", () => {
    const { webhook } = manager.create({ name: "x", action: "prompt", actionPayload: {} });
    expect(manager.get(webhook.id)?.name).toBe("x");
    expect(manager.get("nonexistent")).toBeUndefined();
  });

  it("toggles enabled state", () => {
    const { webhook } = manager.create({ name: "t", action: "prompt", actionPayload: {} });
    const disabled = manager.toggle(webhook.id, false);
    expect(disabled?.enabled).toBe(false);
    const enabled = manager.toggle(webhook.id, true);
    expect(enabled?.enabled).toBe(true);
  });

  it("deletes a webhook", () => {
    const { webhook } = manager.create({ name: "d", action: "prompt", actionPayload: {} });
    expect(manager.delete(webhook.id)).toBe(true);
    expect(manager.get(webhook.id)).toBeUndefined();
    expect(manager.delete("nonexistent")).toBe(false);
  });

  it("authenticates by API key", () => {
    const { apiKey } = manager.create({ name: "auth", action: "prompt", actionPayload: {} });
    const found = manager.authenticateByApiKey(apiKey);
    expect(found?.name).toBe("auth");
    expect(manager.authenticateByApiKey("whk_invalid")).toBeUndefined();
  });

  it("rotates API key", () => {
    const { webhook, apiKey: oldKey } = manager.create({ name: "rotate", action: "prompt", actionPayload: {} });
    const result = manager.rotateKey(webhook.id);
    expect(result?.apiKey).toBeDefined();
    expect(result?.apiKey).not.toBe(oldKey);

    // Old key no longer works
    expect(manager.authenticateByApiKey(oldKey)).toBeUndefined();
    // New key works
    expect(manager.authenticateByApiKey(result!.apiKey)?.name).toBe("rotate");
  });

  it("enforces rate limits", () => {
    const { webhook } = manager.create({
      name: "rate",
      action: "prompt",
      actionPayload: {},
      rateLimit: 3,
    });

    expect(manager.checkRateLimit(webhook.id)).toBe(true);
    expect(manager.checkRateLimit(webhook.id)).toBe(true);
    expect(manager.checkRateLimit(webhook.id)).toBe(true);
    // 4th should fail
    expect(manager.checkRateLimit(webhook.id)).toBe(false);
  });

  it("records triggers", () => {
    const { webhook } = manager.create({ name: "count", action: "prompt", actionPayload: {} });
    expect(webhook.triggerCount).toBe(0);
    manager.recordTrigger(webhook.id);
    const updated = manager.get(webhook.id);
    expect(updated?.triggerCount).toBe(1);
    expect(updated?.lastTriggeredAt).toBeDefined();
  });

  it("verifies HMAC signature", () => {
    const { webhook } = manager.create({ name: "sig", action: "prompt", actionPayload: {} });
    const body = '{"test":true}';

    // Compute valid HMAC signature
    const expected = createHmac("sha256", webhook.secret).update(body).digest("hex");

    expect(manager.verifySignature(webhook.id, body, expected)).toBe(true);
    expect(manager.verifySignature(webhook.id, body, "invalid-sig")).toBe(false);
    expect(manager.verifySignature("nonexistent", body, expected)).toBe(false);
  });
});
