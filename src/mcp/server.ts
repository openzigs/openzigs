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
import { createPersonalityTools } from "./tools/personality-tools.js";
import { createSocialMediaTools } from "./tools/social-media-tools.js";
import { createDocumentIntelligenceTools } from "./tools/document-intelligence-tools.js";
import { createMarkItDownTools } from "./tools/markitdown-tools.js";
import { createGmailTools } from "./tools/gmail-tools.js";
import { createDatabaseTools } from "./tools/database-tools.js";
import { createGitHubTools } from "./tools/github-tools.js";
import { createInstagramTools } from "./tools/instagram-tools.js";
import { createAgentTools } from "./tools/agent-tools.js";
import { createOrchestrateAgentsTools } from "./tools/orchestrate-agents.js";
import { createSystemConfigTools } from "./tools/system-config-tools.js";
import { createDocumentationTools } from "./tools/documentation-tools.js";
import { createWizardTools } from "./tools/wizard-tools.js";
import { createKnowledgeTools } from "./tools/knowledge-tools.js";
import { createSecretTools } from "./tools/secret-tools.js";
import { ToolRegistry, type ToolDefinition } from "./tool-registry.js";
import type { LocalMcpServerManager } from "./local-mcp-server-manager.js";
import { AuditLogger } from "../logging/audit-logger.js";
import { ApprovalQueue } from "../approvals/index.js";
import type { PromptManager } from "../productivity/prompt-manager.js";
import type { Scheduler } from "../productivity/scheduler.js";
import type { PersonalityManager } from "../personality/personality-manager.js";
import type { TaskEngine } from "../tasks/task-engine.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { KnowledgeIngestionService } from "../knowledge/index.js";
import type { SecretVaultService } from "../vault/index.js";

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
  personalityManager?: PersonalityManager;
  taskEngine?: TaskEngine;
  copilot?: CopilotWrapper;
  /** Commands allowed for shell-execute tool. Empty = tool disabled. */
  shellAllowlist?: string[];
  linkedinSidecarUrl?: string;
  twitterSidecarUrl?: string;
  facebookSidecarUrl?: string;
  pinterestSidecarUrl?: string;
  markitdownSidecarUrl?: string;
  gmailSidecarUrl?: string;
  databaseSidecarUrl?: string;
  githubSidecarUrl?: string;
  /** GitHub Personal Access Token — enables direct REST API calls without a sidecar. */
  githubToken?: string;
  localServerManager?: LocalMcpServerManager;
  /** Per-sidecar disabled tool lists from config */
  disabledTools?: Record<string, string[]>;
  /** Knowledge Ingestion Service for search-knowledge tool. */
  knowledgeService?: KnowledgeIngestionService;
  /** Secret Vault Service for get-secret / browser-navigate token resolution. */
  vaultService?: SecretVaultService;
};

export type RegisterMcpToolsOptions = Pick<
  McpServerOptions,
  | "allowedDirs"
  | "braveApiKey"
  | "chromeDebugHost"
  | "chromeDebugPort"
  | "shellAllowlist"
  | "auditLogger"
  | "approvalQueue"
  | "promptManager"
  | "scheduler"
  | "personalityManager"
  | "taskEngine"
  | "copilot"
  | "linkedinSidecarUrl"
  | "twitterSidecarUrl"
  | "facebookSidecarUrl"
  | "pinterestSidecarUrl"
  | "markitdownSidecarUrl"
  | "gmailSidecarUrl"
  | "databaseSidecarUrl"
  | "githubSidecarUrl"
  | "githubToken"
  | "localServerManager"
  | "disabledTools"
  | "knowledgeService"
  | "vaultService"
>;

const readFileSchema = z.object({ path: z.string() });
const listDirectorySchema = z.object({ path: z.string(), recursive: z.boolean().optional() });
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

    // Approval gating has been migrated to SDK hooks (onPreToolUse).
    // The MCP protocol handler no longer gates high-risk tools inline;
    // Copilot SDK sessions enforce approval via the hooks config.

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
  const disabledToolSet = new Set(
    Object.values(options.disabledTools ?? {}).flat()
  );

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
    port: options.chromeDebugPort ?? 9222,
    vaultService: options.vaultService,
  });

  const shellExecuteHandler = createShellExecuteHandler({
    allowlist: options.shellAllowlist,
    allowedDirs: options.allowedDirs,
    auditLogger: options.auditLogger
  });

  const registerTool = (tool: ToolDefinition) => {
    if (disabledToolSet.has(tool.name)) {
      return;
    }
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
    description: "List directory entries from allowed directories. Set recursive=true to list all files and subdirectories recursively.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean", description: "When true, list all entries recursively including nested subdirectories" }
      },
      required: ["path"]
    },
    zodSchema: listDirectorySchema,
    category: "filesystem",
    riskLevel: "low",
    handler: async (args) => {
      const { path: dirPath, recursive } = args as ListDirectoryInput;
      if (recursive) {
        const output = await filesystemHandlers.listDirectoryRecursive({ path: dirPath });
        return { text: JSON.stringify(output) };
      }
      const output = await filesystemHandlers.listDirectory({ path: dirPath });
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
    description: "Control Chrome browser: navigate to URLs, click elements, type text, take screenshots, extract text, list tabs, snapshot DOM, evaluate JavaScript, or wait for manual navigation. The navigate action auto-detects CAPTCHA pages (reCAPTCHA, hCaptcha) and returns captcha:true — when this happens, instruct the user to solve the CAPTCHA manually in the open Chrome window, then use action 'wait-for-navigation' to resume. Supports {{SECRET:<uuid>}} tokens in the 'text' parameter — use get-secret to retrieve a token, then pass it to the type action for secure credential injection. Requires Chrome with --remote-debugging-port.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["navigate", "click", "type", "screenshot", "get-text", "list-tabs", "evaluate", "snapshot-dom", "wait-for-navigation"] },
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

    // System Configuration Tools (create-prompt — high-risk, requires approval)
    const systemConfigTools = createSystemConfigTools({ promptManager: options.promptManager });
    for (const tool of systemConfigTools) {
      registerTool(tool);
    }
  }

  if (options.scheduler) {
    const schedulerTools = createSchedulerTools({ scheduler: options.scheduler });
    for (const tool of schedulerTools) {
      registerTool(tool);
    }
  }

  // ── Personality Tools ──
  if (options.personalityManager) {
    const personalityToolList = createPersonalityTools({ personalityManager: options.personalityManager });
    for (const tool of personalityToolList) {
      registerTool(tool);
    }
  }

  // ── Social Media Tools ──
  const socialTools = createSocialMediaTools({
    linkedinSidecarUrl: options.linkedinSidecarUrl,
    twitterSidecarUrl: options.twitterSidecarUrl,
    facebookSidecarUrl: options.facebookSidecarUrl,
    pinterestSidecarUrl: options.pinterestSidecarUrl,
  });
  for (const tool of socialTools) {
    registerTool(tool);
  }

  // ── Document Intelligence Tools (PDF native, Word/Calendar via local MCP servers) ──
  const docTools = createDocumentIntelligenceTools({
    localServerManager: options.localServerManager,
  });
  for (const tool of docTools) {
    registerTool(tool);
  }

  // ── MarkItDown Tools (Docker sidecar) ──
  const markitdownTools = createMarkItDownTools({
    sidecarUrl: options.markitdownSidecarUrl,
  });
  for (const tool of markitdownTools) {
    registerTool(tool);
  }

  // ── Gmail Tools (Docker sidecar) ──
  const gmailTools = createGmailTools({
    sidecarUrl: options.gmailSidecarUrl,
  });
  for (const tool of gmailTools) {
    registerTool(tool);
  }

  // ── Database Tools (Docker/JBang sidecar) ──
  const databaseTools = createDatabaseTools({
    sidecarUrl: options.databaseSidecarUrl,
  });
  for (const tool of databaseTools) {
    registerTool(tool);
  }

  // ── GitHub Tools (Docker sidecar) ──
  const githubTools = createGitHubTools({
    sidecarUrl: options.githubSidecarUrl,
    token: options.githubToken,
  });
  for (const tool of githubTools) {
    registerTool(tool);
  }

  // ── Instagram Tools (Local python MCP server) ──
  const instagramTools = createInstagramTools({
    localServerManager: options.localServerManager,
  });
  for (const tool of instagramTools) {
    registerTool(tool);
  }

  // ── Agent / Task Tools (spawn-agent) ──
  if (options.taskEngine) {
    const agentTools = createAgentTools({ taskEngine: options.taskEngine });
    for (const tool of agentTools) {
      registerTool(tool);
    }
  }

  // ── Orchestrate Agents (fan-out/fan-in) ──
  if (options.taskEngine && options.copilot) {
    const orchestrateTools = createOrchestrateAgentsTools({
      taskEngine: options.taskEngine,
      copilot: options.copilot,
    });
    for (const tool of orchestrateTools) {
      registerTool(tool);
    }
  }

  // ── Documentation Tools (self-aware AI) ──
  const docQueryTools = createDocumentationTools();
  for (const tool of docQueryTools) {
    registerTool(tool);
  }

  // ── Workflow Wizard (interactive preview cards) ──
  const wizardTools = createWizardTools();
  for (const tool of wizardTools) {
    registerTool(tool);
  }

  // ── Knowledge Base (local RAG search) ──
  if (options.knowledgeService) {
    const knowledgeTools = createKnowledgeTools({ knowledgeService: options.knowledgeService });
    for (const tool of knowledgeTools) {
      registerTool(tool);
    }
  }

  // ── Secret Vault Tools (get-secret, list-secrets) ──
  if (options.vaultService) {
    const secretTools = createSecretTools({ vaultService: options.vaultService });
    for (const tool of secretTools) {
      registerTool(tool);
    }
  }
};
