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
      category: "documents",
      riskLevel: "low",
      handler: async (args) => {
        const input = args as z.infer<typeof githubGetFileSchema>;
        return callSidecar(options.sidecarUrl, "github_get_file", input);
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
      category: "documents",
      riskLevel: "low",
      handler: async (args) => {
        const input = args as z.infer<typeof githubSearchCodeSchema>;
        return callSidecar(options.sidecarUrl, "github_search_code", input);
      },
    },
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
      category: "documents",
      riskLevel: "low",
      handler: async (args) => {
        const input = args as z.infer<typeof githubListIssuesSchema>;
        return callSidecar(options.sidecarUrl, "github_list_issues", input);
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
      category: "documents",
      riskLevel: "medium",
      handler: async (args) => {
        const input = args as z.infer<typeof githubCreateIssueSchema>;
        return callSidecar(options.sidecarUrl, "github_create_issue", input);
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
      category: "documents",
      riskLevel: "high",
      handler: async (args) => {
        const input = args as z.infer<typeof githubCreatePrSchema>;
        return callSidecar(options.sidecarUrl, "github_create_pr", input);
      },
    },
  ];
};
