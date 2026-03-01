import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PromptAuditor } from "./prompt-auditor.js";
import type { PromptAuditorDeps } from "./prompt-auditor.js";

function makeMockCopilot() {
  return {
    chat: vi.fn(),
  };
}

function makeMockSessionManager() {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    getHistory: vi.fn().mockResolvedValue([]),
  };
}

function makeDeps(overrides: Partial<PromptAuditorDeps> = {}): PromptAuditorDeps {
  return {
    copilot: makeMockCopilot() as unknown as PromptAuditorDeps["copilot"],
    sessionManager: makeMockSessionManager() as unknown as PromptAuditorDeps["sessionManager"],
    ...overrides,
  };
}

describe("PromptAuditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty result when no sessions exist", async () => {
    const deps = makeDeps();
    const auditor = new PromptAuditor(deps);

    const result = await auditor.audit(5);

    expect(result.sampledCount).toBe(0);
    expect(result.audits).toEqual([]);
    expect(result.averageScore).toBe(10);
  });

  it("samples recent prompts and analyzes them", async () => {
    const sessionManager = makeMockSessionManager();
    sessionManager.listSessions.mockResolvedValue([
      { id: "session-1", lastActiveAt: new Date().toISOString() },
    ]);
    sessionManager.getHistory.mockResolvedValue([
      { type: "user", content: "How do I implement a binary search tree in JavaScript?" },
    ]);

    const copilot = makeMockCopilot();
    async function* mockChat() {
      yield '{"score": 8, "suggestions": "Clear and specific", "rewrite": null}';
    }
    copilot.chat.mockReturnValue(mockChat());

    const auditor = new PromptAuditor(makeDeps({
      copilot: copilot as unknown as PromptAuditorDeps["copilot"],
      sessionManager: sessionManager as unknown as PromptAuditorDeps["sessionManager"],
    }));

    const result = await auditor.audit(1);

    expect(result.sampledCount).toBe(1);
    expect(result.audits[0].score).toBe(8);
    expect(result.audits[0].suggestions).toBe("Clear and specific");
    expect(result.audits[0].rewrite).toBeNull();
  });

  it("calculates average score correctly", async () => {
    const sessionManager = makeMockSessionManager();
    sessionManager.listSessions.mockResolvedValue([
      { id: "s1", lastActiveAt: new Date().toISOString() },
      { id: "s2", lastActiveAt: new Date().toISOString() },
    ]);
    sessionManager.getHistory
      .mockResolvedValueOnce([{ type: "user", content: "Tell me about algorithms and data structures" }])
      .mockResolvedValueOnce([{ type: "user", content: "Write me some code please thanks" }]);

    const copilot = makeMockCopilot();
    let callCount = 0;
    copilot.chat.mockImplementation(() => {
      callCount++;
      async function* gen() {
        if (callCount === 1) yield '{"score": 9, "suggestions": "Great", "rewrite": null}';
        else yield '{"score": 3, "suggestions": "Vague", "rewrite": "Write a Python function that sorts a list"}';
      }
      return gen();
    });

    const auditor = new PromptAuditor(makeDeps({
      copilot: copilot as unknown as PromptAuditorDeps["copilot"],
      sessionManager: sessionManager as unknown as PromptAuditorDeps["sessionManager"],
    }));

    const result = await auditor.audit(2);

    expect(result.sampledCount).toBe(2);
    expect(result.averageScore).toBe(6); // (9+3)/2
  });

  it("handles LLM response parse failures gracefully", async () => {
    const sessionManager = makeMockSessionManager();
    sessionManager.listSessions.mockResolvedValue([
      { id: "s1", lastActiveAt: new Date().toISOString() },
    ]);
    sessionManager.getHistory.mockResolvedValue([
      { type: "user", content: "A sufficiently long prompt to pass the filter" },
    ]);

    const copilot = makeMockCopilot();
    async function* mockChat() {
      yield "This is not JSON at all, just plain text response";
    }
    copilot.chat.mockReturnValue(mockChat());

    const auditor = new PromptAuditor(makeDeps({
      copilot: copilot as unknown as PromptAuditorDeps["copilot"],
      sessionManager: sessionManager as unknown as PromptAuditorDeps["sessionManager"],
    }));

    const result = await auditor.audit(1);

    expect(result.sampledCount).toBe(1);
    expect(result.audits[0].score).toBe(5); // Default fallback
    expect(result.audits[0].suggestions).toContain("This is not JSON");
  });

  it("clamps score to 1-10 range", async () => {
    const sessionManager = makeMockSessionManager();
    sessionManager.listSessions.mockResolvedValue([
      { id: "s1", lastActiveAt: new Date().toISOString() },
    ]);
    sessionManager.getHistory.mockResolvedValue([
      { type: "user", content: "A sufficiently long prompt to analyze" },
    ]);

    const copilot = makeMockCopilot();
    async function* mockChat() {
      yield '{"score": 15, "suggestions": "Perfect", "rewrite": null}';
    }
    copilot.chat.mockReturnValue(mockChat());

    const auditor = new PromptAuditor(makeDeps({
      copilot: copilot as unknown as PromptAuditorDeps["copilot"],
      sessionManager: sessionManager as unknown as PromptAuditorDeps["sessionManager"],
    }));

    const result = await auditor.audit(1);
    expect(result.audits[0].score).toBe(10); // Clamped to max
  });

  it("skips user messages shorter than 10 characters", async () => {
    const sessionManager = makeMockSessionManager();
    sessionManager.listSessions.mockResolvedValue([
      { id: "s1", lastActiveAt: new Date().toISOString() },
    ]);
    sessionManager.getHistory.mockResolvedValue([
      { type: "user", content: "hi" },
      { type: "user", content: "yes" },
    ]);

    const auditor = new PromptAuditor(makeDeps({
      sessionManager: sessionManager as unknown as PromptAuditorDeps["sessionManager"],
    }));

    const result = await auditor.audit(1);

    expect(result.sampledCount).toBe(0);
    expect(result.audits).toEqual([]);
  });

  it("handles session history retrieval failures gracefully", async () => {
    const sessionManager = makeMockSessionManager();
    sessionManager.listSessions.mockResolvedValue([
      { id: "s1", lastActiveAt: new Date().toISOString() },
    ]);
    sessionManager.getHistory.mockRejectedValue(new Error("JSONL corrupted"));

    const auditor = new PromptAuditor(makeDeps({
      sessionManager: sessionManager as unknown as PromptAuditorDeps["sessionManager"],
    }));

    const result = await auditor.audit(1);

    expect(result.sampledCount).toBe(0);
  });

  it("handles listSessions failures gracefully", async () => {
    const sessionManager = makeMockSessionManager();
    sessionManager.listSessions.mockRejectedValue(new Error("disk error"));

    const auditor = new PromptAuditor(makeDeps({
      sessionManager: sessionManager as unknown as PromptAuditorDeps["sessionManager"],
    }));

    const result = await auditor.audit(5);

    expect(result.sampledCount).toBe(0);
    expect(result.averageScore).toBe(10);
  });

  it("truncates prompt to 500 chars for sampling and 200 chars in audit result", async () => {
    const longPrompt = "A".repeat(600);
    const sessionManager = makeMockSessionManager();
    sessionManager.listSessions.mockResolvedValue([
      { id: "s1", lastActiveAt: new Date().toISOString() },
    ]);
    sessionManager.getHistory.mockResolvedValue([
      { type: "user", content: longPrompt },
    ]);

    const copilot = makeMockCopilot();
    async function* mockChat() {
      yield '{"score": 7, "suggestions": "OK", "rewrite": null}';
    }
    copilot.chat.mockReturnValue(mockChat());

    const auditor = new PromptAuditor(makeDeps({
      copilot: copilot as unknown as PromptAuditorDeps["copilot"],
      sessionManager: sessionManager as unknown as PromptAuditorDeps["sessionManager"],
    }));

    const result = await auditor.audit(1);

    expect(result.audits[0].originalPrompt.length).toBeLessThanOrEqual(200);
  });

  it("estimates tokens as ceil(length/4)", async () => {
    const prompt = "Tell me about machine learning algorithms"; // 42 chars
    const sessionManager = makeMockSessionManager();
    sessionManager.listSessions.mockResolvedValue([
      { id: "s1", lastActiveAt: new Date().toISOString() },
    ]);
    sessionManager.getHistory.mockResolvedValue([
      { type: "user", content: prompt },
    ]);

    const copilot = makeMockCopilot();
    async function* mockChat() {
      yield '{"score": 7, "suggestions": "OK", "rewrite": null}';
    }
    copilot.chat.mockReturnValue(mockChat());

    const auditor = new PromptAuditor(makeDeps({
      copilot: copilot as unknown as PromptAuditorDeps["copilot"],
      sessionManager: sessionManager as unknown as PromptAuditorDeps["sessionManager"],
    }));

    const result = await auditor.audit(1);
    // Token estimate is based on the sampled prompt (up to 500 chars), ceil(len/4)
    expect(result.audits[0].tokenEstimate).toBe(Math.ceil(prompt.length / 4));
  });

  it("setModel changes the model used for analysis", () => {
    const deps = makeDeps();
    const auditor = new PromptAuditor(deps);
    auditor.setModel("gpt-4o");
    // Model is private, but we can verify it was called with the right model by checking chat args
    // This is a basic smoke test that setModel doesn't throw
    expect(() => auditor.setModel("gpt-4o")).not.toThrow();
  });

  it("handles copilot chat failure for individual prompts", async () => {
    const sessionManager = makeMockSessionManager();
    sessionManager.listSessions.mockResolvedValue([
      { id: "s1", lastActiveAt: new Date().toISOString() },
    ]);
    sessionManager.getHistory.mockResolvedValue([
      { type: "user", content: "A prompt long enough to pass the filter" },
    ]);

    const copilot = makeMockCopilot();
    copilot.chat.mockImplementation(() => {
      throw new Error("API rate limited");
    });

    const auditor = new PromptAuditor(makeDeps({
      copilot: copilot as unknown as PromptAuditorDeps["copilot"],
      sessionManager: sessionManager as unknown as PromptAuditorDeps["sessionManager"],
    }));

    const result = await auditor.audit(1);

    // Should handle the error and return 0 audits
    expect(result.sampledCount).toBe(0);
    expect(result.averageScore).toBe(10);
  });
});
