/** Core tools that are always included regardless of maxToolsPerRequest filtering. */
export const ALWAYS_ON_TOOLS = new Set([
  "read-file",
  "list-directory",
  "web-search",
  "browser-navigate",
  "shell-execute",
  "spawn-agent",
  "orchestrate-agents",
  "search-knowledge",
  "list-secrets",
  "get-secret",
]);

/**
 * High-risk tools that are auto-approved during interactive chat sessions.
 *
 * When a human user is actively chatting, they are the implicit approver —
 * forcing them through the approval queue for every tool call they initiated
 * is bad UX. Background/automated tasks still go through the normal
 * approval flow unless their task config includes autoApproveTools.
 */
export const INTERACTIVE_CHAT_AUTO_APPROVE_TOOLS = [
  "shell-execute",
  "browser-navigate",
  "list-secrets",
  "get-secret",
  "write-file",
];
