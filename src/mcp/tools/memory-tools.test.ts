import { describe, it, expect, vi } from "vitest";
import { createMemoryTools } from "./memory-tools.js";
import type { MemoryManager, Memory, MemoryConfig } from "../../memory/memory-manager.js";

// ── Helpers ────────────────────────────────────────────────────────────

const makeMemory = (overrides: Partial<Memory> = {}): Memory => ({
  id: "memories/preferences/video-format.md",
  category: "preferences",
  title: "Video format",
  content: "Use 9:16 for TikTok, 16:9 for YouTube",
  createdAt: "2026-03-01T00:00:00Z",
  updatedAt: "2026-03-01T00:00:00Z",
  sha: "abc123",
  ...overrides,
});

const makeManager = (overrides: {
  enabled?: boolean;
  owner?: string;
  memories?: Memory[];
} = {}): MemoryManager => {
  const config: MemoryConfig = {
    enabled: overrides.enabled ?? true,
    owner: overrides.owner ?? "testuser",
    repo: "openzigs-memory",
    cacheTtlMs: 300000,
  };

  const memories = overrides.memories ?? [];

  return {
    getConfig: vi.fn(() => config),
    listMemories: vi.fn(async () => memories),
    createMemory: vi.fn(async (input) => makeMemory({
      id: `memories/${input.category}/${input.title.toLowerCase().replace(/\s+/g, "-")}.md`,
      category: input.category,
      title: input.title,
      content: input.content,
    })),
    updateMemory: vi.fn(async (id, input) => {
      const existing = memories.find((m) => m.id === id)!;
      return { ...existing, ...input, updatedAt: new Date().toISOString() };
    }),
    deleteMemory: vi.fn(async () => {}),
    invalidateCache: vi.fn(),
  } as unknown as MemoryManager;
};

// ── Tests ──────────────────────────────────────────────────────────────

describe("memory-tools", () => {
  describe("save-memory", () => {
    it("creates a new memory", async () => {
      const manager = makeManager();
      const tools = createMemoryTools({ memoryManager: manager });
      const saveTool = tools.find((t) => t.name === "save-memory")!;

      const result = await saveTool.handler({
        category: "preferences",
        title: "TikTok format",
        content: "Always use 9:16 vertical for TikTok videos",
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.text);
      expect(parsed.action).toBe("created");
      expect(parsed.title).toBe("TikTok format");
      expect(manager.createMemory).toHaveBeenCalledWith({
        category: "preferences",
        title: "TikTok format",
        content: "Always use 9:16 vertical for TikTok videos",
      });
    });

    it("updates an existing memory with the same title", async () => {
      const existing = makeMemory({ title: "Video format", category: "preferences" });
      const manager = makeManager({ memories: [existing] });
      const tools = createMemoryTools({ memoryManager: manager });
      const saveTool = tools.find((t) => t.name === "save-memory")!;

      const result = await saveTool.handler({
        category: "preferences",
        title: "Video format",
        content: "Updated: use 4:3 for Instagram",
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.text);
      expect(parsed.action).toBe("updated");
      expect(manager.updateMemory).toHaveBeenCalledWith(existing.id, {
        content: "Updated: use 4:3 for Instagram",
      });
    });

    it("returns error when memory is disabled", async () => {
      const manager = makeManager({ enabled: false });
      const tools = createMemoryTools({ memoryManager: manager });
      const saveTool = tools.find((t) => t.name === "save-memory")!;

      const result = await saveTool.handler({
        category: "context",
        title: "Test",
        content: "Content",
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("disabled");
    });

    it("returns error when owner is not set", async () => {
      const manager = makeManager({ owner: "" });
      const tools = createMemoryTools({ memoryManager: manager });
      const saveTool = tools.find((t) => t.name === "save-memory")!;

      const result = await saveTool.handler({
        category: "context",
        title: "Test",
        content: "Content",
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("not been set up");
    });

    it("handles createMemory failure gracefully", async () => {
      const manager = makeManager();
      (manager.createMemory as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("GitHub API rate limited"),
      );
      const tools = createMemoryTools({ memoryManager: manager });
      const saveTool = tools.find((t) => t.name === "save-memory")!;

      const result = await saveTool.handler({
        category: "decisions",
        title: "Some decision",
        content: "Details",
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("GitHub API rate limited");
    });
  });

  describe("recall-memories", () => {
    const memories: Memory[] = [
      makeMemory({
        id: "memories/preferences/video-format.md",
        category: "preferences",
        title: "Video format",
        content: "Use 9:16 for TikTok",
      }),
      makeMemory({
        id: "memories/context/youtube-channel.md",
        category: "context",
        title: "YouTube channel",
        content: "Channel name is TechReviews, audience is developers",
      }),
      makeMemory({
        id: "memories/conventions/posting-schedule.md",
        category: "conventions",
        title: "Posting schedule",
        content: "Post on Mon/Wed/Fri at 9am EST",
      }),
    ];

    it("returns all memories when no filters given", async () => {
      const manager = makeManager({ memories });
      const tools = createMemoryTools({ memoryManager: manager });
      const recallTool = tools.find((t) => t.name === "recall-memories")!;

      const result = await recallTool.handler({});
      const parsed = JSON.parse(result.text);

      expect(parsed.count).toBe(3);
      expect(parsed.memories).toHaveLength(3);
    });

    it("filters by category", async () => {
      const manager = makeManager({ memories });
      const tools = createMemoryTools({ memoryManager: manager });
      const recallTool = tools.find((t) => t.name === "recall-memories")!;

      const result = await recallTool.handler({ category: "preferences" });
      const parsed = JSON.parse(result.text);

      expect(parsed.count).toBe(1);
      expect(parsed.memories[0].title).toBe("Video format");
    });

    it("filters by keyword", async () => {
      const manager = makeManager({ memories });
      const tools = createMemoryTools({ memoryManager: manager });
      const recallTool = tools.find((t) => t.name === "recall-memories")!;

      const result = await recallTool.handler({ query: "youtube" });
      const parsed = JSON.parse(result.text);

      expect(parsed.count).toBe(1);
      expect(parsed.memories[0].title).toBe("YouTube channel");
    });

    it("filters by category AND keyword", async () => {
      const manager = makeManager({ memories });
      const tools = createMemoryTools({ memoryManager: manager });
      const recallTool = tools.find((t) => t.name === "recall-memories")!;

      const result = await recallTool.handler({ category: "context", query: "youtube" });
      const parsed = JSON.parse(result.text);

      expect(parsed.count).toBe(1);
      expect(parsed.memories[0].category).toBe("context");
    });

    it("returns empty when no matches", async () => {
      const manager = makeManager({ memories });
      const tools = createMemoryTools({ memoryManager: manager });
      const recallTool = tools.find((t) => t.name === "recall-memories")!;

      const result = await recallTool.handler({ query: "nonexistent" });
      const parsed = JSON.parse(result.text);

      expect(parsed.count).toBe(0);
      expect(parsed.memories).toHaveLength(0);
    });

    it("returns empty with message when disabled", async () => {
      const manager = makeManager({ enabled: false });
      const tools = createMemoryTools({ memoryManager: manager });
      const recallTool = tools.find((t) => t.name === "recall-memories")!;

      const result = await recallTool.handler({});
      const parsed = JSON.parse(result.text);

      expect(parsed.memories).toHaveLength(0);
      expect(parsed.message).toContain("disabled");
    });

    it("returns empty with message when not set up", async () => {
      const manager = makeManager({ owner: "" });
      const tools = createMemoryTools({ memoryManager: manager });
      const recallTool = tools.find((t) => t.name === "recall-memories")!;

      const result = await recallTool.handler({});
      const parsed = JSON.parse(result.text);

      expect(parsed.memories).toHaveLength(0);
      expect(parsed.message).toContain("not set up");
    });
  });

  it("registers exactly two tools", () => {
    const manager = makeManager();
    const tools = createMemoryTools({ memoryManager: manager });

    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["recall-memories", "save-memory"]);
  });

  it("tools have correct metadata", () => {
    const manager = makeManager();
    const tools = createMemoryTools({ memoryManager: manager });

    for (const tool of tools) {
      expect(tool.category).toBe("productivity");
      expect(tool.riskLevel).toBe("low");
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });
});
