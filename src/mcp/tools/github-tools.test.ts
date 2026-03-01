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

  // ── Direct API (token-based, no sidecar) ──────────────────

  describe("Direct API calls (token, no sidecar)", () => {
    it("github-get-me calls /user via token", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ login: "octocat", id: 1 })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-get-me")!;
      const result = await tool.handler({});

      expect(result.isError).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/user");
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer ghp_test123");
    });

    it("github-list-issues calls correct endpoint with query params", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify([{ number: 1, title: "Bug" }])),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-list-issues")!;
      await tool.handler({ owner: "octocat", repo: "hello", state: "open", labels: "bug", perPage: 10 });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/repos/octocat/hello/issues");
      expect(url).toContain("state=open");
      expect(url).toContain("labels=bug");
      expect(url).toContain("per_page=10");
    });

    it("github-create-issue sends POST with body", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ number: 42 })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-create-issue")!;
      await tool.handler({
        owner: "octocat",
        repo: "hello",
        title: "New Bug",
        body: "Description",
        labels: ["bug"],
        assignees: ["user1"],
      });

      expect(mockFetch.mock.calls[0][1].method).toBe("POST");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.title).toBe("New Bug");
      expect(body.labels).toEqual(["bug"]);
    });

    it("github-get-issue maps issueNumber to issue_number", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ number: 5, title: "Issue 5" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-get-issue")!;
      await tool.handler({ owner: "octocat", repo: "hello", issueNumber: 5 });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/repos/octocat/hello/issues/5");
    });

    it("github-update-issue sends PATCH with optional fields", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ number: 5 })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-update-issue")!;
      await tool.handler({
        owner: "octocat",
        repo: "hello",
        issueNumber: 5,
        title: "Updated Title",
        state: "closed",
      });

      expect(mockFetch.mock.calls[0][1].method).toBe("PATCH");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.title).toBe("Updated Title");
      expect(body.state).toBe("closed");
    });

    it("github-add-issue-comment sends POST with body", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ id: 999 })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-add-issue-comment")!;
      await tool.handler({ owner: "octocat", repo: "hello", issueNumber: 5, body: "LGTM" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/repos/octocat/hello/issues/5/comments");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.body).toBe("LGTM");
    });

    it("github-list-commits calls correct endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify([{ sha: "abc123" }])),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-list-commits")!;
      await tool.handler({ owner: "octocat", repo: "hello", sha: "main", perPage: 5 });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/repos/octocat/hello/commits");
      expect(url).toContain("sha=main");
    });

    it("github-get-commit calls correct endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ sha: "abc123" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-get-commit")!;
      await tool.handler({ owner: "octocat", repo: "hello", ref: "abc123" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/repos/octocat/hello/commits/abc123");
    });

    it("github-list-branches calls correct endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify([{ name: "main" }])),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-list-branches")!;
      await tool.handler({ owner: "octocat", repo: "hello" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/repos/octocat/hello/branches");
    });

    it("github-create-branch sends POST to git/refs", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ ref: "refs/heads/new-branch" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-create-branch")!;
      await tool.handler({ owner: "octocat", repo: "hello", branch: "new-branch", from: "abc123" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/repos/octocat/hello/git/refs");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.ref).toBe("refs/heads/new-branch");
      expect(body.sha).toBe("abc123");
    });

    it("github-list-prs calls correct endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify([{ number: 1 }])),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-list-prs")!;
      await tool.handler({ owner: "octocat", repo: "hello", state: "open" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/repos/octocat/hello/pulls");
      expect(url).toContain("state=open");
    });

    it("github-get-pr calls correct endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ number: 42, title: "Fix" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-get-pr")!;
      await tool.handler({ owner: "octocat", repo: "hello", pullNumber: 42 });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/repos/octocat/hello/pulls/42");
    });

    it("github-merge-pr sends PUT with merge method", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ merged: true })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-merge-pr")!;
      await tool.handler({
        owner: "octocat",
        repo: "hello",
        pullNumber: 42,
        mergeMethod: "squash",
        commitTitle: "Squash merge",
      });

      expect(mockFetch.mock.calls[0][1].method).toBe("PUT");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.merge_method).toBe("squash");
      expect(body.commit_title).toBe("Squash merge");
    });

    it("github-create-or-update-file base64 encodes content", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ content: { path: "test.md" } })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-create-or-update-file")!;
      await tool.handler({
        owner: "octocat",
        repo: "hello",
        path: "test.md",
        content: "Hello World",
        message: "Add test.md",
        branch: "main",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.content).toBe(Buffer.from("Hello World").toString("base64"));
    });

    it("github-delete-file sends DELETE with sha", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ commit: { sha: "abc" } })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-delete-file")!;
      await tool.handler({
        owner: "octocat",
        repo: "hello",
        path: "old.md",
        message: "Remove old.md",
        sha: "abc123",
      });

      expect(mockFetch.mock.calls[0][1].method).toBe("DELETE");
    });

    it("github-fork-repo sends POST", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ full_name: "user/repo" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-fork-repo")!;
      await tool.handler({ owner: "octocat", repo: "hello", organization: "myorg" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.organization).toBe("myorg");
    });

    it("github-fork-repo without organization sends no body", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ full_name: "user/repo" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-fork-repo")!;
      await tool.handler({ owner: "octocat", repo: "hello" });

      // Body should be undefined (no organization)
      const fetchOpts = mockFetch.mock.calls[0][1];
      // The body function returns undefined when no organization
      expect(fetchOpts.body).toBeUndefined();
    });

    it("github-create-repo sends POST to /user/repos", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ full_name: "user/new-repo" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-create-repo")!;
      await tool.handler({ name: "new-repo", description: "Test", private: true, autoInit: true });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/user/repos");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.name).toBe("new-repo");
      expect(body.private).toBe(true);
      expect(body.auto_init).toBe(true);
    });

    it("github-list-releases calls correct endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify([{ tag_name: "v1.0.0" }])),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-list-releases")!;
      await tool.handler({ owner: "octocat", repo: "hello" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/repos/octocat/hello/releases");
    });

    it("github-get-latest-release calls correct endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ tag_name: "v2.0.0" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-get-latest-release")!;
      await tool.handler({ owner: "octocat", repo: "hello" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/repos/octocat/hello/releases/latest");
    });

    it("github-get-release-by-tag calls correct endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ tag_name: "v1.5.0" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-get-release-by-tag")!;
      await tool.handler({ owner: "octocat", repo: "hello", tag: "v1.5.0" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/repos/octocat/hello/releases/tags/v1.5.0");
    });

    it("github-search-issues appends is:issue to query", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ items: [] })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-search-issues")!;
      await tool.handler({ query: "bug repo:octocat/hello" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("is%3Aissue");
    });

    it("github-search-prs appends is:pr to query", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ items: [] })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-search-prs")!;
      await tool.handler({ query: "fix repo:octocat/hello" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("is%3Apr");
    });

    it("github-update-pr sends PATCH", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ number: 42 })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-update-pr")!;
      await tool.handler({
        owner: "octocat",
        repo: "hello",
        pullNumber: 42,
        title: "Updated PR",
        state: "closed",
      });

      expect(mockFetch.mock.calls[0][1].method).toBe("PATCH");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.title).toBe("Updated PR");
      expect(body.state).toBe("closed");
    });

    it("github-update-pr-branch sends PUT", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ message: "Updating" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-update-pr-branch")!;
      await tool.handler({
        owner: "octocat",
        repo: "hello",
        pullNumber: 42,
        expectedHeadSha: "abc123",
      });

      expect(mockFetch.mock.calls[0][1].method).toBe("PUT");
    });

    it("github-list-tags calls correct endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify([{ name: "v1.0.0" }])),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-list-tags")!;
      await tool.handler({ owner: "octocat", repo: "hello" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/repos/octocat/hello/tags");
    });

    it("github-get-repo-tree calls correct endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ tree: [] })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-get-repo-tree")!;
      await tool.handler({ owner: "octocat", repo: "hello", recursive: true });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/repos/octocat/hello/git/trees/HEAD");
      expect(url).toContain("recursive=1");
    });

    it("github-list-labels calls correct endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify([{ name: "bug" }])),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-list-labels")!;
      await tool.handler({ owner: "octocat", repo: "hello" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/repos/octocat/hello/labels");
    });

    it("github-get-label encodes label name in URL", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ name: "help wanted" })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-get-label")!;
      await tool.handler({ owner: "octocat", repo: "hello", name: "help wanted" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("help%20wanted");
    });

    it("github-search-repos calls correct endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ items: [] })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-search-repos")!;
      await tool.handler({ query: "machine learning stars:>1000" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/search/repositories");
    });

    it("github-search-users calls correct endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ items: [] })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-search-users")!;
      await tool.handler({ query: "octocat" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/search/users");
    });

    it("github-search-code builds query with owner and repo", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ items: [] })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-search-code")!;
      await tool.handler({ query: "handleClick", owner: "octocat", repo: "hello", perPage: 5 });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("repo%3Aoctocat%2Fhello");
    });

    it("github-search-code builds query with owner only", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ items: [] })),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-search-code")!;
      await tool.handler({ query: "handleClick", owner: "octocat" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("org%3Aoctocat");
    });
  });

  // ── Error handling ────────────────────────────────────────

  describe("Error handling", () => {
    it("returns error when no token and no sidecar", async () => {
      const tools = createGitHubTools({});
      const tool = tools.find((t) => t.name === "github-get-me")!;
      const result = await tool.handler({});

      expect(result.isError).toBe(true);
      expect(result.text).toContain("GitHub not configured");
    });

    it("returns error on API HTTP error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('{"message":"Not Found"}'),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-get-file")!;
      const result = await tool.handler({ owner: "octocat", repo: "hello", path: "missing.txt" });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("GitHub API error (404)");
    });

    it("returns error on network failure", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("DNS resolution failed"));
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-get-me")!;
      const result = await tool.handler({});

      expect(result.isError).toBe(true);
      expect(result.text).toContain("GitHub API request failed");
    });

    it("returns non-JSON text response as-is", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve("plain text response that is not json"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-get-me")!;
      const result = await tool.handler({});

      expect(result.text).toBe("plain text response that is not json");
    });
  });

  // ── Sidecar fallback behavior ─────────────────────────────

  describe("Sidecar fallback", () => {
    it("falls back to direct API when sidecar returns non-ok", async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        callCount++;
        if (callCount === 1) {
          // Sidecar call - non-ok
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve("sidecar error"),
          });
        }
        // Direct API call
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ login: "octocat" })),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ sidecarUrl: "http://localhost:5304", token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-get-me")!;
      const result = await tool.handler({});

      expect(result.isError).toBeUndefined();
      expect(callCount).toBe(2);
    });

    it("falls back to direct API when sidecar is unreachable", async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        callCount++;
        if (callCount === 1) {
          // Sidecar unreachable
          return Promise.reject(new Error("ECONNREFUSED"));
        }
        // Direct API call
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ login: "octocat" })),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ sidecarUrl: "http://localhost:5304", token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-get-me")!;
      const result = await tool.handler({});

      expect(result.isError).toBeUndefined();
      expect(callCount).toBe(2);
    });

    it("returns error when sidecar fails and no token", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ sidecarUrl: "http://localhost:5304" });
      const tool = tools.find((t) => t.name === "github-get-me")!;
      const result = await tool.handler({});

      expect(result.isError).toBe(true);
      expect(result.text).toContain("GitHub not configured");
    });
  });

  // ── Push files (Git Data API) ─────────────────────────────

  describe("github-push-files", () => {
    it("pushes files via multi-step Git Data API", async () => {
      const callLog: string[] = [];
      const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        callLog.push(`${opts?.method ?? "GET"} ${url}`);

        if (url.includes("/git/ref/heads/")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ object: { sha: "base-sha" } }),
          });
        }
        if (url.includes("/git/commits/base-sha")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ tree: { sha: "tree-sha" } }),
          });
        }
        if (url.includes("/git/blobs")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ sha: "blob-sha" }),
          });
        }
        if (url.includes("/git/trees")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ sha: "new-tree-sha" }),
          });
        }
        if (url.includes("/git/commits") && opts?.method === "POST") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ sha: "new-commit-sha" }),
          });
        }
        if (url.includes("/git/refs/heads/") && opts?.method === "PATCH") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ref: "refs/heads/main" }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-push-files")!;
      const result = await tool.handler({
        owner: "octocat",
        repo: "hello",
        branch: "main",
        message: "Add files",
        files: [
          { path: "file1.txt", content: "Hello" },
          { path: "file2.txt", content: "World" },
        ],
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.text);
      expect(parsed.sha).toBe("new-commit-sha");
      expect(parsed.files).toBe(2);
    });

    it("returns error when ref fetch fails", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        text: () => Promise.resolve("Branch not found"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-push-files")!;
      const result = await tool.handler({
        owner: "octocat",
        repo: "hello",
        branch: "nonexistent",
        message: "Add files",
        files: [{ path: "f.txt", content: "x" }],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("Failed to get ref");
    });

    it("returns error on network failure during push", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network down"));
      vi.stubGlobal("fetch", mockFetch);

      const tools = createGitHubTools({ token: "ghp_test123" });
      const tool = tools.find((t) => t.name === "github-push-files")!;
      const result = await tool.handler({
        owner: "octocat",
        repo: "hello",
        branch: "main",
        message: "Add files",
        files: [{ path: "f.txt", content: "x" }],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("Push files failed");
    });
  });

  // ── Tool source property ──────────────────────────────────

  describe("Tool metadata", () => {
    it("all tools have source set to github", () => {
      const tools = createGitHubTools({ token: "ghp_test123" });
      for (const tool of tools) {
        expect(tool.source).toBe("github");
      }
    });

    it("all tools have zodSchema defined", () => {
      const tools = createGitHubTools({ token: "ghp_test123" });
      for (const tool of tools) {
        expect(tool.zodSchema).toBeDefined();
      }
    });

    it("all tools have inputSchema defined", () => {
      const tools = createGitHubTools({ token: "ghp_test123" });
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    });
  });
});
