import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { logger } from "../logging/logger.js";

// ── Local MCP Server Definition ──────────────────────────────────────────────

export type LocalMcpServerDefinition = {
  /** Unique key, e.g. "word", "calendar" */
  name: string;
  /** Human-readable label */
  label: string;
  /** Command to spawn (e.g. "uvx", "npx", "python3") */
  command: string;
  /** Arguments to pass to the command */
  args: string[];
  /** Environment variables injected into the subprocess (merged with process.env) */
  env?: Record<string, string>;
  /** Env var names required in process.env for this server to start */
  requiredEnvVars?: string[];
  /** Runtime: "python" | "node" | "other" */
  runtime: "python" | "node" | "other";
  /** Category for tool grouping */
  category: string;
  /** Whether this server needs credentials to run */
  requiresCredentials: boolean;
};

export type LocalServerStatus = {
  name: string;
  label: string;
  running: boolean;
  runtime: string;
  toolCount: number;
  error?: string;
  pid?: number;
};

type LocalServerInstance = {
  definition: LocalMcpServerDefinition;
  client: Client;
  transport: StdioClientTransport;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
};

type LocalServerManagerEvents = {
  "server:started": (status: LocalServerStatus) => void;
  "server:stopped": (status: LocalServerStatus) => void;
  "server:error": (name: string, error: Error) => void;
};

// ── Default local server definitions ─────────────────────────────────────────

export const DEFAULT_LOCAL_SERVER_DEFINITIONS: LocalMcpServerDefinition[] = [
  {
    name: "word",
    label: "Word / Office",
    command: "uvx",
    args: ["--from", "office-word-mcp-server", "word_mcp_server"],
    runtime: "python",
    category: "documents",
    requiresCredentials: false,
  },
  {
    name: "markitdown",
    label: "MarkItDown",
    command: "uvx",
    args: ["--from", "markitdown-mcp", "markitdown-mcp"],
    runtime: "python",
    category: "documents",
    requiresCredentials: false,
  },
  {
    name: "gmail",
    label: "Gmail",
    command: "npx",
    args: ["-y", "@anthropic/gmail-mcp-server"],
    requiredEnvVars: ["GMAIL_OAUTH_PATH", "GMAIL_CREDENTIALS_PATH"],
    env: {
      GMAIL_OAUTH_PATH: process.env.GMAIL_OAUTH_PATH ?? "",
      GMAIL_CREDENTIALS_PATH: process.env.GMAIL_CREDENTIALS_PATH ?? "",
    },
    runtime: "node",
    category: "communication",
    requiresCredentials: true,
  },
  {
    name: "database",
    label: "Database (JDBC)",
    command: "jbang",
    args: ["jdbc@quarkiverse/quarkus-mcp-servers"],
    requiredEnvVars: ["JDBC_URL"],
    env: {
      JDBC_URL: process.env.JDBC_URL ?? "",
    },
    runtime: "other",
    category: "data",
    requiresCredentials: true,
  },
  {
    name: "github",
    label: "GitHub",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    requiredEnvVars: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    runtime: "node",
    category: "development",
    requiresCredentials: true,
  },
  {
    name: "calendar",
    label: "Google Calendar",
    command: "npx",
    args: ["-y", "@cocal/google-calendar-mcp"],
    requiredEnvVars: ["GOOGLE_OAUTH_CREDENTIALS"],
    runtime: "node",
    category: "documents",
    requiresCredentials: true,
  },
  {
    name: "instagram",
    label: "Instagram",
    command: path.join(process.cwd(), "external/ig-mcp/.venv/bin/python"),
    args: [path.join(process.cwd(), "external/ig-mcp/src/instagram_mcp_server.py")],
    requiredEnvVars: [
      "INSTAGRAM_ACCESS_TOKEN",
      "FACEBOOK_APP_ID",
      "FACEBOOK_APP_SECRET",
      "INSTAGRAM_BUSINESS_ACCOUNT_ID"
    ],
    runtime: "python",
    category: "social",
    requiresCredentials: true,
  },
  {
    name: "facebook",
    label: "Facebook / Meta Pages",
    command: path.join(process.cwd(), "external/fb-mcp/.venv/bin/python"),
    args: [path.join(process.cwd(), "external/fb-mcp/src/facebook_mcp_server.py")],
    requiredEnvVars: ["FACEBOOK_PAGE_TOKEN"],
    runtime: "python",
    category: "social",
    requiresCredentials: true,
  },
  {
    name: "twitter",
    label: "Twitter / X",
    command: path.join(process.cwd(), "external/twitter-mcp/.venv/bin/python"),
    args: [path.join(process.cwd(), "external/twitter-mcp/src/twitter_mcp_server.py")],
    requiredEnvVars: ["TWITTER_BEARER_TOKEN"],
    runtime: "python",
    category: "social",
    requiresCredentials: true,
  },
  {
    name: "youtube",
    label: "YouTube",
    command: path.join(process.cwd(), "external/youtube-mcp/.venv/bin/python"),
    args: [path.join(process.cwd(), "external/youtube-mcp/src/youtube_mcp_server.py")],
    requiredEnvVars: ["YOUTUBE_API_KEY"],
    runtime: "python",
    category: "social",
    requiresCredentials: true,
  },
  {
    name: "linkedin",
    label: "LinkedIn",
    command: path.join(process.cwd(), "external/linkedin-mcp/.venv/bin/python"),
    args: [path.join(process.cwd(), "external/linkedin-mcp/src/linkedin_mcp_server.py")],
    requiredEnvVars: ["LINKEDIN_ACCESS_TOKEN"],
    runtime: "python",
    category: "social",
    requiresCredentials: true,
  },
  {
    name: "reddit",
    label: "Reddit",
    command: path.join(process.cwd(), "external/reddit-mcp/.venv/bin/python"),
    args: [path.join(process.cwd(), "external/reddit-mcp/src/reddit_mcp_server.py")],
    requiredEnvVars: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"],
    runtime: "python",
    category: "social",
    requiresCredentials: true,
  },
];

// ── Manager ──────────────────────────────────────────────────────────────────

export type LocalMcpServerManagerOptions = {
  /** Server definitions to manage (default: DEFAULT_LOCAL_SERVER_DEFINITIONS) */
  definitions?: LocalMcpServerDefinition[];
  /** If true, skip servers whose required env vars are empty (default: true) */
  skipUnconfigured?: boolean;
  /** Timeout in ms for establishing MCP connection (default: 30000) */
  connectTimeout?: number;
};

/**
 * Manages subprocess-based MCP servers (word, calendar, etc.).
 *
 * @deprecated Prefer the native `mcpServers` configuration in `copilot.nativeMcpServers`
 * (or `config/default.json` → `copilot.nativeMcpServers`), which uses the Copilot SDK's
 * built-in MCP server orchestration. This class will be removed in a future release.
 */
export class LocalMcpServerManager extends EventEmitter {
  private definitions: LocalMcpServerDefinition[];
  private skipUnconfigured: boolean;
  private connectTimeout: number;
  private instances: Map<string, LocalServerInstance> = new Map();
  private statuses: Map<string, LocalServerStatus> = new Map();

  constructor(options: LocalMcpServerManagerOptions = {}) {
    super();
    this.definitions = options.definitions ?? DEFAULT_LOCAL_SERVER_DEFINITIONS;
    this.skipUnconfigured = options.skipUnconfigured ?? true;
    this.connectTimeout = options.connectTimeout ?? 30_000;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Start all eligible local MCP servers. */
  async startAll(): Promise<void> {
    for (const def of this.definitions) {
      if (this.skipUnconfigured && !this.hasRequiredCredentials(def)) {
        logger.info(
          `Skipping local MCP server "${def.name}": missing required env vars (${(def.requiredEnvVars ?? []).join(", ")})`
        );
        this.setStatus(def, {
          running: false,
          toolCount: 0,
          error: "credentials_missing",
        });
        continue;
      }

      if (!this.isRuntimeAvailable(def)) {
        logger.info(
          `Skipping local MCP server "${def.name}": runtime "${def.runtime}" not available (${def.command} not found)`
        );
        this.setStatus(def, {
          running: false,
          toolCount: 0,
          error: "runtime_unavailable",
        });
        continue;
      }

      try {
        await this.startServer(def);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(`Failed to start local MCP server "${def.name}": ${err.message}`);
        this.setStatus(def, {
          running: false,
          toolCount: 0,
          error: err.message,
        });
        this.emit("server:error", def.name, err);
      }
    }
  }

  /** Stop all running local MCP servers. */
  async stopAll(): Promise<void> {
    for (const [name, instance] of this.instances) {
      try {
        await this.stopServer(name, instance);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to stop local MCP server "${name}": ${msg}`);
      }
    }
    this.instances.clear();
  }

  /** Restart a single server by name. */
  async restartServer(name: string): Promise<LocalServerStatus | null> {
    const def = this.definitions.find((d) => d.name === name);
    if (!def) return null;

    const existing = this.instances.get(name);
    if (existing) {
      try {
        await this.stopServer(name, existing);
      } catch {
        // Best effort stop
      }
      this.instances.delete(name);
    }

    try {
      await this.startServer(def);
      return this.statuses.get(name) ?? null;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus(def, { running: false, toolCount: 0, error: err.message });
      return this.statuses.get(name) ?? null;
    }
  }

  /**
   * Call a tool on a local MCP server.
   * The tool name should be the raw tool name from the remote server.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ text: string; isError?: boolean }> {
    const instance = this.instances.get(serverName);
    if (!instance) {
      return {
        text: `Local MCP server "${serverName}" is not running.`,
        isError: true,
      };
    }

    try {
      const result = await instance.client.callTool({
        name: toolName,
        arguments: args,
      });

      // MCP callTool returns { content: Array<{ type, text }>, isError? }
      const content = result.content as Array<{ type: string; text?: string }> | undefined;
      const text = content
        ?.filter((c) => c.type === "text" && c.text)
        .map((c) => c.text)
        .join("\n") ?? JSON.stringify(result);
      const isError = result.isError === true;

      return { text, isError };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { text: `Tool call failed: ${message}`, isError: true };
    }
  }

  /** Get the list of tools discovered from a specific server. */
  getServerTools(serverName: string): Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> {
    return this.instances.get(serverName)?.tools ?? [];
  }

  /** Get all statuses. */
  getAllStatuses(): LocalServerStatus[] {
    return Array.from(this.statuses.values());
  }

  /** Get status of a single server. */
  getStatus(name: string): LocalServerStatus | undefined {
    return this.statuses.get(name);
  }

  /** Return all server definitions. */
  getDefinitions(): LocalMcpServerDefinition[] {
    return [...this.definitions];
  }

  /** Return names of servers with valid credentials. */
  getConfiguredServers(): string[] {
    return this.definitions
      .filter((def) => this.hasRequiredCredentials(def))
      .map((def) => def.name);
  }

  /** Check if a specific server is currently running. */
  isRunning(name: string): boolean {
    return this.instances.has(name);
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private hasRequiredCredentials(def: LocalMcpServerDefinition): boolean {
    if (!def.requiredEnvVars || def.requiredEnvVars.length === 0) return true;
    return def.requiredEnvVars.every((envVar) => {
      const value = process.env[envVar];
      return value !== undefined && value !== "";
    });
  }

  private isRuntimeAvailable(def: LocalMcpServerDefinition): boolean {
    try {
      execSync(`which ${def.command}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private async startServer(def: LocalMcpServerDefinition): Promise<void> {
    logger.info(
      `Starting local MCP server "${def.name}": ${def.command} ${def.args.join(" ")}`
    );

    // Build environment: inherit process.env + definition overrides + required vars
    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ),
    };

    // Overlay definition-specified env
    if (def.env) {
      Object.assign(env, def.env);
    }

    // Ensure required env vars are forwarded
    if (def.requiredEnvVars) {
      for (const envVar of def.requiredEnvVars) {
        const value = process.env[envVar];
        if (value) {
          env[envVar] = value;
        }
      }
    }

    const transport = new StdioClientTransport({
      command: def.command,
      args: def.args,
      env,
    });

    const client = new Client(
      { name: `openzigs-${def.name}`, version: "0.1.0" },
    );

    // Set up error handling on transport
    transport.onerror = (error) => {
      logger.error(`Local MCP server "${def.name}" transport error: ${error.message}`);
      this.handleServerCrash(def.name);
    };

    transport.onclose = () => {
      logger.warn(`Local MCP server "${def.name}" transport closed`);
      this.handleServerCrash(def.name);
    };

    // Connect with timeout
    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Connection to "${def.name}" timed out after ${this.connectTimeout}ms`)),
        this.connectTimeout
      )
    );

    await Promise.race([connectPromise, timeoutPromise]);

    // Discover tools
    const toolsResult = await client.listTools();
    const tools = (toolsResult.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));

    logger.info(
      `Local MCP server "${def.name}" connected — discovered ${tools.length} tools`
    );

    const instance: LocalServerInstance = { definition: def, client, transport, tools };
    this.instances.set(def.name, instance);

    // Try to get the child process PID
    const pid = (transport as unknown as { _process?: { pid?: number } })._process?.pid;

    this.setStatus(def, {
      running: true,
      toolCount: tools.length,
      pid,
    });

    this.emit("server:started", this.statuses.get(def.name)!);
  }

  private async stopServer(name: string, instance: LocalServerInstance): Promise<void> {
    logger.info(`Stopping local MCP server "${name}"`);

    try {
      await instance.transport.close();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.debug(`Transport close for "${name}": ${msg}`);
    }

    this.setStatus(instance.definition, { running: false, toolCount: 0 });
    this.emit("server:stopped", this.statuses.get(name)!);
  }

  private handleServerCrash(name: string): void {
    const instance = this.instances.get(name);
    if (!instance) return;

    this.instances.delete(name);
    this.setStatus(instance.definition, {
      running: false,
      toolCount: 0,
      error: "process_crashed",
    });
    this.emit("server:error", name, new Error("Process crashed or closed unexpectedly"));
  }

  private setStatus(
    def: LocalMcpServerDefinition,
    partial: Partial<LocalServerStatus>
  ): void {
    const existing = this.statuses.get(def.name);
    this.statuses.set(def.name, {
      name: def.name,
      label: def.label,
      running: partial.running ?? existing?.running ?? false,
      runtime: def.runtime,
      toolCount: partial.toolCount ?? existing?.toolCount ?? 0,
      pid: partial.pid ?? existing?.pid,
      error: partial.error,
    });
  }

  // ── Typed events ────────────────────────────────────────────────────────

  override on<K extends keyof LocalServerManagerEvents>(
    event: K,
    listener: LocalServerManagerEvents[K]
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof LocalServerManagerEvents>(
    event: K,
    ...args: Parameters<LocalServerManagerEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}
