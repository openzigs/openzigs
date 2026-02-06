import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import type { ToolDefinition, ToolRegistry } from "../mcp/tool-registry.js";

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

type CopilotSessionLike = {
  on: (event: string, handler: (event: { data?: { deltaContent?: string } }) => void) => void;
  sendAndWait: (input: { prompt: string }) => Promise<unknown>;
};

type CopilotClientLike = {
  start?: () => Promise<void>;
  createSession: (config: {
    model?: string;
    streaming?: boolean;
    tools?: unknown[];
    onPermissionRequest?: (request: { kind: string; toolName?: string; toolArgs?: unknown }) => Promise<{
      kind: "approved" | "denied-by-rules" | "denied-by-user";
    }>;
  }) => Promise<CopilotSessionLike>;
  stop?: () => Promise<Error[]>;
  startDeviceAuth?: (input: { clientId: string; scopes: string[] }) => Promise<DeviceAuthInfo>;
  waitForAuth?: (input: { timeoutMs: number }) => Promise<unknown>;
};

export interface CopilotWrapper {
  authenticate(): Promise<DeviceAuthInfo>;
  waitForAuth(): Promise<void>;
  isAuthenticated(): Promise<boolean>;
  chat(message: string, tools?: ToolDefinition[]): AsyncGenerator<string>;
  onToolCall(tool: string, args: unknown): Promise<void>;
}

export type CopilotWrapperOptions = {
  client?: CopilotClientLike;
  toolRegistry?: ToolRegistry;
  authPath?: string;
  clientId?: string;
  model?: string;
  authTimeoutMs?: number;
  onToolCall?: (tool: string, args: unknown) => Promise<void>;
  onPermissionRequest?: (request: { kind: string; toolName?: string; toolArgs?: unknown }) => Promise<{
    kind: "approved" | "denied-by-rules" | "denied-by-user";
  }>;
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
  await fs.mkdir(path.dirname(authPath), { recursive: true });
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
  private pendingAuth?: Promise<AuthState>;
  private toolCallHandler?: (tool: string, args: unknown) => Promise<void>;
  private permissionHandler?: (request: { kind: string; toolName?: string; toolArgs?: unknown }) => Promise<{
    kind: "approved" | "denied-by-rules" | "denied-by-user";
  }>;

  constructor({
    client,
    toolRegistry,
    authPath = defaultAuthPath(),
    clientId = process.env.GITHUB_CLIENT_ID ?? "",
    model = "gpt-4.1",
    authTimeoutMs = 5 * 60 * 1000,
    onToolCall,
    onPermissionRequest
  }: CopilotWrapperOptions = {}) {
    this.client = client ?? new CopilotClient();
    this.toolRegistry = toolRegistry;
    this.authPath = authPath;
    this.clientId = clientId;
    this.model = model;
    this.authTimeoutMs = authTimeoutMs;
    this.toolCallHandler = onToolCall;
    this.permissionHandler = onPermissionRequest;
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

  async *chat(message: string, tools?: ToolDefinition[]): AsyncGenerator<string> {
    await this.ensureStarted();

    const toolList = tools ?? this.toolRegistry?.listEnabledTools() ?? [];
    const wrappedTools = toolList.map((tool) =>
      defineTool(tool.name, {
        description: tool.description,
        parameters: tool.inputSchema,
        handler: async (args) => {
          await this.onToolCall(tool.name, args);
          const result = await tool.handler(args as Record<string, unknown>);
          if (result.isError) {
            throw new Error(result.text);
          }
          return result.text;
        }
      })
    );

    const session = await this.client.createSession({
      model: this.model,
      streaming: true,
      tools: wrappedTools,
      onPermissionRequest: async (request) => {
        if (this.permissionHandler) {
          return this.permissionHandler(request);
        }
        if (request.toolName) {
          await this.onToolCall(request.toolName, request.toolArgs);
        }
        return { kind: "approved" };
      }
    });

    const queue = new AsyncQueue<string>();
    let sendError: unknown;

    session.on("assistant.message_delta", (event) => {
      const chunk = event.data?.deltaContent ?? "";
      if (chunk) {
        queue.push(chunk);
      }
    });

    session.on("session.idle", () => {
      queue.end();
    });

    void this.sendWithRetries(session, message).catch((error) => {
      sendError = error;
      queue.end();
    });

    yield* this.streamQueue(queue, () => {
      if (sendError) {
        throw sendError;
      }
    });
  }

  async onToolCall(tool: string, args: unknown): Promise<void> {
    if (this.toolCallHandler) {
      await this.toolCallHandler(tool, args);
    }
  }

  private async ensureStarted() {
    if (this.started) {
      return;
    }
    if (this.client.start) {
      await this.client.start();
    }
    this.started = true;
  }

  private async sendWithRetries(session: CopilotSessionLike, prompt: string) {
    const maxRetries = 3;
    let attempt = 0;

    while (true) {
      try {
        await session.sendAndWait({ prompt });
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
          const delay = Math.min(1000 * Math.pow(2, attempt), 60_000);
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

  private async *streamQueue(queue: AsyncQueue<string>, onEnd: () => void): AsyncGenerator<string> {
    try {
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
