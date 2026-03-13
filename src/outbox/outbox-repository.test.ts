import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { OutboxRepository, type OutboxPlatform } from "./outbox-repository.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function createRepo(db: Database.Database, clock?: () => Date): OutboxRepository {
  const repo = new OutboxRepository(db, clock);
  repo.migrate();
  return repo;
}

const NOW = new Date("2026-03-13T12:00:00Z");
const PAST = new Date("2026-03-13T11:00:00Z");
const FUTURE = new Date("2026-03-13T13:00:00Z");

describe("OutboxRepository", () => {
  let db: Database.Database;
  let repo: OutboxRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = createRepo(db, () => NOW);
  });

  describe("migrate()", () => {
    it("creates the outbox_queue table", () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='outbox_queue'",
      ).all();
      expect(tables).toHaveLength(1);
    });

    it("is idempotent — can run migrate twice", () => {
      repo.migrate();
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='outbox_queue'",
      ).all();
      expect(tables).toHaveLength(1);
    });
  });

  describe("insert()", () => {
    it("inserts a new outbox item with correct defaults", () => {
      const item = repo.insert({
        assetId: "asset-1",
        platform: "twitter",
        scheduledTime: PAST,
        agentContext: "Write a sarcastic caption",
      });

      expect(item.id).toBeDefined();
      expect(item.assetId).toBe("asset-1");
      expect(item.platform).toBe("twitter");
      expect(item.status).toBe("pending");
      expect(item.agentContext).toBe("Write a sarcastic caption");
      expect(item.retryCount).toBe(0);
      expect(item.maxRetries).toBe(3);
      expect(item.assetType).toBe("image");
      expect(item.error).toBeNull();
      expect(item.publishedUrl).toBeNull();
    });

    it("inserts with custom asset type and metadata", () => {
      const item = repo.insert({
        assetId: "video-1",
        assetType: "video",
        platform: "youtube",
        scheduledTime: FUTURE,
        agentContext: "Upload this tech review",
        platformMetadata: { youtube_title: "Tech Review", youtube_tags: ["tech"] },
        maxRetries: 5,
      });

      expect(item.assetType).toBe("video");
      expect(item.platformMetadata).toEqual({ youtube_title: "Tech Review", youtube_tags: ["tech"] });
      expect(item.maxRetries).toBe(5);
    });

    it("throws for invalid platform", () => {
      expect(() =>
        repo.insert({
          platform: "tiktok" as OutboxPlatform,
          scheduledTime: PAST,
          agentContext: "test",
        }),
      ).toThrow("Invalid platform: tiktok");
    });
  });

  describe("getById()", () => {
    it("returns the item by ID", () => {
      const inserted = repo.insert({
        platform: "pinterest",
        scheduledTime: PAST,
        agentContext: "Pin this",
      });
      const found = repo.getById(inserted.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(inserted.id);
    });

    it("returns null for unknown ID", () => {
      expect(repo.getById("nonexistent")).toBeNull();
    });
  });

  describe("list()", () => {
    beforeEach(() => {
      repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "t1" });
      repo.insert({ platform: "pinterest", scheduledTime: PAST, agentContext: "t2" });
      repo.insert({ platform: "twitter", scheduledTime: FUTURE, agentContext: "t3" });
    });

    it("returns all items with default filters", () => {
      const items = repo.list();
      expect(items).toHaveLength(3);
    });

    it("filters by platform", () => {
      const items = repo.list({ platform: "twitter" });
      expect(items).toHaveLength(2);
      expect(items.every((i) => i.platform === "twitter")).toBe(true);
    });

    it("filters by status", () => {
      const items = repo.list({ status: "pending" });
      expect(items).toHaveLength(3);
      const processing = repo.list({ status: "processing" });
      expect(processing).toHaveLength(0);
    });

    it("respects pagination", () => {
      const page1 = repo.list({ limit: 2, offset: 0 });
      const page2 = repo.list({ limit: 2, offset: 2 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
    });
  });

  describe("getStats()", () => {
    it("returns correct counts by status", () => {
      repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "a" });
      repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "b" });
      repo.insert({ platform: "pinterest", scheduledTime: PAST, agentContext: "c" });

      const stats = repo.getStats();
      expect(stats.pending).toBe(3);
      expect(stats.processing).toBe(0);
      expect(stats.published).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.canceled).toBe(0);
      expect(stats.total).toBe(3);
    });

    it("returns zero stats for empty table", () => {
      const stats = repo.getStats();
      expect(stats.total).toBe(0);
    });
  });

  describe("claimPending()", () => {
    it("claims items whose scheduled_time has passed", () => {
      repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "past" });
      repo.insert({ platform: "twitter", scheduledTime: FUTURE, agentContext: "future" });

      const claimed = repo.claimPending(10);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].status).toBe("processing");
      expect(claimed[0].agentContext).toBe("past");
    });

    it("respects batch size limit", () => {
      for (let i = 0; i < 5; i++) {
        repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: `item-${i}` });
      }
      const claimed = repo.claimPending(3);
      expect(claimed).toHaveLength(3);
      expect(claimed.every((i) => i.status === "processing")).toBe(true);

      // Remaining should still be pending
      const stats = repo.getStats();
      expect(stats.pending).toBe(2);
      expect(stats.processing).toBe(3);
    });

    it("does not claim already processing items", () => {
      repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "a" });
      const first = repo.claimPending(10);
      expect(first).toHaveLength(1);

      const second = repo.claimPending(10);
      expect(second).toHaveLength(0);
    });

    it("returns empty array when nothing to claim", () => {
      const claimed = repo.claimPending(10);
      expect(claimed).toHaveLength(0);
    });
  });

  describe("markPublished()", () => {
    it("transitions processing → published", () => {
      const item = repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "test" });
      repo.claimPending(1);

      const published = repo.markPublished(item.id, "https://twitter.com/status/123");
      expect(published).not.toBeNull();
      expect(published!.status).toBe("published");
      expect(published!.publishedUrl).toBe("https://twitter.com/status/123");
      expect(published!.completedAt).not.toBeNull();
    });

    it("returns null if item is not in processing status", () => {
      const item = repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "test" });
      const result = repo.markPublished(item.id, "https://twitter.com/123");
      expect(result).toBeNull();
    });
  });

  describe("markFailed()", () => {
    it("transitions processing → failed with error", () => {
      const item = repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "test" });
      repo.claimPending(1);

      const failed = repo.markFailed(item.id, "API rate limit exceeded");
      expect(failed).not.toBeNull();
      expect(failed!.status).toBe("failed");
      expect(failed!.error).toBe("API rate limit exceeded");
      expect(failed!.retryCount).toBe(1);
    });
  });

  describe("retry()", () => {
    it("transitions failed → pending", () => {
      const item = repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "test" });
      repo.claimPending(1);
      repo.markFailed(item.id, "error");

      const retried = repo.retry(item.id);
      expect(retried).not.toBeNull();
      expect(retried!.status).toBe("pending");
      expect(retried!.error).toBeNull();
    });

    it("returns null if item is not in failed status", () => {
      const item = repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "test" });
      const result = repo.retry(item.id);
      expect(result).toBeNull();
    });
  });

  describe("cancel()", () => {
    it("cancels a pending item", () => {
      const item = repo.insert({ platform: "twitter", scheduledTime: FUTURE, agentContext: "test" });
      const canceled = repo.cancel(item.id);
      expect(canceled).not.toBeNull();
      expect(canceled!.status).toBe("canceled");
    });

    it("cancels a failed item", () => {
      const item = repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "test" });
      repo.claimPending(1);
      repo.markFailed(item.id, "err");

      const canceled = repo.cancel(item.id);
      expect(canceled).not.toBeNull();
      expect(canceled!.status).toBe("canceled");
    });

    it("returns null for processing items", () => {
      const item = repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "test" });
      repo.claimPending(1);
      const result = repo.cancel(item.id);
      expect(result).toBeNull();
    });
  });

  describe("delete()", () => {
    it("removes an item from the database", () => {
      const item = repo.insert({ platform: "twitter", scheduledTime: PAST, agentContext: "test" });
      expect(repo.delete(item.id)).toBe(true);
      expect(repo.getById(item.id)).toBeNull();
    });

    it("returns false for unknown ID", () => {
      expect(repo.delete("nonexistent")).toBe(false);
    });
  });
});
