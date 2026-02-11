import { describe, it, expect, vi } from "vitest";
import { createWizardTools } from "./wizard-tools.js";

describe("workflow-wizard tool", () => {
  it("registers with correct metadata", () => {
    const tools = createWizardTools({});
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool.name).toBe("workflow-wizard");
    expect(tool.category).toBe("productivity");
    expect(tool.riskLevel).toBe("low");
  });

  it("auto-confirms when no requestUserInput is available", async () => {
    const tools = createWizardTools({});
    const result = await tools[0].handler({
      type: "prompt",
      name: "daily-summary",
      summary: "Summarize the day's events",
      config: { template: "Give me a summary of {{topic}}" },
    });
    const parsed = JSON.parse(result.text);
    expect(parsed.action).toBe("confirm");
    expect(parsed.message).toContain("auto-confirming");
  });

  it("forwards preview to requestUserInput and returns the answer", async () => {
    const mockInput = vi.fn().mockResolvedValue({ answer: "edit", wasFreeform: false });
    const tools = createWizardTools({
      requestUserInput: mockInput,
      sessionId: "test-session",
    });

    const result = await tools[0].handler({
      type: "scheduled-job",
      name: "weekly-report",
      summary: "Run weekly report every Monday",
      config: { cronExpression: "0 9 * * MON", timezone: "UTC" },
    });

    expect(mockInput).toHaveBeenCalledOnce();
    const call = mockInput.mock.calls[0];
    expect(call[0].preview).toEqual({
      type: "scheduled-job",
      name: "weekly-report",
      summary: "Run weekly report every Monday",
      config: { cronExpression: "0 9 * * MON", timezone: "UTC" },
    });
    expect(call[1]).toBe("test-session");

    const parsed = JSON.parse(result.text);
    expect(parsed.action).toBe("edit");
  });

  it("auto-confirms on timeout", async () => {
    const mockInput = vi.fn().mockRejectedValue(new Error("timeout"));
    const tools = createWizardTools({ requestUserInput: mockInput, sessionId: "s" });

    const result = await tools[0].handler({
      type: "agent",
      name: "custom-agent",
      summary: "A test agent",
      config: { prompt: "Hello" },
    });

    const parsed = JSON.parse(result.text);
    expect(parsed.action).toBe("confirm");
    expect(parsed.message).toContain("timed out");
  });

  it("uses custom question when provided", async () => {
    const mockInput = vi.fn().mockResolvedValue({ answer: "confirm" });
    const tools = createWizardTools({ requestUserInput: mockInput, sessionId: "s" });

    await tools[0].handler({
      type: "prompt",
      name: "test",
      summary: "test",
      config: {},
      question: "Should I create this prompt?",
    });

    expect(mockInput.mock.calls[0][0].question).toBe("Should I create this prompt?");
  });
});
