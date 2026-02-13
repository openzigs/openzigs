import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { NativeMcpServerDefinition } from "../copilot/copilot-wrapper.js";
import { logger } from "../logging/logger.js";

type LocalNativeMcpServer = Extract<NativeMcpServerDefinition, { type: "local" | "stdio" }>;
type RemoteNativeMcpServer = Extract<NativeMcpServerDefinition, { type: "http" | "sse" }>;

const isLocalNativeMcpServer = (server: NativeMcpServerDefinition): server is LocalNativeMcpServer =>
  server.type === "local" || server.type === "stdio";

/** Default timeout for MCP connection + tool discovery (ms). */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export type NativeMcpDiscoveredTool = {
  name: string;
  description: string;
};

export type NativeMcpTestSuccess = {
  ok: true;
  serverName: string;
  tools: NativeMcpDiscoveredTool[];
  connectionTimeMs: number;
};

export type NativeMcpTestFailure = {
  ok: false;
  serverName: string;
  error: string;
};

export type NativeMcpTestResult = NativeMcpTestSuccess | NativeMcpTestFailure;

export interface NativeMcpTester {
  testServer(serverName: string, server: NativeMcpServerDefinition): Promise<NativeMcpTestResult>;
}

/**
 * Discovers MCP server tools using the MCP protocol directly.
 *
 * Instead of routing through the Copilot SDK and asking an LLM to enumerate
 * tools (which hallucinates built-in tools), this connects directly to the MCP
 * server process via stdio or SSE and calls the standard `tools/list` method.
 */
export class CopilotNativeMcpTester implements NativeMcpTester {
  private connectTimeout: number;

  constructor(options?: { connectTimeout?: number }) {
    this.connectTimeout = options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  async testServer(serverName: string, server: NativeMcpServerDefinition): Promise<NativeMcpTestResult> {
    const startedAt = Date.now();
    let transport: StdioClientTransport | SSEClientTransport | null = null;
    let client: Client | null = null;

    try {
      // Build the appropriate transport
      if (isLocalNativeMcpServer(server)) {
        const env: Record<string, string> = {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined
            )
          ),
        };
        if (server.env) {
          Object.assign(env, server.env);
        }

        transport = new StdioClientTransport({
          command: server.command,
          args: server.args ?? [],
          env,
        });
      } else {
        const remoteServer = server as RemoteNativeMcpServer;
        const url = new URL(remoteServer.url);
        transport = new SSEClientTransport(url);
      }

      client = new Client(
        { name: `openzigs-test-${serverName}`, version: "0.1.0" },
      );

      // Connect with timeout
      const connectPromise = client.connect(transport);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Connection to "${serverName}" timed out after ${this.connectTimeout}ms`)),
          this.connectTimeout,
        ),
      );

      await Promise.race([connectPromise, timeoutPromise]);

      // Discover tools via MCP protocol (tools/list)
      const toolsResult = await client.listTools();
      const tools: NativeMcpDiscoveredTool[] = (toolsResult.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? "",
      }));

      logger.info(
        `Native MCP test "${serverName}" discovered ${tools.length} tools in ${Date.now() - startedAt}ms`,
      );

      return {
        ok: true,
        serverName,
        tools,
        connectionTimeMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        serverName,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      try {
        await transport?.close();
      } catch {
        // Best effort cleanup
      }
    }
  }
}
