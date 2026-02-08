import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGitHubTools } from "./github-tools.js";

describe("GitHub Tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should create five tools", () => {
    const tools = createGitHubTools({ sidecarUrl: "http://localhost:5304" });
    expect(tools).toHaveLength(5);

    const names = tools.map((t) => t.name);
    expect(names).toContain("github-get-file");
    expect(names).toContain("github-search-code");
    expect(names).toContain("github-list-issues");
    expect(names).toContain("github-create-issue");
    expect(names).toContain("github-create-pr");
  });

  it("should assign correct risk levels", () => {
    const tools = createGitHubTools({ sidecarUrl: "http://localhost:5304" });
    const riskMap = Object.fromEntries(tools.map((t) => [t.name, t.riskLevel]));

    expect(riskMap["github-get-file"]).toBe("low");
    expect(riskMap["github-search-code"]).toBe("low");
    expect(riskMap["github-list-issues"]).toBe("low");
    expect(riskMap["github-create-issue"]).toBe("medium");
    expect(riskMap["github-create-pr"]).toBe("high");
  });

  it("should categorize all tools as developer", () => {
    const tools = createGitHubTools({ sidecarUrl: "http://localhost:5304" });
    for (const tool of tools) {
      expect(tool.category).toBe("developer");
    }
  });

  it("github-get-file should proxy to sidecar", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: { content: "# README\nHello", encoding: "utf-8" },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tools = createGitHubTools({ sidecarUrl: "http://localhost:5304" });
    const getFileTool = tools.find((t) => t.name === "github-get-file")!;
    const result = await getFileTool.handler({
      owner: "octocat",
      repo: "hello-world",
      path: "README.md",
    });

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe("github_get_file");
    expect(body.params.owner).toBe("octocat");
    expect(body.params.repo).toBe("hello-world");
    expect(body.params.path).toBe("README.md");
  });

  it("github-create-pr should send full PR parameters", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: { number: 42, url: "https://github.com/octocat/hello-world/pull/42" },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tools = createGitHubTools({ sidecarUrl: "http://localhost:5304" });
    const createPrTool = tools.find((t) => t.name === "github-create-pr")!;
    const result = await createPrTool.handler({
      owner: "octocat",
      repo: "hello-world",
      title: "Fix typo",
      head: "fix-typo",
      base: "main",
      body: "Fixed a typo in README",
    });

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe("github_create_pr");
    expect(body.params.title).toBe("Fix typo");
    expect(body.params.head).toBe("fix-typo");
    expect(body.params.base).toBe("main");
  });

  it("github-search-code should support query parameter", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { items: [], total_count: 0 } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tools = createGitHubTools({ sidecarUrl: "http://localhost:5304" });
    const searchTool = tools.find((t) => t.name === "github-search-code")!;
    await searchTool.handler({ query: "function handleClick language:typescript" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe("github_search_code");
    expect(body.params.query).toBe("function handleClick language:typescript");
  });
});
