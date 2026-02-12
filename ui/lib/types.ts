/* ── Shared types for the OpenZigs UI ── */

export type ToolInfo = {
  name: string;
  description: string;
  category: string;
  riskLevel: string;
  enabled: boolean;
  source?: string;
  /** Whether this tool has a global approval lock (always requires approval). */
  globalApprovalRequired?: boolean;
};

export type Approval = {
  id: string;
  tool: string;
  riskLevel: string;
  status: string;
  createdAt: string;
  explanation: string;
  preview?: string;
  decidedVia?: string;
  args?: Record<string, unknown>;
};

export type AuditEntry = {
  id: string;
  timestamp: string;
  level: string;
  category: string;
  event: string;
  details: Record<string, unknown>;
};

export type SavedPrompt = {
  id: string;
  name: string;
  template: string;
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type ScheduledJob = {
  id: string;
  name: string;
  cronExpression: string;
  timezone: string;
  actionType: string;
  actionPayload: Record<string, unknown>;
  model?: string | null;
  allowedTools?: string[] | null;
  autoApproveTools?: string[] | null;
  enabled: boolean;
  lastRunAt: string | null;
  runCount: number;
  createdAt: string;
};

export type EnvEntry = {
  name: string;
  label?: string;
  configured: boolean;
};

export type SidecarEnvVar = {
  name: string;
  configured: boolean;
};

export type SidecarCredential = {
  platform: string;
  label: string;
  imageAvailable: boolean;
  enabled: boolean;
  envVars: SidecarEnvVar[];
};

export type SidecarStatus = {
  name: string;
  running: boolean;
  healthy: boolean;
  url?: string;
  error?: string;
};

export type SidecarsResponse = {
  dockerAvailable: boolean;
  credentials: SidecarCredential[];
  sidecars: SidecarStatus[];
};

export type ChannelConfig = {
  telegram: {
    enabled: boolean;
    model?: string;
    webhookUrl?: string;
    webhookSecret?: string;
    adminUserId?: string;
    allowedUsers?: string[];
  };
  discord: {
    enabled: boolean;
    allowedGuilds?: string[];
  };
};

export type ModelCapabilities = {
  supports: {
    reasoningEffort: boolean;
    vision?: boolean;
  };
  limits?: {
    max_context_window_tokens?: number;
  };
};

export type ModelInfo = {
  id: string;
  capabilities?: ModelCapabilities;
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
};

export type LocalServerDefinition = {
  name: string;
  label: string;
  runtime: string;
  command: string;
  args: string[];
  category: string;
  requiresCredentials: boolean;
  requiredEnvVars?: string[];
};

export type LocalServerStatus = {
  name: string;
  running: boolean;
  toolCount: number;
  error?: string;
};

export type LocalServerCredential = {
  server: string;
  envVars: SidecarEnvVar[];
};

export type LocalServersResponse = {
  servers: LocalServerStatus[];
  credentials: LocalServerCredential[];
  definitions: LocalServerDefinition[];
};

export type PersonalityConfig = {
  systemInstruction: string;
  prePrompt: string;
  postPrompt: string;
  enabled: boolean;
  updatedAt: string;
  mode: "append" | "replace";
};

export type SessionInfo = {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  channel: string;
  userId: string;
  metadata: Record<string, unknown>;
};

export type ConversationEvent = {
  timestamp: string;
  type: "user" | "assistant" | "tool_call" | "tool_result";
  content: string;
  metadata?: {
    toolName?: string;
    args?: Record<string, unknown>;
    duration?: number;
  };
};

/* ── Chat Attachment types (#141) ── */

export type ChatAttachment = {
  type: "file" | "directory";
  path: string;
  name: string;
};

/* ── Reasoning Effort types (#142) ── */

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type ProviderInfo = {
  type: "copilot" | "azure" | "openai" | "anthropic" | "ollama" | "custom";
  label: string;
};

/* ── User Input Request types (#143) ── */

export type WorkflowPreview = {
  type: "prompt" | "scheduled-job" | "webhook" | "agent";
  name: string;
  summary: string;
  config: Record<string, unknown>;
};

export type UserInputRequest = {
  requestId: string;
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
  timeout?: number;
  preview?: WorkflowPreview;
};

export type UserInputResponse = {
  requestId: string;
  answer: string;
  wasFreeform: boolean;
};

/* ── Session Status types (#144) ── */

export type SessionStatus = {
  sessionId: string;
  contextUsage: number;
  turnCount: number;
  createdAt: string;
  isResumed: boolean;
  compactionActive: boolean;
  infiniteSessionsEnabled: boolean;
};

/* ── Model & Provider Config types (#145) ── */

export type ProviderType = "openai" | "azure" | "anthropic" | "ollama" | "custom";

export type ProviderConfig = {
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
  bearerToken?: string;
  azure?: { apiVersion?: string };
  wireApi?: "openai" | "anthropic";
  headers?: Record<string, string>;
};

export type ModelConfig = {
  reasoningEffort: ReasoningEffort;
  provider: ProviderConfig | null;
  workingDirectory: string | null;
};

/* ── Custom Agent types (#146) ── */

export type CustomAgentDefinition = {
  name: string;
  displayName: string;
  description?: string;
  prompt: string;
  tools?: string[] | null;
  infer?: boolean;
};

/* ── Native MCP Server types (#147) ── */

export type NativeMcpServerType = "local" | "stdio" | "http" | "sse";

export type NativeMcpServerDefinition =
  | { type: "local" | "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; tools?: string[]; timeout?: number }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string>; tools?: string[]; timeout?: number };
