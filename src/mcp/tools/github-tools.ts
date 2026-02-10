import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";

/**
 * GitHub MCP tools for repository management, issues, PRs, and code search.
 *
 * Connectivity: Direct GitHub REST API calls using a Personal Access Token,
 * with an optional Docker sidecar fallback (github/github-mcp-server).
 */

type GitHubToolsOptions = {
  sidecarUrl?: string;
  /** GitHub Personal Access Token — enables direct REST API calls without a sidecar. */
  token?: string;
};

const githubGetFileSchema = z.object({
  owner: z.string().describe("Repository owner (user or organization)"),
  repo: z.string().describe("Repository name"),
  path: z.string().describe("File path within the repository"),
  ref: z.string().optional().describe("Git ref (branch, tag, or commit SHA)"),
});

const githubSearchCodeSchema = z.object({
  query: z.string().describe("Search query using GitHub code search syntax"),
  owner: z.string().optional().describe("Filter to a specific repository owner"),
  repo: z.string().optional().describe("Filter to a specific repository"),
  perPage: z.number().optional().describe("Results per page (max 100)"),
});

const githubListIssuesSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  state: z.enum(["open", "closed", "all"]).optional().describe("Issue state filter"),
  labels: z.string().optional().describe("Comma-separated list of label names"),
  perPage: z.number().optional().describe("Results per page (max 100)"),
});

const githubCreateIssueSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  title: z.string().describe("Issue title"),
  body: z.string().optional().describe("Issue description (Markdown)"),
  labels: z.array(z.string()).optional().describe("Labels to apply"),
  assignees: z.array(z.string()).optional().describe("Users to assign"),
});

const githubCreatePrSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  title: z.string().describe("Pull request title"),
  body: z.string().optional().describe("Pull request description (Markdown)"),
  head: z.string().describe("Branch containing changes"),
  base: z.string().describe("Branch to merge into"),
  draft: z.boolean().optional().describe("Create as a draft PR"),
});

const githubGetMeSchema = z.object({});

const githubListCommitsSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  sha: z.string().optional().describe("Branch name or commit SHA to list commits from"),
  perPage: z.number().optional().describe("Results per page (max 100)"),
});

const githubGetCommitSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  ref: z.string().describe("Commit SHA, branch name, or tag"),
});

const githubListBranchesSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  perPage: z.number().optional().describe("Results per page (max 100)"),
});

const githubCreateBranchSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  branch: z.string().describe("New branch name"),
  from: z.string().optional().describe("Source branch or commit SHA (defaults to default branch)"),
});

const githubListPullRequestsSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  state: z.enum(["open", "closed", "all"]).optional().describe("PR state filter"),
  head: z.string().optional().describe("Filter by head branch (user:branch)"),
  base: z.string().optional().describe("Filter by base branch"),
  perPage: z.number().optional().describe("Results per page (max 100)"),
});

const githubGetPullRequestSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  pullNumber: z.number().describe("Pull request number"),
});

const githubMergePrSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  pullNumber: z.number().describe("Pull request number"),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional().describe("Merge method"),
  commitTitle: z.string().optional().describe("Custom merge commit title"),
  commitMessage: z.string().optional().describe("Custom merge commit message"),
});

const githubCreateOrUpdateFileSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  path: z.string().describe("File path within the repository"),
  content: z.string().describe("File content (will be base64 encoded)"),
  message: z.string().describe("Commit message"),
  branch: z.string().optional().describe("Branch to commit to"),
  sha: z.string().optional().describe("SHA of the file being replaced (for updates)"),
});

const githubDeleteFileSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  path: z.string().describe("File path within the repository"),
  message: z.string().describe("Commit message"),
  branch: z.string().optional().describe("Branch to commit to"),
  sha: z.string().describe("SHA of the file being deleted"),
});

const githubForkRepoSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  organization: z.string().optional().describe("Organization to fork into"),
});

const githubCreateRepoSchema = z.object({
  name: z.string().describe("Repository name"),
  description: z.string().optional().describe("Repository description"),
  private: z.boolean().optional().describe("Whether the repo is private"),
  autoInit: z.boolean().optional().describe("Initialize with a README"),
});

const githubListReleasesSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  perPage: z.number().optional().describe("Results per page (max 100)"),
});

const githubSearchReposSchema = z.object({
  query: z.string().describe("Search query using GitHub search syntax"),
  perPage: z.number().optional().describe("Results per page (max 100)"),
});

const githubSearchUsersSchema = z.object({
  query: z.string().describe("Search query for users"),
  perPage: z.number().optional().describe("Results per page (max 100)"),
});

// ── Additional schemas ──

const githubGetIssueSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  issueNumber: z.number().describe("Issue number"),
});

const githubUpdateIssueSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  issueNumber: z.number().describe("Issue number"),
  title: z.string().optional().describe("New title"),
  body: z.string().optional().describe("New body (Markdown)"),
  state: z.enum(["open", "closed"]).optional().describe("Issue state"),
  labels: z.array(z.string()).optional().describe("Labels to set (replaces existing)"),
  assignees: z.array(z.string()).optional().describe("Assignees to set (replaces existing)"),
});

const githubAddIssueCommentSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  issueNumber: z.number().describe("Issue or pull request number"),
  body: z.string().describe("Comment body (Markdown)"),
});

const githubSearchIssuesSchema = z.object({
  query: z.string().describe("Search query using GitHub issues search syntax"),
  perPage: z.number().optional().describe("Results per page (max 100)"),
});

const githubSearchPullRequestsSchema = z.object({
  query: z.string().describe("Search query using GitHub PR search syntax"),
  perPage: z.number().optional().describe("Results per page (max 100)"),
});

const githubUpdatePrSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  pullNumber: z.number().describe("Pull request number"),
  title: z.string().optional().describe("New title"),
  body: z.string().optional().describe("New body (Markdown)"),
  state: z.enum(["open", "closed"]).optional().describe("PR state"),
  base: z.string().optional().describe("New base branch"),
});

const githubUpdatePrBranchSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  pullNumber: z.number().describe("Pull request number"),
  expectedHeadSha: z.string().optional().describe("Expected SHA of the head branch"),
});

const githubPushFilesSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  branch: z.string().describe("Branch to push to"),
  message: z.string().describe("Commit message"),
  files: z.array(z.object({
    path: z.string().describe("File path"),
    content: z.string().describe("File content"),
  })).describe("Array of files to push"),
});

const githubListTagsSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  perPage: z.number().optional().describe("Results per page (max 100)"),
});

const githubGetLatestReleaseSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
});

const githubGetReleaseByTagSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  tag: z.string().describe("Tag name"),
});

const githubGetRepoTreeSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  sha: z.string().optional().describe("Branch name, tag, or commit SHA (defaults to default branch)"),
  recursive: z.boolean().optional().describe("Whether to recursively list the tree"),
});

const githubListLabelsSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  perPage: z.number().optional().describe("Results per page (max 100)"),
});

const githubGetLabelSchema = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  name: z.string().describe("Label name"),
});

// ── GitHub REST API direct caller ──

const GITHUB_API = "https://api.github.com";

type ApiRoute = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: (p: Record<string, unknown>) => string;
  query?: (p: Record<string, unknown>) => Record<string, string>;
  body?: (p: Record<string, unknown>) => Record<string, unknown> | undefined;
};

/** Map sidecar method names → GitHub REST API routes. */
const API_ROUTES: Record<string, ApiRoute> = {
  get_me: {
    method: "GET",
    path: () => "/user",
  },
  get_file_contents: {
    method: "GET",
    path: (p) => `/repos/${p.owner}/${p.repo}/contents/${p.path}`,
    query: (p) => { const q: Record<string, string> = {}; if (p.ref) q.ref = String(p.ref); return q; },
  },
  search_code: {
    method: "GET",
    path: () => "/search/code",
    query: (p) => {
      let q = String(p.query);
      if (p.owner && p.repo) q += ` repo:${p.owner}/${p.repo}`;
      else if (p.owner) q += ` org:${p.owner}`;
      const params: Record<string, string> = { q };
      if (p.perPage) params.per_page = String(p.perPage);
      return params;
    },
  },
  search_repositories: {
    method: "GET",
    path: () => "/search/repositories",
    query: (p) => {
      const params: Record<string, string> = { q: String(p.query) };
      if (p.perPage) params.per_page = String(p.perPage);
      return params;
    },
  },
  search_users: {
    method: "GET",
    path: () => "/search/users",
    query: (p) => {
      const params: Record<string, string> = { q: String(p.query) };
      if (p.perPage) params.per_page = String(p.perPage);
      return params;
    },
  },
  list_issues: {
    method: "GET",
    path: (p) => `/repos/${p.owner}/${p.repo}/issues`,
    query: (p) => {
      const params: Record<string, string> = {};
      if (p.state) params.state = String(p.state);
      if (p.labels) params.labels = String(p.labels);
      if (p.perPage) params.per_page = String(p.perPage);
      return params;
    },
  },
  create_issue: {
    method: "POST",
    path: (p) => `/repos/${p.owner}/${p.repo}/issues`,
    body: (p) => ({ title: p.title, body: p.body, labels: p.labels, assignees: p.assignees }),
  },
  get_issue: {
    method: "GET",
    path: (p) => `/repos/${p.owner}/${p.repo}/issues/${p.issue_number}`,
  },
  update_issue: {
    method: "PATCH",
    path: (p) => `/repos/${p.owner}/${p.repo}/issues/${p.issue_number}`,
    body: (p) => {
      const b: Record<string, unknown> = {};
      if (p.title !== undefined) b.title = p.title;
      if (p.body !== undefined) b.body = p.body;
      if (p.state !== undefined) b.state = p.state;
      if (p.labels !== undefined) b.labels = p.labels;
      if (p.assignees !== undefined) b.assignees = p.assignees;
      return b;
    },
  },
  add_issue_comment: {
    method: "POST",
    path: (p) => `/repos/${p.owner}/${p.repo}/issues/${p.issue_number}/comments`,
    body: (p) => ({ body: p.body }),
  },
  search_issues: {
    method: "GET",
    path: () => "/search/issues",
    query: (p) => {
      const params: Record<string, string> = { q: `${p.query} is:issue` };
      if (p.perPage) params.per_page = String(p.perPage);
      return params;
    },
  },
  list_commits: {
    method: "GET",
    path: (p) => `/repos/${p.owner}/${p.repo}/commits`,
    query: (p) => {
      const params: Record<string, string> = {};
      if (p.sha) params.sha = String(p.sha);
      if (p.perPage) params.per_page = String(p.perPage);
      return params;
    },
  },
  get_commit: {
    method: "GET",
    path: (p) => `/repos/${p.owner}/${p.repo}/commits/${p.ref}`,
  },
  list_branches: {
    method: "GET",
    path: (p) => `/repos/${p.owner}/${p.repo}/branches`,
    query: (p) => { const q: Record<string, string> = {}; if (p.perPage) q.per_page = String(p.perPage); return q; },
  },
  create_branch: {
    method: "POST",
    path: (p) => `/repos/${p.owner}/${p.repo}/git/refs`,
    body: (p) => ({ ref: `refs/heads/${p.branch}`, sha: String(p.from ?? "") }),
  },
  list_pull_requests: {
    method: "GET",
    path: (p) => `/repos/${p.owner}/${p.repo}/pulls`,
    query: (p) => {
      const params: Record<string, string> = {};
      if (p.state) params.state = String(p.state);
      if (p.head) params.head = String(p.head);
      if (p.base) params.base = String(p.base);
      if (p.perPage) params.per_page = String(p.perPage);
      return params;
    },
  },
  get_pull_request: {
    method: "GET",
    path: (p) => `/repos/${p.owner}/${p.repo}/pulls/${p.pullNumber}`,
  },
  create_pull_request: {
    method: "POST",
    path: (p) => `/repos/${p.owner}/${p.repo}/pulls`,
    body: (p) => ({ title: p.title, body: p.body, head: p.head, base: p.base, draft: p.draft }),
  },
  merge_pull_request: {
    method: "PUT",
    path: (p) => `/repos/${p.owner}/${p.repo}/pulls/${p.pullNumber}/merge`,
    body: (p) => ({
      merge_method: p.mergeMethod,
      commit_title: p.commitTitle,
      commit_message: p.commitMessage,
    }),
  },
  create_or_update_file: {
    method: "PUT",
    path: (p) => `/repos/${p.owner}/${p.repo}/contents/${p.path}`,
    body: (p) => ({
      message: p.message,
      content: Buffer.from(String(p.content)).toString("base64"),
      branch: p.branch,
      sha: p.sha,
    }),
  },
  delete_file: {
    method: "DELETE",
    path: (p) => `/repos/${p.owner}/${p.repo}/contents/${p.path}`,
    body: (p) => ({ message: p.message, sha: p.sha, branch: p.branch }),
  },
  fork_repository: {
    method: "POST",
    path: (p) => `/repos/${p.owner}/${p.repo}/forks`,
    body: (p) => (p.organization ? { organization: p.organization } : undefined),
  },
  create_repository: {
    method: "POST",
    path: () => "/user/repos",
    body: (p) => ({ name: p.name, description: p.description, private: p.private, auto_init: p.autoInit }),
  },
  list_releases: {
    method: "GET",
    path: (p) => `/repos/${p.owner}/${p.repo}/releases`,
    query: (p) => { const q: Record<string, string> = {}; if (p.perPage) q.per_page = String(p.perPage); return q; },
  },
  get_latest_release: {
    method: "GET",
    path: (p) => `/repos/${p.owner}/${p.repo}/releases/latest`,
  },
  get_release_by_tag: {
    method: "GET",
    path: (p) => `/repos/${p.owner}/${p.repo}/releases/tags/${p.tag}`,
  },
  search_pull_requests: {
    method: "GET",
    path: () => "/search/issues",
    query: (p) => {
      const params: Record<string, string> = { q: `${p.query} is:pr` };
      if (p.perPage) params.per_page = String(p.perPage);
      return params;
    },
  },
  update_pull_request: {
    method: "PATCH",
    path: (p) => `/repos/${p.owner}/${p.repo}/pulls/${p.pull_number}`,
    body: (p) => {
      const b: Record<string, unknown> = {};
      if (p.title !== undefined) b.title = p.title;
      if (p.body !== undefined) b.body = p.body;
      if (p.state !== undefined) b.state = p.state;
      if (p.base !== undefined) b.base = p.base;
      return b;
    },
  },
  update_pull_request_branch: {
    method: "PUT",
    path: (p) => `/repos/${p.owner}/${p.repo}/pulls/${p.pull_number}/update-branch`,
    body: (p) => (p.expected_head_sha ? { expected_head_sha: p.expected_head_sha } : undefined),
  },
  push_files: {
    // push_files is complex (tree API) — handled specially
    method: "POST",
    path: () => "/special/push_files",
  },
  list_tags: {
    method: "GET",
    path: (p) => `/repos/${p.owner}/${p.repo}/tags`,
    query: (p) => { const q: Record<string, string> = {}; if (p.perPage) q.per_page = String(p.perPage); return q; },
  },
  get_repository_tree: {
    method: "GET",
    path: (p) => `/repos/${p.owner}/${p.repo}/git/trees/${p.sha ?? "HEAD"}`,
    query: (p) => { const q: Record<string, string> = {}; if (p.recursive) q.recursive = "1"; return q; },
  },
  list_labels: {
    method: "GET",
    path: (p) => `/repos/${p.owner}/${p.repo}/labels`,
    query: (p) => { const q: Record<string, string> = {}; if (p.perPage) q.per_page = String(p.perPage); return q; },
  },
  get_label: {
    method: "GET",
    path: (p) => `/repos/${p.owner}/${p.repo}/labels/${encodeURIComponent(String(p.name))}`,
  },
};

/** GitHub REST API call with token auth. */
const callGitHubApi = async (
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> => {
  // Special case: push_files requires the Git Data API (blobs → tree → commit → ref)
  if (method === "push_files") {
    return pushFilesViaApi(token, params);
  }

  const route = API_ROUTES[method];
  if (!route) {
    return { text: `Unknown GitHub API method: ${method}`, isError: true };
  }

  const urlPath = route.path(params);
  const queryParams = route.query?.(params) ?? {};
  const qs = new URLSearchParams(queryParams).toString();
  const fullUrl = `${GITHUB_API}${urlPath}${qs ? `?${qs}` : ""}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "OpenZigs/0.1",
  };

  const fetchOpts: RequestInit = { method: route.method, headers };

  if (route.body && (route.method === "POST" || route.method === "PUT" || route.method === "PATCH" || route.method === "DELETE")) {
    const bodyData = route.body(params);
    if (bodyData !== undefined) {
      headers["Content-Type"] = "application/json";
      fetchOpts.body = JSON.stringify(bodyData);
    }
  }

  try {
    const resp = await fetch(fullUrl, fetchOpts);
    const text = await resp.text();

    if (!resp.ok) {
      return { text: `GitHub API error (${resp.status}): ${text}`, isError: true };
    }

    // Return parsed JSON as formatted text for the LLM
    try {
      const json = JSON.parse(text);
      return { text: JSON.stringify(json, null, 2) };
    } catch {
      return { text };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { text: `GitHub API request failed: ${msg}`, isError: true };
  }
};

/** Push multiple files in a single commit via Git Data API. */
const pushFilesViaApi = async (
  token: string,
  params: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> => {
  const { owner, repo, branch, message, files } = params as {
    owner: string;
    repo: string;
    branch: string;
    message: string;
    files: Array<{ path: string; content: string }>;
  };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "OpenZigs/0.1",
  };

  try {
    // 1. Get the current ref
    const refResp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`, { headers });
    if (!refResp.ok) return { text: `Failed to get ref: ${await refResp.text()}`, isError: true };
    const refData = (await refResp.json()) as { object: { sha: string } };
    const baseSha = refData.object.sha;

    // 2. Get the base tree
    const commitResp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/commits/${baseSha}`, { headers });
    if (!commitResp.ok) return { text: `Failed to get commit: ${await commitResp.text()}`, isError: true };
    const commitData = (await commitResp.json()) as { tree: { sha: string } };
    const baseTreeSha = commitData.tree.sha;

    // 3. Create blobs for each file
    const tree: Array<{ path: string; mode: string; type: string; sha: string }> = [];
    for (const file of files) {
      const blobResp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content: file.content, encoding: "utf-8" }),
      });
      if (!blobResp.ok) return { text: `Failed to create blob: ${await blobResp.text()}`, isError: true };
      const blob = (await blobResp.json()) as { sha: string };
      tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    }

    // 4. Create new tree
    const treeResp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/trees`, {
      method: "POST",
      headers,
      body: JSON.stringify({ base_tree: baseTreeSha, tree }),
    });
    if (!treeResp.ok) return { text: `Failed to create tree: ${await treeResp.text()}`, isError: true };
    const newTree = (await treeResp.json()) as { sha: string };

    // 5. Create commit
    const newCommitResp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/commits`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message, tree: newTree.sha, parents: [baseSha] }),
    });
    if (!newCommitResp.ok) return { text: `Failed to create commit: ${await newCommitResp.text()}`, isError: true };
    const newCommit = (await newCommitResp.json()) as { sha: string; html_url?: string };

    // 6. Update ref
    const updateRefResp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ sha: newCommit.sha }),
    });
    if (!updateRefResp.ok) return { text: `Failed to update ref: ${await updateRefResp.text()}`, isError: true };

    return { text: JSON.stringify({ sha: newCommit.sha, files: files.length, branch }) };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { text: `Push files failed: ${msg}`, isError: true };
  }
};

/**
 * Call GitHub: tries Docker sidecar first, then falls back to direct REST API.
 */
const callGitHub = async (
  sidecarUrl: string | undefined,
  token: string | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> => {
  // Strategy 1: Docker sidecar (if configured and reachable)
  if (sidecarUrl) {
    try {
      const response = await fetch(`${sidecarUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, params }),
      });

      if (response.ok) {
        const result = (await response.json()) as { result?: string };
        return { text: result.result ?? JSON.stringify(result) };
      }
      // Non-ok response — fall through to direct API
    } catch {
      // Sidecar unreachable — fall through
    }
  }

  // Strategy 2: Direct GitHub REST API
  if (!token) {
    return {
      text: "GitHub not configured. Set GITHUB_PERSONAL_ACCESS_TOKEN in the Admin panel or .env file.",
      isError: true,
    };
  }

  return callGitHubApi(token, method, params);
};

export const createGitHubTools = (options: GitHubToolsOptions): ToolDefinition[] => {
  return [
    // ── Read / Query ──
    {
      name: "github-get-me",
      description: "Get the authenticated GitHub user's profile information.",
      inputSchema: { type: "object", properties: {} },
      zodSchema: githubGetMeSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async () => callGitHub(options.sidecarUrl, options.token, "get_me", {}),
    },
    {
      name: "github-get-file",
      description: "Get the contents of a file from a GitHub repository.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string" },
          ref: { type: "string" },
        },
        required: ["owner", "repo", "path"],
      },
      zodSchema: githubGetFileSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubGetFileSchema>;
        return callGitHub(options.sidecarUrl, options.token, "get_file_contents", input);
      },
    },
    {
      name: "github-search-code",
      description: "Search code across GitHub repositories using GitHub's code search syntax.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          owner: { type: "string" },
          repo: { type: "string" },
          perPage: { type: "number" },
        },
        required: ["query"],
      },
      zodSchema: githubSearchCodeSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubSearchCodeSchema>;
        return callGitHub(options.sidecarUrl, options.token, "search_code", input);
      },
    },
    {
      name: "github-search-repos",
      description: "Search GitHub repositories by keyword, language, topic, or other criteria.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          perPage: { type: "number" },
        },
        required: ["query"],
      },
      zodSchema: githubSearchReposSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubSearchReposSchema>;
        return callGitHub(options.sidecarUrl, options.token, "search_repositories", input);
      },
    },
    {
      name: "github-search-users",
      description: "Search GitHub users by username, name, or other criteria.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          perPage: { type: "number" },
        },
        required: ["query"],
      },
      zodSchema: githubSearchUsersSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubSearchUsersSchema>;
        return callGitHub(options.sidecarUrl, options.token, "search_users", input);
      },
    },

    // ── Issues ──
    {
      name: "github-list-issues",
      description: "List issues in a GitHub repository with optional state and label filters.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"] },
          labels: { type: "string" },
          perPage: { type: "number" },
        },
        required: ["owner", "repo"],
      },
      zodSchema: githubListIssuesSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubListIssuesSchema>;
        return callGitHub(options.sidecarUrl, options.token, "list_issues", input);
      },
    },
    {
      name: "github-create-issue",
      description: "Create a new issue in a GitHub repository.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          labels: { type: "array", items: { type: "string" } },
          assignees: { type: "array", items: { type: "string" } },
        },
        required: ["owner", "repo", "title"],
      },
      zodSchema: githubCreateIssueSchema,
      category: "developer",
      riskLevel: "medium",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubCreateIssueSchema>;
        return callGitHub(options.sidecarUrl, options.token, "create_issue", input);
      },
    },

    // ── Commits & Branches ──
    {
      name: "github-list-commits",
      description: "List commits on a branch in a GitHub repository.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          sha: { type: "string" },
          perPage: { type: "number" },
        },
        required: ["owner", "repo"],
      },
      zodSchema: githubListCommitsSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubListCommitsSchema>;
        return callGitHub(options.sidecarUrl, options.token, "list_commits", input);
      },
    },
    {
      name: "github-get-commit",
      description: "Get details for a specific commit including diff stats.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          ref: { type: "string" },
        },
        required: ["owner", "repo", "ref"],
      },
      zodSchema: githubGetCommitSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubGetCommitSchema>;
        return callGitHub(options.sidecarUrl, options.token, "get_commit", input);
      },
    },
    {
      name: "github-list-branches",
      description: "List branches in a GitHub repository.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          perPage: { type: "number" },
        },
        required: ["owner", "repo"],
      },
      zodSchema: githubListBranchesSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubListBranchesSchema>;
        return callGitHub(options.sidecarUrl, options.token, "list_branches", input);
      },
    },
    {
      name: "github-create-branch",
      description: "Create a new branch in a GitHub repository.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          branch: { type: "string" },
          from: { type: "string" },
        },
        required: ["owner", "repo", "branch"],
      },
      zodSchema: githubCreateBranchSchema,
      category: "developer",
      riskLevel: "medium",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubCreateBranchSchema>;
        return callGitHub(options.sidecarUrl, options.token, "create_branch", input);
      },
    },

    // ── Pull Requests ──
    {
      name: "github-list-prs",
      description: "List pull requests in a GitHub repository.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"] },
          head: { type: "string" },
          base: { type: "string" },
          perPage: { type: "number" },
        },
        required: ["owner", "repo"],
      },
      zodSchema: githubListPullRequestsSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubListPullRequestsSchema>;
        return callGitHub(options.sidecarUrl, options.token, "list_pull_requests", input);
      },
    },
    {
      name: "github-get-pr",
      description: "Get details for a specific pull request.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          pullNumber: { type: "number" },
        },
        required: ["owner", "repo", "pullNumber"],
      },
      zodSchema: githubGetPullRequestSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubGetPullRequestSchema>;
        return callGitHub(options.sidecarUrl, options.token, "get_pull_request", input);
      },
    },
    {
      name: "github-create-pr",
      description:
        "Create a pull request in a GitHub repository. WARNING: This creates a public code change. Requires human approval.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          head: { type: "string" },
          base: { type: "string" },
          draft: { type: "boolean" },
        },
        required: ["owner", "repo", "title", "head", "base"],
      },
      zodSchema: githubCreatePrSchema,
      category: "developer",
      riskLevel: "high",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubCreatePrSchema>;
        return callGitHub(options.sidecarUrl, options.token, "create_pull_request", input);
      },
    },
    {
      name: "github-merge-pr",
      description: "Merge a pull request. WARNING: This modifies the repository's default branch.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          pullNumber: { type: "number" },
          mergeMethod: { type: "string", enum: ["merge", "squash", "rebase"] },
          commitTitle: { type: "string" },
          commitMessage: { type: "string" },
        },
        required: ["owner", "repo", "pullNumber"],
      },
      zodSchema: githubMergePrSchema,
      category: "developer",
      riskLevel: "high",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubMergePrSchema>;
        return callGitHub(options.sidecarUrl, options.token, "merge_pull_request", input);
      },
    },

    // ── File Operations ──
    {
      name: "github-create-or-update-file",
      description: "Create or update a single file in a GitHub repository via commit.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string" },
          content: { type: "string" },
          message: { type: "string" },
          branch: { type: "string" },
          sha: { type: "string" },
        },
        required: ["owner", "repo", "path", "content", "message"],
      },
      zodSchema: githubCreateOrUpdateFileSchema,
      category: "developer",
      riskLevel: "high",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubCreateOrUpdateFileSchema>;
        return callGitHub(options.sidecarUrl, options.token, "create_or_update_file", input);
      },
    },
    {
      name: "github-delete-file",
      description: "Delete a file from a GitHub repository via commit.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string" },
          message: { type: "string" },
          branch: { type: "string" },
          sha: { type: "string" },
        },
        required: ["owner", "repo", "path", "message", "sha"],
      },
      zodSchema: githubDeleteFileSchema,
      category: "developer",
      riskLevel: "high",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubDeleteFileSchema>;
        return callGitHub(options.sidecarUrl, options.token, "delete_file", input);
      },
    },

    // ── Repository Management ──
    {
      name: "github-fork-repo",
      description: "Fork a GitHub repository to your account or a specified organization.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          organization: { type: "string" },
        },
        required: ["owner", "repo"],
      },
      zodSchema: githubForkRepoSchema,
      category: "developer",
      riskLevel: "medium",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubForkRepoSchema>;
        return callGitHub(options.sidecarUrl, options.token, "fork_repository", input);
      },
    },
    {
      name: "github-create-repo",
      description: "Create a new GitHub repository for the authenticated user.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          private: { type: "boolean" },
          autoInit: { type: "boolean" },
        },
        required: ["name"],
      },
      zodSchema: githubCreateRepoSchema,
      category: "developer",
      riskLevel: "high",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubCreateRepoSchema>;
        return callGitHub(options.sidecarUrl, options.token, "create_repository", input);
      },
    },

    // ── Releases ──
    {
      name: "github-list-releases",
      description: "List releases in a GitHub repository.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          perPage: { type: "number" },
        },
        required: ["owner", "repo"],
      },
      zodSchema: githubListReleasesSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubListReleasesSchema>;
        return callGitHub(options.sidecarUrl, options.token, "list_releases", input);
      },
    },
    {
      name: "github-get-latest-release",
      description: "Get the latest release for a GitHub repository.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
        },
        required: ["owner", "repo"],
      },
      zodSchema: githubGetLatestReleaseSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubGetLatestReleaseSchema>;
        return callGitHub(options.sidecarUrl, options.token, "get_latest_release", input);
      },
    },
    {
      name: "github-get-release-by-tag",
      description: "Get a specific release by its tag name.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          tag: { type: "string" },
        },
        required: ["owner", "repo", "tag"],
      },
      zodSchema: githubGetReleaseByTagSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubGetReleaseByTagSchema>;
        return callGitHub(options.sidecarUrl, options.token, "get_release_by_tag", input);
      },
    },

    // ── Additional Issue Tools ──
    {
      name: "github-get-issue",
      description: "Get details of a specific issue in a GitHub repository.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issueNumber: { type: "number" },
        },
        required: ["owner", "repo", "issueNumber"],
      },
      zodSchema: githubGetIssueSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubGetIssueSchema>;
        return callGitHub(options.sidecarUrl, options.token, "get_issue", {
          owner: input.owner,
          repo: input.repo,
          issue_number: input.issueNumber,
        });
      },
    },
    {
      name: "github-update-issue",
      description: "Update an existing issue (title, body, state, labels, assignees).",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issueNumber: { type: "number" },
          title: { type: "string" },
          body: { type: "string" },
          state: { type: "string", enum: ["open", "closed"] },
          labels: { type: "array", items: { type: "string" } },
          assignees: { type: "array", items: { type: "string" } },
        },
        required: ["owner", "repo", "issueNumber"],
      },
      zodSchema: githubUpdateIssueSchema,
      category: "developer",
      riskLevel: "medium",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubUpdateIssueSchema>;
        return callGitHub(options.sidecarUrl, options.token, "update_issue", {
          owner: input.owner,
          repo: input.repo,
          issue_number: input.issueNumber,
          title: input.title,
          body: input.body,
          state: input.state,
          labels: input.labels,
          assignees: input.assignees,
        });
      },
    },
    {
      name: "github-add-issue-comment",
      description: "Add a comment to an issue or pull request.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issueNumber: { type: "number" },
          body: { type: "string" },
        },
        required: ["owner", "repo", "issueNumber", "body"],
      },
      zodSchema: githubAddIssueCommentSchema,
      category: "developer",
      riskLevel: "medium",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubAddIssueCommentSchema>;
        return callGitHub(options.sidecarUrl, options.token, "add_issue_comment", {
          owner: input.owner,
          repo: input.repo,
          issue_number: input.issueNumber,
          body: input.body,
        });
      },
    },
    {
      name: "github-search-issues",
      description: "Search issues across GitHub repositories using search syntax.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          perPage: { type: "number" },
        },
        required: ["query"],
      },
      zodSchema: githubSearchIssuesSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubSearchIssuesSchema>;
        return callGitHub(options.sidecarUrl, options.token, "search_issues", input);
      },
    },

    // ── Additional PR Tools ──
    {
      name: "github-search-prs",
      description: "Search pull requests across GitHub repositories using search syntax.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          perPage: { type: "number" },
        },
        required: ["query"],
      },
      zodSchema: githubSearchPullRequestsSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubSearchPullRequestsSchema>;
        return callGitHub(options.sidecarUrl, options.token, "search_pull_requests", input);
      },
    },
    {
      name: "github-update-pr",
      description: "Update an existing pull request (title, body, state, base branch).",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          pullNumber: { type: "number" },
          title: { type: "string" },
          body: { type: "string" },
          state: { type: "string", enum: ["open", "closed"] },
          base: { type: "string" },
        },
        required: ["owner", "repo", "pullNumber"],
      },
      zodSchema: githubUpdatePrSchema,
      category: "developer",
      riskLevel: "medium",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubUpdatePrSchema>;
        return callGitHub(options.sidecarUrl, options.token, "update_pull_request", {
          owner: input.owner,
          repo: input.repo,
          pull_number: input.pullNumber,
          title: input.title,
          body: input.body,
          state: input.state,
          base: input.base,
        });
      },
    },
    {
      name: "github-update-pr-branch",
      description: "Update a pull request branch with the latest changes from the base branch.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          pullNumber: { type: "number" },
          expectedHeadSha: { type: "string" },
        },
        required: ["owner", "repo", "pullNumber"],
      },
      zodSchema: githubUpdatePrBranchSchema,
      category: "developer",
      riskLevel: "medium",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubUpdatePrBranchSchema>;
        return callGitHub(options.sidecarUrl, options.token, "update_pull_request_branch", {
          owner: input.owner,
          repo: input.repo,
          pull_number: input.pullNumber,
          expected_head_sha: input.expectedHeadSha,
        });
      },
    },

    // ── Multi-File Push ──
    {
      name: "github-push-files",
      description: "Push multiple files to a GitHub repository in a single commit.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          branch: { type: "string" },
          message: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["path", "content"],
            },
          },
        },
        required: ["owner", "repo", "branch", "message", "files"],
      },
      zodSchema: githubPushFilesSchema,
      category: "developer",
      riskLevel: "high",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubPushFilesSchema>;
        return callGitHub(options.sidecarUrl, options.token, "push_files", input);
      },
    },

    // ── Tags ──
    {
      name: "github-list-tags",
      description: "List tags in a GitHub repository.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          perPage: { type: "number" },
        },
        required: ["owner", "repo"],
      },
      zodSchema: githubListTagsSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubListTagsSchema>;
        return callGitHub(options.sidecarUrl, options.token, "list_tags", input);
      },
    },

    // ── Repository Tree ──
    {
      name: "github-get-repo-tree",
      description: "Get the file/directory tree of a GitHub repository.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          sha: { type: "string" },
          recursive: { type: "boolean" },
        },
        required: ["owner", "repo"],
      },
      zodSchema: githubGetRepoTreeSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubGetRepoTreeSchema>;
        return callGitHub(options.sidecarUrl, options.token, "get_repository_tree", input);
      },
    },

    // ── Labels ──
    {
      name: "github-list-labels",
      description: "List labels in a GitHub repository.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          perPage: { type: "number" },
        },
        required: ["owner", "repo"],
      },
      zodSchema: githubListLabelsSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubListLabelsSchema>;
        return callGitHub(options.sidecarUrl, options.token, "list_labels", input);
      },
    },
    {
      name: "github-get-label",
      description: "Get a specific label from a GitHub repository.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          name: { type: "string" },
        },
        required: ["owner", "repo", "name"],
      },
      zodSchema: githubGetLabelSchema,
      category: "developer",
      riskLevel: "low",
      source: "github",
      handler: async (args) => {
        const input = args as z.infer<typeof githubGetLabelSchema>;
        return callGitHub(options.sidecarUrl, options.token, "get_label", input);
      },
    },
  ];
};
