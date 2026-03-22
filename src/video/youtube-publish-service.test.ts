import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { YouTubePublishService } from "./youtube-publish-service.js";
import { YouTubePublishRepository } from "./youtube-publish-repository.js";
import { ToolRegistry } from "../mcp/tool-registry.js";
import type { ToolDefinition } from "../mcp/tool-registry.js";
import { z } from "zod";

/** Use a path inside the allowed renders directory for test temp files. */
const TEST_RENDERS_DIR = path.join(os.homedir(), ".openzigs", "renders", "__test__");

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
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
  db.prepare(
    `INSERT INTO director_drafts (id, title, manifest, production_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("draft-1", "Test Video", "{}", "ai", new Date().toISOString(), new Date().toISOString());
  return db;
}

function createMockToolRegistry(uploadResult?: { text: string; isError?: boolean }): ToolRegistry {
  const registry = new ToolRegistry({ statePath: "/tmp/test-yt-tools-state.json" });

  const mockTool: ToolDefinition = {
    name: "yt_upload_video",
    description: "Upload video to YouTube",
    inputSchema: { type: "object", properties: {} },
    zodSchema: z.object({}),
    handler: vi.fn().mockResolvedValue(
      uploadResult ?? {
        text: JSON.stringify({
          success: true,
          data: { video_id: "abc123", url: "https://www.youtube.com/watch?v=abc123" },
        }),
        isError: false,
      },
    ),
    category: "social",
    riskLevel: "medium",
    source: "youtube",
  };

  registry.registerTool(mockTool);
  return registry;
}

describe("YouTubePublishService", () => {
  let db: Database.Database;
  let publishRepo: YouTubePublishRepository;

  beforeEach(() => {
    db = createTestDb();
    publishRepo = new YouTubePublishRepository(db);
    publishRepo.migrate();
    fs.mkdirSync(TEST_RENDERS_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_RENDERS_DIR, { recursive: true, force: true });
  });

  describe("publish", () => {
    it("returns failed status when file does not exist", async () => {
      const registry = createMockToolRegistry();
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo });

      const result = await service.publish({
        draftId: "draft-1",
        filePath: path.join(TEST_RENDERS_DIR, "nonexistent-video.mp4"),
        title: "Test Upload",
      });

      expect(result.status).toBe("failed");
      expect(result.error).toContain("Video file not found");
      expect(result.videoId).toBeNull();

      // Verify it was persisted
      const row = publishRepo.getById(result.publishId);
      expect(row).toBeDefined();
      expect(row!.status).toBe("failed");
    });

    it("returns failed status when yt_upload_video tool is not available", async () => {
      const registry = new ToolRegistry({ statePath: "/tmp/test-yt-empty-state.json" });
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo });

      const tmpFile = path.join(TEST_RENDERS_DIR, "test-yt-publish-video.mp4");
      fs.writeFileSync(tmpFile, "fake video data");

      const result = await service.publish({
        draftId: "draft-1",
        filePath: tmpFile,
        title: "Test Upload",
      });

      expect(result.status).toBe("failed");
      expect(result.error).toContain("yt_upload_video");
    });

    it("publishes successfully when tool succeeds", async () => {
      const registry = createMockToolRegistry();
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo });

      const tmpFile = path.join(TEST_RENDERS_DIR, "test-yt-publish-success.mp4");
      fs.writeFileSync(tmpFile, "fake video data");

      const result = await service.publish({
        draftId: "draft-1",
        filePath: tmpFile,
        title: "My Video Title",
        description: "A great video",
        tags: ["tech", "tutorial"],
        categoryId: "28",
        privacyStatus: "public",
      });

      expect(result.status).toBe("published");
      expect(result.videoId).toBe("abc123");
      expect(result.videoUrl).toBe("https://www.youtube.com/watch?v=abc123");

      // Verify the tool was called with correct arguments
      const tool = registry.getToolDefinition("yt_upload_video")!;
      expect(tool.handler).toHaveBeenCalledWith({
        file_path: tmpFile,
        title: "My Video Title",
        description: "A great video",
        tags: ["tech", "tutorial"],
        category_id: "28",
        privacy_status: "public",
        notify_subscribers: true,
      });

      // Verify DB record was updated
      const row = publishRepo.getById(result.publishId)!;
      expect(row.status).toBe("published");
      expect(row.video_id).toBe("abc123");
    });

    it("handles tool error response", async () => {
      const registry = createMockToolRegistry({
        text: "Upload quota exceeded",
        isError: true,
      });
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo });

      const tmpFile = path.join(TEST_RENDERS_DIR, "test-yt-publish-error.mp4");
      fs.writeFileSync(tmpFile, "fake video data");

      const result = await service.publish({
        draftId: "draft-1",
        filePath: tmpFile,
        title: "Test Upload",
      });

      expect(result.status).toBe("failed");
      expect(result.error).toContain("Upload quota exceeded");
    });

    it("handles API error in response JSON", async () => {
      const registry = createMockToolRegistry({
        text: JSON.stringify({ success: false, error: "Daily quota exceeded" }),
        isError: false,
      });
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo });

      const tmpFile = path.join(TEST_RENDERS_DIR, "test-yt-publish-api-error.mp4");
      fs.writeFileSync(tmpFile, "fake video data");

      const result = await service.publish({
        draftId: "draft-1",
        filePath: tmpFile,
        title: "Test Upload",
      });

      expect(result.status).toBe("failed");
    expect(result.error).toContain("Daily quota exceeded");
    });

    it("emits Socket.IO events during publish", async () => {
      const registry = createMockToolRegistry();
      const io = { emit: vi.fn() } as unknown as import("socket.io").Server;
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo, io });

      const tmpFile = path.join(TEST_RENDERS_DIR, "test-yt-publish-events.mp4");
      fs.writeFileSync(tmpFile, "fake video data");

      await service.publish({
        draftId: "draft-1",
        filePath: tmpFile,
        title: "Test Upload",
      });

      expect(io.emit).toHaveBeenCalledWith("youtube:publish:progress", expect.objectContaining({
        draftId: "draft-1",
        stage: "uploading",
      }));
      expect(io.emit).toHaveBeenCalledWith("youtube:publish:complete", expect.objectContaining({
        draftId: "draft-1",
        videoId: "abc123",
      }));
    });
  });

  describe("getPublishStatus", () => {
    it("returns null when no publishes exist", () => {
      const registry = createMockToolRegistry();
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo });
      expect(service.getPublishStatus("draft-1")).toBeNull();
    });

    it("returns latest publish status", () => {
      const registry = createMockToolRegistry();
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo });

      publishRepo.insert({
        id: "pub-1",
        draft_id: "draft-1",
        video_id: "v1",
        video_url: "https://youtube.com/watch?v=v1",
        title: "Video",
        privacy_status: "public",
        published_at: new Date().toISOString(),
        status: "published",
        error_message: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const status = service.getPublishStatus("draft-1")!;
      expect(status.status).toBe("published");
      expect(status.videoId).toBe("v1");
    });
  });

  describe("getPublishHistory", () => {
    it("returns all publishes for a draft", () => {
      const registry = createMockToolRegistry();
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo });

      publishRepo.insert({
        id: "pub-1", draft_id: "draft-1", video_id: null, video_url: null,
        title: "V1", privacy_status: "private", published_at: null,
        status: "failed", error_message: "err",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      publishRepo.insert({
        id: "pub-2", draft_id: "draft-1", video_id: "v2", video_url: "url",
        title: "V2", privacy_status: "public", published_at: new Date().toISOString(),
        status: "published", error_message: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });

      const history = service.getPublishHistory("draft-1");
      expect(history).toHaveLength(2);
    });
  });

  describe("path traversal protection", () => {
    it("rejects file paths outside allowed directories", async () => {
      const registry = createMockToolRegistry();
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo });

      const result = await service.publish({
        draftId: "draft-1",
        filePath: "/etc/passwd",
        title: "Malicious Upload",
      });

      expect(result.status).toBe("failed");
      expect(result.error).toContain("outside allowed directories");
    });

    it("rejects path traversal attempts with ../", async () => {
      const registry = createMockToolRegistry();
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo });

      const result = await service.publish({
        draftId: "draft-1",
        filePath: "~/.openzigs/renders/../auth.json",
        title: "Traversal Attempt",
      });

      expect(result.status).toBe("failed");
      expect(result.error).toContain("outside allowed directories");
    });
  });
});
