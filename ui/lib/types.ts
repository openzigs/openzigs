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

/** A single stage in a multi-stage pipeline. */
export type PipelineStage = {
  type?: "prompt";
  name: string;
  prompt: string;
  tools?: string[] | null;
  autoApproveTools?: string[];
  model?: string;
  timeoutSeconds?: number;
  postAction?: PipelinePostAction;
};

/** Deterministic post-action configuration for a pipeline stage. */
export type PipelinePostAction = {
  type: string;
  config?: Record<string, unknown>;
};

export type SavedPrompt = {
  id: string;
  name: string;
  template: string;
  description: string;
  tags: string[];
  /** Optional pipeline stages for multi-stage execution. null = single-stage prompt. */
  stages: PipelineStage[] | null;
  /** Optional list of preferred tool names. null = no preference (all tools). */
  preferredTools: string[] | null;
  /** Optional brand voice ID to apply when executing this prompt. null = use active default. */
  brandVoiceId: string | null;
  /** Optional skill to activate when using this prompt (e.g., "media-director"). null = no skill. */
  suggestedSkill: string | null;
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
  reasoningEffort?: ReasoningEffort | null;
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

export type BrandVoiceRulebook = {
  tone: string;
  sentence_structure: string;
  vocabulary_level: string;
  formatting_quirks: string;
  banned_words: string[];
};

export type BrandVoice = {
  id: string;
  name: string;
  rulebook: BrandVoiceRulebook;
  active: boolean;
  samples: string[];
  createdAt: string;
  updatedAt: string;
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

/* ── Copilot SDK Session types (Epic #334) ── */

export type SdkSessionContext = {
  cwd: string;
  gitRoot?: string;
  repository?: string;
  branch?: string;
};

export type SdkSessionMetadata = {
  sessionId: string;
  startTime: string;
  modifiedTime: string;
  summary?: string;
  isRemote: boolean;
  context?: SdkSessionContext;
};

export type SdkSessionEvent = {
  id: string;
  timestamp: string;
  parentId: string | null;
  ephemeral?: boolean;
  type: string;
  data: Record<string, unknown>;
};

export type SessionAnalytics = {
  sessionsCreated: number;
  sessionsResumed: number;
  sessionsDestroyed: number;
  compactionCount: number;
  lifecycleEvents: Array<{
    type: string;
    sessionId: string;
    metadata?: { startTime: string; modifiedTime: string; summary?: string };
  }>;
  lastUpdated: string;
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
  | { type: "local" | "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; tools?: string[]; disabledTools?: string[]; timeout?: number }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string>; tools?: string[]; disabledTools?: string[]; timeout?: number };

/* ── Token Usage / Observability types (#184) ── */

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number;
};

export type TokenUsageEvent = {
  sessionId: string;
  delta: {
    inputTokens: number;
    outputTokens: number;
  };
  cumulative: TokenUsage;
};

export type CompactionEvent = {
  sessionId: string;
  status: "started" | "completed";
};

/* ── Template Portability types (#188) ── */

export type TemplatePlaceholder = {
  key: string;
  path: string;
  description: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  defaultValue?: string;
};

export type TemplateExport = {
  $schema: "openzigs-template-v1";
  version: number;
  exportedAt: string;
  exportedFrom: string;
  prompt: {
    name: string;
    description: string;
    template: string;
    tags: string[];
    preferredTools: string[] | null;
    stages: PipelineStage[] | null;
  };
  placeholders: TemplatePlaceholder[];
};

export type TemplateAnalysis = {
  valid: boolean;
  errors: { message: string; path?: string }[];
  prompt?: {
    name: string;
    description: string;
    stageCount: number;
    tags: string[];
  };
  placeholders: TemplatePlaceholder[];
  exportedAt?: string;
  exportedFrom?: string;
};

/* ── Sentinel: Autonomous System Monitor types (#179) ── */

export type SentinelConfig = {
  enabled: boolean;
  model: string;
  checkIntervalMinutes: number;
  jitterMinutes: number;
  digestHour: number;
  auditHour: number;
  consecutiveFailureThreshold: number;
  queueDepthThreshold: number;
  // #195
  persistMarkdownDigest: boolean;
  markdownDigestPath: string | null;
  digestRetentionDays: number;
  // #196
  notifyChannels: string[];
  criticalCooldownMinutes: number;
  warningCooldownMinutes: number;
  // #197
  timezone: string;
  noOverlap: boolean;
  maxRandomDelayMs: number;
};

export type SentinelStatus = {
  enabled: boolean;
  lastTaskCheckAt: string | null;
  lastDigestAt: string | null;
  lastPromptAuditAt: string | null;
  consecutiveFailures: number;
  totalTasksReviewed: number;
  alertsSent: number;
  modelOverride: string | null;
  nextCheckEstimate: string | null;
  config: SentinelConfig;
};

export type SentinelAlert = {
  type: string;
  priority: "critical" | "warning";
  message: string;
  timestamp: string;
  data?: Record<string, unknown>;
};

export type DigestRecord = {
  timestamp: string;
  period: { from: string; to: string };
  taskSummary: {
    completed: number;
    failed: number;
    cancelled: number;
    successRate: number;
  };
  tokenBurn: {
    total: number;
    avgPerTask: number;
    topConsumer: { goal: string; tokens: number } | null;
  } | null;
  promptAudit: {
    sampledCount: number;
    avgScore: number;
  } | null;
  promptRecommendations: PromptRecommendation[] | null;
  alertCount: number;
};

export type PromptRecommendation = {
  prompt: string;
  sessionId: string;
  score: number;
  suggestions: string;
  rewrite: string | null;
};

/* ── Knowledge Base types (#215) ── */

export type KnowledgeSourceType =
  | "markdown"
  | "text"
  | "pdf"
  | "docx"
  | "xlsx"
  | "json"
  | "csv"
  | "html"
  | "code"
  | "media"
  | "image";
export type DocumentStatus = "pending" | "processing" | "indexed" | "failed";

export type KnowledgeDocument = {
  id: string;
  filePath: string;
  relativePath: string;
  sourceType: KnowledgeSourceType;
  sizeBytes: number;
  contentHash: string;
  status: DocumentStatus;
  chunkCount: number;
  indexedAt: string | null;
  createdAt: string;
  error?: string;
};

export type KnowledgeSearchResult = {
  text: string;
  sourcePath: string;
  score: number;
  sectionHeading?: string;
  documentId: string;
  chunkIndex: number;
};

export type KnowledgeStats = {
  totalDocuments: number;
  totalChunks: number;
  indexedDocuments: number;
  failedDocuments: number;
  pendingDocuments: number;
  totalSizeBytes: number;
  lastIndexedAt: string | null;
};

export type KnowledgeSearchMode = "vector" | "fts" | "hybrid";

export type KnowledgeConfig = {
  enabled: boolean;
  directory: string;
  chunkSize: number;
  chunkOverlap: number;
  maxResults: number;
  includeExtensions: string[];
  excludePatterns: string[];
  watchEnabled: boolean;
  mediaModel: string;
  minScore: number;
  searchMode: KnowledgeSearchMode;
};
