import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createShellExecuteHandler } from "./shell.js";

const command = process.platform === "win32" ? "cmd" : "echo";
const args = process.platform === "win32" ? ["/c", "echo", "test"] : ["test"];
const handler = createShellExecuteHandler({ allowlist: [command] });

describe("shell execute handler", () => {
  it("executes a command and returns stdout", async () => {
    const result = await handler({ command, args, timeout: 5000 });

    expect(result.stdout.toLowerCase()).toContain("test");
    expect(result.exitCode).toBe(0);
  });

  it("rejects cwd outside allowed directories", async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-shell-"));
    const disallowedCwd = path.resolve(process.cwd());
    const guardedHandler = createShellExecuteHandler({
      allowlist: [command],
      allowedDirs: [allowedRoot]
    });

    const result = await guardedHandler({ command, args, cwd: disallowedCwd, timeout: 5000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/cwd not allowed/i);
  });
});
