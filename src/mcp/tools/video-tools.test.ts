/**
 * Director Mode — Video MCP Tools Tests
 * Issue #239
 */

import { describe, it, expect } from "vitest";
import { createVideoTools } from "./video-tools.js";
import type { CopilotWrapper } from "../../copilot/copilot-wrapper.js";

function createMockCopilot() {
  return {
    chat: function* () { yield "{}"; },
    authenticate: async () => ({}),
    waitForAuth: async () => {},
    isAuthenticated: async () => true,
    listModels: async () => [],
    onToolCall: async () => {},
    setMaxToolsPerRequest: () => {},
    getMaxToolsPerRequest: () => 30,
    destroySession: async () => {},
    hasSession: () => false,
    clearAllSessions: async () => {},
    getReasoningEffort: () => undefined,
    setReasoningEffort: () => {},
    getProvider: () => undefined,
    setProvider: () => {},
    getWorkingDirectory: () => undefined,
    setWorkingDirectory: () => {},
    getCustomAgents: () => [],
    setCustomAgents: () => {},
    getNativeMcpServers: () => ({}),
    setNativeMcpServers: () => {},
    modelSupportsReasoning: () => false,
    getSessionUsage: () => null,
    clearSessionUsage: () => null,
  } as unknown as CopilotWrapper;
}

describe("createVideoTools", () => {
  it("returns 3 tool definitions", () => {
    const tools = createVideoTools({ copilot: createMockCopilot() });
    expect(tools).toHaveLength(3);
  });

  it("includes produce-video tool", () => {
    const tools = createVideoTools({ copilot: createMockCopilot() });
    const pv = tools.find(t => t.name === "produce-video");
    expect(pv).toBeDefined();
    expect(pv!.category).toBe("productivity");
    expect(pv!.riskLevel).toBe("high");
  });

  it("includes list-templates tool", () => {
    const tools = createVideoTools({ copilot: createMockCopilot() });
    const lt = tools.find(t => t.name === "list-templates");
    expect(lt).toBeDefined();
    expect(lt!.riskLevel).toBe("low");
  });

  it("includes search-assets tool", () => {
    const tools = createVideoTools({ copilot: createMockCopilot() });
    const sa = tools.find(t => t.name === "search-assets");
    expect(sa).toBeDefined();
    expect(sa!.riskLevel).toBe("low");
  });

  it("list-templates handler returns template data", async () => {
    const tools = createVideoTools({ copilot: createMockCopilot() });
    const lt = tools.find(t => t.name === "list-templates")!;
    const result = await lt.handler({});
    const parsed = JSON.parse(result.text);
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toHaveProperty("id");
    expect(parsed[0]).toHaveProperty("name");
  });

  it("list-templates filters by tag", async () => {
    const tools = createVideoTools({ copilot: createMockCopilot() });
    const lt = tools.find(t => t.name === "list-templates")!;
    const result = await lt.handler({ tag: "social" });
    const parsed = JSON.parse(result.text);
    for (const t of parsed) {
      expect(t.tags).toContain("social");
    }
  });
});
