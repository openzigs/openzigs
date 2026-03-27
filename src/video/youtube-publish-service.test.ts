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

    CREATE TABLE IF NOT EXISTS director_renders (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      quality TEXT NOT NULL DEFAULT 'standard',
      status TEXT NOT NULL DEFAULT 'queued',
      output_path TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (draft_id) REFERENCES director_drafts(id) ON DELETE CASCADE
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
    name: "youtube-upload-video",
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

    it("returns failed status when youtube-upload-video tool is not available", async () => {
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
      expect(result.error).toContain("youtube-upload-video");
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
      const tool = registry.getToolDefinition("youtube-upload-video")!;
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

  describe("resolveRenderOutputPath (DB-based)", () => {
    it("resolves video path from director_renders table", async () => {
      const registry = createMockToolRegistry();
      const tmpFile = path.join(TEST_RENDERS_DIR, "My_Cool_Video.mp4");
      fs.writeFileSync(tmpFile, "fake video data");

      // Insert a completed render row pointing to our test file
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO director_renders (id, draft_id, job_id, quality, status, output_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("render-1", "draft-1", "job-1", "standard", "complete", tmpFile, now, now);

      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo, db });

      const result = await service.publish({
        draftId: "draft-1",
        title: "DB Lookup Test",
      });

      // Should succeed using the DB-resolved path
      expect(result.status).toBe("published");
      expect(result.videoId).toBe("abc123");

      // Verify the tool was called with the DB-resolved path
      const tool = registry.getToolDefinition("youtube-upload-video")!;
      expect(tool.handler).toHaveBeenCalledWith(
        expect.objectContaining({ file_path: tmpFile }),
      );
    });

    it("falls back to filesystem scan when DB has no render", async () => {
      const registry = createMockToolRegistry();
      const tmpFile = path.join(TEST_RENDERS_DIR, "Safe_Title.mp4");
      fs.writeFileSync(tmpFile, "fake video data");

      // Pass the db but don't insert any director_renders row
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo, db });

      const result = await service.publish({
        draftId: "draft-1",
        title: "Fallback Test",
      });

      // Should succeed via filesystem scan finding the .mp4
      expect(result.status).toBe("published");
      expect(result.videoId).toBe("abc123");
    });

    it("uses DB path even when filename is not output.mp4", async () => {
      const registry = createMockToolRegistry();
      const tmpFile = path.join(TEST_RENDERS_DIR, "How_to_Build_a_Rocket.mp4");
      fs.writeFileSync(tmpFile, "fake video data");

      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO director_renders (id, draft_id, job_id, quality, status, output_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("render-2", "draft-1", "job-2", "standard", "complete", tmpFile, now, now);

      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo, db });

      const result = await service.publish({
        draftId: "draft-1",
        title: "Custom Filename Test",
      });

      expect(result.status).toBe("published");
      const tool = registry.getToolDefinition("youtube-upload-video")!;
      expect(tool.handler).toHaveBeenCalledWith(
        expect.objectContaining({ file_path: tmpFile }),
      );
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

  describe("checkVideoExists", () => {
    it("returns not_found when publish ID does not exist", async () => {
      const registry = createMockToolRegistry();
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo });

      const result = await service.checkVideoExists("nonexistent");
      expect(result.exists).toBe(false);
      expect(result.status).toBe("not_found");
    });

    it("returns current status when no video_id is set", async () => {
      const registry = createMockToolRegistry();
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo });

      publishRepo.insert({
        id: "pub-check-1",
        draft_id: "draft-1",
        video_id: null,
        video_url: null,
        title: "No Video ID",
        privacy_status: "private",
        published_at: null,
        status: "failed",
        error_message: "Upload failed",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const result = await service.checkVideoExists("pub-check-1");
      expect(result.exists).toBe(false);
      expect(result.status).toBe("failed");
    });

    it("marks video as deleted when check tool reports it does not exist", async () => {
      const registry = createMockToolRegistry();
      const checkTool: ToolDefinition = {
        name: "youtube-check-video-exists",
        description: "Check video",
        inputSchema: { type: "object", properties: {} },
        zodSchema: z.object({}),
        handler: vi.fn().mockResolvedValue({
          text: JSON.stringify({ success: true, data: { exists: false, video_id: "deleted123" } }),
          isError: false,
        }),
        category: "social",
        riskLevel: "low",
        source: "youtube",
      };
      registry.registerTool(checkTool);

      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo });

      publishRepo.insert({
        id: "pub-check-2",
        draft_id: "draft-1",
        video_id: "deleted123",
        video_url: "https://youtube.com/watch?v=deleted123",
        title: "Deleted Video",
        privacy_status: "public",
        published_at: new Date().toISOString(),
        status: "published",
        error_message: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const result = await service.checkVideoExists("pub-check-2");
      expect(result.exists).toBe(false);
      expect(result.status).toBe("deleted");

      // Verify DB was updated
      const row = publishRepo.getById("pub-check-2")!;
      expect(row.status).toBe("deleted");
    });

    it("keeps published status when video still exists", async () => {
      const registry = createMockToolRegistry();
      const checkTool: ToolDefinition = {
        name: "youtube-check-video-exists",
        description: "Check video",
        inputSchema: { type: "object", properties: {} },
        zodSchema: z.object({}),
        handler: vi.fn().mockResolvedValue({
          text: JSON.stringify({ success: true, data: { exists: true, video_id: "live123" } }),
          isError: false,
        }),
        category: "social",
        riskLevel: "low",
        source: "youtube",
      };
      registry.registerTool(checkTool);

      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo });

      publishRepo.insert({
        id: "pub-check-3",
        draft_id: "draft-1",
        video_id: "live123",
        video_url: "https://youtube.com/watch?v=live123",
        title: "Live Video",
        privacy_status: "public",
        published_at: new Date().toISOString(),
        status: "published",
        error_message: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const result = await service.checkVideoExists("pub-check-3");
      expect(result.exists).toBe(true);
      expect(result.status).toBe("published");
    });

    it("returns true when check tool is not available", async () => {
      const registry = new ToolRegistry({ statePath: "/tmp/test-yt-no-check-tool.json" });
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo });

      publishRepo.insert({
        id: "pub-check-4",
        draft_id: "draft-1",
        video_id: "v123",
        video_url: "https://youtube.com/watch?v=v123",
        title: "No Tool",
        privacy_status: "public",
        published_at: new Date().toISOString(),
        status: "published",
        error_message: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const result = await service.checkVideoExists("pub-check-4");
      expect(result.exists).toBe(true);
      expect(result.status).toBe("published");
    });
  });

  describe("generateSrtForDraft", () => {
    it("returns null when no database is set", () => {
      const registry = createMockToolRegistry();
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo });
      expect(service.generateSrtForDraft("draft-1")).toBeNull();
    });

    it("returns null when draft has no subtitle segments", () => {
      const registry = createMockToolRegistry();
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo, db });

      // Draft-1 has manifest "{}" which has no timeline
      expect(service.generateSrtForDraft("draft-1")).toBeNull();
    });

    it("generates SRT from manifest with timeline", () => {
      const registry = createMockToolRegistry();
      const manifest = JSON.stringify({
        composition: { fps: 30 },
        timeline: [
          { type: "narration", scriptText: "Hello world", durationInFrames: 90 },
          { type: "narration", scriptText: "Second line", durationInFrames: 60 },
        ],
      });
      db.prepare(`UPDATE director_drafts SET manifest = ? WHERE id = ?`).run(manifest, "draft-1");

      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo, db });
      const srt = service.generateSrtForDraft("draft-1");

      expect(srt).not.toBeNull();
      expect(srt).toContain("Hello world");
      expect(srt).toContain("Second line");
      expect(srt).toContain("-->");
    });

    it("returns null for non-existent draft", () => {
      const registry = createMockToolRegistry();
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo, db });
      expect(service.generateSrtForDraft("nonexistent")).toBeNull();
    });
  });

  describe("uploadCaptions", () => {
    it("returns error when publish has no video ID", async () => {
      const registry = createMockToolRegistry();
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo, db });

      publishRepo.insert({
        id: "pub-cap-1",
        draft_id: "draft-1",
        video_id: null,
        video_url: null,
        title: "No Video",
        privacy_status: "private",
        published_at: null,
        status: "failed",
        error_message: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const result = await service.uploadCaptions("pub-cap-1");
      expect(result.success).toBe(false);
      expect(result.error).toContain("No video ID");
    });

    it("returns error when no subtitle content exists", async () => {
      const registry = createMockToolRegistry();
      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo, db });

      publishRepo.insert({
        id: "pub-cap-2",
        draft_id: "draft-1",
        video_id: "v123",
        video_url: "https://youtube.com/watch?v=v123",
        title: "No Subs",
        privacy_status: "public",
        published_at: new Date().toISOString(),
        status: "published",
        error_message: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const result = await service.uploadCaptions("pub-cap-2");
      expect(result.success).toBe(false);
      expect(result.error).toContain("No subtitle content");
    });

    it("returns error when caption upload tool is not available", async () => {
      const registry = createMockToolRegistry();
      const manifest = JSON.stringify({
        composition: { fps: 30 },
        timeline: [{ type: "narration", scriptText: "Hello", durationInFrames: 90 }],
      });
      db.prepare(`UPDATE director_drafts SET manifest = ? WHERE id = ?`).run(manifest, "draft-1");

      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo, db });

      publishRepo.insert({
        id: "pub-cap-3",
        draft_id: "draft-1",
        video_id: "v123",
        video_url: "https://youtube.com/watch?v=v123",
        title: "No Tool",
        privacy_status: "public",
        published_at: new Date().toISOString(),
        status: "published",
        error_message: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const result = await service.uploadCaptions("pub-cap-3");
      expect(result.success).toBe(false);
      expect(result.error).toContain("youtube-upload-captions tool not available");
    });

    it("uploads captions successfully", async () => {
      const registry = createMockToolRegistry();
      const captionTool: ToolDefinition = {
        name: "youtube-upload-captions",
        description: "Upload captions",
        inputSchema: { type: "object", properties: {} },
        zodSchema: z.object({}),
        handler: vi.fn().mockResolvedValue({
          text: JSON.stringify({ success: true, data: { id: "cap-1" } }),
          isError: false,
        }),
        category: "social",
        riskLevel: "medium",
        source: "youtube",
      };
      registry.registerTool(captionTool);

      const manifest = JSON.stringify({
        composition: { fps: 30 },
        timeline: [{ type: "narration", scriptText: "Hello world", durationInFrames: 90 }],
      });
      db.prepare(`UPDATE director_drafts SET manifest = ? WHERE id = ?`).run(manifest, "draft-1");

      const service = new YouTubePublishService({ toolRegistry: registry, publishRepo, db });

      publishRepo.insert({
        id: "pub-cap-4",
        draft_id: "draft-1",
        video_id: "v456",
        video_url: "https://youtube.com/watch?v=v456",
        title: "With Subs",
        privacy_status: "public",
        published_at: new Date().toISOString(),
        status: "published",
        error_message: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const result = await service.uploadCaptions("pub-cap-4");
      expect(result.success).toBe(true);

      // Verify tool was called with correct args
      expect(captionTool.handler).toHaveBeenCalledWith(
        expect.objectContaining({
          video_id: "v456",
          language: "en",
          caption_name: "English",
        }),
      );
      // Verify SRT content was included
      const callArgs = (captionTool.handler as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.srt_content).toContain("Hello world");
    });
  });
});
