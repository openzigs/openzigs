import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDraftMediaTools } from "./draft-media-tools.js";
import type { ToolDefinition } from "../tool-registry.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

vi.mock("node:fs/promises");

const DRAFTS_BASE = path.join(os.homedir(), ".openzigs", "files", "drafts");

describe("draft-media-tools", () => {
  let tools: ToolDefinition[];
  let tool: ToolDefinition;

  beforeEach(() => {
    tools = createDraftMediaTools();
    tool = tools.find((t) => t.name === "save-draft-media")!;
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.copyFile).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Factory Tests ──────────────────────────────────

  describe("createDraftMediaTools", () => {
    it("returns exactly 1 tool", () => {
      expect(tools).toHaveLength(1);
    });

    it("tool is named save-draft-media", () => {
      expect(tool.name).toBe("save-draft-media");
    });

    it("has category productivity", () => {
      expect(tool.category).toBe("productivity");
    });

    it("has riskLevel medium", () => {
      expect(tool.riskLevel).toBe("medium");
    });

    it("has valid inputSchema", () => {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
      expect(tool.inputSchema.required).toEqual(["source_path", "title", "media_type"]);
    });

    it("has non-empty description", () => {
      expect(tool.description.length).toBeGreaterThan(20);
    });
  });

  // ─── Handler Tests ──────────────────────────────────

  describe("save-draft-media handler", () => {
    it("copies file to drafts base when no project_id", async () => {
      const result = await tool.handler({
        source_path: "/tmp/test-image.png",
        title: "Test Image",
        media_type: "image",
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.text);
      expect(parsed.saved).toBe(true);
      expect(parsed.path).toBe(path.join(DRAFTS_BASE, "test-image.png"));
      expect(parsed.media_type).toBe("image");
      expect(parsed.project_id).toBeNull();

      expect(fs.mkdir).toHaveBeenCalledWith(DRAFTS_BASE, { recursive: true });
      expect(fs.copyFile).toHaveBeenCalledWith("/tmp/test-image.png", parsed.path);
    });

    it("copies file to project subdirectory when project_id provided", async () => {
      const result = await tool.handler({
        source_path: "/tmp/chart.png",
        title: "Comparison Chart",
        media_type: "image",
        project_id: "research-ai-tools",
      });

      const parsed = JSON.parse(result.text);
      expect(parsed.saved).toBe(true);
      expect(parsed.path).toContain("research-ai-tools");
      expect(parsed.project_id).toBe("research-ai-tools");

      const expectedDir = path.join(DRAFTS_BASE, "research-ai-tools");
      expect(fs.mkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
    });

    it("sanitizes title for filename", async () => {
      const result = await tool.handler({
        source_path: "/tmp/file.jpg",
        title: "My Super Image!! @#$ 2026",
        media_type: "image",
      });

      const parsed = JSON.parse(result.text);
      expect(parsed.path).toMatch(/my-super-image-2026\.jpg$/);
    });

    it("preserves source file extension", async () => {
      const result = await tool.handler({
        source_path: "/tmp/video.mp4",
        title: "Demo Video",
        media_type: "video",
      });

      const parsed = JSON.parse(result.text);
      expect(parsed.path).toMatch(/\.mp4$/);
    });

    it("adds default extension when source has none", async () => {
      const result = await tool.handler({
        source_path: "/tmp/noext",
        title: "No Extension",
        media_type: "audio",
      });

      const parsed = JSON.parse(result.text);
      expect(parsed.path).toMatch(/\.mp3$/);
    });

    it("returns error when source file does not exist", async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));

      const result = await tool.handler({
        source_path: "/nonexistent/file.png",
        title: "Missing",
        media_type: "image",
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("Source file not found");
    });

    it("returns error for invalid media_type", async () => {
      const result = await tool.handler({
        source_path: "/tmp/file.txt",
        title: "Bad Type",
        media_type: "document",
      });

      expect(result.isError).toBe(true);
    });

    it("returns error when title is missing", async () => {
      const result = await tool.handler({
        source_path: "/tmp/file.png",
        media_type: "image",
      });

      expect(result.isError).toBe(true);
    });

    it("returns error when source_path is missing", async () => {
      const result = await tool.handler({
        title: "No Path",
        media_type: "image",
      });

      expect(result.isError).toBe(true);
    });

    it("handles fs.copyFile failure gracefully", async () => {
      vi.mocked(fs.copyFile).mockRejectedValue(new Error("ENOSPC: no space left"));

      const result = await tool.handler({
        source_path: "/tmp/file.png",
        title: "Disk Full",
        media_type: "image",
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("Error saving draft media");
    });

    it("sanitizes project_id for directory name", async () => {
      const result = await tool.handler({
        source_path: "/tmp/file.png",
        title: "Test",
        media_type: "image",
        project_id: "My Project / Special!!",
      });

      const parsed = JSON.parse(result.text);
      expect(parsed.path).not.toContain("!!");
      expect(parsed.path).not.toContain("/My Project ");
    });
  });
});
