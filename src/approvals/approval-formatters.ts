/**
 * Tool-specific approval formatters that produce human-readable context
 * for high-risk tool approval prompts.
 *
 * Each formatter extracts the most important information from the tool's
 * parameters to help the human reviewer make an informed decision.
 */

export type ApprovalContext = {
  summary: string;
  details: string[];
  destructiveAction: string;
};

type ApprovalFormatter = (params: Record<string, unknown>) => ApprovalContext;

const truncate = (text: string, maxLen: number): string =>
  text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const approvalFormatters: Record<string, ApprovalFormatter> = {
  "gmail-send": (p) => ({
    summary: `Send email to ${asString(p.to)}`,
    details: [
      `To: ${asString(p.to)}`,
      `Subject: ${asString(p.subject)}`,
      `Body: ${truncate(asString(p.body), 200)}`,
      ...(p.cc ? [`CC: ${asString(p.cc)}`] : []),
      ...(p.bcc ? [`BCC: ${asString(p.bcc)}`] : []),
    ],
    destructiveAction: "This will send an email from your Gmail account",
  }),

  "db-query": (p) => ({
    summary: "Execute SQL query",
    details: [asString(p.query)],
    destructiveAction: "This will run a SQL query against your database",
  }),

  "github-create-pr": (p) => ({
    summary: `Create PR in ${asString(p.owner)}/${asString(p.repo)}`,
    details: [
      `Title: ${asString(p.title)}`,
      `Branch: ${asString(p.head)} → ${asString(p.base)}`,
      ...(p.body ? [`Body: ${truncate(asString(p.body), 200)}`] : []),
      ...(p.draft === true ? ["Draft: yes"] : []),
    ],
    destructiveAction: "This will create a pull request on GitHub",
  }),

  "social-post": (p) => ({
    summary: `Post to ${asString(p.platform)}`,
    details: [`Platform: ${asString(p.platform)}`, `Content: ${truncate(asString(p.content), 200)}`],
    destructiveAction: `This will publish content to ${asString(p.platform)}`,
  }),

  "write-file": (p) => ({
    summary: `Write file to ${asString(p.path)}`,
    details: [`Path: ${asString(p.path)}`, `Size: ${asString(p.content).length} characters`],
    destructiveAction: "This will modify a file on the host filesystem",
  }),

  "shell-execute": (p) => ({
    summary: `Run command: ${asString(p.command)}`,
    details: [
      `Command: ${asString(p.command)}`,
      ...(Array.isArray(p.args) && p.args.length > 0
        ? [`Args: ${(p.args as string[]).join(" ")}`]
        : []),
      ...(p.cwd ? [`Working directory: ${asString(p.cwd)}`] : []),
    ],
    destructiveAction: "This will execute a shell command on the host",
  }),

  "browser-navigate": (p) => ({
    summary: `Browser action: ${asString(p.action)}`,
    details: [
      `Action: ${asString(p.action)}`,
      ...(p.url ? [`URL: ${asString(p.url)}`] : []),
      ...(p.expression ? [`JS Expression: ${truncate(asString(p.expression), 100)}`] : []),
    ],
    destructiveAction: "This can navigate the browser and execute JavaScript",
  }),
};

/**
 * Format an approval context for a given tool. Returns undefined if no
 * formatter is registered for the tool (non-high-risk tools).
 */
export const formatApprovalContext = (
  toolName: string,
  params: Record<string, unknown>
): ApprovalContext | undefined => {
  const formatter = approvalFormatters[toolName];
  if (!formatter) {
    return undefined;
  }
  return formatter(params);
};
