import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { postActionRegistry } from "./post-action-registry.js";
import { registerBuiltinPostActions, executePostAction } from "./post-actions.js";

// We need to test the internal parseFindings indirectly via executeCreateGitHubIssues,
// but since parseFindings is private we'll test through the registered handler.

describe("registerBuiltinPostActions", () => {
  beforeEach(() => {
    // Clear the registry before each test
    postActionRegistry.clear();
  });

  it("registers create-github-issues and send-webhook", () => {
    registerBuiltinPostActions();
    expect(postActionRegistry.has("create-github-issues")).toBe(true);
    expect(postActionRegistry.has("send-webhook")).toBe(true);
  });

  it("is idempotent — calling twice does not throw", () => {
    registerBuiltinPostActions();
    registerBuiltinPostActions();
    expect(postActionRegistry.has("create-github-issues")).toBe(true);
  });
});

describe("executePostAction", () => {
  beforeEach(() => {
    postActionRegistry.clear();
    registerBuiltinPostActions();
  });

  it("delegates to postActionRegistry.execute", async () => {
    const spy = vi.spyOn(postActionRegistry, "execute").mockResolvedValue("result");
    const action = { type: "send-webhook", config: { url: "https://example.com/hook" } };
    const result = await executePostAction(action as never, "stage output");
    expect(spy).toHaveBeenCalledWith(action, "stage output");
    expect(result).toBe("result");
    spy.mockRestore();
  });
});

describe("create-github-issues handler", () => {
  let originalFetch: typeof global.fetch;
  let originalEnv: string | undefined;

  beforeEach(() => {
    postActionRegistry.clear();
    registerBuiltinPostActions();
    originalFetch = global.fetch;
    originalEnv = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.GITHUB_PERSONAL_ACCESS_TOKEN = originalEnv;
    } else {
      delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    }
  });

  it("returns error when GITHUB_PERSONAL_ACCESS_TOKEN is not set", async () => {
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    const def = postActionRegistry.get("create-github-issues");
    const result = await def!.handler("some output", { owner: "org", repo: "myrepo" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
    expect(parsed.issuesCreated).toBe(0);
  });

  it("returns no findings when stage has no matching format", async () => {
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_test123";
    const def = postActionRegistry.get("create-github-issues");
    const result = await def!.handler("no reviews here", { owner: "org", repo: "myrepo" });
    const parsed = JSON.parse(result);
    expect(parsed.issuesAttempted).toBe(0);
    expect(parsed.issuesCreated).toBe(0);
    expect(parsed.note).toContain("No findings");
  });

  it("parses findings and creates issues", async () => {
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_test123";

    const stageOutput = `
1. **[High]** File: src/main.ts Line: 42
   Description: SQL injection vulnerability in user input handler
   Recommendation: Use parameterized queries instead

2. **[Medium]** File: src/auth.ts Line: 10
   Description: Weak password hashing
   Recommendation: Use bcrypt or argon2
    `;

    // Mock fetch for search (returns 0 dupes) and create (returns issue)
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ total_count: 0 }) }) // search
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ number: 1, html_url: "https://github.com/org/repo/issues/1", title: "Test" }) }) // create
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ total_count: 0 }) }) // search
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ number: 2, html_url: "https://github.com/org/repo/issues/2", title: "Test 2" }) }); // create
    global.fetch = mockFetch;

    const def = postActionRegistry.get("create-github-issues");
    const result = await def!.handler(stageOutput, { owner: "org", repo: "myrepo" });
    const parsed = JSON.parse(result);
    expect(parsed.issuesCreated).toBe(2);
    expect(parsed.createdIssues).toHaveLength(2);
  });

  it("skips duplicate issues", async () => {
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_test123";

    const stageOutput = `
1. **[High]** File: src/main.ts Line: 42
   Description: SQL injection vulnerability
   Recommendation: Use parameterized queries
    `;

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ total_count: 1 }) }); // search returns dupe
    global.fetch = mockFetch;

    const def = postActionRegistry.get("create-github-issues");
    const result = await def!.handler(stageOutput, { owner: "org", repo: "myrepo" });
    const parsed = JSON.parse(result);
    expect(parsed.issuesCreated).toBe(0);
  });

  it("filters by minSeverity", async () => {
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_test123";

    const stageOutput = `
1. **[Low]** File: src/main.ts
   Description: Consider renaming this variable
   Recommendation: Use a more descriptive name

2. **[Critical]** File: src/auth.ts Line: 5
   Description: Hardcoded credentials
   Recommendation: Use environment variables
    `;

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ total_count: 0 }) }) // search
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ number: 1, html_url: "https://github.com/org/repo/issues/1", title: "Test" }) }); // create
    global.fetch = mockFetch;

    const def = postActionRegistry.get("create-github-issues");
    const result = await def!.handler(stageOutput, { owner: "org", repo: "myrepo", minSeverity: "high" });
    const parsed = JSON.parse(result);
    // Only the critical finding should be above "high" severity
    expect(parsed.issuesCreated).toBe(1);
  });
});

describe("send-webhook handler", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    postActionRegistry.clear();
    registerBuiltinPostActions();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns error when url is missing", async () => {
    const def = postActionRegistry.get("send-webhook");
    const result = await def!.handler("output", {});
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("URL");
  });

  it("sends webhook with stage output included", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 });
    global.fetch = mockFetch;

    const def = postActionRegistry.get("send-webhook");
    const result = await def!.handler("my stage output", { url: "https://example.com/hook" });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe(200);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.stageOutput).toBe("my stage output");
    expect(callBody.event).toBe("pipeline_stage_completed");
  });

  it("caps stage output at 10KB", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 });
    global.fetch = mockFetch;

    const longOutput = "x".repeat(20_000);
    const def = postActionRegistry.get("send-webhook");
    await def!.handler(longOutput, { url: "https://example.com/hook" });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.stageOutput.length).toBe(10_000);
  });

  it("excludes output when includeOutput is false", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 });
    global.fetch = mockFetch;

    const def = postActionRegistry.get("send-webhook");
    await def!.handler("output", { url: "https://example.com/hook", includeOutput: false });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.stageOutput).toBeUndefined();
  });

  it("handles fetch error gracefully", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("Network error"));
    global.fetch = mockFetch;

    const def = postActionRegistry.get("send-webhook");
    const result = await def!.handler("output", { url: "https://example.com/hook" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Network error");
  });

  it("includes response body on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });
    global.fetch = mockFetch;

    const def = postActionRegistry.get("send-webhook");
    const result = await def!.handler("output", { url: "https://example.com/hook" });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe(500);
    expect(parsed.body).toBe("Internal Server Error");
  });

  it("uses custom method and headers", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 });
    global.fetch = mockFetch;

    const def = postActionRegistry.get("send-webhook");
    await def!.handler("output", {
      url: "https://example.com/hook",
      method: "PUT",
      headers: { "X-Custom": "test" },
    });

    expect(mockFetch.mock.calls[0][1].method).toBe("PUT");
    expect(mockFetch.mock.calls[0][1].headers["X-Custom"]).toBe("test");
  });

  // ── SSRF protection tests (Issue #467) ────────────────────

  it("blocks SSRF: localhost URL", async () => {
    const def = postActionRegistry.get("send-webhook");
    const result = await def!.handler("output", { url: "http://localhost:3000/admin" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("SSRF");
  });

  it("blocks SSRF: AWS metadata endpoint", async () => {
    const def = postActionRegistry.get("send-webhook");
    const result = await def!.handler("output", { url: "http://169.254.169.254/latest/meta-data/" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("SSRF");
  });

  it("blocks SSRF: private 10.x.x.x range", async () => {
    const def = postActionRegistry.get("send-webhook");
    const result = await def!.handler("output", { url: "http://10.0.0.1/internal" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("SSRF");
  });

  it("blocks SSRF: private 192.168.x.x range", async () => {
    const def = postActionRegistry.get("send-webhook");
    const result = await def!.handler("output", { url: "http://192.168.1.1/" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("SSRF");
  });

  it("blocks SSRF: non-HTTP protocol", async () => {
    const def = postActionRegistry.get("send-webhook");
    const result = await def!.handler("output", { url: "file:///etc/passwd" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("SSRF");
  });

  it("allows valid public webhook URL through SSRF check", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 });
    global.fetch = mockFetch;

    const def = postActionRegistry.get("send-webhook");
    const result = await def!.handler("output", { url: "https://hooks.slack.com/services/xxx" });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
