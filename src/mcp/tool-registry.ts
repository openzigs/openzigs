import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type * as z from "zod";
import { ALWAYS_ON_TOOLS } from "./constants.js";

/** Minimal audit logger surface used by ToolRegistry.invokeTool — avoids a hard dep cycle. */
export interface ToolRegistryAuditLogger {
  log(entry: {
    level: "info" | "warn" | "error" | "security";
    category: "session" | "message" | "tool" | "security" | "system";
    event: string;
    sessionId?: string;
    userId?: string;
    details: Record<string, unknown>;
  }): Promise<unknown>;
}

/** Context passed to invokeTool — attributes the call in the audit log. */
export type ToolInvocationContext = {
  /** Logical caller, e.g. "director-studio", "admin-api", "chat-session". */
  source?: string;
  /** Session that triggered the call, if any. */
  sessionId?: string;
  /** User identifier, if known. */
  userId?: string;
};

export type RiskLevel = "low" | "medium" | "high";
export type ToolCategory =
  | "filesystem"
  | "search"
  | "browser"
  | "shell"
  | "productivity"
  | "social"
  | "documents"
  | "personal"
  | "data"
  | "developer"
  | "knowledge";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  zodSchema: z.ZodSchema;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{ text: string; isError?: boolean }>;
  category: ToolCategory;
  riskLevel: RiskLevel;
  /** The sidecar/source this tool belongs to (e.g., "linkedin", "gmail", "github"). */
  source?: string;
};

export type ToolInfo = {
  name: string;
  description: string;
  category: ToolCategory;
  riskLevel: RiskLevel;
  enabled: boolean;
  /** The sidecar/source this tool belongs to, if any. */
  source?: string;
  /** Whether this tool has a global approval lock (requires approval regardless of risk level). */
  globalApprovalRequired?: boolean;
};

export type ToolRegistryState = {
  enabledTools: string[];
  customRiskOverrides: Record<string, RiskLevel>;
  /** Per-tool global approval override: true = always require approval regardless of risk level. */
  globalApprovalOverrides: Record<string, boolean>;
};

const defaultState: ToolRegistryState = {
  enabledTools: [],
  customRiskOverrides: {},
  globalApprovalOverrides: {},
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
    if (
      parsed.customRiskOverrides &&
      typeof parsed.customRiskOverrides === "object"
    ) {
      for (const [tool, risk] of Object.entries(parsed.customRiskOverrides)) {
        if (isRiskLevel(risk)) {
          customRiskOverrides[tool] = risk;
        }
      }
    }

    const globalApprovalOverrides: Record<string, boolean> = {};
    if (
      parsed.globalApprovalOverrides &&
      typeof parsed.globalApprovalOverrides === "object"
    ) {
      for (const [tool, value] of Object.entries(
        parsed.globalApprovalOverrides as Record<string, unknown>,
      )) {
        if (typeof value === "boolean") {
          globalApprovalOverrides[tool] = value;
        }
      }
    }

    return {
      enabledTools,
      customRiskOverrides,
      globalApprovalOverrides,
    };
  } catch (error) {
    console.error(
      `[ToolRegistry] Failed to load state from ${statePath}:`,
      error,
    );
    return null;
  }
};

const saveState = async (statePath: string, state: ToolRegistryState) => {
  await fsPromises.mkdir(path.dirname(statePath), { recursive: true });
  await fsPromises.writeFile(
    statePath,
    JSON.stringify(state, null, 2),
    "utf-8",
  );
};

const toolCategories: ToolCategory[] = [
  "filesystem",
  "search",
  "browser",
  "shell",
  "productivity",
  "social",
  "documents",
  "personal",
  "data",
  "developer",
  "knowledge",
];

export type ToolRegistryOptions = {
  statePath: string;
  defaultEnabledTools?: string[];
  auditLogger?: ToolRegistryAuditLogger;
};

export class ToolRegistry extends EventEmitter {
  private tools = new Map<string, ToolDefinition>();
  private enabledTools: Set<string> | null;
  private customRiskOverrides: Record<string, RiskLevel>;
  private globalApprovalOverrides: Record<string, boolean>;
  private statePath: string;
  private auditLogger?: ToolRegistryAuditLogger;

  constructor({
    statePath,
    defaultEnabledTools = [],
    auditLogger,
  }: ToolRegistryOptions) {
    super();
    this.statePath = statePath;
    this.auditLogger = auditLogger;
    const state = loadState(statePath);

    if (state) {
      this.enabledTools = new Set(state.enabledTools);
      this.customRiskOverrides = state.customRiskOverrides;
      this.globalApprovalOverrides = state.globalApprovalOverrides;
    } else {
      this.enabledTools =
        defaultEnabledTools.length > 0 ? new Set(defaultEnabledTools) : null;
      this.customRiskOverrides = { ...defaultState.customRiskOverrides };
      this.globalApprovalOverrides = {
        ...defaultState.globalApprovalOverrides,
      };
    }
  }

  registerTool(tool: ToolDefinition) {
    this.tools.set(tool.name, tool);
  }

  getToolDefinition(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Inject (or swap) the audit logger after construction. */
  setAuditLogger(logger: ToolRegistryAuditLogger | undefined): void {
    this.auditLogger = logger;
  }

  /**
   * Invoke a registered tool with audit logging.
   *
   * - Validates args against the tool's Zod schema (so callers can't bypass schema stripping).
   * - Emits `tool_invoked` before the handler runs and `tool_invoke_succeeded` /
   *   `tool_invoke_failed` after.
   * - Returns the handler result verbatim (does not throw on validation errors —
   *   returns `{ text, isError: true }` so callers can render the message).
   *
   * Prefer this over `getToolDefinition(name).handler(args)` whenever the call
   * originates outside the chat/SDK loop (Director Studio, admin actions, schedulers).
   */
  async invokeTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolInvocationContext = {},
  ): Promise<{ text: string; isError?: boolean }> {
    const tool = this.tools.get(name);
    if (!tool) {
      const msg = `Unknown tool: ${name}`;
      await this.safeAudit({
        level: "warn",
        category: "tool",
        event: "tool_invoke_failed",
        sessionId: context.sessionId,
        userId: context.userId,
        details: { tool: name, source: context.source, error: msg },
      });
      return { text: msg, isError: true };
    }

    const parsed = tool.zodSchema.safeParse(args);
    if (!parsed.success) {
      const msg = `Invalid arguments for ${name}: ${parsed.error.message}`;
      await this.safeAudit({
        level: "warn",
        category: "tool",
        event: "tool_invoke_failed",
        sessionId: context.sessionId,
        userId: context.userId,
        details: {
          tool: name,
          source: context.source,
          error: msg,
          issues: parsed.error.issues,
        },
      });
      return { text: msg, isError: true };
    }

    await this.safeAudit({
      level: "info",
      category: "tool",
      event: "tool_invoked",
      sessionId: context.sessionId,
      userId: context.userId,
      details: {
        tool: name,
        source: context.source,
        args: parsed.data as Record<string, unknown>,
      },
    });

    try {
      const result = await tool.handler(parsed.data as Record<string, unknown>);
      await this.safeAudit({
        level: result.isError ? "warn" : "info",
        category: "tool",
        event: result.isError ? "tool_invoke_failed" : "tool_invoke_succeeded",
        sessionId: context.sessionId,
        userId: context.userId,
        details: {
          tool: name,
          source: context.source,
          isError: result.isError ?? false,
          textPreview:
            typeof result.text === "string"
              ? result.text.slice(0, 500)
              : undefined,
        },
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.safeAudit({
        level: "error",
        category: "tool",
        event: "tool_invoke_failed",
        sessionId: context.sessionId,
        userId: context.userId,
        details: {
          tool: name,
          source: context.source,
          error: message,
        },
      });
      return { text: `Tool execution failed: ${message}`, isError: true };
    }
  }

  private async safeAudit(
    entry: Parameters<ToolRegistryAuditLogger["log"]>[0],
  ): Promise<void> {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.log(entry);
    } catch {
      // Never let audit failures bubble into tool callers.
    }
  }

  getAllTools(): Record<ToolCategory, ToolInfo[]> {
    const grouped = Object.fromEntries(
      toolCategories.map((category) => [category, []]),
    ) as unknown as Record<ToolCategory, ToolInfo[]>;

    for (const tool of this.tools.values()) {
      const riskLevel = this.getRiskLevel(tool.name) ?? tool.riskLevel;
      grouped[tool.category].push({
        name: tool.name,
        description: tool.description,
        category: tool.category,
        riskLevel,
        enabled: this.isEnabled(tool.name),
        source: tool.source,
        globalApprovalRequired:
          this.globalApprovalOverrides[tool.name] === true ? true : undefined,
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
      enabled: this.isEnabled(name),
      source: tool.source,
      globalApprovalRequired:
        this.globalApprovalOverrides[name] === true ? true : undefined,
    };
  }

  /** Return all tools that belong to a given source/sidecar. */
  getToolsBySource(source: string): ToolInfo[] {
    const result: ToolInfo[] = [];
    for (const tool of this.tools.values()) {
      if (tool.source === source) {
        result.push({
          name: tool.name,
          description: tool.description,
          category: tool.category,
          riskLevel: this.getRiskLevel(tool.name) ?? tool.riskLevel,
          enabled: this.isEnabled(tool.name),
          source: tool.source,
          globalApprovalRequired:
            this.globalApprovalOverrides[tool.name] === true ? true : undefined,
        });
      }
    }
    return result;
  }

  listEnabledTools(): ToolDefinition[] {
    if (this.enabledTools === null) {
      return Array.from(this.tools.values());
    }
    return Array.from(this.tools.values()).filter(
      (tool) =>
        this.enabledTools?.has(tool.name) || ALWAYS_ON_TOOLS.has(tool.name),
    );
  }

  /** Return all registered tools regardless of enabled/disabled state. */
  listAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  isEnabled(name: string): boolean {
    if (this.enabledTools === null) {
      return true;
    }
    return this.enabledTools.has(name) || ALWAYS_ON_TOOLS.has(name);
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

    await this.persistState();
    this.emit("tool:toggled", { name, enabled });
  }

  /** Returns true if the tool requires approval (either via risk level or global override). */
  requiresApproval(name: string): boolean {
    if (this.globalApprovalOverrides[name] === true) {
      return true;
    }
    const riskLevel =
      this.getRiskLevel(name) ?? this.tools.get(name)?.riskLevel;
    return riskLevel === "high";
  }

  /** Returns true if the tool has a global approval lock (regardless of risk level). */
  requiresGlobalApproval(name: string): boolean {
    return this.globalApprovalOverrides[name] === true;
  }

  /** Set or clear a global approval override for a tool. */
  async setGlobalApprovalOverride(name: string, required: boolean) {
    if (!this.tools.has(name)) {
      throw new Error(`Unknown tool: ${name}`);
    }

    if (required) {
      this.globalApprovalOverrides[name] = true;
    } else {
      delete this.globalApprovalOverrides[name];
    }

    await this.persistState();
    this.emit("tool:globalApprovalChanged", { name, required });
  }

  async setRiskOverride(name: string, riskLevel: RiskLevel) {
    if (!this.tools.has(name)) {
      throw new Error(`Unknown tool: ${name}`);
    }

    this.customRiskOverrides[name] = riskLevel;

    if (this.enabledTools === null) {
      this.enabledTools = new Set(this.tools.keys());
    }

    await this.persistState();
    this.emit("tool:riskChanged", { name, riskLevel });
  }

  getEffectiveRiskLevel(name: string): RiskLevel | undefined {
    return this.getRiskLevel(name) ?? this.tools.get(name)?.riskLevel;
  }

  private getRiskLevel(name: string): RiskLevel | undefined {
    return this.customRiskOverrides[name];
  }

  /** Persist the full registry state (enabled tools, risk overrides, global approval overrides). */
  private async persistState() {
    if (this.enabledTools === null) {
      this.enabledTools = new Set(this.tools.keys());
    }
    await saveState(this.statePath, {
      enabledTools: Array.from(this.enabledTools).sort(),
      customRiskOverrides: this.customRiskOverrides,
      globalApprovalOverrides: this.globalApprovalOverrides,
    });
  }
}
