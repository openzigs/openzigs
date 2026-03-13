import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { OutboxRepository } from "../../outbox/outbox-repository.js";
import { createOutboxTools } from "./outbox-tools.js";
import type { ToolDefinition } from "../tool-registry.js";

const NOW = new Date("2026-03-13T12:00:00Z");
const PAST = new Date("2026-03-13T11:00:00Z");

function setup() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const repo = new OutboxRepository(db, () => NOW);
  repo.migrate();

  const mockIo = { emit: vi.fn() };
  const tools = createOutboxTools({ outboxRepo: repo, io: mockIo as any });
  const byName = (name: string) => tools.find((t) => t.name === name)!;

  return { db, repo, tools, byName, mockIo };
}

describe("outbox-tools", () => {
  let repo: OutboxRepository;
  let byName: (name: string) => ToolDefinition;
  let mockIo: { emit: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    const s = setup();
    repo = s.repo;
    byName = s.byName;
    mockIo = s.mockIo as { emit: ReturnType<typeof vi.fn> };
  });

  describe("pop-next-queue-item", () => {
    it("returns no items when queue is empty", async () => {
      const tool = byName("pop-next-queue-item");
      const result = await tool.handler({});
      expect(result.text).toContain("No processing items");
      expect(result.isError).toBeUndefined();
    });

    it("returns a specific processing item by ID", async () => {
      const item = repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "test" });
      repo.claimPending(1);

      const tool = byName("pop-next-queue-item");
      const result = await tool.handler({ item_id: item.id });
      const parsed = JSON.parse(result.text);
      expect(parsed.id).toBe(item.id);
      expect(parsed.status).toBe("processing");
    });

    it("errors when item is not in processing status", async () => {
      const item = repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "test" });

      const tool = byName("pop-next-queue-item");
      const result = await tool.handler({ item_id: item.id });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("pending");
    });

    it("returns oldest processing item when no ID given", async () => {
      repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "first" });
      repo.insert({ platform: "pinterest", scheduledTime: PAST, agentContext: "second" });
      repo.claimPending(10);

      const tool = byName("pop-next-queue-item");
      const result = await tool.handler({});
      const parsed = JSON.parse(result.text);
      expect(parsed.status).toBe("processing");
    });

    it("returns error for nonexistent item_id", async () => {
      const tool = byName("pop-next-queue-item");
      const result = await tool.handler({ item_id: "nonexistent" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not found");
    });
  });

  describe("update-outbox-status", () => {
    it("marks an item as published", async () => {
      const item = repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "test" });
      repo.claimPending(1);

      const tool = byName("update-outbox-status");
      const result = await tool.handler({
        item_id: item.id,
        status: "published",
        published_url: "https://twitter.com/status/123",
      });

      expect(result.text).toContain("published");
      expect(result.isError).toBeUndefined();
      expect(mockIo.emit).toHaveBeenCalledWith("outbox:updated");

      const updated = repo.getById(item.id);
      expect(updated!.status).toBe("published");
      expect(updated!.publishedUrl).toBe("https://twitter.com/status/123");
    });

    it("marks an item as failed", async () => {
      const item = repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "test" });
      repo.claimPending(1);

      const tool = byName("update-outbox-status");
      const result = await tool.handler({
        item_id: item.id,
        status: "failed",
        error: "Rate limit exceeded",
      });

      expect(result.text).toContain("failed");
      expect(mockIo.emit).toHaveBeenCalledWith("outbox:updated");

      const updated = repo.getById(item.id);
      expect(updated!.status).toBe("failed");
      expect(updated!.error).toBe("Rate limit exceeded");
    });

    it("returns error when item is not processing", async () => {
      const item = repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "test" });

      const tool = byName("update-outbox-status");
      const result = await tool.handler({
        item_id: item.id,
        status: "published",
        published_url: "https://example.com",
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("not in 'processing' status");
    });

    it("uses default error message when none provided", async () => {
      const item = repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "test" });
      repo.claimPending(1);

      const tool = byName("update-outbox-status");
      await tool.handler({ item_id: item.id, status: "failed" });

      const updated = repo.getById(item.id);
      expect(updated!.error).toBe("Unknown error");
    });
  });
});
