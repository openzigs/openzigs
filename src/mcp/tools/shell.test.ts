import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createShellExecuteHandler, normaliseShellInput } from "./shell.js";

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

  it("handles command with args embedded in command string", async () => {
    const h = createShellExecuteHandler({ allowlist: ["echo"] });
    const result = await h({ command: "echo hello world", timeout: 5000 });

    expect(result.stdout.trim()).toBe("hello world");
    expect(result.exitCode).toBe(0);
  });

  it("rejects compound commands with && operator", async () => {
    const h = createShellExecuteHandler({ allowlist: ["echo", "ls"] });
    const result = await h({ command: "echo hi && ls", timeout: 5000 });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/compound.*operator/i);
  });

  it("rejects piped commands", async () => {
    const h = createShellExecuteHandler({ allowlist: ["echo", "grep"] });
    const result = await h({ command: "echo test | grep test", timeout: 5000 });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/compound.*operator/i);
  });

  it("rejects commands not in allowlist even with args in command string", async () => {
    const h = createShellExecuteHandler({ allowlist: ["echo"] });
    const result = await h({ command: "rm -rf /tmp/something", timeout: 5000 });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/not allowed/i);
  });
});

describe("normaliseShellInput", () => {
  it("passes through clean command + args", () => {
    const result = normaliseShellInput("git", ["-C", "/path", "pull"]);
    expect(result).toEqual({ binary: "git", args: ["-C", "/path", "pull"] });
  });

  it("splits command string when no args provided", () => {
    const result = normaliseShellInput("find /path -name '*.java'", []);
    // Surrounding quotes are stripped by normaliseShellInput
    expect(result).toEqual({ binary: "find", args: ["/path", "-name", "*.java"] });
  });

  it("extracts binary from command even when args are provided", () => {
    // Edge: command has trailing space but args are supplied
    const result = normaliseShellInput("git ", ["pull"]);
    expect(result).toEqual({ binary: "git", args: ["pull"] });
  });

  it("rejects && compound commands", () => {
    const result = normaliseShellInput("cd /tmp && ls", []);
    expect(result).toHaveProperty("error");
  });

  it("rejects || compound commands", () => {
    const result = normaliseShellInput("cmd1 || cmd2", []);
    expect(result).toHaveProperty("error");
  });

  it("rejects pipe operators", () => {
    const result = normaliseShellInput("echo test | grep test", []);
    expect(result).toHaveProperty("error");
  });

  it("rejects command substitution", () => {
    const result = normaliseShellInput("echo $(whoami)", []);
    expect(result).toHaveProperty("error");
  });

  it("rejects redirect operators", () => {
    const result = normaliseShellInput("echo test > /tmp/out", []);
    expect(result).toHaveProperty("error");
  });

  it("rejects empty command", () => {
    const result = normaliseShellInput("", []);
    expect(result).toHaveProperty("error");
  });

  it("strips surrounding quotes from parsed args", () => {
    const result = normaliseShellInput('find /path -name "*.java"', []);
    expect(result).toEqual({ binary: "find", args: ["/path", "-name", "*.java"] });
  });
});
