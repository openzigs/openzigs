import { describe, expect, it } from "vitest";
import { createShellExecuteHandler } from "./shell.js";

const handler = createShellExecuteHandler();

describe("shell execute handler", () => {
  it("executes a command and returns stdout", async () => {
    const command = process.platform === "win32" ? "cmd /c echo test" : "echo test";
    const result = await handler({ command, timeout: 5000 });

    expect(result.stdout.toLowerCase()).toContain("test");
    expect(result.exitCode).toBe(0);
  });
});
