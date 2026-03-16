import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerMcpTools, createMcpServer } from "./server.js";
import { ToolRegistry } from "./tool-registry.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../logging/audit-logger.js", () => ({
  AuditLogger: vi.fn(() => ({ log: vi.fn(), logToolExecution: vi.fn() })),
}));
vi.mock("../approvals/index.js", () => ({
  ApprovalQueue: vi.fn(() => ({
    requestApproval: vi.fn().mockResolvedValue({ approved: true }),
  })),
}));

// Mock all tool creators to return simple stubs
const stubTools = (name: string) => [{
  name,
  description: `Stub ${name}`,
  inputSchema: { type: "object" as const, properties: {} },
  zodSchema: { safeParse: () => ({ success: true, data: {} }) },
  category: "test",
  riskLevel: "low" as const,
  handler: vi.fn().mockResolvedValue({ text: "ok" }),
}];

vi.mock("./tools/filesystem.js", () => ({
  createFilesystemHandlers: vi.fn(() => ({
    readFile: vi.fn().mockResolvedValue({ content: "data" }),
    writeFile: vi.fn().mockResolvedValue({ ok: true }),
    listDirectory: vi.fn().mockResolvedValue({ entries: [] }),
    listDirectoryRecursive: vi.fn().mockResolvedValue({ entries: [] }),
  })),
}));
vi.mock("./tools/brave-search.js", () => ({
  createBraveSearchHandler: vi.fn(() => vi.fn().mockResolvedValue({ results: [] })),
}));
vi.mock("./tools/chrome-devtools.js", () => ({
  createChromeDevtoolsHandler: vi.fn(() => vi.fn().mockResolvedValue({ content: "" })),
}));
vi.mock("./tools/browser-navigate.js", () => ({
  createBrowserNavigateHandler: vi.fn(() => vi.fn().mockResolvedValue({ ok: true })),
}));
vi.mock("./tools/shell.js", () => ({
  createShellExecuteHandler: vi.fn(() => vi.fn().mockResolvedValue({ stdout: "" })),
}));
vi.mock("./tools/prompt-tools.js", () => ({
  createPromptTools: vi.fn(() => stubTools("list-prompts")),
}));
vi.mock("./tools/scheduler-tools.js", () => ({
  createSchedulerTools: vi.fn(() => stubTools("schedule-job")),
}));
vi.mock("./tools/personality-tools.js", () => ({
  createPersonalityTools: vi.fn(() => stubTools("get-personality")),
}));
vi.mock("./tools/social-media-tools.js", () => ({
  createSocialMediaTools: vi.fn(() => stubTools("social-post")),
}));
vi.mock("./tools/document-intelligence-tools.js", () => ({
  createDocumentIntelligenceTools: vi.fn(() => stubTools("read-pdf")),
}));
vi.mock("./tools/markitdown-tools.js", () => ({
  createMarkItDownTools: vi.fn(() => stubTools("convert-doc")),
}));
vi.mock("./tools/gmail-tools.js", () => ({
  createGmailTools: vi.fn(() => stubTools("send-email")),
}));
vi.mock("./tools/database-tools.js", () => ({
  createDatabaseTools: vi.fn(() => stubTools("query-db")),
}));
vi.mock("./tools/github-tools.js", () => ({
  createGitHubTools: vi.fn(() => stubTools("github-search")),
}));
vi.mock("./tools/agent-tools.js", () => ({
  createAgentTools: vi.fn(() => stubTools("spawn-agent")),
}));
vi.mock("./tools/orchestrate-agents.js", () => ({
  createOrchestrateAgentsTools: vi.fn(() => stubTools("orchestrate-agents")),
}));
vi.mock("./tools/system-config-tools.js", () => ({
  createSystemConfigTools: vi.fn(() => stubTools("create-prompt")),
}));
vi.mock("./tools/documentation-tools.js", () => ({
  createDocumentationTools: vi.fn(() => stubTools("query-docs")),
}));
vi.mock("./tools/wizard-tools.js", () => ({
  createWizardTools: vi.fn(() => stubTools("wizard")),
}));
vi.mock("./tools/knowledge-tools.js", () => ({
  createKnowledgeTools: vi.fn(() => stubTools("search-knowledge")),
}));
vi.mock("./tools/secret-tools.js", () => ({
  createSecretTools: vi.fn(() => stubTools("get-secret")),
}));
vi.mock("./tools/video-tools.js", () => ({
  createVideoTools: vi.fn(() => stubTools("create-video")),
}));
vi.mock("./tools/shorts-tools.js", () => ({
  createShortsTools: vi.fn(() => stubTools("create-short")),
}));
vi.mock("./tools/blog-tools.js", () => ({
  createBlogTools: vi.fn(() => stubTools("blog-to-video")),
}));
vi.mock("./tools/social-brain-tools.js", () => ({
  createSocialBrainTools: vi.fn(() => stubTools("social-crm")),
}));
vi.mock("./tools/twitter-tools.js", () => ({
  createTwitterTools: vi.fn(() => stubTools("tweet")),
}));
vi.mock("./tools/youtube-tools.js", () => ({
  createYouTubeTools: vi.fn(() => stubTools("yt-upload")),
}));
vi.mock("./tools/linkedin-tools.js", () => ({
  createLinkedInTools: vi.fn(() => stubTools("li-post")),
}));
vi.mock("./tools/reddit-tools.js", () => ({
  createRedditTools: vi.fn(() => stubTools("reddit-post")),
}));
vi.mock("./tools/ingest-youtube-tools.js", () => ({
  createIngestYouTubeTools: vi.fn(() => stubTools("ingest-youtube")),
}));

describe("MCP server.ts", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ToolRegistry({
      statePath: "/tmp/test-tools.json",
      defaultEnabledTools: [],
    });
  });

  describe("registerMcpTools", () => {
    it("registers core filesystem, search, browser, and shell tools", () => {
      registerMcpTools(registry, { allowedDirs: ["/tmp"] });

      expect(registry.getToolDefinition("read-file")).toBeDefined();
      expect(registry.getToolDefinition("list-directory")).toBeDefined();
      expect(registry.getToolDefinition("write-file")).toBeDefined();
      expect(registry.getToolDefinition("web-search")).toBeDefined();
      expect(registry.getToolDefinition("browser-read")).toBeDefined();
      expect(registry.getToolDefinition("browser-navigate")).toBeDefined();
      expect(registry.getToolDefinition("shell-execute")).toBeDefined();
    });

    it("registers prompt tools when promptManager is provided", () => {
      registerMcpTools(registry, {
        allowedDirs: ["/tmp"],
        promptManager: {} as never,
      });
      expect(registry.getToolDefinition("list-prompts")).toBeDefined();
      expect(registry.getToolDefinition("create-prompt")).toBeDefined();
    });

    it("registers scheduler tools when scheduler is provided", () => {
      registerMcpTools(registry, {
        allowedDirs: ["/tmp"],
        scheduler: {} as never,
      });
      expect(registry.getToolDefinition("schedule-job")).toBeDefined();
    });

    it("registers personality tools when personalityManager is provided", () => {
      registerMcpTools(registry, {
        allowedDirs: ["/tmp"],
        personalityManager: {} as never,
      });
      expect(registry.getToolDefinition("get-personality")).toBeDefined();
    });

    it("registers agent tools when taskEngine is provided", () => {
      registerMcpTools(registry, {
        allowedDirs: ["/tmp"],
        taskEngine: {} as never,
      });
      expect(registry.getToolDefinition("spawn-agent")).toBeDefined();
    });

    it("registers orchestrate tools when taskEngine + copilot provided", () => {
      registerMcpTools(registry, {
        allowedDirs: ["/tmp"],
        taskEngine: {} as never,
        copilot: {} as never,
      });
      expect(registry.getToolDefinition("orchestrate-agents")).toBeDefined();
    });

    it("registers knowledge tools when knowledgeService is provided", () => {
      registerMcpTools(registry, {
        allowedDirs: ["/tmp"],
        knowledgeService: {} as never,
      });
      expect(registry.getToolDefinition("search-knowledge")).toBeDefined();
    });

    it("registers secret tools when vaultService is provided", () => {
      registerMcpTools(registry, {
        allowedDirs: ["/tmp"],
        vaultService: {} as never,
      });
      expect(registry.getToolDefinition("get-secret")).toBeDefined();
    });

    it("registers video tools when copilot is provided", () => {
      registerMcpTools(registry, {
        allowedDirs: ["/tmp"],
        copilot: {} as never,
      });
      expect(registry.getToolDefinition("create-video")).toBeDefined();
      expect(registry.getToolDefinition("create-short")).toBeDefined();
      expect(registry.getToolDefinition("blog-to-video")).toBeDefined();
    });

    it("registers social brain tools when repository + handoffManager provided", () => {
      registerMcpTools(registry, {
        allowedDirs: ["/tmp"],
        socialRepository: {} as never,
        socialHandoffManager: {} as never,
      });
      expect(registry.getToolDefinition("social-crm")).toBeDefined();
    });

    it("registers ingest-youtube tools when mediaQueueRepo provided", () => {
      registerMcpTools(registry, {
        allowedDirs: ["/tmp"],
        mediaQueueRepo: {} as never,
      });
      expect(registry.getToolDefinition("ingest-youtube")).toBeDefined();
    });

    it("skips tools in disabledTools set", () => {
      registerMcpTools(registry, {
        allowedDirs: ["/tmp"],
        disabledTools: { "some-sidecar": ["read-file"] },
      });
      expect(registry.getToolDefinition("read-file")).toBeUndefined();
    });

    it("registers social media platform tools", () => {
      registerMcpTools(registry, { allowedDirs: ["/tmp"] });
      expect(registry.getToolDefinition("social-post")).toBeDefined();
      expect(registry.getToolDefinition("read-pdf")).toBeDefined();
      expect(registry.getToolDefinition("convert-doc")).toBeDefined();
      expect(registry.getToolDefinition("send-email")).toBeDefined();
      expect(registry.getToolDefinition("query-db")).toBeDefined();
      expect(registry.getToolDefinition("github-search")).toBeDefined();
    });
  });

  describe("createMcpServer", () => {
    it("creates a server instance", () => {
      const server = createMcpServer({ allowedDirs: ["/tmp"] });
      expect(server).toBeDefined();
    });
  });
});
