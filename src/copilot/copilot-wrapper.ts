import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import type { ToolDefinition, ToolRegistry } from "../mcp/tool-registry.js";
import { ALWAYS_ON_TOOLS } from "../mcp/constants.js";

export type DeviceAuthInfo = {
  verificationUri: string;
  userCode: string;
};

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
  onUserInputRequest?: (
    request: { question: string; choices?: string[]; allowFreeform?: boolean },
    context: { sessionId: string }
  ) => Promise<{ answer: string; wasFreeform?: boolean }>;
};

type CopilotSessionLike = {
  readonly sessionId: string;
  on: (event: string, handler: (event: { data?: { deltaContent?: string } }) => void) => (() => void);
  sendAndWait: (input: { prompt: string }, timeout?: number) => Promise<unknown>;
  destroy: () => Promise<void>;
};

export type CopilotModel = {
  id: string;
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
};

export type SystemMessageConfig = {
  mode: "append" | "replace";
  content: string;
};

export type UserInputRequest = {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
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

export class CopilotWrapperService implements CopilotWrapper {
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
  private sessionCache = new Map<string, CopilotSessionLike>();
  private sessionCreationPromises = new Map<string, Promise<CopilotSessionLike>>();

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
    onUserInputRequest
  }: CopilotWrapperOptions = {}) {
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
  }

  setMaxToolsPerRequest(n: number): void {
    this.maxToolsPerRequest = Math.max(1, Math.min(128, Math.floor(n)));
  }

  getMaxToolsPerRequest(): number {
    return this.maxToolsPerRequest;
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

    // Enforce maxToolsPerRequest: if we exceed the cap, keep always-on core tools
    // and fill the remaining slots with the rest.
    if (toolList.length > this.maxToolsPerRequest) {
      const coreTools = toolList.filter((t) => ALWAYS_ON_TOOLS.has(t.name));
      const otherTools = toolList.filter((t) => !ALWAYS_ON_TOOLS.has(t.name));
      const remainingSlots = Math.max(0, this.maxToolsPerRequest - coreTools.length);
      toolList = [...coreTools, ...otherTools.slice(0, remainingSlots)];
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
          const result = await tool.handler(args as Record<string, unknown>);
          if (result.isError) {
            throw new Error(result.text);
          }
          return result.text;
        }
      })
    );

    const session = await this.getOrCreateSession(
      options?.conversationId,
      effectiveModel,
      wrappedTools,
      {
        systemMessage: options?.systemMessage,
        availableTools: options?.availableTools,
        excludedTools: options?.excludedTools,
        onUserInputRequest: options?.onUserInputRequest,
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
      void this.sendWithRetries(session, message).catch((error) => {
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
    await Promise.allSettled(destroyPromises);
  }

  async onToolCall(tool: string, args: unknown): Promise<void> {
    if (this.toolCallHandler) {
      await this.toolCallHandler(tool, args);
    }
  }

  async listModels(): Promise<CopilotModel[]> {
    await this.ensureStarted();
    if (this.startFailed) {
      throw new Error("Copilot SDK failed to start — cannot list models");
    }
    if (!this.client.listModels) {
      return [{ id: this.model }];
    }
    return this.client.listModels();
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
    } catch {
      this.startFailed = true;
    }
  }

  private async sendWithRetries(session: CopilotSessionLike, prompt: string) {
    const maxRetries = 3;
    let attempt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await session.sendAndWait({ prompt }, this.sendAndWaitTimeoutMs);
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
  private buildSessionConfig(
    model: string,
    tools: unknown[],
    sessionId?: string,
    extra?: {
      systemMessage?: SystemMessageConfig;
      availableTools?: string[];
      excludedTools?: string[];
      onUserInputRequest?: UserInputHandler;
    }
  ): SessionCreateConfig {
    const effectiveHooks = this.hooksConfig;
    const effectiveUserInput = extra?.onUserInputRequest ?? this.userInputHandler;

    return {
      ...(sessionId ? { sessionId } : {}),
      model,
      streaming: true,
      tools,
      ...(this.infiniteSessionsConfig ? { infiniteSessions: this.infiniteSessionsConfig } : {}),
      ...(extra?.systemMessage ? { systemMessage: extra.systemMessage } : {}),
      ...(effectiveHooks ? {
        hooks: {
          ...effectiveHooks,
          onPreToolUse: effectiveHooks.onPreToolUse
            ? async (input: Omit<HookPreToolUseInput, "context">) => {
                return effectiveHooks.onPreToolUse!({
                  ...input,
                  context: { sessionId: sessionId ?? "ephemeral" },
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
    }
  ): Promise<CopilotSessionLike> {
    if (!conversationId) {
      // No conversationId — ephemeral session (backward compatible)
      return this.client.createSession(this.buildSessionConfig(model, tools, undefined, extra));
    }

    const cached = this.sessionCache.get(conversationId);
    if (cached) {
      return cached;
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
          } catch (resumeError) {
            // It's useful to log why resume failed, even if we fall back gracefully.
            // console.warn(`Failed to resume session ${conversationId}, creating a new one. Error:`, resumeError);
            session = await this.client.createSession(
              this.buildSessionConfig(model, tools, conversationId, extra)
            );
          }
        } else {
          session = await this.client.createSession(
            this.buildSessionConfig(model, tools, conversationId, extra)
          );
        }
        this.sessionCache.set(conversationId, session);
        return session;
      } finally {
        // Once the session is created and cached (or failed), remove the promise from the map.
        this.sessionCreationPromises.delete(conversationId);
      }
    })();

    this.sessionCreationPromises.set(conversationId, createPromise);
    return createPromise;
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
}
