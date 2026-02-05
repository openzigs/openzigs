import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type * as z from "zod";

export type RiskLevel = "low" | "medium" | "high";
export type ToolCategory = "filesystem" | "search" | "browser" | "shell";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  zodSchema: z.ZodSchema;
  handler: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
  category: ToolCategory;
  riskLevel: RiskLevel;
};

export type ToolInfo = {
  name: string;
  description: string;
  category: ToolCategory;
  riskLevel: RiskLevel;
  enabled: boolean;
};

export type ToolRegistryState = {
  enabledTools: string[];
  customRiskOverrides: Record<string, RiskLevel>;
};

const defaultState: ToolRegistryState = {
  enabledTools: [],
  customRiskOverrides: {}
};

const isRiskLevel = (value: unknown): value is RiskLevel => {
  return value === "low" || value === "medium" || value === "high";
};

const loadState = (statePath: string): ToolRegistryState | null => {
  try {
    if (!fs.existsSync(statePath)) {
      return null;
    }
    const raw = fs.readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ToolRegistryState>;

    const enabledTools = Array.isArray(parsed.enabledTools)
      ? parsed.enabledTools.filter((tool) => typeof tool === "string")
      : [];

    const customRiskOverrides: Record<string, RiskLevel> = {};
    if (parsed.customRiskOverrides && typeof parsed.customRiskOverrides === "object") {
      for (const [tool, risk] of Object.entries(parsed.customRiskOverrides)) {
        if (isRiskLevel(risk)) {
          customRiskOverrides[tool] = risk;
        }
      }
    }

    return {
      enabledTools,
      customRiskOverrides
    };
  } catch (error) {
    console.error(`[ToolRegistry] Failed to load state from ${statePath}:`, error);
    return null;
  }
};

const saveState = async (statePath: string, state: ToolRegistryState) => {
  await fsPromises.mkdir(path.dirname(statePath), { recursive: true });
  await fsPromises.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
};

const toolCategories: ToolCategory[] = ["filesystem", "search", "browser", "shell"];

export type ToolRegistryOptions = {
  statePath: string;
  defaultEnabledTools?: string[];
};

export class ToolRegistry extends EventEmitter {
  private tools = new Map<string, ToolDefinition>();
  private enabledTools: Set<string> | null;
  private customRiskOverrides: Record<string, RiskLevel>;
  private defaultEnabledTools: string[];
  private statePath: string;

  constructor({ statePath, defaultEnabledTools = [] }: ToolRegistryOptions) {
    super();
    this.statePath = statePath;
    this.defaultEnabledTools = defaultEnabledTools;
    const state = loadState(statePath);

    if (state) {
      this.enabledTools = new Set(state.enabledTools);
      this.customRiskOverrides = state.customRiskOverrides;
    } else {
      this.enabledTools = defaultEnabledTools.length > 0 ? new Set(defaultEnabledTools) : null;
      this.customRiskOverrides = { ...defaultState.customRiskOverrides };
    }
  }

  registerTool(tool: ToolDefinition) {
    this.tools.set(tool.name, tool);
  }

  getToolDefinition(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAllTools(): Record<ToolCategory, ToolInfo[]> {
    const grouped = Object.fromEntries(
      toolCategories.map((category) => [category, []])
    ) as Record<ToolCategory, ToolInfo[]>;

    for (const tool of this.tools.values()) {
      const riskLevel = this.getRiskLevel(tool.name) ?? tool.riskLevel;
      grouped[tool.category].push({
        name: tool.name,
        description: tool.description,
        category: tool.category,
        riskLevel,
        enabled: this.isEnabled(tool.name)
      });
    }

    for (const category of toolCategories) {
      grouped[category].sort((a, b) => a.name.localeCompare(b.name));
    }

    return grouped;
  }

  getToolInfo(name: string): ToolInfo | undefined {
    const tool = this.tools.get(name);
    if (!tool) {
      return undefined;
    }
    return {
      name: tool.name,
      description: tool.description,
      category: tool.category,
      riskLevel: this.getRiskLevel(name) ?? tool.riskLevel,
      enabled: this.isEnabled(name)
    };
  }

  listEnabledTools(): ToolDefinition[] {
    if (this.enabledTools === null) {
      return Array.from(this.tools.values());
    }
    return Array.from(this.tools.values()).filter((tool) => this.enabledTools?.has(tool.name));
  }

  isEnabled(name: string): boolean {
    if (this.enabledTools === null) {
      return true;
    }
    return this.enabledTools.has(name);
  }

  async setEnabled(name: string, enabled: boolean) {
    if (!this.tools.has(name)) {
      throw new Error(`Unknown tool: ${name}`);
    }

    if (this.enabledTools === null) {
      this.enabledTools = new Set(this.tools.keys());
    }

    if (enabled) {
      this.enabledTools.add(name);
    } else {
      this.enabledTools.delete(name);
    }

    await saveState(this.statePath, {
      enabledTools: Array.from(this.enabledTools).sort(),
      customRiskOverrides: this.customRiskOverrides
    });

    this.emit("tool:toggled", { name, enabled });
  }

  requiresApproval(name: string): boolean {
    const riskLevel = this.getRiskLevel(name) ?? this.tools.get(name)?.riskLevel;
    return riskLevel === "high";
  }

  private getRiskLevel(name: string): RiskLevel | undefined {
    return this.customRiskOverrides[name];
  }
}
