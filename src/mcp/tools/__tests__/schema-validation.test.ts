import { describe, it, expect, beforeAll } from "vitest";
import { Ajv } from "ajv";
import { createGalleryTools } from "../gallery-tools.js";
import { createMediaQueueTools } from "../media-queue-tools.js";
import { createCharacterTools } from "../character-tools.js";
import { createRemixTools } from "../remix-tools.js";
import { createBrandVoiceTools } from "../brand-voice-tools.js";
import { createVoiceTools } from "../voice-tools.js";
import { createPresenterTools } from "../presenter-tools.js";
import { createKnowledgeManagementTools } from "../knowledge-management-tools.js";
import { createWebhookTools } from "../webhook-tools.js";
import { createSentinelTools } from "../sentinel-tools.js";
import type { ToolDefinition } from "../../tool-registry.js";

const ajv = new Ajv({ strict: false });

const VALID_CATEGORIES = [
  "filesystem", "search", "browser", "shell",
  "productivity", "social", "documents", "personal",
  "data", "developer", "knowledge",
];
const VALID_RISK_LEVELS = ["low", "medium", "high"];
const KEBAB_CASE_RE = /^[a-z][a-z0-9-]{2,40}$/;

const stubRepo = {
  listAssets: () => [],
  getAsset: () => null,
  getJob: () => null,
  createJob: () => ({ id: "test", type: "txt2img", status: "pending" }),
} as never;

const stubQueueMaster = {
  getNodeStatuses: async () => [],
} as never;

const stubCharacterRepo = {
  getAll: () => [],
  getById: () => null,
  getByStatus: () => [],
} as never;

const stubBrandVoice = {
  getAll: () => [],
  getById: () => null,
  getActive: () => null,
  analyzeAndSave: async () => ({}),
  setActive: () => null,
  deactivateAll: () => {},
  delete: () => false,
} as never;

const stubVoice = {
  synthesize: async () => ({ audio: Buffer.alloc(0), cached: false, durationMs: 0 }),
  isReady: () => false,
  getSidecarHealth: async () => ({}),
} as never;

const stubPresRepo = { listAll: () => [], findById: () => undefined, delete: () => false } as never;
const stubQuiz = { generate: async () => [] } as never;
const stubTeacher = { ask: async function* () { yield ""; } } as never;
const stubKnowledge = {
  ingestText: async () => {},
  deleteDocument: async () => {},
  reindexDocument: async () => {},
  reindexAll: async () => {},
  getStats: async () => ({}),
} as never;
const stubWebhook = {
  create: () => ({ webhook: {}, apiKey: "test" }),
  list: () => [],
  get: () => undefined,
  delete: () => false,
  toggle: () => undefined,
} as never;
const stubSentinel = {
  getStatus: () => ({}),
  toggle: async () => {},
  getDigestHistory: async () => [],
} as never;

describe("Tier 1: Tool Schema Validation", () => {
  let allTools: ToolDefinition[];

  beforeAll(() => {
    allTools = [
      ...createGalleryTools({ mediaQueueRepo: stubRepo }),
      ...createMediaQueueTools({ mediaQueueRepo: stubRepo, queueMaster: stubQueueMaster }),
      ...createCharacterTools({ characterRepo: stubCharacterRepo }),
      ...createRemixTools({ mediaQueueRepo: stubRepo }),
      ...createBrandVoiceTools({ brandVoiceService: stubBrandVoice }),
      ...createVoiceTools({ voiceService: stubVoice }),
      ...createPresenterTools({
        presentationRepo: stubPresRepo,
        quizGenerator: stubQuiz,
        teacherAgent: stubTeacher,
      }),
      ...createKnowledgeManagementTools({ knowledgeService: stubKnowledge }),
      ...createWebhookTools({ webhookManager: stubWebhook }),
      ...createSentinelTools({ sentinelService: stubSentinel }),
    ];
  });

  it("should register at least 11 agent tools", () => {
    expect(allTools.length).toBeGreaterThanOrEqual(11);
  });

  for (const toolName of [
    "query-gallery-assets",
    "submit-media-job",
    "get-job-status",
    "manage-characters",
    "remix-session-manager",
    "manage-brand-voice",
    "synthesize-speech",
    "manage-presentations",
    "manage-knowledge-base",
    "manage-webhooks",
    "sentinel-control",
  ]) {
    describe(`Tool: ${toolName}`, () => {
      let tool: ToolDefinition;

      beforeAll(() => {
        tool = allTools.find((t) => t.name === toolName)!;
      });

      it("exists in registry", () => {
        expect(tool).toBeDefined();
      });

      it("has a valid JSON Schema", () => {
        const valid = ajv.validateSchema(tool.inputSchema);
        expect(valid).toBe(true);
      });

      it("name follows kebab-case", () => {
        expect(tool.name).toMatch(KEBAB_CASE_RE);
      });

      it("description is non-empty and under 200 chars", () => {
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.description.length).toBeLessThanOrEqual(200);
      });

      it("has valid category", () => {
        expect(VALID_CATEGORIES).toContain(tool.category);
      });

      it("has valid riskLevel", () => {
        expect(VALID_RISK_LEVELS).toContain(tool.riskLevel);
      });

      it("has a handler function", () => {
        expect(typeof tool.handler).toBe("function");
      });

      it("has a zodSchema", () => {
        expect(tool.zodSchema).toBeDefined();
      });
    });
  }
});
