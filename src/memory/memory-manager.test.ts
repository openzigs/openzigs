import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MemoryManager,
  createGitHubApiClient,
  type GitHubApiClient,
  type MemoryConfig,
  type GitHubContent,
  formatMemoryFile,
  parseMemoryFile,
  slugify,
  MEMORY_CATEGORIES,
} from "./memory-manager.js";

// ── Helpers ────────────────────────────────────────────────────────────

function createMockGitHub(overrides: Partial<GitHubApiClient> = {}): GitHubApiClient {
  return {
    getAuthenticatedUser: vi.fn().mockResolvedValue({ login: "testuser" }),
    getRepo: vi.fn().mockResolvedValue({ full_name: "testuser/openzigs-memory" }),
    createRepo: vi.fn().mockResolvedValue({ full_name: "testuser/openzigs-memory" }),
    getContents: vi.fn().mockResolvedValue(null),
    createOrUpdateFile: vi.fn().mockResolvedValue({ content: { sha: "abc123" } }),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    enabled: true,
    owner: "testuser",
    repo: "openzigs-memory",
    cacheTtlMs: 60_000,
    ...overrides,
  };
}

function encodeContent(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

const SAMPLE_MEMORY_FILE = formatMemoryFile(
  "ESM Imports",
  "Always use explicit `.js` extensions in ESM imports.",
  "2026-01-01T00:00:00.000Z",
  "2026-01-01T00:00:00.000Z",
);

// ── File Format ────────────────────────────────────────────────────────

describe("formatMemoryFile / parseMemoryFile", () => {
  it("round-trips title, content, and timestamps", () => {
    const raw = formatMemoryFile("My Title", "Some content", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
    const parsed = parseMemoryFile(raw);
    expect(parsed.title).toBe("My Title");
    expect(parsed.content).toBe("Some content");
    expect(parsed.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(parsed.updatedAt).toBe("2026-02-01T00:00:00Z");
  });

  it("handles content without frontmatter", () => {
    const parsed = parseMemoryFile("Just plain text");
    expect(parsed.title).toBe("Untitled");
    expect(parsed.content).toBe("Just plain text");
  });

  it("escapes double quotes in title", () => {
    const raw = formatMemoryFile('Say "hello"', "body", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    expect(raw).toContain('title: "Say \\"hello\\""');
  });
});

describe("slugify", () => {
  it("converts title to URL-safe slug", () => {
    expect(slugify("ESM Import Extensions")).toBe("esm-import-extensions");
  });

  it("strips leading/trailing hyphens", () => {
    expect(slugify("  --Hello World--  ")).toBe("hello-world");
  });

  it("truncates at 80 characters", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });
});

// ── MemoryManager ──────────────────────────────────────────────────────

describe("MemoryManager", () => {
  let github: ReturnType<typeof createMockGitHub>;
  let manager: MemoryManager;

  beforeEach(() => {
    github = createMockGitHub();
    manager = new MemoryManager(makeConfig(), github);
  });

  // ── Config ─────────────────────────────────────────────────────────

  describe("getConfig / updateConfig", () => {
    it("returns a copy of the config", () => {
      const cfg = manager.getConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.repo).toBe("openzigs-memory");
    });

    it("emits config:changed on update", () => {
      const spy = vi.fn();
      manager.on("config:changed", spy);
      manager.updateConfig({ enabled: false });
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    });

    it("invalidates cache on config change", async () => {
      // Populate cache
      (github.getContents as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await manager.listMemories();
      manager.updateConfig({ cacheTtlMs: 120_000 });
      // Next listMemories should re-fetch (cache was invalidated)
      await manager.listMemories();
      // getContents called once per category × 2 rounds = 10
      expect(github.getContents).toHaveBeenCalledTimes(MEMORY_CATEGORIES.length * 2);
    });
  });

  // ── Setup Repo ─────────────────────────────────────────────────────

  describe("setupRepo", () => {
    it("returns created: false when repo already exists", async () => {
      (github.getRepo as ReturnType<typeof vi.fn>).mockResolvedValue({ full_name: "testuser/openzigs-memory" });
      const result = await manager.setupRepo();
      expect(result.created).toBe(false);
      expect(github.createRepo).not.toHaveBeenCalled();
    });

    it("creates repo and initialises structure when repo does not exist", async () => {
      (github.getRepo as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const result = await manager.setupRepo();
      expect(result.created).toBe(true);
      expect(github.createRepo).toHaveBeenCalledWith(
        "openzigs-memory",
        true,
        expect.stringContaining("persistent"),
      );
      expect(github.createOrUpdateFile).toHaveBeenCalledWith(
        "testuser", "openzigs-memory", "memories/README.md",
        expect.stringContaining("initialise"),
        expect.stringContaining("Agent Memory"),
      );
    });

    it("uses authenticated user login when owner is empty", async () => {
      manager.updateConfig({ owner: "" });
      (github.getRepo as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await manager.setupRepo();
      expect(github.getAuthenticatedUser).toHaveBeenCalled();
      expect(github.createRepo).toHaveBeenCalled();
    });

    it("emits repo:created event", async () => {
      (github.getRepo as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const spy = vi.fn();
      manager.on("repo:created", spy);
      await manager.setupRepo();
      expect(spy).toHaveBeenCalledWith({ owner: "testuser", repo: "openzigs-memory" });
    });
  });

  // ── Status ─────────────────────────────────────────────────────────

  describe("getStatus", () => {
    it("returns disconnected when disabled", async () => {
      manager.updateConfig({ enabled: false });
      const status = await manager.getStatus();
      expect(status.connected).toBe(false);
      expect(status.error).toBe("Memory is disabled");
    });

    it("returns disconnected when repo not found", async () => {
      (github.getRepo as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const status = await manager.getStatus();
      expect(status.connected).toBe(false);
      expect(status.error).toBe("Repository not found");
    });

    it("returns connected with memory count", async () => {
      (github.getRepo as ReturnType<typeof vi.fn>).mockResolvedValue({ full_name: "testuser/openzigs-memory" });
      // No memories
      (github.getContents as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const status = await manager.getStatus();
      expect(status.connected).toBe(true);
      expect(status.memoryCount).toBe(0);
    });

    it("returns error on API failure", async () => {
      (github.getRepo as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));
      const status = await manager.getStatus();
      expect(status.connected).toBe(false);
      expect(status.error).toBe("Network error");
    });
  });

  // ── CRUD ───────────────────────────────────────────────────────────

  describe("listMemories", () => {
    it("returns empty array when no categories have files", async () => {
      const memories = await manager.listMemories();
      expect(memories).toEqual([]);
    });

    it("fetches and parses memories from all categories", async () => {
      const listing: GitHubContent[] = [
        { name: "esm-imports.md", path: "memories/conventions/esm-imports.md", sha: "s1", type: "file" },
      ];
      const fileContent: GitHubContent = {
        name: "esm-imports.md",
        path: "memories/conventions/esm-imports.md",
        sha: "s1",
        type: "file",
        content: encodeContent(SAMPLE_MEMORY_FILE),
        encoding: "base64",
      };
      (github.getContents as ReturnType<typeof vi.fn>).mockImplementation(
        async (_o: string, _r: string, p: string) => {
          if (p === "memories/conventions") return listing;
          if (p === "memories/conventions/esm-imports.md") return fileContent;
          return null;
        },
      );

      const memories = await manager.listMemories();
      expect(memories).toHaveLength(1);
      expect(memories[0].title).toBe("ESM Imports");
      expect(memories[0].category).toBe("conventions");
    });

    it("uses cache on subsequent calls", async () => {
      (github.getContents as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await manager.listMemories();
      await manager.listMemories();
      // Only called once per category (5 categories × 1 round)
      expect(github.getContents).toHaveBeenCalledTimes(MEMORY_CATEGORIES.length);
    });
  });

  describe("createMemory", () => {
    it("creates a file in the correct path", async () => {
      const memory = await manager.createMemory({
        category: "conventions",
        title: "ESM Import Extensions",
        content: "Always use `.js` extensions.",
      });

      expect(memory.id).toBe("memories/conventions/esm-import-extensions.md");
      expect(memory.category).toBe("conventions");
      expect(memory.sha).toBe("abc123");
      expect(github.createOrUpdateFile).toHaveBeenCalledWith(
        "testuser", "openzigs-memory",
        "memories/conventions/esm-import-extensions.md",
        "memory: add conventions/esm-import-extensions",
        expect.stringContaining("ESM Import Extensions"),
      );
    });

    it("emits memory:created event", async () => {
      const spy = vi.fn();
      manager.on("memory:created", spy);
      await manager.createMemory({ category: "patterns", title: "Test", content: "body" });
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ category: "patterns", title: "Test" }));
    });
  });

  describe("updateMemory", () => {
    it("updates the file content and sha", async () => {
      // Seed cache with one memory
      const listing: GitHubContent[] = [
        { name: "test.md", path: "memories/conventions/test.md", sha: "old-sha", type: "file" },
      ];
      const fileContent: GitHubContent = {
        name: "test.md",
        path: "memories/conventions/test.md",
        sha: "old-sha",
        type: "file",
        content: encodeContent(formatMemoryFile("Test", "old content", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")),
        encoding: "base64",
      };
      (github.getContents as ReturnType<typeof vi.fn>).mockImplementation(
        async (_o: string, _r: string, p: string) => {
          if (p === "memories/conventions") return listing;
          if (p === "memories/conventions/test.md") return fileContent;
          return null;
        },
      );
      (github.createOrUpdateFile as ReturnType<typeof vi.fn>).mockResolvedValue({ content: { sha: "new-sha" } });

      const updated = await manager.updateMemory("memories/conventions/test.md", { content: "new content" });
      expect(updated.content).toBe("new content");
      expect(updated.sha).toBe("new-sha");
      expect(github.createOrUpdateFile).toHaveBeenCalledWith(
        "testuser", "openzigs-memory", "memories/conventions/test.md",
        "memory: update memories/conventions/test.md",
        expect.stringContaining("new content"),
        "old-sha",
      );
    });

    it("throws when memory not found", async () => {
      (github.getContents as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(manager.updateMemory("nonexistent", { content: "x" })).rejects.toThrow("Memory not found");
    });
  });

  describe("deleteMemory", () => {
    it("deletes the file from GitHub", async () => {
      // Seed cache
      const listing: GitHubContent[] = [
        { name: "test.md", path: "memories/patterns/test.md", sha: "del-sha", type: "file" },
      ];
      const fileContent: GitHubContent = {
        name: "test.md", path: "memories/patterns/test.md", sha: "del-sha", type: "file",
        content: encodeContent(formatMemoryFile("Test", "body", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")),
        encoding: "base64",
      };
      (github.getContents as ReturnType<typeof vi.fn>).mockImplementation(
        async (_o: string, _r: string, p: string) => {
          if (p === "memories/patterns") return listing;
          if (p === "memories/patterns/test.md") return fileContent;
          return null;
        },
      );

      await manager.deleteMemory("memories/patterns/test.md");
      expect(github.deleteFile).toHaveBeenCalledWith(
        "testuser", "openzigs-memory", "memories/patterns/test.md",
        "memory: delete memories/patterns/test.md",
        "del-sha",
      );
    });

    it("emits memory:deleted event", async () => {
      const listing: GitHubContent[] = [
        { name: "test.md", path: "memories/patterns/test.md", sha: "del-sha", type: "file" },
      ];
      const fileContent: GitHubContent = {
        name: "test.md", path: "memories/patterns/test.md", sha: "del-sha", type: "file",
        content: encodeContent(formatMemoryFile("Test", "body", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")),
        encoding: "base64",
      };
      (github.getContents as ReturnType<typeof vi.fn>).mockImplementation(
        async (_o: string, _r: string, p: string) => {
          if (p === "memories/patterns") return listing;
          if (p === "memories/patterns/test.md") return fileContent;
          return null;
        },
      );

      const spy = vi.fn();
      manager.on("memory:deleted", spy);
      await manager.deleteMemory("memories/patterns/test.md");
      expect(spy).toHaveBeenCalledWith({ id: "memories/patterns/test.md" });
    });
  });

  // ── Session Context ────────────────────────────────────────────────

  describe("buildSessionContext", () => {
    it("returns null when disabled", async () => {
      manager.updateConfig({ enabled: false });
      const ctx = await manager.buildSessionContext();
      expect(ctx).toBeNull();
    });

    it("returns null when no memories exist", async () => {
      (github.getContents as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const ctx = await manager.buildSessionContext();
      expect(ctx).toBeNull();
    });

    it("builds markdown with categorised memories", async () => {
      const listing: GitHubContent[] = [
        { name: "esm.md", path: "memories/conventions/esm.md", sha: "s1", type: "file" },
      ];
      const fileContent: GitHubContent = {
        name: "esm.md", path: "memories/conventions/esm.md", sha: "s1", type: "file",
        content: encodeContent(formatMemoryFile("ESM", "Use .js extensions", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")),
        encoding: "base64",
      };
      (github.getContents as ReturnType<typeof vi.fn>).mockImplementation(
        async (_o: string, _r: string, p: string) => {
          if (p === "memories/conventions") return listing;
          if (p === "memories/conventions/esm.md") return fileContent;
          return null;
        },
      );

      const ctx = await manager.buildSessionContext();
      expect(ctx).toContain("# Agent Memory");
      expect(ctx).toContain("## Conventions");
      expect(ctx).toContain("### ESM");
      expect(ctx).toContain("Use .js extensions");
    });
  });
});

// ── createGitHubApiClient ──────────────────────────────────────────────

describe("createGitHubApiClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(status: number, body: unknown, ok = status >= 200 && status < 300): void {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok,
      status,
      json: vi.fn().mockResolvedValue(body),
      text: vi.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body)),
    }) as unknown as typeof fetch;
  }

  it("getAuthenticatedUser returns login", async () => {
    mockFetch(200, { login: "octocat" });
    const client = createGitHubApiClient("test-token");
    const user = await client.getAuthenticatedUser();
    expect(user.login).toBe("octocat");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-token" }) }),
    );
  });

  it("getAuthenticatedUser throws on non-ok response", async () => {
    mockFetch(401, "Unauthorized", false);
    const client = createGitHubApiClient("bad-token");
    await expect(client.getAuthenticatedUser()).rejects.toThrow("401");
  });

  it("getRepo returns repo info", async () => {
    mockFetch(200, { full_name: "owner/repo" });
    const client = createGitHubApiClient("tok");
    const repo = await client.getRepo("owner", "repo");
    expect(repo?.full_name).toBe("owner/repo");
  });

  it("getRepo returns null for 404", async () => {
    mockFetch(404, null, false);
    const client = createGitHubApiClient("tok");
    const repo = await client.getRepo("owner", "missing");
    expect(repo).toBeNull();
  });

  it("getRepo throws on server error", async () => {
    mockFetch(500, "Server Error", false);
    const client = createGitHubApiClient("tok");
    await expect(client.getRepo("owner", "repo")).rejects.toThrow("500");
  });

  it("createRepo sends POST with correct body", async () => {
    mockFetch(201, { full_name: "user/new-repo" });
    const client = createGitHubApiClient("tok");
    const repo = await client.createRepo("new-repo", true, "My desc");
    expect(repo.full_name).toBe("user/new-repo");
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.name).toBe("new-repo");
    expect(body.private).toBe(true);
    expect(body.description).toBe("My desc");
  });

  it("createRepo throws on failure with response text", async () => {
    mockFetch(422, "Validation Failed", false);
    const client = createGitHubApiClient("tok");
    await expect(client.createRepo("bad", true, "")).rejects.toThrow("Validation Failed");
  });

  it("getContents returns content", async () => {
    mockFetch(200, { name: "file.md", path: "memories/file.md", sha: "abc", type: "file" });
    const client = createGitHubApiClient("tok");
    const content = await client.getContents("owner", "repo", "memories/file.md");
    expect(content).toEqual(expect.objectContaining({ name: "file.md" }));
  });

  it("getContents returns null for 404", async () => {
    mockFetch(404, null, false);
    const client = createGitHubApiClient("tok");
    const content = await client.getContents("owner", "repo", "missing");
    expect(content).toBeNull();
  });

  it("getContents throws on server error", async () => {
    mockFetch(503, "Unavailable", false);
    const client = createGitHubApiClient("tok");
    await expect(client.getContents("owner", "repo", "path")).rejects.toThrow("503");
  });

  it("createOrUpdateFile sends PUT with base64 content", async () => {
    mockFetch(200, { content: { sha: "newsha" } });
    const client = createGitHubApiClient("tok");
    const result = await client.createOrUpdateFile("owner", "repo", "path.md", "commit msg", "file content");
    expect(result.content.sha).toBe("newsha");
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.message).toBe("commit msg");
    expect(Buffer.from(body.content, "base64").toString("utf-8")).toBe("file content");
  });

  it("createOrUpdateFile includes sha when updating", async () => {
    mockFetch(200, { content: { sha: "updated" } });
    const client = createGitHubApiClient("tok");
    await client.createOrUpdateFile("owner", "repo", "path.md", "update", "content", "oldsha");
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.sha).toBe("oldsha");
  });

  it("createOrUpdateFile throws on failure", async () => {
    mockFetch(409, "Conflict", false);
    const client = createGitHubApiClient("tok");
    await expect(client.createOrUpdateFile("o", "r", "p", "m", "c")).rejects.toThrow("Conflict");
  });

  it("deleteFile sends DELETE with sha", async () => {
    mockFetch(200, {});
    const client = createGitHubApiClient("tok");
    await client.deleteFile("owner", "repo", "path.md", "delete msg", "sha123");
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].method).toBe("DELETE");
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.sha).toBe("sha123");
  });

  it("deleteFile throws on failure", async () => {
    mockFetch(422, "Unprocessable", false);
    const client = createGitHubApiClient("tok");
    await expect(client.deleteFile("o", "r", "p", "m", "s")).rejects.toThrow("Unprocessable");
  });
});
