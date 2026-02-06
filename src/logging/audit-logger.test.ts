import { describe, expect, it, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { AuditLogger } from "./audit-logger.js";

const createTempDir = async () => {
  return fs.mkdtemp(path.join(os.tmpdir(), "openzigs-audit-"));
};

describe("AuditLogger", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("writes entries to daily JSONL files", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const dayOne = new Date("2026-02-03T10:00:00Z");
    const dayTwo = new Date("2026-02-04T10:00:00Z");

    const logger = new AuditLogger({ baseDir, clock: () => dayOne });
    await logger.log({
      level: "info",
      category: "system",
      event: "server_started",
      details: { port: 3000 }
    });

    const loggerTwo = new AuditLogger({ baseDir, clock: () => dayTwo });
    await loggerTwo.log({
      level: "security",
      category: "tool",
      event: "shell_execute",
      details: { command: "echo", args: ["hello"] }
    });

    const files = await fs.readdir(baseDir);
    expect(files).toContain("audit-2026-02-03.jsonl");
    expect(files).toContain("audit-2026-02-04.jsonl");
  });

  it("redacts sensitive values in details", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const logger = new AuditLogger({ baseDir, clock: () => new Date("2026-02-03T10:00:00Z") });
    await logger.log({
      level: "security",
      category: "tool",
      event: "secret_detected",
      details: {
        apiKey: "secret",
        nested: { token: "abc" },
        args: ["--api-key=123", "safe"],
        message: "safe"
      }
    });

    const raw = await fs.readFile(path.join(baseDir, "audit-2026-02-03.jsonl"), "utf-8");
    const entry = JSON.parse(raw.split("\n")[0]) as { details: Record<string, unknown> };

    expect(entry.details.apiKey).toBe("[REDACTED]");
    expect((entry.details.nested as { token?: string }).token).toBe("[REDACTED]");
    expect((entry.details.args as string[])[0]).toBe("[REDACTED]");
    expect(entry.details.message).toBe("safe");
  });

  it("filters query results", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const logger = new AuditLogger({ baseDir, clock: () => new Date("2026-02-03T10:00:00Z") });
    await logger.log({
      level: "security",
      category: "tool",
      event: "tool_call",
      details: { command: "ls" }
    });
    await logger.log({
      level: "info",
      category: "system",
      event: "server_started",
      details: { port: 3000 }
    });

    const results = await logger.query({ category: "tool" });
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe("tool");
  });
});
