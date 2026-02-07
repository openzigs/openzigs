import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import * as z from "zod";
import { createFilesystemHandlers } from "./tools/filesystem.js";
import { createBraveSearchHandler } from "./tools/brave-search.js";
import { createChromeDevtoolsHandler } from "./tools/chrome-devtools.js";
import { createBrowserNavigateHandler } from "./tools/browser-navigate.js";
import { createShellExecuteHandler } from "./tools/shell.js";
import { createPromptTools } from "./tools/prompt-tools.js";
import { createSchedulerTools } from "./tools/scheduler-tools.js";
import { createSocialMediaTools } from "./tools/social-media-tools.js";
import { createDocumentIntelligenceTools } from "./tools/document-intelligence-tools.js";
import { ToolRegistry, type ToolDefinition } from "./tool-registry.js";
import { AuditLogger } from "../logging/audit-logger.js";
import { ApprovalQueue } from "../approvals/index.js";
import type { PromptManager } from "../productivity/prompt-manager.js";
import type { Scheduler } from "../productivity/scheduler.js";

export type McpServerOptions = {
  allowedDirs: string[];
  braveApiKey?: string;
  chromeDebugHost?: string;
  chromeDebugPort?: number;
  toolRegistry?: ToolRegistry;
  toolStatePath?: string;
  defaultEnabledTools?: string[];
  auditLogger?: AuditLogger;
  approvalQueue?: ApprovalQueue;
  promptManager?: PromptManager;
  scheduler?: Scheduler;
  linkedinSidecarUrl?: string;
  twitterSidecarUrl?: string;
  facebookSidecarUrl?: string;
  wordSidecarUrl?: string;
  calendarSidecarUrl?: string;
};

export type RegisterMcpToolsOptions = Pick<
  McpServerOptions,
  | "allowedDirs"
  | "braveApiKey"
  | "chromeDebugHost"
  | "chromeDebugPort"
  | "auditLogger"
  | "approvalQueue"
  | "promptManager"
  | "scheduler"
  | "linkedinSidecarUrl"
  | "twitterSidecarUrl"
  | "facebookSidecarUrl"
  | "wordSidecarUrl"
  | "calendarSidecarUrl"
>;

const readFileSchema = z.object({ path: z.string() });
const listDirectorySchema = z.object({ path: z.string() });
const writeFileSchema = z.object({ path: z.string(), content: z.string() });
const webSearchSchema = z.object({ query: z.string(), count: z.number().optional() });
const browserReadSchema = z.object({ selector: z.string().optional() });
const browserNavigateSchema = z.object({
  action: z.enum(["navigate", "click", "type", "screenshot", "get-text", "list-tabs", "evaluate", "snapshot-dom"]),
  url: z.string().optional(),
  selector: z.string().optional(),
  text: z.string().optional(),
  expression: z.string().optional()
});
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
type BrowserNavigateInput = z.infer<typeof browserNavigateSchema>;
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

const buildApprovalPreview = (toolName: string, args: Record<string, unknown>) => {
  if (toolName === "write-file") {
    const path = typeof args.path === "string" ? args.path : "";
    const content = typeof args.content === "string" ? args.content : "";
    return `Would write ${content.length} bytes to ${path}`;
  }
  if (toolName === "shell-execute") {
    const command = typeof args.command === "string" ? args.command : "";
    const argList = Array.isArray(args.args) ? args.args.join(" ") : "";
    return `Would run: ${command}${argList ? ` ${argList}` : ""}`;
  }
  return undefined;
};

export const createMcpServer = (options: McpServerOptions) => {
  const server = new Server({ name: "openzigs", version: "0.1.0" });
  const toolRegistry = options.toolRegistry
    ?? new ToolRegistry({
      statePath: options.toolStatePath
        ?? path.resolve(process.cwd(), "config", "tools.json"),
      defaultEnabledTools: options.defaultEnabledTools
    });

  registerMcpTools(toolRegistry, options);

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

    if (toolRegistry.requiresApproval(toolName)) {
      if (!options.approvalQueue) {
        return {
          content: [{ type: "text", text: `Approval required for tool: ${toolName}` }],
          isError: true
        };
      }

      const approval = await options.approvalQueue.requestApproval({
        tool: toolName,
        args: validated.data as Record<string, unknown>,
        riskLevel: "high",
        explanation: "High-risk tool execution requires approval.",
        preview: buildApprovalPreview(toolName, validated.data as Record<string, unknown>),
        channelType: "web"
      });

      if (!approval.approved) {
        const reason = approval.status === "expired" ? "Approval timed out" : "Approval rejected";
        return {
          content: [{ type: "text", text: reason }],
          isError: true
        };
      }
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

export const registerMcpTools = (toolRegistry: ToolRegistry, options: RegisterMcpToolsOptions) => {
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

  const browserNavigateHandler = createBrowserNavigateHandler({
    host: options.chromeDebugHost ?? "",
    port: options.chromeDebugPort ?? 9222
  });

  const shellExecuteHandler = createShellExecuteHandler({
    allowedDirs: options.allowedDirs,
    auditLogger: options.auditLogger
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
    name: "browser-navigate",
    description: "Control Chrome browser: navigate to URLs, click elements, type text, take screenshots, extract text, list tabs, snapshot DOM, or evaluate JavaScript. Requires Chrome with --remote-debugging-port.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["navigate", "click", "type", "screenshot", "get-text", "list-tabs", "evaluate", "snapshot-dom"] },
        url: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        expression: { type: "string" }
      },
      required: ["action"]
    },
    zodSchema: browserNavigateSchema,
    category: "browser",
    riskLevel: "high",
    handler: async (args) => {
      const input = args as BrowserNavigateInput;
      const output = await browserNavigateHandler(input);
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

  // ── Productivity Tools (Saved Prompts + Scheduler) ──
  if (options.promptManager) {
    const promptTools = createPromptTools({ promptManager: options.promptManager });
    for (const tool of promptTools) {
      registerTool(tool);
    }
  }

  if (options.scheduler) {
    const schedulerTools = createSchedulerTools({ scheduler: options.scheduler });
    for (const tool of schedulerTools) {
      registerTool(tool);
    }
  }

  // ── Social Media Tools ──
  const socialTools = createSocialMediaTools({
    linkedinSidecarUrl: options.linkedinSidecarUrl,
    twitterSidecarUrl: options.twitterSidecarUrl,
    facebookSidecarUrl: options.facebookSidecarUrl,
  });
  for (const tool of socialTools) {
    registerTool(tool);
  }

  // ── Document Intelligence Tools ──
  const docTools = createDocumentIntelligenceTools({
    wordSidecarUrl: options.wordSidecarUrl,
    calendarSidecarUrl: options.calendarSidecarUrl,
  });
  for (const tool of docTools) {
    registerTool(tool);
  }
};
