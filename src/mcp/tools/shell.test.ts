import { describe, expect, it } from "vitest";
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
});
