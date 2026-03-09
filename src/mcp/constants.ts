/**
 * Essential tools that are ALWAYS included in every session, regardless of
 * maxToolsPerRequest filtering or skill scoping. These are the fundamental
 * capabilities every agent needs: file I/O, search, execution, delegation.
 *
 * Best practice (OpenAI): "Aim for fewer than 20 functions at the start of
 * a turn." Keeping this set small (~6) leaves room for skill-specific and
 * contextual tools within a typical 20–30 tool budget.
 */
export const ESSENTIAL_TOOLS = new Set([
  "read-file",
  "list-directory",
  "web-search",
  "shell-execute",
  "spawn-agent",
  "orchestrate-agents",
]);

/**
 * Contextual tools included when budget allows but not essential for every
 * session. Dropped in favour of skill-specific tools when the cap is tight.
 */
export const CONTEXTUAL_TOOLS = new Set([
  "browser-navigate",
  "search-knowledge",
  "list-secrets",
  "get-secret",
  "ingest-youtube",
  "query-gallery-assets",
  "submit-media-job",
  "get-job-status",
  "save-draft-media",
  "send-notification",
  "produce-video",
  "transcribe-audio",
]);

/** Combined set — backward-compatible union of ESSENTIAL + CONTEXTUAL. */
export const ALWAYS_ON_TOOLS = new Set([...ESSENTIAL_TOOLS, ...CONTEXTUAL_TOOLS]);

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
  "ingest-youtube",
  "submit-media-job",
  "get-job-status",
  "save-draft-media",
  "send-notification",
  "produce-video",
  "transcribe-audio",
];
