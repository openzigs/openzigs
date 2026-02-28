import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { BrandVoiceRepository } from "./brand-voice-repository.js";
import { BrandVoiceService } from "./brand-voice-service.js";
import type { BrandVoiceRulebook } from "./brand-voice-repository.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";

const sampleRulebook: BrandVoiceRulebook = {
  tone: "direct and technical, dry wit",
  sentence_structure: "short statements, no filler",
  vocabulary_level: "developer-facing, precise jargon",
  formatting_quirks: "code blocks, numbered lists",
  banned_words: ["delve", "tapestry", "unlock", "unleash", "dive in", "landscape", "realm"],
};

const createMockCopilot = (response: string): CopilotWrapper => {
  const destroySession = vi.fn();
  return {
    chat: async function* (_msg: string) {
      yield response;
    },
    destroySession,
    authenticate: vi.fn(),
    waitForAuth: vi.fn(),
    isAuthenticated: vi.fn(),
    listModels: vi.fn(),
    onToolCall: vi.fn(),
    setMaxToolsPerRequest: vi.fn(),
    getMaxToolsPerRequest: vi.fn(),
    hasSession: vi.fn(),
    clearAllSessions: vi.fn(),
  } as unknown as CopilotWrapper;
};

describe("BrandVoiceService", () => {
  let db: Database.Database;
  let repo: BrandVoiceRepository;
  const clock = () => new Date("2026-02-28T12:00:00Z");

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    repo = new BrandVoiceRepository(db, clock);
  });

  it("analyzeWritingStyle parses valid JSON response", async () => {
    const mockCopilot = createMockCopilot(JSON.stringify(sampleRulebook));
    const service = new BrandVoiceService({ repository: repo, copilot: mockCopilot });

    const result = await service.analyzeWritingStyle(["Some writing sample."]);
    expect(result).toEqual(sampleRulebook);
  });

  it("analyzeWritingStyle handles markdown-fenced JSON", async () => {
    const response = "```json\n" + JSON.stringify(sampleRulebook) + "\n```";
    const mockCopilot = createMockCopilot(response);
    const service = new BrandVoiceService({ repository: repo, copilot: mockCopilot });

    const result = await service.analyzeWritingStyle(["Sample text."]);
    expect(result.tone).toBe(sampleRulebook.tone);
  });

  it("analyzeWritingStyle throws on invalid response", async () => {
    const mockCopilot = createMockCopilot("This is not JSON at all.");
    const service = new BrandVoiceService({ repository: repo, copilot: mockCopilot });

    await expect(service.analyzeWritingStyle(["Sample"])).rejects.toThrow("Failed to parse");
  });

  it("analyzeWritingStyle throws when no samples provided", async () => {
    const mockCopilot = createMockCopilot("{}");
    const service = new BrandVoiceService({ repository: repo, copilot: mockCopilot });

    await expect(service.analyzeWritingStyle([])).rejects.toThrow("At least one writing sample");
  });

  it("analyzeAndSave creates a brand voice from analysis", async () => {
    const mockCopilot = createMockCopilot(JSON.stringify(sampleRulebook));
    const service = new BrandVoiceService({ repository: repo, copilot: mockCopilot });

    const voice = await service.analyzeAndSave("My Voice", ["Sample writing"], { active: true });
    expect(voice.name).toBe("My Voice");
    expect(voice.active).toBe(true);
    expect(voice.rulebook).toEqual(sampleRulebook);
    expect(voice.samples).toEqual(["Sample writing"]);
  });

  it("getActiveVoicePromptBlock returns empty string when no active voice", () => {
    const mockCopilot = createMockCopilot("{}");
    const service = new BrandVoiceService({ repository: repo, copilot: mockCopilot });
    expect(service.getActiveVoicePromptBlock()).toBe("");
  });

  it("getActiveVoicePromptBlock returns formatted block when active voice exists", () => {
    repo.create({ name: "Active", rulebook: sampleRulebook, samples: [], active: true });
    const mockCopilot = createMockCopilot("{}");
    const service = new BrandVoiceService({ repository: repo, copilot: mockCopilot });

    const block = service.getActiveVoicePromptBlock();
    expect(block).toContain("BRAND VOICE RULES");
    expect(block).toContain(sampleRulebook.tone);
    expect(block).toContain("delve");
  });

  it("buildPromptBlock includes all rulebook fields", () => {
    const mockCopilot = createMockCopilot("{}");
    const service = new BrandVoiceService({ repository: repo, copilot: mockCopilot });

    const block = service.buildPromptBlock(sampleRulebook);
    expect(block).toContain("Tone:");
    expect(block).toContain("Sentence Structure:");
    expect(block).toContain("Vocabulary Level:");
    expect(block).toContain("Formatting Quirks:");
    expect(block).toContain("BANNED WORDS");
  });

  it("delegates CRUD to repository", () => {
    const mockCopilot = createMockCopilot("{}");
    const service = new BrandVoiceService({ repository: repo, copilot: mockCopilot });

    const voice = repo.create({ name: "Test", rulebook: sampleRulebook, samples: [] });
    expect(service.getById(voice.id)?.name).toBe("Test");
    expect(service.getAll()).toHaveLength(1);

    service.update(voice.id, { name: "Updated" });
    expect(service.getById(voice.id)?.name).toBe("Updated");

    service.setActive(voice.id);
    expect(service.getActive()?.id).toBe(voice.id);

    service.deactivateAll();
    expect(service.getActive()).toBeNull();

    expect(service.delete(voice.id)).toBe(true);
    expect(service.getAll()).toHaveLength(0);
  });
});
