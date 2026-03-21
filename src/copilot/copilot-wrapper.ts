import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import type { ToolDefinition, ToolRegistry } from "../mcp/tool-registry.js";
import { ALWAYS_ON_TOOLS, ESSENTIAL_TOOLS, CONTEXTUAL_TOOLS } from "../mcp/constants.js";
import { TokenTracker } from "./token-tracker.js";
import type { TokenUsage, TokenUsageEvent, CompactionEvent } from "./token-tracker.js";

export type { TokenUsage, TokenUsageEvent, CompactionEvent };

export type DeviceAuthInfo = {
  verificationUri: string;
  userCode: string;
};

// ── SDK Attachment Types ──
export type SdkAttachment = {
  type: "file" | "directory" | "selection";
  path: string;
  displayName?: string;
  languageId?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
};

// ── Reasoning Effort ──
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

// ── BYOK Provider Config ──
export type ProviderConfig =
  | { type: "openai"; baseUrl: string; apiKey?: string; bearerToken?: string; wireApi?: "openai" | "anthropic" }
  | { type: "azure"; baseUrl: string; apiKey?: string; bearerToken?: string; azure?: { apiVersion?: string } }
  | { type: "anthropic"; baseUrl: string; apiKey?: string; bearerToken?: string }
  | { type: "ollama"; baseUrl: string };

// ── Native Custom Agent Definition ──
export type CustomAgentDefinition = {
  name: string;
  displayName: string;
  description?: string;
  prompt: string;
  tools?: string[] | null;
  infer?: boolean;
  mcpServers?: Record<string, NativeMcpServerDefinition>;
};

// ── Native MCP Server Definition (SDK-level) ──
export type NativeMcpServerDefinition =
  | { type: "local" | "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; tools?: string[]; disabledTools?: string[]; timeout?: number }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string>; tools?: string[]; disabledTools?: string[]; timeout?: number };

type DeviceAuthResult = {
  token: string;
  refreshToken?: string;
  expiresAt?: number;
};

type AuthState = {
  token: string;
  refreshToken?: string;
  expiresAt?: number;
  obtainedAt: number;
};

type PermissionRequest = { kind: string; toolName?: string; toolArgs?: unknown };
type PermissionResponse = { kind: "approved" | "denied-by-rules" | "denied-by-user" };
type PermissionRequestHandler = (request: PermissionRequest) => Promise<PermissionResponse>;

export type InfiniteSessionConfig = {
  enabled?: boolean;
  backgroundCompactionThreshold?: number;
  bufferExhaustionThreshold?: number;
};

type SessionCreateConfig = {
  sessionId?: string;
  model?: string;
  streaming?: boolean;
  tools?: unknown[];
  infiniteSessions?: InfiniteSessionConfig;
  onPermissionRequest?: PermissionRequestHandler;
  systemMessage?: SystemMessageConfig;
  hooks?: HooksConfig;
  availableTools?: string[];
  excludedTools?: string[];
  workingDirectory?: string;
  reasoningEffort?: ReasoningEffort;
  provider?: ProviderConfig;
  customAgents?: CustomAgentDefinition[];
  mcpServers?: Record<string, NativeMcpServerDefinition>;
  skillDirectories?: string[];
  onUserInputRequest?: (
    request: { question: string; choices?: string[]; allowFreeform?: boolean },
    context: { sessionId: string }
  ) => Promise<{ answer: string; wasFreeform?: boolean }>;
  disabledSkills?: string[];
};

// ── SDK Session Event / Metadata types (re-exported for consumers) ──
export type SdkSessionContext = {
  cwd: string;
  gitRoot?: string;
  repository?: string;
  branch?: string;
};

export type SdkSessionMetadata = {
  sessionId: string;
  startTime: string;   // ISO
  modifiedTime: string; // ISO
  summary?: string;
  isRemote: boolean;
  context?: SdkSessionContext;
};

export type SdkSessionListFilter = {
  cwd?: string;
  gitRoot?: string;
  repository?: string;
  branch?: string;
};

export type SdkSessionEvent = {
  id: string;
  timestamp: string;
  parentId: string | null;
  ephemeral?: boolean;
  type: string;
  data: Record<string, unknown>;
};

export type SdkSessionLifecycleEvent = {
  type: "session.created" | "session.deleted" | "session.updated" | "session.foreground" | "session.background";
  sessionId: string;
  metadata?: {
    startTime: string;
    modifiedTime: string;
    summary?: string;
  };
};

// ── Subagent Event Payload Types ──
export type SubagentStartedEvent = {
  sessionId: string;
  agentName: string;
  parentSessionId?: string;
};

export type SubagentCompletedEvent = {
  sessionId: string;
  agentName: string;
  summary?: string;
};

export type SubagentFailedEvent = {
  sessionId: string;
  agentName: string;
  error: string;
};

export type SubagentSelectedEvent = {
  sessionId: string;
  agentName: string;
};

export type SubagentDeselectedEvent = {
  sessionId: string;
  agentName: string;
};

export type SubagentEvent =
  | { type: "started"; payload: SubagentStartedEvent }
  | { type: "completed"; payload: SubagentCompletedEvent }
  | { type: "failed"; payload: SubagentFailedEvent }
  | { type: "selected"; payload: SubagentSelectedEvent }
  | { type: "deselected"; payload: SubagentDeselectedEvent };

type CopilotSessionLike = {
  readonly sessionId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on: (event: string, handler: (event: any) => void) => (() => void);
  sendAndWait: (input: { prompt: string; attachments?: SdkAttachment[] }, timeout?: number) => Promise<unknown>;
  destroy: () => Promise<void>;
  getMessages?: () => Promise<SdkSessionEvent[]>;
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

export type CopilotModel = {
  id: string;
  capabilities?: ModelCapabilities;
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
  [key: string]: unknown;
};

type CopilotClientLike = {
  start?: () => Promise<void>;
  createSession: (config: SessionCreateConfig) => Promise<CopilotSessionLike>;
  resumeSession?: (sessionId: string, config?: Omit<SessionCreateConfig, "sessionId">) => Promise<CopilotSessionLike>;
  stop?: () => Promise<Error[]>;
  startDeviceAuth?: (input: { clientId: string; scopes: string[] }) => Promise<DeviceAuthInfo>;
  waitForAuth?: (input: { timeoutMs: number }) => Promise<unknown>;
  listModels?: () => Promise<CopilotModel[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listSessions?: (filter?: SdkSessionListFilter) => Promise<any[]>;
  deleteSession?: (sessionId: string) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on?: (...args: any[]) => (() => void);
};

export type SystemMessageConfig = {
  mode: "append" | "replace";
  content: string;
};

export type WorkflowPreview = {
  type: "prompt" | "scheduled-job" | "webhook" | "agent";
  name: string;
  summary: string;
  config: Record<string, unknown>;
};

export type UserInputRequest = {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
  preview?: WorkflowPreview;
};

export type UserInputResponse = {
  answer: string;
  wasFreeform?: boolean;
};

export type UserInputHandler = (
  request: UserInputRequest,
  sessionId: string
) => Promise<UserInputResponse>;

export type HookPreToolUseInput = {
  toolName: string;
  toolArgs: unknown;
  cwd?: string;
  timestamp?: number;
  context: {
    sessionId: string;
    /** Closure-captured auto-approve list (survives JSON-RPC boundary). */
    autoApproveTools?: string[];
  };
};

export type HookPreToolUseResult = {
  permissionDecision: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
  modifiedArgs?: unknown;
  additionalContext?: string;
};

export type HookPostToolUseInput = {
  toolName: string;
  toolArgs: unknown;
  toolResult: unknown;
  timestamp?: number;
};

export type HookPostToolUseResult = {
  modifiedResult?: unknown;
  additionalContext?: string;
} | null;

export type HookSessionStartInput = {
  source?: string;
};

export type HookSessionEndInput = {
  reason?: string;
};

export type HookErrorInput = {
  error: string;
  errorContext?: string;
  recoverable?: boolean;
};

export type HooksConfig = {
  onPreToolUse?: (input: HookPreToolUseInput) => Promise<HookPreToolUseResult>;
  onPostToolUse?: (input: HookPostToolUseInput) => Promise<HookPostToolUseResult>;
  onSessionStart?: (input: HookSessionStartInput) => Promise<{ additionalContext?: string } | null>;
  onSessionEnd?: (input: HookSessionEndInput) => Promise<null>;
  onErrorOccurred?: (input: HookErrorInput) => Promise<{ errorHandling: "retry" | "abort" } | null>;
};

export type ChatOptions = {
  tools?: ToolDefinition[];
  model?: string;
  onToolCall?: (tool: string, args: unknown) => void;
  /** When provided, the SDK session is cached and reused across calls for multi-turn context. */
  conversationId?: string;
  /** System message injected at the SDK session level instead of in the user prompt. */
  systemMessage?: SystemMessageConfig;
  /** Per-session tool allowlist — only these tool names are visible to the model. */
  availableTools?: string[];
  /** Per-session tool blocklist — these tool names are hidden from the model. */
  excludedTools?: string[];
  /** Handler for interactive user input requests from the SDK's ask_user tool. */
  onUserInputRequest?: UserInputHandler;
  /** File/directory/selection attachments sent alongside the prompt. */
  attachments?: SdkAttachment[];
  /** Working directory for the SDK session (base path for tool operations). */
  workingDirectory?: string;
  /** Reasoning effort for reasoning models (low, medium, high, xhigh). */
  reasoningEffort?: ReasoningEffort;
  /** Per-call custom agent overrides — merged with (or replaces) default agents. */
  customAgents?: CustomAgentDefinition[];
  /** Per-call native MCP server overrides — merged with (or replaces) default servers. */
  mcpServers?: Record<string, NativeMcpServerDefinition>;
  /** Tools to auto-approve without approval-queue gating (closure-based, survives JSON-RPC boundary). */
  autoApproveTools?: string[];
  /** Skill names to disable for this session (SDK-native disabledSkills support). */
  disabledSkills?: string[];
  /** When true, SDK-native subagent delegation is enabled (customAgents are passed to the session). */
  enableSubagents?: boolean;
  /** Override agent for this session — the SDK will use this agent's persona/tools. */
  agent?: string;
};

export interface CopilotWrapper {
  authenticate(): Promise<DeviceAuthInfo>;
  waitForAuth(): Promise<void>;
  isAuthenticated(): Promise<boolean>;
  chat(message: string, options?: ChatOptions): AsyncGenerator<string>;
  listModels(): Promise<CopilotModel[]>;
  onToolCall(tool: string, args: unknown): Promise<void>;
  setMaxToolsPerRequest(n: number): void;
  getMaxToolsPerRequest(): number;
  /** Destroy the cached SDK session for a conversation, freeing resources. */
  destroySession(conversationId: string): Promise<void>;
  /** Check if a cached session exists for the given conversation ID. */
  hasSession(conversationId: string): boolean;
  /** Destroy all cached sessions. */
  clearAllSessions(): Promise<void>;
  /** Get the current reasoning effort setting. */
  getReasoningEffort(): ReasoningEffort | undefined;
  /** Set the default reasoning effort for reasoning models. */
  setReasoningEffort(effort: ReasoningEffort | undefined): void;
  /** Get the current BYOK provider configuration. */
  getProvider(): ProviderConfig | undefined;
  /** Set the BYOK provider configuration (clears all cached sessions). */
  setProvider(provider: ProviderConfig | undefined): void;
  /** Get the default working directory. */
  getWorkingDirectory(): string | undefined;
  /** Set the default working directory. */
  setWorkingDirectory(dir: string | undefined): void;
  /** Get the configured custom agents. */
  getCustomAgents(): CustomAgentDefinition[];
  /** Replace the full set of custom agents (clears all cached sessions). */
  setCustomAgents(agents: CustomAgentDefinition[]): void;
  /** Get the configured native MCP servers. */
  getNativeMcpServers(): Record<string, NativeMcpServerDefinition>;
  /** Replace the full set of native MCP servers (clears all cached sessions). */
  setNativeMcpServers(servers: Record<string, NativeMcpServerDefinition>): void;
  /** Check whether a model supports reasoning effort configuration. */
  modelSupportsReasoning(modelId: string): boolean;
  /** Get accumulated token usage for a session (non-destructive). */
  getSessionUsage(sessionId: string): TokenUsage | null;
  /** Get and remove accumulated usage for a session (used on task completion). */
  clearSessionUsage(sessionId: string): TokenUsage | null;
  /** List all SDK-managed sessions (Phase 1). */
  listSdkSessions(filter?: SdkSessionListFilter): Promise<SdkSessionMetadata[]>;
  /** Get conversation events from an SDK session (Phase 3). */
  getSdkSessionMessages(sessionId: string): Promise<SdkSessionEvent[]>;
  /** Delete an SDK-managed session (Phase 1). */
  deleteSdkSession(sessionId: string): Promise<void>;
  /** Get session analytics metrics (Phase 4). */
  getSessionAnalytics(): SessionAnalytics;
  /** Reset session analytics counters. */
  resetSessionAnalytics(): void;
  /** Get configured skill directories for SKILL.md persona injection. */
  getSkillDirectories?(): string[];
  /** Add a skill directory and invalidate cached sessions. */
  addSkillDirectory?(dir: string): void;
}

export type CopilotWrapperOptions = {
  client?: CopilotClientLike;
  toolRegistry?: ToolRegistry;
  authPath?: string;
  clientId?: string;
  model?: string;
  authTimeoutMs?: number;
  maxToolsPerRequest?: number;
  onToolCall?: (tool: string, args: unknown) => Promise<void>;
  onPermissionRequest?: PermissionRequestHandler;
  /** Timeout in ms for each sendAndWait call. Default 600_000 (10 min). */
  sendAndWaitTimeoutMs?: number;
  /** Infinite session configuration for automatic context compaction. */
  infiniteSessions?: InfiniteSessionConfig;
  /** SDK hooks for tool lifecycle, session events, and error handling. */
  hooks?: HooksConfig;
  /** Default handler for interactive user input requests (ask_user). */
  onUserInputRequest?: UserInputHandler;
  /** Default reasoning effort for reasoning models. */
  defaultReasoningEffort?: ReasoningEffort;
  /** BYOK provider configuration (OpenAI-compatible, Azure, Anthropic, Ollama). */
  provider?: ProviderConfig;
  /** Default working directory for SDK sessions. */
  defaultWorkingDirectory?: string;
  /** Default custom agent definitions passed to every SDK session. */
  customAgents?: CustomAgentDefinition[];
  /** Default native MCP server definitions passed to every SDK session. */
  nativeMcpServers?: Record<string, NativeMcpServerDefinition>;
  /** Directories containing SKILL.md files for agent persona injection. */
  skillDirectories?: string[];
};

const defaultAuthPath = () => path.join(os.homedir(), ".openzigs", "auth.json");

const isExpired = (expiresAt?: number) => {
  if (!expiresAt) {
    return false;
  }
  return Date.now() >= expiresAt;
};

const readAuthState = async (authPath: string): Promise<AuthState | null> => {
  try {
    const raw = await fs.readFile(authPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AuthState>;
    if (!parsed.token) {
      return null;
    }
    return {
      token: parsed.token,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      obtainedAt: parsed.obtainedAt ?? Date.now()
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const writeAuthState = async (authPath: string, state: AuthState) => {
  await fs.mkdir(path.dirname(authPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(authPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.chmod(authPath, 0o600);
};

const normalizeAuthResult = (result: unknown): DeviceAuthResult => {
  if (!result || typeof result !== "object") {
    throw new Error("Device flow auth returned empty result");
  }

  const token = "token" in result && typeof (result as { token?: string }).token === "string"
    ? (result as { token: string }).token
    : "accessToken" in result && typeof (result as { accessToken?: string }).accessToken === "string"
      ? (result as { accessToken: string }).accessToken
      : "";

  if (!token) {
    throw new Error("Device flow auth did not return a token");
  }

  const expiresAt = "expiresAt" in result && typeof (result as { expiresAt?: number }).expiresAt === "number"
    ? (result as { expiresAt: number }).expiresAt
    : undefined;

  const refreshToken = "refreshToken" in result && typeof (result as { refreshToken?: string }).refreshToken === "string"
    ? (result as { refreshToken: string }).refreshToken
    : undefined;

  return { token, refreshToken, expiresAt };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Session Analytics (Phase 4) ──
export type SessionAnalytics = {
  sessionsCreated: number;
  sessionsResumed: number;
  sessionsDestroyed: number;
  compactionCount: number;
  lifecycleEvents: SdkSessionLifecycleEvent[];
  lastUpdated: string; // ISO
};

const isUnauthorizedError = (error: unknown) => {
  if (!error) {
    return false;
  }
  if (error instanceof Error && /401|unauthorized/i.test(error.message)) {
    return true;
  }
  const status = (error as { status?: number }).status;
  return status === 401;
};

const isRateLimitError = (error: unknown) => {
  if (!error) {
    return false;
  }
  if (error instanceof Error && /429|rate limit/i.test(error.message)) {
    return true;
  }
  const status = (error as { status?: number }).status;
  return status === 429;
};

const isTimeoutError = (error: unknown) => {
  if (!error) {
    return false;
  }
  if (error instanceof Error && /timeout/i.test(error.message)) {
    return true;
  }
  return false;
};

class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private done = false;

  push(item: T) {
    if (this.done) {
      return;
    }
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  end() {
    if (this.done) {
      return;
    }
    this.done = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      if (resolver) {
        resolver({ value: undefined, done: true });
      }
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return { value: this.items.shift() as T, done: false };
    }
    if (this.done) {
      return { value: undefined, done: true };
    }
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }
}

export class CopilotWrapperService extends EventEmitter implements CopilotWrapper {
  private client: CopilotClientLike;
  private toolRegistry?: ToolRegistry;
  private authPath: string;
  private clientId: string;
  private model: string;
  private authTimeoutMs: number;
  private started = false;
  private startFailed = false;
  private startPromise?: Promise<void>;
  private pendingAuth?: Promise<AuthState>;
  private toolCallHandler?: (tool: string, args: unknown) => Promise<void>;
  private permissionHandler?: PermissionRequestHandler;
  private maxToolsPerRequest: number;
  private sendAndWaitTimeoutMs: number;
  private infiniteSessionsConfig?: InfiniteSessionConfig;
  private hooksConfig?: HooksConfig;
  private userInputHandler?: UserInputHandler;
  private defaultReasoningEffort?: ReasoningEffort;
  private providerConfig?: ProviderConfig;
  private defaultWorkingDirectory?: string;
  private customAgentsConfig: CustomAgentDefinition[];
  private nativeMcpServersConfig: Record<string, NativeMcpServerDefinition>;
  private skillDirectoriesConfig: string[];
  private sessionCache = new Map<string, CopilotSessionLike>();
  private sessionConfigSignatures = new Map<string, string>();
  private sessionCreationPromises = new Map<string, Promise<CopilotSessionLike>>();
  private modelCapabilitiesCache = new Map<string, { supportsReasoning: boolean }>();
  private analytics: SessionAnalytics = {
    sessionsCreated: 0,
    sessionsResumed: 0,
    sessionsDestroyed: 0,
    compactionCount: 0,
    lifecycleEvents: [],
    lastUpdated: new Date().toISOString(),
  };
  private lifecycleUnsubscribe?: () => void; // retained for future teardown
  readonly tokenTracker = new TokenTracker();
  private memoryContextProvider?: () => Promise<string | null>;

  constructor({
    client,
    toolRegistry,
    authPath = defaultAuthPath(),
    clientId = process.env.GITHUB_CLIENT_ID ?? "",
    model = "gpt-4.1",
    authTimeoutMs = 5 * 60 * 1000,
    maxToolsPerRequest = 30,
    sendAndWaitTimeoutMs = 15 * 60 * 1000, // 15 minutes — browser automation needs room
    onToolCall,
    onPermissionRequest,
    infiniteSessions,
    hooks,
    onUserInputRequest,
    defaultReasoningEffort,
    provider,
    defaultWorkingDirectory,
    customAgents,
    nativeMcpServers,
    skillDirectories,
  }: CopilotWrapperOptions = {}) {
    super();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.client = client ?? (new CopilotClient() as any);
    this.toolRegistry = toolRegistry;
    this.authPath = authPath;
    this.clientId = clientId;
    this.model = model;
    this.authTimeoutMs = authTimeoutMs;
    this.maxToolsPerRequest = maxToolsPerRequest;
    this.sendAndWaitTimeoutMs = sendAndWaitTimeoutMs;
    this.toolCallHandler = onToolCall;
    this.permissionHandler = onPermissionRequest;
    this.infiniteSessionsConfig = infiniteSessions;
    this.hooksConfig = hooks;
    this.userInputHandler = onUserInputRequest;
    this.defaultReasoningEffort = defaultReasoningEffort;
    this.providerConfig = provider;
    this.defaultWorkingDirectory = defaultWorkingDirectory;
    this.customAgentsConfig = customAgents ?? [];
    this.nativeMcpServersConfig = nativeMcpServers ?? {};
    this.skillDirectoriesConfig = skillDirectories ?? [];
  }

  setMaxToolsPerRequest(n: number): void {
    this.maxToolsPerRequest = Math.max(1, Math.min(128, Math.floor(n)));
  }

  getMaxToolsPerRequest(): number {
    return this.maxToolsPerRequest;
  }

  getReasoningEffort(): ReasoningEffort | undefined {
    return this.defaultReasoningEffort;
  }

  setReasoningEffort(effort: ReasoningEffort | undefined): void {
    this.defaultReasoningEffort = effort;
  }

  getProvider(): ProviderConfig | undefined {
    return this.providerConfig;
  }

  setProvider(provider: ProviderConfig | undefined): void {
    this.providerConfig = provider;
    // Provider change invalidates all cached sessions
    void this.clearAllSessions();
  }

  getWorkingDirectory(): string | undefined {
    return this.defaultWorkingDirectory;
  }

  setWorkingDirectory(dir: string | undefined): void {
    this.defaultWorkingDirectory = dir;
  }

  getCustomAgents(): CustomAgentDefinition[] {
    return [...this.customAgentsConfig];
  }

  setCustomAgents(agents: CustomAgentDefinition[]): void {
    this.customAgentsConfig = [...agents];
    // Agent changes invalidate all cached sessions
    void this.clearAllSessions();
  }

  getNativeMcpServers(): Record<string, NativeMcpServerDefinition> {
    return { ...this.nativeMcpServersConfig };
  }

  getSkillDirectories(): string[] {
    return [...this.skillDirectoriesConfig];
  }

  addSkillDirectory(dir: string): void {
    if (!this.skillDirectoriesConfig.includes(dir)) {
      this.skillDirectoriesConfig.push(dir);
      void this.clearAllSessions();
    }
  }

  setNativeMcpServers(servers: Record<string, NativeMcpServerDefinition>): void {
    this.nativeMcpServersConfig = { ...servers };
    // MCP server changes invalidate all cached sessions
    void this.clearAllSessions();
  }

  /** Set an async provider that returns memory context to inject into sessions. */
  setMemoryContextProvider(provider: () => Promise<string | null>): void {
    this.memoryContextProvider = provider;
  }

  async authenticate(): Promise<DeviceAuthInfo> {
    if (!this.clientId) {
      throw new Error("GITHUB_CLIENT_ID is required for device flow auth");
    }

    if (!this.client.startDeviceAuth || !this.client.waitForAuth) {
      throw new Error("The provided client does not support device flow authentication");
    }

    const authInfo = await this.client.startDeviceAuth({
      clientId: this.clientId,
      scopes: ["copilot", "read:user"]
    });

    this.pendingAuth = this.client.waitForAuth({ timeoutMs: this.authTimeoutMs })
      .then((result) => {
        const normalized = normalizeAuthResult(result);
        const state: AuthState = {
          token: normalized.token,
          refreshToken: normalized.refreshToken,
          expiresAt: normalized.expiresAt,
          obtainedAt: Date.now()
        };
        return writeAuthState(this.authPath, state).then(() => state);
      });

    return authInfo;
  }

  async waitForAuth(): Promise<void> {
    if (!this.pendingAuth) {
      throw new Error("Device flow authentication has not been started");
    }
    await this.pendingAuth;
  }

  async isAuthenticated(): Promise<boolean> {
    const state = await readAuthState(this.authPath);
    if (!state) {
      return false;
    }
    return !isExpired(state.expiresAt);
  }

  async *chat(message: string, options?: ChatOptions): AsyncGenerator<string> {
    await this.ensureStarted();

    if (this.startFailed) {
      throw new Error(
        "Copilot SDK is unavailable. The Copilot CLI may be outdated or missing. " +
        "Please update your GitHub Copilot extension to get CLI version 0.0.394 or later."
      );
    }

    const effectiveModel = options?.model ?? this.model;
    let toolList = options?.tools ?? this.toolRegistry?.listEnabledTools() ?? [];
    const perCallToolCallback = options?.onToolCall;

    // When availableTools is specified (skill scoping or explicit client filter),
    // pre-filter tool definitions to only those in the allow-list.
    // Merge ESSENTIAL_TOOLS so skill sessions always retain core capabilities
    // (file I/O, web search, shell, delegation) without the caller needing to
    // declare them explicitly.
    if (options?.availableTools && options.availableTools.length > 0) {
      const scopedSet = new Set(options.availableTools);
      for (const essential of ESSENTIAL_TOOLS) {
        scopedSet.add(essential);
      }
      toolList = toolList.filter((t) => scopedSet.has(t.name));
    }

    // Enforce maxToolsPerRequest with tiered priority:
    //   1. Essential tools (always included — ~6 tools)
    //   2. Contextual always-on tools (included when budget allows)
    //   3. Everything else (skill-specific, MCP, etc.)
    if (toolList.length > this.maxToolsPerRequest) {
      const essential = toolList.filter((t) => ESSENTIAL_TOOLS.has(t.name));
      const contextual = toolList.filter(
        (t) => CONTEXTUAL_TOOLS.has(t.name) && !ESSENTIAL_TOOLS.has(t.name),
      );
      const other = toolList.filter((t) => !ALWAYS_ON_TOOLS.has(t.name));

      let budget = this.maxToolsPerRequest;
      const result = [...essential];
      budget -= essential.length;

      const contextualSlice = contextual.slice(0, Math.max(0, budget));
      result.push(...contextualSlice);
      budget -= contextualSlice.length;

      if (budget > 0) {
        result.push(...other.slice(0, budget));
      }

      toolList = result;
    }

    const wrappedTools = toolList.map((tool) =>
      defineTool(tool.name, {
        description: tool.description,
        parameters: tool.inputSchema,
        handler: async (args) => {
          await this.onToolCall(tool.name, args);
          if (perCallToolCallback) {
            perCallToolCallback(tool.name, args);
          }
          try {
            const result = await tool.handler(args as Record<string, unknown>);
            if (result.isError) {
              return `[Tool Error] ${result.text}`;
            }
            return result.text;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `[Tool Error] ${msg}`;
          }
        }
      })
    );

    // Inject memory context into system message when available
    let effectiveSystemMessage = options?.systemMessage;
    if (this.memoryContextProvider) {
      try {
        const memoryContext = await this.memoryContextProvider();
        if (memoryContext) {
          const existing = effectiveSystemMessage?.content ?? "";
          const combined = existing
            ? `${existing}\n\n${memoryContext}`
            : memoryContext;
          effectiveSystemMessage = { mode: effectiveSystemMessage?.mode ?? "append", content: combined };
        }
      } catch (err) {
        // Memory context is best-effort — don't block chat on failures
        console.warn("Failed to get memory context:", err);
      }
    }

    const session = await this.getOrCreateSession(
      options?.conversationId,
      effectiveModel,
      wrappedTools,
      {
        systemMessage: effectiveSystemMessage,
        availableTools: options?.availableTools,
        excludedTools: options?.excludedTools,
        onUserInputRequest: options?.onUserInputRequest,
        workingDirectory: options?.workingDirectory,
        reasoningEffort: options?.reasoningEffort,
        customAgents: options?.customAgents,
        mcpServers: options?.mcpServers,
        autoApproveTools: options?.autoApproveTools,
        disabledSkills: options?.disabledSkills,
      }
    );

    const queue = new AsyncQueue<string>();
    let sendError: unknown;

    // Register event handlers — capture unsubscribe fns to clean up after this call
    const unsubDelta = session.on("assistant.message_delta", (event) => {
      const chunk = event.data?.deltaContent ?? "";
      if (chunk) {
        queue.push(chunk);
      }
    });

    const unsubIdle = session.on("session.idle", () => {
      queue.end();
    });

    try {
      void this.sendWithRetries(session, message, options?.attachments).catch((error) => {
        sendError = error;
        queue.end();
      });

      yield* this.streamQueue(queue, () => {
        if (sendError) {
          throw sendError;
        }
      });
    } finally {
      // Always unsubscribe per-call handlers to prevent accumulation on reused sessions
      unsubDelta();
      unsubIdle();
    }
  }

  async destroySession(conversationId: string): Promise<void> {
    const session = this.sessionCache.get(conversationId);
    if (session) {
      this.sessionCache.delete(conversationId);
      this.sessionConfigSignatures.delete(conversationId);
      await session.destroy();
    }
  }

  hasSession(conversationId: string): boolean {
    return this.sessionCache.has(conversationId);
  }

  async clearAllSessions(): Promise<void> {
    const destroyPromises: Promise<void>[] = [];
    for (const session of this.sessionCache.values()) {
      destroyPromises.push(session.destroy());
    }
    this.sessionCache.clear();
    this.sessionConfigSignatures.clear();
    if (this.lifecycleUnsubscribe) {
      this.lifecycleUnsubscribe();
      this.lifecycleUnsubscribe = undefined;
    }
    await Promise.allSettled(destroyPromises);
  }

  async onToolCall(tool: string, args: unknown): Promise<void> {
    if (this.toolCallHandler) {
      await this.toolCallHandler(tool, args);
    }
  }

  modelSupportsReasoning(modelId: string): boolean {
    const cached = this.modelCapabilitiesCache.get(modelId);
    if (cached !== undefined) {
      return cached.supportsReasoning;
    }
    // If we haven't fetched model info yet, fall back to a well-known list of reasoning models.
    // This prevents errors when the model cache hasn't been populated.
    const lower = modelId.toLowerCase();
    return lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4");
  }

  async listModels(): Promise<CopilotModel[]> {
    await this.ensureStarted();
    if (this.startFailed) {
      throw new Error("Copilot SDK failed to start — cannot list models");
    }
    if (!this.client.listModels) {
      return [{ id: this.model }];
    }
    const models = await this.client.listModels();
    // Cache model capabilities for reasoning-effort gating
    for (const model of models) {
      const supportsReasoning = model.capabilities?.supports?.reasoningEffort === true
        || (model.supportedReasoningEfforts != null && model.supportedReasoningEfforts.length > 0);
      this.modelCapabilitiesCache.set(model.id, { supportsReasoning });
    }
    return models;
  }

  private async ensureStarted() {
    if (this.started || this.startFailed) {
      return;
    }
    if (!this.startPromise) {
      this.startPromise = this.doStart();
    }
    await this.startPromise;
  }

  private async doStart() {
    if (!this.client.start) {
      this.started = true;
      return;
    }
    try {
      await Promise.race([
        this.client.start(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Copilot CLI start timed out after 10s")), 10_000)
        )
      ]);
      this.started = true;

      // Subscribe to client-level lifecycle events (Phase 4)
      if (this.client.on) {
        this.lifecycleUnsubscribe = this.client.on((event: SdkSessionLifecycleEvent) => {
          const MAX_LIFECYCLE_EVENTS = 200;
          if (this.analytics.lifecycleEvents.length >= MAX_LIFECYCLE_EVENTS) {
            this.analytics.lifecycleEvents.splice(0, this.analytics.lifecycleEvents.length - MAX_LIFECYCLE_EVENTS + 1);
          }
          this.analytics.lifecycleEvents.push(event);
          this.analytics.lastUpdated = new Date().toISOString();
          this.emit("session:lifecycle", event);
        });
      }
    } catch {
      this.startFailed = true;
    }
  }

  private async sendWithRetries(session: CopilotSessionLike, prompt: string, attachments?: SdkAttachment[]) {
    const maxRetries = 3;
    let attempt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const input: { prompt: string; attachments?: SdkAttachment[] } = { prompt };
        if (attachments && attachments.length > 0) {
          input.attachments = attachments;
        }
        await session.sendAndWait(input, this.sendAndWaitTimeoutMs);
        return;
      } catch (error) {
        if (isUnauthorizedError(error)) {
          await this.clearAuth();
          throw error;
        }

        attempt += 1;
        if (attempt > maxRetries) {
          throw error;
        }

        if (isRateLimitError(error)) {
          const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 60_000);
          await sleep(delay);
          continue;
        }

        if (isTimeoutError(error)) {
          await sleep(5000);
          continue;
        }

        throw error;
      }
    }
  }

  private async clearAuth() {
    try {
      await fs.unlink(this.authPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  /**
   * Build the session configuration shared between create and resume paths.
   */
  /**
   * Merge two sets of custom agent definitions. Per-call agents override
   * defaults when they share the same `name`; new agents are appended.
   */
  private mergeCustomAgents(
    defaults: CustomAgentDefinition[],
    overrides?: CustomAgentDefinition[]
  ): CustomAgentDefinition[] {
    if (!overrides?.length) return defaults;
    if (!defaults.length) return overrides;

    const merged = new Map<string, CustomAgentDefinition>();
    for (const agent of defaults) merged.set(agent.name, agent);
    for (const agent of overrides) merged.set(agent.name, agent);
    return [...merged.values()];
  }

  private buildSessionConfig(
    model: string,
    tools: unknown[],
    sessionId?: string,
    extra?: {
      systemMessage?: SystemMessageConfig;
      availableTools?: string[];
      excludedTools?: string[];
      onUserInputRequest?: UserInputHandler;
      workingDirectory?: string;
      reasoningEffort?: ReasoningEffort;
      customAgents?: CustomAgentDefinition[];
      mcpServers?: Record<string, NativeMcpServerDefinition>;
      autoApproveTools?: string[];
      disabledSkills?: string[];
    }
  ): SessionCreateConfig {
    const effectiveHooks = this.hooksConfig;
    const closureAutoApproveTools = extra?.autoApproveTools;
    const effectiveUserInput = extra?.onUserInputRequest ?? this.userInputHandler;
    const effectiveWorkingDirectory = extra?.workingDirectory ?? this.defaultWorkingDirectory;
    // Only include reasoning effort when the model actually supports it.
    // Non-reasoning models (gpt-4.1, claude-sonnet-4, etc.) reject this parameter.
    const rawReasoningEffort = extra?.reasoningEffort ?? this.defaultReasoningEffort;
    const effectiveReasoningEffort = rawReasoningEffort && this.modelSupportsReasoning(model)
      ? rawReasoningEffort
      : undefined;

    // Merge per-call agent overrides with defaults (per-call wins on name collision)
    const mergedAgents = this.mergeCustomAgents(
      this.customAgentsConfig,
      extra?.customAgents
    );
    // Merge per-call MCP server overrides with defaults (per-call wins on key collision)
    const mergedMcpServers = {
      ...this.nativeMcpServersConfig,
      ...(extra?.mcpServers ?? {}),
    };

    // Strip disabledTools from definitions before passing to SDK.
    // The SDK doesn't understand disabledTools — it's our own field.
    // When disabledTools is set but no explicit tools allowlist exists,
    // we can't compute the effective allowlist without knowing all available
    // tools (which requires a live connection). Instead, we rely on the
    // onPreToolUse hook to reject disabled tools at call time.
    const sdkMcpServers: Record<string, NativeMcpServerDefinition> = {};
    for (const [key, def] of Object.entries(mergedMcpServers)) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { disabledTools: _dt, ...sdkDef } = def;
      sdkMcpServers[key] = sdkDef as NativeMcpServerDefinition;
    }

    return {
      ...(sessionId ? { sessionId } : {}),
      model,
      streaming: true,
      tools,
      ...(this.infiniteSessionsConfig ? { infiniteSessions: this.infiniteSessionsConfig } : {}),
      ...(extra?.systemMessage ? { systemMessage: extra.systemMessage } : {}),
      ...(effectiveWorkingDirectory ? { workingDirectory: effectiveWorkingDirectory } : {}),
      ...(effectiveReasoningEffort ? { reasoningEffort: effectiveReasoningEffort } : {}),
      ...(this.providerConfig ? { provider: this.providerConfig } : {}),
      ...(mergedAgents.length > 0 ? { customAgents: mergedAgents } : {}),
      ...(Object.keys(sdkMcpServers).length > 0 ? { mcpServers: sdkMcpServers } : {}),
      ...(this.skillDirectoriesConfig.length > 0 ? { skillDirectories: this.skillDirectoriesConfig } : {}),
      ...(extra?.disabledSkills?.length ? { disabledSkills: extra.disabledSkills } : {}),
      ...(effectiveHooks ? {
        hooks: {
          ...effectiveHooks,
          onPreToolUse: effectiveHooks.onPreToolUse
            ? async (input: Omit<HookPreToolUseInput, "context">) => {
                return effectiveHooks.onPreToolUse!({
                  ...input,
                  context: {
                    sessionId: sessionId ?? "ephemeral",
                    // Closure-captured auto-approve list survives JSON-RPC boundaries
                    // (AsyncLocalStorage context is lost across vscode-jsonrpc dispatches).
                    autoApproveTools: closureAutoApproveTools,
                  },
                });
              }
            : undefined,
        }
      } : {}),
      ...(extra?.availableTools ? { availableTools: extra.availableTools } : {}),
      ...(extra?.excludedTools ? { excludedTools: extra.excludedTools } : {}),
      ...(effectiveUserInput
        ? {
            onUserInputRequest: async (
              request: { question: string; choices?: string[]; allowFreeform?: boolean },
              context: { sessionId: string }
            ) => effectiveUserInput(request, context.sessionId),
          }
        : {}),
      onPermissionRequest: async (request) => {
        if (this.permissionHandler) {
          return this.permissionHandler(request);
        }
        return { kind: "approved" };
      }
    };
  }

  /**
   * Retrieve a cached session by conversationId, or create/resume one.
   * When no conversationId is provided, an ephemeral session is created (not cached).
   */
  private async getOrCreateSession(
    conversationId: string | undefined,
    model: string,
    tools: unknown[],
    extra?: {
      systemMessage?: SystemMessageConfig;
      availableTools?: string[];
      excludedTools?: string[];
      onUserInputRequest?: UserInputHandler;
      workingDirectory?: string;
      reasoningEffort?: ReasoningEffort;
      customAgents?: CustomAgentDefinition[];
      mcpServers?: Record<string, NativeMcpServerDefinition>;
      autoApproveTools?: string[];
      disabledSkills?: string[];
    }
  ): Promise<CopilotSessionLike> {
    const requestedSignature = this.computeSessionConfigSignature(model, tools, extra);

    if (!conversationId) {
      // No conversationId — ephemeral session (backward compatible)
      return this.client.createSession(this.buildSessionConfig(model, tools, undefined, extra));
    }

    const cached = this.sessionCache.get(conversationId);
    if (cached) {
      const existingSignature = this.sessionConfigSignatures.get(conversationId);
      if (existingSignature === requestedSignature) {
        return cached;
      }

      // Session configuration changed (for example a tool was enabled/disabled).
      // Recreate the cached session so the latest tool list is applied immediately.
      this.sessionCache.delete(conversationId);
      this.sessionConfigSignatures.delete(conversationId);
      await cached.destroy();
    }

    const pendingPromise = this.sessionCreationPromises.get(conversationId);
    if (pendingPromise) {
      return pendingPromise;
    }

    const createPromise = (async (): Promise<CopilotSessionLike> => {
      try {
        let session: CopilotSessionLike;
        // Try to resume a persisted session first, then fall back to create
        if (this.client.resumeSession) {
          try {
            session = await this.client.resumeSession(
              conversationId,
              this.buildSessionConfig(model, tools, undefined, extra)
            );
            this.analytics.sessionsResumed++;
          } catch (resumeError) {
            // It's useful to log why resume failed, even if we fall back gracefully.
            // console.warn(`Failed to resume session ${conversationId}, creating a new one. Error:`, resumeError);
            session = await this.client.createSession(
              this.buildSessionConfig(model, tools, conversationId, extra)
            );
            this.analytics.sessionsCreated++;
          }
        } else {
          session = await this.client.createSession(
            this.buildSessionConfig(model, tools, conversationId, extra)
          );
          this.analytics.sessionsCreated++;
        }
        this.analytics.lastUpdated = new Date().toISOString();
        this.sessionCache.set(conversationId, session);
        this.sessionConfigSignatures.set(conversationId, requestedSignature);
        this.wireSessionEvents(session, conversationId);
        return session;
      } finally {
        // Once the session is created and cached (or failed), remove the promise from the map.
        this.sessionCreationPromises.delete(conversationId);
      }
    })();

    this.sessionCreationPromises.set(conversationId, createPromise);
    return createPromise;
  }

  private computeSessionConfigSignature(
    model: string,
    tools: unknown[],
    extra?: {
      systemMessage?: SystemMessageConfig;
      availableTools?: string[];
      excludedTools?: string[];
      onUserInputRequest?: UserInputHandler;
      workingDirectory?: string;
      reasoningEffort?: ReasoningEffort;
      customAgents?: CustomAgentDefinition[];
      mcpServers?: Record<string, NativeMcpServerDefinition>;
      autoApproveTools?: string[];
    }
  ): string {
    const toolNames = (tools as Array<{ name?: string }>)
      .map((t) => t.name ?? "")
      .filter(Boolean)
      .sort();

    return JSON.stringify({
      model,
      toolNames,
      availableTools: [...(extra?.availableTools ?? [])].sort(),
      excludedTools: [...(extra?.excludedTools ?? [])].sort(),
      autoApproveTools: [...(extra?.autoApproveTools ?? [])].sort(),
      workingDirectory: extra?.workingDirectory,
      reasoningEffort: extra?.reasoningEffort,
      systemMode: extra?.systemMessage?.mode,
      systemContent: extra?.systemMessage?.content,
    });
  }

  private async *streamQueue(queue: AsyncQueue<string>, onEnd: () => void): AsyncGenerator<string> {
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const next = await queue.next();
        if (next.done) {
          break;
        }
        yield next.value;
      }
    } finally {
      onEnd();
    }
  }

  /**
   * Wire SDK session events for token tracking and context compaction.
   * Called once per session creation — event handlers are long-lived
   * (unlike the per-call delta/idle handlers which are unsubscribed).
   */
  private wireSessionEvents(session: CopilotSessionLike, sessionId: string): void {
    // Track token usage from the SDK's assistant.usage event
    session.on("assistant.usage", (event: { data?: { inputTokens?: number; outputTokens?: number } }) => {
      const inputTokens = event.data?.inputTokens ?? 0;
      const outputTokens = event.data?.outputTokens ?? 0;
      const usageEvent = this.tokenTracker.record(sessionId, inputTokens, outputTokens);
      this.emit("token:usage", usageEvent);
    });

    // Track context compaction lifecycle events (infinite sessions)
    session.on("compaction_start", () => {
      this.analytics.compactionCount++;
      this.analytics.lastUpdated = new Date().toISOString();
      const compactionEvent: CompactionEvent = { sessionId, status: "started" };
      this.emit("context:compaction", compactionEvent);
    });

    session.on("compaction_complete", () => {
      const compactionEvent: CompactionEvent = { sessionId, status: "completed" };
      this.emit("context:compaction", compactionEvent);
    });

    // ── Subagent lifecycle events (SDK-native delegation) ──
    session.on("subagent.started", (event: { data?: { agentName?: string; parentSessionId?: string } }) => {
      const payload: SubagentStartedEvent = {
        sessionId,
        agentName: event.data?.agentName ?? "unknown",
        parentSessionId: event.data?.parentSessionId,
      };
      this.emit("subagent:started", payload);
    });

    session.on("subagent.completed", (event: { data?: { agentName?: string; summary?: string } }) => {
      const payload: SubagentCompletedEvent = {
        sessionId,
        agentName: event.data?.agentName ?? "unknown",
        summary: event.data?.summary,
      };
      this.emit("subagent:completed", payload);
    });

    session.on("subagent.failed", (event: { data?: { agentName?: string; error?: string } }) => {
      const payload: SubagentFailedEvent = {
        sessionId,
        agentName: event.data?.agentName ?? "unknown",
        error: event.data?.error ?? "Unknown error",
      };
      this.emit("subagent:failed", payload);
    });

    session.on("subagent.selected", (event: { data?: { agentName?: string } }) => {
      const payload: SubagentSelectedEvent = {
        sessionId,
        agentName: event.data?.agentName ?? "unknown",
      };
      this.emit("subagent:selected", payload);
    });

    session.on("subagent.deselected", (event: { data?: { agentName?: string } }) => {
      const payload: SubagentDeselectedEvent = {
        sessionId,
        agentName: event.data?.agentName ?? "unknown",
      };
      this.emit("subagent:deselected", payload);
    });
  }

  /** Get accumulated token usage for a session (non-destructive). */
  getSessionUsage(sessionId: string): TokenUsage | null {
    return this.tokenTracker.getUsage(sessionId);
  }

  /** Get and remove accumulated usage for a session (used on task completion). */
  clearSessionUsage(sessionId: string): TokenUsage | null {
    return this.tokenTracker.clearUsage(sessionId);
  }

  // ── Phase 1: SDK Session Listing ──

  async listSdkSessions(filter?: SdkSessionListFilter): Promise<SdkSessionMetadata[]> {
    await this.ensureStarted();
    if (this.startFailed || !this.client.listSessions) {
      return [];
    }
    const raw = await this.client.listSessions(filter);
    return raw.map((s) => ({
      sessionId: String(s.sessionId ?? ""),
      startTime: s.startTime instanceof Date ? s.startTime.toISOString() : String(s.startTime ?? ""),
      modifiedTime: s.modifiedTime instanceof Date ? s.modifiedTime.toISOString() : String(s.modifiedTime ?? ""),
      summary: s.summary ?? undefined,
      isRemote: Boolean(s.isRemote),
      context: s.context ?? undefined,
    }));
  }

  async deleteSdkSession(sessionId: string): Promise<void> {
    await this.ensureStarted();
    // Also remove from local cache if present
    const cached = this.sessionCache.get(sessionId);
    if (cached) {
      this.sessionCache.delete(sessionId);
      this.sessionConfigSignatures.delete(sessionId);
    }
    if (this.client.deleteSession) {
      await this.client.deleteSession(sessionId);
    } else if (cached) {
      await cached.destroy();
    }
    this.analytics.sessionsDestroyed++;
    this.analytics.lastUpdated = new Date().toISOString();
  }

  // ── Phase 3: Conversation Replay ──

  async getSdkSessionMessages(sessionId: string): Promise<SdkSessionEvent[]> {
    await this.ensureStarted();
    if (this.startFailed) return [];

    // Try cached session first
    let session = this.sessionCache.get(sessionId);
    let needsCleanup = false;

    if (!session) {
      // Resume the session temporarily to read messages
      if (!this.client.resumeSession) return [];
      try {
        session = await this.client.resumeSession(sessionId, {});
        needsCleanup = true;
      } catch {
        return [];
      }
    }

    if (!session.getMessages) return [];

    try {
      const events = await session.getMessages();
      return events.map((e) => ({
        id: String((e as Record<string, unknown>).id ?? ""),
        timestamp: String((e as Record<string, unknown>).timestamp ?? ""),
        parentId: ((e as Record<string, unknown>).parentId as string | null) ?? null,
        ephemeral: Boolean((e as Record<string, unknown>).ephemeral),
        type: String((e as Record<string, unknown>).type ?? "unknown"),
        data: ((e as Record<string, unknown>).data as Record<string, unknown>) ?? {},
      }));
    } finally {
      if (needsCleanup && session) {
        await session.destroy().catch(() => {});
      }
    }
  }

  // ── Phase 4: Session Analytics ──

  getSessionAnalytics(): SessionAnalytics {
    return { ...this.analytics, lifecycleEvents: [...this.analytics.lifecycleEvents] };
  }

  resetSessionAnalytics(): void {
    this.analytics = {
      sessionsCreated: 0,
      sessionsResumed: 0,
      sessionsDestroyed: 0,
      compactionCount: 0,
      lifecycleEvents: [],
      lastUpdated: new Date().toISOString(),
    };
  }
}
