import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { YouTubePublishRepository } from "./youtube-publish-repository.js";
import type { YouTubePublishRow } from "./youtube-publish-repository.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Create the parent table required by the FK
  db.exec(`
    CREATE TABLE IF NOT EXISTS director_drafts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      manifest TEXT NOT NULL,
      thumbnail TEXT,
      production_mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
    );
  `);

  // Insert a test draft
  db.prepare(
    `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("draft-1", "Test Video", "{}", "ai", new Date().toISOString(), new Date().toISOString());

  return db;
}

function makeRow(overrides: Partial<YouTubePublishRow> = {}): YouTubePublishRow {
  const now = new Date().toISOString();
  return {
    id: "pub-1",
    draft_id: "draft-1",
    video_id: null,
    video_url: null,
    title: "My Video",
    privacy_status: "private",
    published_at: null,
    status: "uploading",
    error_message: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("YouTubePublishRepository", () => {
  let db: Database.Database;
  let repo: YouTubePublishRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new YouTubePublishRepository(db);
    repo.migrate();
  });

  describe("migrate", () => {
    it("creates the youtube_publishes table", () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='youtube_publishes'")
        .all();
      expect(tables).toHaveLength(1);
    });

    it("is idempotent", () => {
      expect(() => repo.migrate()).not.toThrow();
    });
  });

  describe("insert + getById", () => {
    it("inserts and retrieves a publish row", () => {
      const row = makeRow();
      repo.insert(row);

      const result = repo.getById("pub-1");
      expect(result).toBeDefined();
      expect(result!.id).toBe("pub-1");
      expect(result!.draft_id).toBe("draft-1");
      expect(result!.title).toBe("My Video");
      expect(result!.status).toBe("uploading");
      expect(result!.privacy_status).toBe("private");
    });
  });

  describe("updateStatus", () => {
    it("updates status and video_id", () => {
      repo.insert(makeRow());
      repo.updateStatus("pub-1", "published", {
        video_id: "abc123",
        video_url: "https://www.youtube.com/watch?v=abc123",
        published_at: new Date().toISOString(),
      });

      const result = repo.getById("pub-1")!;
      expect(result.status).toBe("published");
      expect(result.video_id).toBe("abc123");
      expect(result.video_url).toBe("https://www.youtube.com/watch?v=abc123");
      expect(result.published_at).toBeTruthy();
    });

    it("updates status to failed with error message", () => {
      repo.insert(makeRow());
      repo.updateStatus("pub-1", "failed", {
        error_message: "Upload quota exceeded",
      });

      const result = repo.getById("pub-1")!;
      expect(result.status).toBe("failed");
      expect(result.error_message).toBe("Upload quota exceeded");
    });
  });

  describe("getByDraftId", () => {
    it("returns publishes for a draft in descending order", () => {
      const now = new Date();
      repo.insert(makeRow({ id: "pub-1", created_at: new Date(now.getTime() - 1000).toISOString() }));
      repo.insert(makeRow({ id: "pub-2", created_at: now.toISOString() }));

      const results = repo.getByDraftId("draft-1");
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe("pub-2");
      expect(results[1].id).toBe("pub-1");
    });
  });

  describe("getLatestByDraftId", () => {
    it("returns the most recent publish for a draft", () => {
      const now = new Date();
      repo.insert(makeRow({ id: "pub-1", created_at: new Date(now.getTime() - 1000).toISOString() }));
      repo.insert(makeRow({ id: "pub-2", created_at: now.toISOString() }));

      const latest = repo.getLatestByDraftId("draft-1");
      expect(latest).toBeDefined();
      expect(latest!.id).toBe("pub-2");
    });

    it("returns undefined for a draft with no publishes", () => {
      expect(repo.getLatestByDraftId("nonexistent")).toBeUndefined();
    });
  });

  describe("listAll", () => {
    it("lists all publishes", () => {
      repo.insert(makeRow({ id: "pub-1" }));
      repo.insert(makeRow({ id: "pub-2" }));

      const results = repo.listAll();
      expect(results).toHaveLength(2);
    });

    it("respects limit", () => {
      repo.insert(makeRow({ id: "pub-1" }));
      repo.insert(makeRow({ id: "pub-2" }));

      const results = repo.listAll(1);
      expect(results).toHaveLength(1);
    });
  });

  describe("deleteById", () => {
    it("deletes and returns true", () => {
      repo.insert(makeRow());
      expect(repo.deleteById("pub-1")).toBe(true);
      expect(repo.getById("pub-1")).toBeUndefined();
    });

    it("returns false for nonexistent", () => {
      expect(repo.deleteById("nonexistent")).toBe(false);
    });
  });
});
