import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import * as z from "zod";
import { createFilesystemHandlers } from "./tools/filesystem.js";
import { createBraveSearchHandler } from "./tools/brave-search.js";
import { createChromeDevtoolsHandler } from "./tools/chrome-devtools.js";
import { createShellExecuteHandler } from "./tools/shell.js";
import { ToolRegistry, type ToolDefinition } from "./tool-registry.js";

export type McpServerOptions = {
  allowedDirs: string[];
  braveApiKey?: string;
  chromeDebugHost?: string;
  chromeDebugPort?: number;
  toolRegistry?: ToolRegistry;
  toolStatePath?: string;
  defaultEnabledTools?: string[];
};

const readFileSchema = z.object({ path: z.string() });
const listDirectorySchema = z.object({ path: z.string() });
const writeFileSchema = z.object({ path: z.string(), content: z.string() });
const webSearchSchema = z.object({ query: z.string(), count: z.number().optional() });
const browserReadSchema = z.object({ selector: z.string().optional() });
const shellExecuteSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  timeout: z.number().optional()
});

type ReadFileInput = z.infer<typeof readFileSchema>;
type ListDirectoryInput = z.infer<typeof listDirectorySchema>;
type WriteFileInput = z.infer<typeof writeFileSchema>;
type WebSearchInput = z.infer<typeof webSearchSchema>;
type BrowserReadInput = z.infer<typeof browserReadSchema>;
type ShellExecuteInput = z.infer<typeof shellExecuteSchema>;

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
  const toolRegistry = options.toolRegistry
    ?? new ToolRegistry({
      statePath: options.toolStatePath
        ?? path.resolve(process.cwd(), "config", "tools.json"),
      defaultEnabledTools: options.defaultEnabledTools
    });

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

  const shellExecuteHandler = createShellExecuteHandler({
    allowedDirs: options.allowedDirs
  });

  const registerTool = (tool: ToolDefinition) => {
    toolRegistry.registerTool(tool);
  };

  registerTool({
    name: "read-file",
    description: "Read file contents from allowed directories",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    },
    zodSchema: readFileSchema,
    category: "filesystem",
    riskLevel: "low",
    handler: async (args) => {
      const { path } = args as ReadFileInput;
      const output = await filesystemHandlers.readFile({ path });
      return { text: output.content };
    }
  });

  registerTool({
    name: "list-directory",
    description: "List directory entries from allowed directories",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    },
    zodSchema: listDirectorySchema,
    category: "filesystem",
    riskLevel: "low",
    handler: async (args) => {
      const { path } = args as ListDirectoryInput;
      const output = await filesystemHandlers.listDirectory({ path });
      return { text: JSON.stringify(output) };
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
    zodSchema: writeFileSchema,
    category: "filesystem",
    riskLevel: "high",
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
    zodSchema: webSearchSchema,
    category: "search",
    riskLevel: "low",
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
    zodSchema: browserReadSchema,
    category: "browser",
    riskLevel: "medium",
    handler: async (args) => {
      const output = await chromeDevtoolsHandler(args as BrowserReadInput);
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
    zodSchema: shellExecuteSchema,
    category: "shell",
    riskLevel: "high",
    handler: async (args) => {
      const { command, args: commandArgs, cwd, timeout } = args as ShellExecuteInput;
      const output = await shellExecuteHandler({ command, args: commandArgs, cwd, timeout });
      return { text: JSON.stringify(output) };
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: toolRegistry.listEnabledTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const tool = toolRegistry.getToolDefinition(toolName);

    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true
      };
    }

    if (!toolRegistry.isEnabled(toolName)) {
      return {
        content: [{ type: "text", text: `Tool disabled: ${toolName}` }],
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
    const result = await tool
      .handler(validated.data as Record<string, unknown>)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        return { text: `Tool execution failed: ${message}`, isError: true };
      });

    return {
      content: [{ type: "text", text: result.text }],
      isError: result.isError ?? false
    };
  });

  return server;
};
