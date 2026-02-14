import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import * as z from "zod";
import { ToolRegistry, type ToolDefinition } from "./tool-registry.js";

const allToolNames = [
  "read-file",
  "list-directory",
  "write-file",
  "web-search",
  "browser-read",
  "shell-execute"
];

const createStateFile = async (enabledTools: string[]) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-registry-"));
  const statePath = path.join(dir, "tools.json");
  await fs.writeFile(
    statePath,
    JSON.stringify({ enabledTools, customRiskOverrides: {} }, null, 2),
    "utf-8"
  );
  return statePath;
};

const buildTool = (partial: Pick<ToolDefinition, "name" | "category" | "riskLevel">): ToolDefinition => {
  return {
    name: partial.name,
    description: `${partial.name} tool`,
    inputSchema: {
      type: "object",
      properties: {}
    },
    zodSchema: z.object({}),
    category: partial.category,
    riskLevel: partial.riskLevel,
    handler: async () => ({ text: "ok" })
  };
};

const registerDefaultTools = (registry: ToolRegistry) => {
  registry.registerTool(buildTool({ name: "read-file", category: "filesystem", riskLevel: "low" }));
  registry.registerTool(buildTool({ name: "list-directory", category: "filesystem", riskLevel: "low" }));
  registry.registerTool(buildTool({ name: "write-file", category: "filesystem", riskLevel: "high" }));
  registry.registerTool(buildTool({ name: "web-search", category: "search", riskLevel: "low" }));
  registry.registerTool(buildTool({ name: "browser-read", category: "browser", riskLevel: "medium" }));
  registry.registerTool(buildTool({ name: "shell-execute", category: "shell", riskLevel: "high" }));
};

describe("tool registry", () => {
  it("returns tools grouped by category", async () => {
    const statePath = await createStateFile(allToolNames);
    const registry = new ToolRegistry({ statePath });
    registerDefaultTools(registry);

    const tools = registry.getAllTools();

    expect(Object.keys(tools)).toEqual(["filesystem", "search", "browser", "shell", "productivity", "social", "documents", "personal", "data", "developer", "knowledge"]);
    expect(tools.filesystem.map((tool) => tool.name)).toEqual([
      "list-directory",
      "read-file",
      "write-file"
    ]);
    expect(tools.search.map((tool) => tool.name)).toEqual(["web-search"]);
    expect(tools.browser.map((tool) => tool.name)).toEqual(["browser-read"]);
    expect(tools.shell.map((tool) => tool.name)).toEqual(["shell-execute"]);
  });

  it("tracks risk levels and approval requirements", async () => {
    const statePath = await createStateFile(allToolNames);
    const registry = new ToolRegistry({ statePath });
    registerDefaultTools(registry);

    expect(registry.getToolInfo("shell-execute")?.riskLevel).toBe("high");
    expect(registry.getToolInfo("read-file")?.riskLevel).toBe("low");
    expect(registry.requiresApproval("shell-execute")).toBe(true);
    expect(registry.requiresApproval("read-file")).toBe(false);
  });

  it("persists enablement across restarts", async () => {
    const statePath = await createStateFile(allToolNames);
    const registry = new ToolRegistry({ statePath });
    registerDefaultTools(registry);

    await registry.setEnabled("write-file", false);
    expect(registry.isEnabled("write-file")).toBe(false);

    const reloaded = new ToolRegistry({ statePath });
    registerDefaultTools(reloaded);
    expect(reloaded.isEnabled("write-file")).toBe(false);
  });
});
