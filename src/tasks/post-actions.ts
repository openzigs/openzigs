/**
 * Post-action handlers for pipeline stages.
 *
 * Instead of relying on the LLM to call tools (which it often hallucinates),
 * post-actions execute deterministic code after a stage completes.
 */

import type { PipelinePostAction } from "./types.js";

/* ------------------------------------------------------------------ */
/*  Finding parser — extracts structured findings from review output  */
/* ------------------------------------------------------------------ */

interface CodeFinding {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line?: number;
  description: string;
  recommendation: string;
}

/**
 * Parse code review findings from an LLM-generated review report.
 * Handles the format:
 *   N. **[SEVERITY]** File: path/to/File.java Line: N
 *      Description: ...
 *      Recommendation: ...
 */
function parseFindings(text: string): CodeFinding[] {
  const findings: CodeFinding[] = [];

  // Split on finding number pattern
  const blocks = text.split(/\d+\.\s+\*\*\[/);

  for (const block of blocks) {
    if (!block.trim()) continue;

    // Extract severity
    const sevMatch = block.match(/^(Critical|High|Medium|Low)\]\*\*/i);
    if (!sevMatch) continue;

    const severity = sevMatch[1].toLowerCase() as CodeFinding["severity"];

    // Extract file
    const fileMatch = block.match(/File:\s*(.+?)(?:\s+Line:|\n)/);
    const file = fileMatch?.[1]?.trim() ?? "unknown";

    // Extract line number
    const lineMatch = block.match(/Line:\s*(\d+)/);
    const line = lineMatch ? parseInt(lineMatch[1], 10) : undefined;

    // Extract description
    const descMatch = block.match(/Description:\s*(.+?)(?:\n\s*Recommendation:|$)/s);
    const description = descMatch?.[1]?.trim() ?? block.slice(0, 200).trim();

    // Extract recommendation
    const recMatch = block.match(/Recommendation:\s*(.+?)(?:\n\d+\.|$)/s);
    const recommendation = recMatch?.[1]?.trim() ?? "";

    findings.push({ severity, file, line, description, recommendation });
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/*  GitHub issue creation via REST API                                */
/* ------------------------------------------------------------------ */

interface GitHubIssueResult {
  number: number;
  url: string;
  title: string;
}

async function createGitHubIssue(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body: string,
  labels: string[],
): Promise<GitHubIssueResult> {
  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "OpenZigs/0.1",
    },
    body: JSON.stringify({ title, body, labels }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API error (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as { number: number; html_url: string; title: string };
  return { number: data.number, url: data.html_url, title: data.title };
}

async function searchGitHubIssues(
  token: string,
  owner: string,
  repo: string,
  query: string,
): Promise<number> {
  const resp = await fetch(
    `https://api.github.com/search/issues?q=${encodeURIComponent(query)}+repo:${owner}/${repo}+is:issue`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "OpenZigs/0.1",
      },
    },
  );

  if (!resp.ok) return 0;
  const data = (await resp.json()) as { total_count: number };
  return data.total_count;
}

/* ------------------------------------------------------------------ */
/*  create-github-issues action                                       */
/* ------------------------------------------------------------------ */

interface CreateGitHubIssuesConfig {
  owner: string;
  repo: string;
  labels?: string[];
  /** Minimum severity to create issues for. Default: "medium" */
  minSeverity?: "critical" | "high" | "medium" | "low";
  /** Maximum issues to create per run. Default: 8 */
  maxIssues?: number;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

async function executeCreateGitHubIssues(
  stageOutput: string,
  config: CreateGitHubIssuesConfig,
): Promise<string> {
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (!token) {
    return JSON.stringify({
      error: "GITHUB_PERSONAL_ACCESS_TOKEN not set",
      issuesCreated: 0,
      createdIssues: [],
    });
  }

  const { owner, repo } = config;
  const labels = config.labels ?? ["code-review", "automated"];
  const minSeverity = config.minSeverity ?? "medium";
  const maxIssues = config.maxIssues ?? 8;
  const minRank = SEVERITY_RANK[minSeverity] ?? 2;

  // Parse findings from stage output
  const allFindings = parseFindings(stageOutput);
  const filtered = allFindings
    .filter((f) => (SEVERITY_RANK[f.severity] ?? 0) >= minRank)
    .slice(0, maxIssues);

  if (filtered.length === 0) {
    return JSON.stringify({
      findings: countBySeverity(allFindings),
      issuesAttempted: 0,
      issuesCreated: 0,
      createdIssues: [],
      note: `No findings at or above ${minSeverity} severity`,
      issuesLink: `https://github.com/${owner}/${repo}/issues`,
    });
  }

  const createdIssues: GitHubIssueResult[] = [];
  const errors: string[] = [];

  for (const finding of filtered) {
    // Build issue title and body
    const title = `[${finding.severity.toUpperCase()}] ${finding.description.slice(0, 80)}`;
    const body = [
      `## Code Review Finding`,
      ``,
      `**Severity:** ${finding.severity.toUpperCase()}`,
      `**File:** \`${finding.file}\`${finding.line ? ` (Line ${finding.line})` : ""}`,
      ``,
      `### Description`,
      finding.description,
      ``,
      ...(finding.recommendation
        ? [`### Recommendation`, finding.recommendation, ``]
        : []),
      `---`,
      `*Generated by OpenZigs automated code review pipeline*`,
    ].join("\n");

    // Check for duplicates
    const shortTitle = finding.description.slice(0, 40);
    const dupeCount = await searchGitHubIssues(token, owner, repo, shortTitle);
    if (dupeCount > 0) {
      continue; // Skip duplicate
    }

    try {
      const issue = await createGitHubIssue(token, owner, repo, title, body, labels);
      createdIssues.push(issue);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to create issue for "${title}": ${msg}`);
    }
  }

  return JSON.stringify({
    findings: countBySeverity(allFindings),
    issuesAttempted: filtered.length,
    issuesCreated: createdIssues.length,
    createdIssues,
    ...(errors.length > 0 ? { errors } : {}),
    issuesLink: `https://github.com/${owner}/${repo}/issues`,
  });
}

function countBySeverity(findings: CodeFinding[]): Record<string, number> {
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  return counts;
}

/* ------------------------------------------------------------------ */
/*  Dispatcher                                                        */
/* ------------------------------------------------------------------ */

/**
 * Execute a post-action after a pipeline stage completes.
 * Returns a result string that gets appended to the accumulated context.
 */
export async function executePostAction(
  action: PipelinePostAction,
  stageOutput: string,
): Promise<string> {
  switch (action.type) {
    case "create-github-issues":
      return executeCreateGitHubIssues(
        stageOutput,
        (action.config ?? {}) as unknown as CreateGitHubIssuesConfig,
      );
    default:
      return JSON.stringify({ error: `Unknown post-action type: ${action.type}` });
  }
}
