import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import * as z from "zod";
import {
  ToolRegistry,
  type ToolDefinition,
  type ToolRegistryAuditLogger,
} from "./tool-registry.js";

const buildTool = (
  overrides: Partial<ToolDefinition> & Pick<ToolDefinition, "name">,
): ToolDefinition => ({
  name: overrides.name,
  description: overrides.description ?? `${overrides.name} tool`,
  inputSchema: { type: "object", properties: {} },
  zodSchema: overrides.zodSchema ?? z.object({ foo: z.string() }),
  category: overrides.category ?? "developer",
  riskLevel: overrides.riskLevel ?? "low",
  handler:
    overrides.handler ?? (async (args) => ({ text: JSON.stringify(args) })),
  source: overrides.source,
});

const createStateFile = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-invoke-"));
  return path.join(dir, "tools.json");
};

const makeLogger = (): {
  logger: ToolRegistryAuditLogger;
  calls: Array<Parameters<ToolRegistryAuditLogger["log"]>[0]>;
} => {
  const calls: Array<Parameters<ToolRegistryAuditLogger["log"]>[0]> = [];
  return {
    calls,
    logger: {
      log: vi.fn(async (entry) => {
        calls.push(entry);
        return entry;
      }),
    },
  };
};

describe("ToolRegistry.invokeTool", () => {
  it("validates args, calls the handler, and writes audit entries on success", async () => {
    const statePath = await createStateFile();
    const { logger, calls } = makeLogger();
    const registry = new ToolRegistry({ statePath, auditLogger: logger });

    const handler = vi.fn(async (args: Record<string, unknown>) => ({
      text: `hello ${args.foo as string}`,
    }));
    registry.registerTool(
      buildTool({
        name: "test-tool",
        handler,
        zodSchema: z.object({ foo: z.string() }),
      }),
    );

    const result = await registry.invokeTool(
      "test-tool",
      { foo: "world" },
      { source: "director-studio", sessionId: "sess-1" },
    );

    expect(result.text).toBe("hello world");
    expect(result.isError).toBeFalsy();
    expect(handler).toHaveBeenCalledWith({ foo: "world" });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.event).toBe("tool_invoked");
    expect(calls[0]?.category).toBe("tool");
    expect(calls[0]?.sessionId).toBe("sess-1");
    expect(calls[0]?.details).toMatchObject({
      tool: "test-tool",
      source: "director-studio",
      args: { foo: "world" },
    });
    expect(calls[1]?.event).toBe("tool_invoke_succeeded");
    expect(calls[1]?.details).toMatchObject({
      tool: "test-tool",
      source: "director-studio",
      isError: false,
    });
  });

  it("rejects invalid args without calling the handler", async () => {
    const statePath = await createStateFile();
    const { logger, calls } = makeLogger();
    const registry = new ToolRegistry({ statePath, auditLogger: logger });

    const handler = vi.fn();
    registry.registerTool(
      buildTool({
        name: "strict-tool",
        handler,
        zodSchema: z.object({ foo: z.string() }),
      }),
    );

    const result = await registry.invokeTool("strict-tool", { foo: 42 });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Invalid arguments");
    expect(handler).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.event).toBe("tool_invoke_failed");
  });

  it("logs tool_invoke_failed when the handler throws", async () => {
    const statePath = await createStateFile();
    const { logger, calls } = makeLogger();
    const registry = new ToolRegistry({ statePath, auditLogger: logger });

    registry.registerTool(
      buildTool({
        name: "boom",
        handler: async () => {
          throw new Error("boom went off");
        },
      }),
    );

    const result = await registry.invokeTool("boom", { foo: "x" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("boom went off");
    expect(calls.at(-1)?.event).toBe("tool_invoke_failed");
    expect(calls.at(-1)?.level).toBe("error");
  });

  it("logs tool_invoke_failed when the handler returns isError=true", async () => {
    const statePath = await createStateFile();
    const { logger, calls } = makeLogger();
    const registry = new ToolRegistry({ statePath, auditLogger: logger });

    registry.registerTool(
      buildTool({
        name: "soft-fail",
        handler: async () => ({ text: "nope", isError: true }),
      }),
    );

    const result = await registry.invokeTool("soft-fail", { foo: "x" });
    expect(result.isError).toBe(true);
    expect(calls.at(-1)?.event).toBe("tool_invoke_failed");
    expect(calls.at(-1)?.level).toBe("warn");
  });

  it("returns isError for an unknown tool and audits the attempt", async () => {
    const statePath = await createStateFile();
    const { logger, calls } = makeLogger();
    const registry = new ToolRegistry({ statePath, auditLogger: logger });

    const result = await registry.invokeTool("ghost", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown tool");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.event).toBe("tool_invoke_failed");
  });

  it("survives an audit logger that throws", async () => {
    const statePath = await createStateFile();
    const registry = new ToolRegistry({
      statePath,
      auditLogger: {
        log: vi.fn(async () => Promise.reject(new Error("disk full"))),
      },
    });
    registry.registerTool(
      buildTool({
        name: "ok",
        handler: async () => ({ text: "fine" }),
      }),
    );

    const result = await registry.invokeTool("ok", { foo: "y" });
    expect(result.text).toBe("fine");
    expect(result.isError).toBeFalsy();
  });

  it("invokes tools without an audit logger configured", async () => {
    const statePath = await createStateFile();
    const registry = new ToolRegistry({ statePath });
    registry.registerTool(
      buildTool({
        name: "no-audit",
        handler: async () => ({ text: "ran" }),
      }),
    );
    const result = await registry.invokeTool("no-audit", { foo: "x" });
    expect(result.text).toBe("ran");
    expect(result.isError).toBeFalsy();
  });

  it("setAuditLogger swaps in a fresh logger that receives subsequent events", async () => {
    const statePath = await createStateFile();
    const registry = new ToolRegistry({ statePath });
    registry.registerTool(buildTool({ name: "swap" }));
    const { logger, calls } = makeLogger();
    registry.setAuditLogger(logger);
    await registry.invokeTool("swap", { foo: "y" });
    const events = calls.map((c) => c.event);
    expect(events).toContain("tool_invoked");
    expect(events).toContain("tool_invoke_succeeded");
  });

  it("loads persisted state on construction (enabled list and risk overrides)", async () => {
    const statePath = await createStateFile();
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      JSON.stringify({
        enabledTools: ["persisted-tool"],
        customRiskOverrides: { "persisted-tool": "high" },
        globalApprovalOverrides: { "persisted-tool": true },
      }),
    );
    const registry = new ToolRegistry({ statePath });
    registry.registerTool(
      buildTool({ name: "persisted-tool", riskLevel: "low" }),
    );
    const info = registry.getToolInfo("persisted-tool");
    expect(info?.enabled).toBe(true);
    expect(info?.riskLevel).toBe("high");
    expect(registry.getEffectiveRiskLevel("persisted-tool")).toBe("high");
  });
});
