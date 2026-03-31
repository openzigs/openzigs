import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { WebhookRepository } from "./webhook-repository.js";
import type { WebhookConfig } from "./webhook-manager.js";

const createTestDb = () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
};

const makeConfig = (overrides: Partial<WebhookConfig> = {}): WebhookConfig => ({
  id: "wh_test_1",
  name: "Test Hook",
  action: "prompt",
  actionPayload: { promptName: "daily-summary" },
  secret: "deadbeef",
  apiKeyHash: "hash123",
  apiKeySalt: "salt123",
  enabled: true,
  allowedIps: ["10.0.0.1"],
  rateLimit: 60,
  createdAt: "2026-03-31T00:00:00.000Z",
  updatedAt: "2026-03-31T00:00:00.000Z",
  lastTriggeredAt: null,
  triggerCount: 0,
  ...overrides,
});

describe("WebhookRepository", () => {
  let db: Database.Database;
  let repo: WebhookRepository;
  const now = new Date("2026-03-31T12:00:00Z");
  const clock = () => now;

  beforeEach(() => {
    db = createTestDb();
    repo = new WebhookRepository(db, clock);
    repo.migrate();
  });

  // ── Schema ──

  describe("migrate", () => {
    it("creates the webhooks table", () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='webhooks'")
        .all();
      expect(tables).toHaveLength(1);
    });

    it("is idempotent — can be called multiple times", () => {
      repo.migrate();
      repo.migrate();
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='webhooks'")
        .all();
      expect(tables).toHaveLength(1);
    });
  });

  // ── Insert + getById ──

  describe("insert + getById", () => {
    it("inserts and retrieves a webhook by ID", () => {
      const config = makeConfig();
      repo.insert(config);
      const retrieved = repo.getById("wh_test_1");
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe("wh_test_1");
      expect(retrieved!.name).toBe("Test Hook");
      expect(retrieved!.action).toBe("prompt");
      expect(retrieved!.actionPayload).toEqual({ promptName: "daily-summary" });
      expect(retrieved!.secret).toBe("deadbeef");
      expect(retrieved!.apiKeyHash).toBe("hash123");
      expect(retrieved!.apiKeySalt).toBe("salt123");
      expect(retrieved!.enabled).toBe(true);
      expect(retrieved!.allowedIps).toEqual(["10.0.0.1"]);
      expect(retrieved!.rateLimit).toBe(60);
      expect(retrieved!.triggerCount).toBe(0);
      expect(retrieved!.lastTriggeredAt).toBeNull();
    });

    it("returns undefined for nonexistent ID", () => {
      expect(repo.getById("nonexistent")).toBeUndefined();
    });

    it("stores and retrieves the goal action type", () => {
      const config = makeConfig({ id: "wh_goal", action: "goal", actionPayload: { goal: "run report" } });
      repo.insert(config);
      const retrieved = repo.getById("wh_goal");
      expect(retrieved!.action).toBe("goal");
      expect(retrieved!.actionPayload).toEqual({ goal: "run report" });
    });

    it("handles empty allowedIps array", () => {
      const config = makeConfig({ id: "wh_empty_ips", allowedIps: [] });
      repo.insert(config);
      const retrieved = repo.getById("wh_empty_ips");
      expect(retrieved!.allowedIps).toEqual([]);
    });

    it("handles a webhook with lastTriggeredAt set", () => {
      const config = makeConfig({ id: "wh_triggered", lastTriggeredAt: "2026-03-31T06:00:00.000Z", triggerCount: 5 });
      repo.insert(config);
      const retrieved = repo.getById("wh_triggered");
      expect(retrieved!.lastTriggeredAt).toBe("2026-03-31T06:00:00.000Z");
      expect(retrieved!.triggerCount).toBe(5);
    });
  });

  // ── List ──

  describe("list", () => {
    it("returns empty array when no webhooks exist", () => {
      expect(repo.list()).toEqual([]);
    });

    it("returns all webhooks ordered by created_at DESC", () => {
      repo.insert(makeConfig({ id: "wh_a", name: "Alpha", createdAt: "2026-03-30T00:00:00.000Z" }));
      repo.insert(makeConfig({ id: "wh_b", name: "Beta", createdAt: "2026-03-31T00:00:00.000Z" }));
      const list = repo.list();
      expect(list).toHaveLength(2);
      expect(list[0].name).toBe("Beta");
      expect(list[1].name).toBe("Alpha");
    });
  });

  // ── Update ──

  describe("update", () => {
    it("updates the enabled flag", () => {
      repo.insert(makeConfig());
      const updated = repo.update("wh_test_1", { enabled: false });
      expect(updated!.enabled).toBe(false);
      expect(updated!.updatedAt).toBe("2026-03-31T12:00:00.000Z");
    });

    it("updates name", () => {
      repo.insert(makeConfig());
      const updated = repo.update("wh_test_1", { name: "New Name" });
      expect(updated!.name).toBe("New Name");
    });

    it("updates apiKeyHash and apiKeySalt", () => {
      repo.insert(makeConfig());
      const updated = repo.update("wh_test_1", { apiKeyHash: "newhash", apiKeySalt: "newsalt" });
      expect(updated!.apiKeyHash).toBe("newhash");
      expect(updated!.apiKeySalt).toBe("newsalt");
    });

    it("updates triggerCount and lastTriggeredAt", () => {
      repo.insert(makeConfig());
      const updated = repo.update("wh_test_1", { triggerCount: 42, lastTriggeredAt: "2026-03-31T11:00:00.000Z" });
      expect(updated!.triggerCount).toBe(42);
      expect(updated!.lastTriggeredAt).toBe("2026-03-31T11:00:00.000Z");
    });

    it("updates allowedIps", () => {
      repo.insert(makeConfig());
      const updated = repo.update("wh_test_1", { allowedIps: ["192.168.1.0/24"] });
      expect(updated!.allowedIps).toEqual(["192.168.1.0/24"]);
    });

    it("updates rateLimit", () => {
      repo.insert(makeConfig());
      const updated = repo.update("wh_test_1", { rateLimit: 120 });
      expect(updated!.rateLimit).toBe(120);
    });

    it("returns undefined for nonexistent ID", () => {
      expect(repo.update("nonexistent", { enabled: false })).toBeUndefined();
    });
  });

  // ── Delete ──

  describe("deleteById", () => {
    it("deletes an existing webhook and returns true", () => {
      repo.insert(makeConfig());
      expect(repo.deleteById("wh_test_1")).toBe(true);
      expect(repo.getById("wh_test_1")).toBeUndefined();
    });

    it("returns false for nonexistent ID", () => {
      expect(repo.deleteById("nonexistent")).toBe(false);
    });

    it("does not affect other webhooks", () => {
      repo.insert(makeConfig({ id: "wh_a", name: "A" }));
      repo.insert(makeConfig({ id: "wh_b", name: "B" }));
      repo.deleteById("wh_a");
      expect(repo.list()).toHaveLength(1);
      expect(repo.list()[0].name).toBe("B");
    });
  });

  // ── Persistence across new repo instance ──

  describe("persistence", () => {
    it("data survives a new WebhookRepository instance on the same db", () => {
      repo.insert(makeConfig({ id: "wh_persist" }));
      const repo2 = new WebhookRepository(db, clock);
      // No need to re-migrate — table already exists
      const retrieved = repo2.getById("wh_persist");
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe("wh_persist");
    });
  });

  // ── Clock injection ──

  describe("clock injection", () => {
    it("uses injected clock for updated_at on update", () => {
      const customClock = () => new Date("2099-12-31T23:59:59.000Z");
      const clockedRepo = new WebhookRepository(db, customClock);
      clockedRepo.migrate();
      clockedRepo.insert(makeConfig({ id: "wh_clock" }));
      const updated = clockedRepo.update("wh_clock", { name: "Clocked" });
      expect(updated!.updatedAt).toBe("2099-12-31T23:59:59.000Z");
    });
  });

  // ── Edge cases ──

  describe("edge cases", () => {
    it("stores complex actionPayload with nested objects", () => {
      const payload = { promptName: "test", vars: { a: 1, b: [2, 3] }, deep: { nested: true } };
      repo.insert(makeConfig({ id: "wh_complex", actionPayload: payload }));
      const retrieved = repo.getById("wh_complex");
      expect(retrieved!.actionPayload).toEqual(payload);
    });

    it("stores multiple allowed IPs", () => {
      const ips = ["10.0.0.1", "192.168.1.0/24", "172.16.0.0/12"];
      repo.insert(makeConfig({ id: "wh_multi_ip", allowedIps: ips }));
      const retrieved = repo.getById("wh_multi_ip");
      expect(retrieved!.allowedIps).toEqual(ips);
    });

    it("handles rateLimit of 0 (unlimited)", () => {
      repo.insert(makeConfig({ id: "wh_unlimited", rateLimit: 0 }));
      const retrieved = repo.getById("wh_unlimited");
      expect(retrieved!.rateLimit).toBe(0);
    });

    it("rejects duplicate primary key", () => {
      repo.insert(makeConfig({ id: "wh_dup" }));
      expect(() => repo.insert(makeConfig({ id: "wh_dup" }))).toThrow();
    });
  });
});
