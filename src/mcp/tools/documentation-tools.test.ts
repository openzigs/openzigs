import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createDocumentationTools } from "./documentation-tools.js";

let tmpDir: string;
let docsDir: string;
let configDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-doc-test-"));
  docsDir = path.join(tmpDir, "docs");
  configDir = path.join(tmpDir, "config");
  await fs.mkdir(docsDir, { recursive: true });
  await fs.mkdir(configDir, { recursive: true });

  // Create test documentation files
  await fs.writeFile(
    path.join(docsDir, "ARCHITECTURE.md"),
    [
      "# Architecture",
      "",
      "## Approval Queue",
      "The approval queue gates high-risk tool executions.",
      "Tools with riskLevel: high require human approval before execution.",
      "",
      "## Tool Registry",
      "The ToolRegistry manages all registered tools.",
      "Each tool has a name, category, and risk level.",
      "",
      "## Channels",
      "OpenZigs supports Telegram, Discord, and Web Chat channels.",
    ].join("\n"),
    "utf-8"
  );

  await fs.writeFile(
    path.join(docsDir, "USER_GUIDE.md"),
    [
      "# User Guide",
      "",
      "## Getting Started",
      "Welcome to OpenZigs! Follow these steps to get started.",
      "",
      "## Scheduling Jobs",
      "You can schedule recurring jobs using the Scheduler page.",
      "Jobs support cron expressions and timezone configuration.",
    ].join("\n"),
    "utf-8"
  );

  await fs.writeFile(
    path.join(docsDir, "TELEGRAM_SETUP.md"),
    [
      "# Telegram Setup",
      "",
      "## Prerequisites",
      "You need a Telegram bot token from @BotFather.",
      "",
      "## Configuration",
      "Set the TELEGRAM_BOT_TOKEN environment variable.",
    ].join("\n"),
    "utf-8"
  );

  await fs.writeFile(
    path.join(configDir, "default.json"),
    JSON.stringify(
      {
        server: { port: 3000 },
        channels: { telegram: { enabled: false } },
      },
      null,
      2
    ),
    "utf-8"
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("documentation-tools", () => {
  it("registers query-documentation tool with correct metadata", () => {
    const tools = createDocumentationTools({ docsDir, configDir });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("query-documentation");
    expect(tools[0].category).toBe("productivity");
    expect(tools[0].riskLevel).toBe("low");
  });

  it("searches across all docs for a topic", async () => {
    const tools = createDocumentationTools({ docsDir, configDir });
    const result = await tools[0].handler({ topic: "approval queue" });

    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Approval Queue");
    expect(result.text).toContain("high-risk tool");
  });

  it("searches a specific file when provided", async () => {
    const tools = createDocumentationTools({ docsDir, configDir });
    const result = await tools[0].handler({
      topic: "telegram",
      file: "TELEGRAM_SETUP",
    });

    expect(result.text).toContain("TELEGRAM_SETUP.md");
    expect(result.text).toContain("BotFather");
  });

  it("returns no-results message for unmatched topics", async () => {
    const tools = createDocumentationTools({ docsDir, configDir });
    const result = await tools[0].handler({ topic: "quantum computing" });

    expect(result.text).toContain("No documentation found");
  });

  it("handles config file search", async () => {
    const tools = createDocumentationTools({ docsDir, configDir });
    const result = await tools[0].handler({
      topic: "telegram",
      file: "CONFIG",
    });

    expect(result.text).toContain("default.json");
    expect(result.text).toContain("telegram");
  });

  it("rejects very short topics", async () => {
    const tools = createDocumentationTools({ docsDir, configDir });
    const result = await tools[0].handler({ topic: "a b" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("more specific");
  });

  it("returns relevant sections from scheduling documentation", async () => {
    const tools = createDocumentationTools({ docsDir, configDir });
    const result = await tools[0].handler({ topic: "scheduling jobs cron" });

    expect(result.text).toContain("Scheduling Jobs");
    expect(result.text).toContain("cron");
  });
});
