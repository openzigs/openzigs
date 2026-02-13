import { CopilotClient } from "@github/copilot-sdk";
import type { NativeMcpServerDefinition } from "../copilot/copilot-wrapper.js";

type SessionOptions = NonNullable<Parameters<CopilotClient["createSession"]>[0]>;
type SessionMcpServer = NonNullable<SessionOptions["mcpServers"]>[string];
type LocalNativeMcpServer = Extract<NativeMcpServerDefinition, { type: "local" | "stdio" }>;
type RemoteNativeMcpServer = Extract<NativeMcpServerDefinition, { type: "http" | "sse" }>;

const isLocalNativeMcpServer = (server: NativeMcpServerDefinition): server is LocalNativeMcpServer =>
  server.type === "local" || server.type === "stdio";

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

const extractJsonBlock = (text: string): string | null => {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const first = text.indexOf("[");
  const last = text.lastIndexOf("]");
  if (first !== -1 && last !== -1 && last > first) {
    return text.slice(first, last + 1).trim();
  }
  return null;
};

const parseToolList = (raw: string): NativeMcpDiscoveredTool[] => {
  const json = extractJsonBlock(raw);
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as Array<{ name?: unknown; description?: unknown }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((tool) => ({
        name: typeof tool.name === "string" ? tool.name.trim() : "",
        description: typeof tool.description === "string" ? tool.description.trim() : "",
      }))
      .filter((tool) => tool.name.length > 0);
  } catch {
    return [];
  }
};

export class CopilotNativeMcpTester implements NativeMcpTester {
  async testServer(serverName: string, server: NativeMcpServerDefinition): Promise<NativeMcpTestResult> {
    const startedAt = Date.now();
    const client = new CopilotClient();
    let session: Awaited<ReturnType<CopilotClient["createSession"]>> | null = null;

    try {
      let sessionServer: SessionMcpServer;
      if (isLocalNativeMcpServer(server)) {
        sessionServer = {
          type: server.type,
          command: server.command,
          args: server.args ?? [],
          env: server.env,
          cwd: server.cwd,
          tools: server.tools ?? [],
          timeout: server.timeout,
        } as SessionMcpServer;
      } else {
        const remoteServer = server as RemoteNativeMcpServer;
        sessionServer = {
          type: remoteServer.type,
          url: remoteServer.url,
          headers: remoteServer.headers,
          tools: remoteServer.tools ?? [],
          timeout: remoteServer.timeout,
        } as SessionMcpServer;
      }

      session = await client.createSession({
        model: "gpt-4.1",
        mcpServers: { test: sessionServer },
      });

      let tools: NativeMcpDiscoveredTool[] = [];

      const maybeListTools = session as unknown as { listTools?: () => Promise<Array<{ name: string; description?: string }>> };
      if (typeof maybeListTools.listTools === "function") {
        const listed = await maybeListTools.listTools();
        tools = listed.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
        }));
      }

      if (tools.length === 0) {
        const result = await session.sendAndWait({
          prompt: [
            "Return ONLY valid JSON array.",
            "List all available MCP tools visible in this session.",
            "Format: [{\"name\":\"tool-name\",\"description\":\"short description\"}]",
            "No markdown, no commentary.",
          ].join("\n"),
        }, 15_000);

        const content = (result as { data?: { content?: string } })?.data?.content ?? "";
        tools = parseToolList(content);
      }

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
        await session?.destroy();
      } catch {
        // Best effort cleanup
      }
      try {
        await client.stop();
      } catch {
        // Best effort cleanup
      }
    }
  }
}
