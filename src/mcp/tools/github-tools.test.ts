import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGitHubTools } from "./github-tools.js";

describe("GitHub Tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should create 34 tools", () => {
    const tools = createGitHubTools({ sidecarUrl: "http://localhost:5304" });
    expect(tools).toHaveLength(34);

    const names = tools.map((t) => t.name);
    expect(names).toContain("github-get-me");
    expect(names).toContain("github-get-file");
    expect(names).toContain("github-search-code");
    expect(names).toContain("github-search-repos");
    expect(names).toContain("github-search-users");
    expect(names).toContain("github-list-issues");
    expect(names).toContain("github-create-issue");
    expect(names).toContain("github-list-commits");
    expect(names).toContain("github-get-commit");
    expect(names).toContain("github-list-branches");
    expect(names).toContain("github-create-branch");
    expect(names).toContain("github-list-prs");
    expect(names).toContain("github-get-pr");
    expect(names).toContain("github-create-pr");
    expect(names).toContain("github-merge-pr");
    expect(names).toContain("github-create-or-update-file");
    expect(names).toContain("github-delete-file");
    expect(names).toContain("github-fork-repo");
    expect(names).toContain("github-create-repo");
    expect(names).toContain("github-list-releases");
    // New tools
    expect(names).toContain("github-get-latest-release");
    expect(names).toContain("github-get-release-by-tag");
    expect(names).toContain("github-get-issue");
    expect(names).toContain("github-update-issue");
    expect(names).toContain("github-add-issue-comment");
    expect(names).toContain("github-search-issues");
    expect(names).toContain("github-search-prs");
    expect(names).toContain("github-update-pr");
    expect(names).toContain("github-update-pr-branch");
    expect(names).toContain("github-push-files");
    expect(names).toContain("github-list-tags");
    expect(names).toContain("github-get-repo-tree");
    expect(names).toContain("github-list-labels");
    expect(names).toContain("github-get-label");
  });

  it("should assign correct risk levels", () => {
    const tools = createGitHubTools({ sidecarUrl: "http://localhost:5304" });
    const riskMap = Object.fromEntries(tools.map((t) => [t.name, t.riskLevel]));

    // Low risk (read-only)
    expect(riskMap["github-get-me"]).toBe("low");
    expect(riskMap["github-get-file"]).toBe("low");
    expect(riskMap["github-search-code"]).toBe("low");
    expect(riskMap["github-list-issues"]).toBe("low");
    expect(riskMap["github-list-commits"]).toBe("low");
    expect(riskMap["github-get-issue"]).toBe("low");
    expect(riskMap["github-search-issues"]).toBe("low");
    expect(riskMap["github-search-prs"]).toBe("low");
    expect(riskMap["github-get-latest-release"]).toBe("low");
    expect(riskMap["github-get-release-by-tag"]).toBe("low");
    expect(riskMap["github-list-tags"]).toBe("low");
    expect(riskMap["github-get-repo-tree"]).toBe("low");
    expect(riskMap["github-list-labels"]).toBe("low");
    expect(riskMap["github-get-label"]).toBe("low");

    // Medium risk (creates/modifies non-critical resources)
    expect(riskMap["github-create-issue"]).toBe("medium");
    expect(riskMap["github-create-branch"]).toBe("medium");
    expect(riskMap["github-update-issue"]).toBe("medium");
    expect(riskMap["github-add-issue-comment"]).toBe("medium");
    expect(riskMap["github-update-pr"]).toBe("medium");
    expect(riskMap["github-update-pr-branch"]).toBe("medium");

    // High risk (modifies code/repo directly)
    expect(riskMap["github-create-pr"]).toBe("high");
    expect(riskMap["github-merge-pr"]).toBe("high");
    expect(riskMap["github-create-repo"]).toBe("high");
    expect(riskMap["github-push-files"]).toBe("high");
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
    expect(body.method).toBe("get_file_contents");
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
    expect(body.method).toBe("create_pull_request");
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
    expect(body.method).toBe("search_code");
    expect(body.params.query).toBe("function handleClick language:typescript");
  });
});
