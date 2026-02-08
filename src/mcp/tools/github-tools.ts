import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";

/**
 * GitHub MCP tools for repository management, issues, PRs, and code search.
 *
 * Connects to the GitHub MCP Docker sidecar (github/github-mcp-server)
 * which provides full GitHub API access via a Personal Access Token.
 */

type GitHubToolsOptions = {
  sidecarUrl?: string;
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

const callSidecar = async (
  baseUrl: string | undefined,
  method: string,
  params: Record<string, unknown>
): Promise<{ text: string; isError?: boolean }> => {
  if (!baseUrl) {
    return {
      text: "GitHub sidecar not configured. Set MCP_GITHUB_URL and GITHUB_PERSONAL_ACCESS_TOKEN in environment variables.",
      isError: true,
    };
  }

  try {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { text: `GitHub sidecar error: ${errorText}`, isError: true };
    }

    const result = (await response.json()) as { result?: string };
    return { text: result.result ?? JSON.stringify(result) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `Failed to reach GitHub sidecar: ${message}`, isError: true };
  }
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
      handler: async () => callSidecar(options.sidecarUrl, "get_me", {}),
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
        return callSidecar(options.sidecarUrl, "get_file_contents", input);
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
        return callSidecar(options.sidecarUrl, "search_code", input);
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
        return callSidecar(options.sidecarUrl, "search_repositories", input);
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
        return callSidecar(options.sidecarUrl, "search_users", input);
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
        return callSidecar(options.sidecarUrl, "list_issues", input);
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
        return callSidecar(options.sidecarUrl, "create_issue", input);
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
        return callSidecar(options.sidecarUrl, "list_commits", input);
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
        return callSidecar(options.sidecarUrl, "get_commit", input);
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
        return callSidecar(options.sidecarUrl, "list_branches", input);
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
        return callSidecar(options.sidecarUrl, "create_branch", input);
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
        return callSidecar(options.sidecarUrl, "list_pull_requests", input);
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
        return callSidecar(options.sidecarUrl, "get_pull_request", input);
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
        return callSidecar(options.sidecarUrl, "create_pull_request", input);
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
        return callSidecar(options.sidecarUrl, "merge_pull_request", input);
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
        return callSidecar(options.sidecarUrl, "create_or_update_file", input);
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
        return callSidecar(options.sidecarUrl, "delete_file", input);
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
        return callSidecar(options.sidecarUrl, "fork_repository", input);
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
        return callSidecar(options.sidecarUrl, "create_repository", input);
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
        return callSidecar(options.sidecarUrl, "list_releases", input);
      },
    },
  ];
};
