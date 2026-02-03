import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
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
  zodSchema: z.ZodSchema;
  handler: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
};

const parseArgs = (schema: z.ZodSchema, args: Record<string, unknown>) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false as const,
      error: parsed.error.message
    };
  }
  return { ok: true as const, data: parsed.data };
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
    zodSchema: z.object({ path: z.string() }),
    handler: async (args) => {
      const parsed = parseArgs(z.object({ path: z.string() }), args);
      if (!parsed.ok) {
        return { text: parsed.error, isError: true };
      }
      const { path } = parsed.data as ReadFileInput;
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
    zodSchema: z.object({ path: z.string(), content: z.string() }),
    handler: async (args) => {
      const parsed = parseArgs(z.object({ path: z.string(), content: z.string() }), args);
      if (!parsed.ok) {
        return { text: parsed.error, isError: true };
      }
      const { path, content } = parsed.data as WriteFileInput;
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
    zodSchema: z.object({ query: z.string(), count: z.number().optional() }),
    handler: async (args) => {
      const parsed = parseArgs(z.object({ query: z.string(), count: z.number().optional() }), args);
      if (!parsed.ok) {
        return { text: parsed.error, isError: true };
      }
      const { query, count } = parsed.data as WebSearchInput;
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
    zodSchema: z.object({ selector: z.string().optional() }),
    handler: async (_args) => {
      const parsed = parseArgs(z.object({ selector: z.string().optional() }), _args);
      if (!parsed.ok) {
        return { text: parsed.error, isError: true };
      }
      const output = await chromeDevtoolsHandler(parsed.data as BrowserReadInput);
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
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        timeout: { type: "number" }
      },
      required: ["command"]
    },
    zodSchema: z.object({
      command: z.string(),
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      timeout: z.number().optional()
    }),
    handler: async (args) => {
      const parsed = parseArgs(
        z.object({
          command: z.string(),
          args: z.array(z.string()).optional(),
          cwd: z.string().optional(),
          timeout: z.number().optional()
        }),
        args
      );
      if (!parsed.ok) {
        return { text: parsed.error, isError: true };
      }
      const { command, args: commandArgs, cwd, timeout } = parsed.data as ShellExecuteInput & {
        args?: string[];
      };
      const output = await shellExecuteHandler({ command, args: commandArgs, cwd, timeout });
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
    const validated = parseArgs(tool.zodSchema, args);
    if (!validated.ok) {
      return {
        content: [{ type: "text", text: validated.error }],
        isError: true
      };
    }
    const result = await tool.handler(validated.data as Record<string, unknown>);

    return {
      content: [{ type: "text", text: result.text }],
      isError: result.isError ?? false
    };
  });

  return server;
};
