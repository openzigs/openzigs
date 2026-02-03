import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createFilesystemHandlers } from "./tools/filesystem.js";
import { createBraveSearchHandler } from "./tools/brave-search.js";
import { createChromeDevtoolsHandler } from "./tools/chrome-devtools.js";
import { createShellExecuteHandler } from "./tools/shell.js";

export type McpServerOptions = {
  allowedDirs: string[];
  braveApiKey?: string;
  chromeDebugHost?: string;
  chromeDebugPort?: number;
};

type ReadFileInput = { path: string };
type WriteFileInput = { path: string; content: string };
type WebSearchInput = { query: string; count?: number };
type BrowserReadInput = { selector?: string };
type ShellExecuteInput = { command: string; cwd?: string; timeout?: number };

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
};

export const createMcpServer = (options: McpServerOptions) => {
  const server = new Server({ name: "openzigs", version: "0.1.0" });

  const filesystemHandlers = createFilesystemHandlers({
    allowedDirs: options.allowedDirs
  });

  const braveSearchHandler = createBraveSearchHandler({
    apiKey: options.braveApiKey ?? ""
  });

  const chromeDevtoolsHandler = createChromeDevtoolsHandler({
    host: options.chromeDebugHost ?? "",
    port: options.chromeDebugPort ?? 9222
  });

  const shellExecuteHandler = createShellExecuteHandler();

  const tools = new Map<string, ToolDefinition>();

  const registerTool = (tool: ToolDefinition) => {
    tools.set(tool.name, tool);
  };

  registerTool({
    name: "read-file",
    description: "Read file contents from allowed directories",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    },
    handler: async (args) => {
      const { path } = args as ReadFileInput;
      const output = await filesystemHandlers.readFile({ path });
      return { text: output.content };
    }
  });

  registerTool({
    name: "write-file",
    description: "Write content to a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"]
    },
    handler: async (args) => {
      const { path, content } = args as WriteFileInput;
      const output = await filesystemHandlers.writeFile({ path, content });
      return { text: JSON.stringify(output) };
    }
  });

  registerTool({
    name: "web-search",
    description: "Search the web using Brave Search API",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, count: { type: "number" } },
      required: ["query"]
    },
    handler: async (args) => {
      const { query, count } = args as WebSearchInput;
      const output = await braveSearchHandler({ query, count });
      return { text: JSON.stringify(output) };
    }
  });

  registerTool({
    name: "browser-read",
    description: "Read information from a Chrome tab via DevTools",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" } }
    },
    handler: async (_args) => {
      const output = await chromeDevtoolsHandler({} as BrowserReadInput);
      return { text: JSON.stringify(output) };
    }
  });

  registerTool({
    name: "shell-execute",
    description: "Run a command in the terminal",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeout: { type: "number" }
      },
      required: ["command"]
    },
    handler: async (args) => {
      const { command, cwd, timeout } = args as ShellExecuteInput;
      const output = await shellExecuteHandler({ command, cwd, timeout });
      return { text: JSON.stringify(output) };
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: Array.from(tools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const tool = tools.get(toolName);

    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true
      };
    }

    const args = request.params.arguments ?? {};
    const result = await tool.handler(args);

    return {
      content: [{ type: "text", text: result.text }],
      isError: result.isError ?? false
    };
  });

  return server;
};
