import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isPathAllowed } from "./path-utils.js";
import type { AuditLogger } from "../../logging/audit-logger.js";

const execFileAsync = promisify(execFile);

type ShellExecuteInput = {
  command: string;
  args?: string[];
  cwd?: string;
  timeout?: number;
};

type ShellExecuteOutput = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type ShellExecuteOptions = {
  allowlist?: string[];
  allowedDirs?: string[];
  auditLogger?: AuditLogger;
};

/**
 * Shell operators and control characters that indicate compound/piped commands.
 * These are rejected because execFile cannot safely handle them and they
 * could be used for injection.
 */
const SHELL_OPERATORS = ["&&", "||", "|", ";", ">", ">>", "<", "$(", "`"];

/**
 * Normalise LLM-provided shell input into a clean binary + args pair.
 *
 * LLMs frequently send the full command line as `command` instead of splitting
 * into command + args.  For example:
 *   { command: "find /path -name '*.java'" }  instead of
 *   { command: "find", args: ["/path", "-name", "*.java"] }
 *
 * This function:
 * 1. Detects compound / piped commands (&&, ||, |, ;, etc.) → rejects them.
 * 2. If `args` is empty and `command` contains whitespace, splits `command`
 *    on whitespace to extract binary + args.
 * 3. Strips surrounding quotes from individual tokens.
 */
export const normaliseShellInput = (
  command: string,
  args: string[]
): { binary: string; args: string[] } | { error: string } => {
  // Reject compound commands — these require a real shell interpreter
  // and would bypass the allowlist intent.
  for (const op of SHELL_OPERATORS) {
    if (command.includes(op)) {
      return { error: `Compound shell operators (${op}) are not allowed. Run each command separately.` };
    }
  }

  const trimmed = command.trim();
  if (!trimmed) {
    return { error: "Empty command" };
  }

  // If args are already provided, just extract the binary name.
  if (args.length > 0) {
    const binary = trimmed.split(/\s+/)[0];
    return { binary, args };
  }

  // No args supplied — split the command string.
  // Use a simple split on whitespace (covers the common case).
  const tokens = trimmed.split(/\s+/);
  const binary = tokens[0];
  const parsedArgs = tokens.slice(1).map((t) =>
    // Strip matching surrounding quotes that the LLM sometimes adds
    t.replace(/^(["'])(.+)\1$/, "$2")
  );

  return { binary, args: parsedArgs };
};

export const createShellExecuteHandler = (
  { allowlist = [], allowedDirs = [], auditLogger }: ShellExecuteOptions = {}
) => {
  return async ({ command, args = [], cwd, timeout = 30000 }: ShellExecuteInput): Promise<ShellExecuteOutput> => {
    const startedAt = Date.now();
    const logDenial = (reason: string) => {
      if (!auditLogger) {
        return;
      }
      void auditLogger.log({
        level: "security",
        category: "tool",
        event: "shell_execute_denied",
        details: { command, args, cwd, timeout, reason }
      });
    };
    if (auditLogger) {
      void auditLogger.log({
        level: "security",
        category: "tool",
        event: "shell_execute_requested",
        details: { command, args, cwd, timeout }
      });
    }

    if (allowlist.length === 0) {
      logDenial("allowlist_empty");
      return {
        stdout: "",
        stderr: "Shell tool disabled by default. Configure an allowlist to enable.",
        exitCode: 1
      };
    }

    // Normalise the LLM-provided input: extract binary name and split
    // args when the model jams everything into the command field.
    const parsed = normaliseShellInput(command, args);
    if ("error" in parsed) {
      logDenial("compound_command_rejected");
      return {
        stdout: "",
        stderr: parsed.error,
        exitCode: 1
      };
    }

    const { binary, args: resolvedArgs } = parsed;

    if (!allowlist.includes(binary)) {
      logDenial("command_not_allowed");
      return {
        stdout: "",
        stderr: `Shell command not allowed: ${binary}`,
        exitCode: 1
      };
    }

    if (cwd && allowedDirs.length > 0 && !isPathAllowed(cwd, allowedDirs)) {
      logDenial("cwd_not_allowed");
      return {
        stdout: "",
        stderr: `Shell cwd not allowed: ${cwd}`,
        exitCode: 1
      };
    }

    let output: ShellExecuteOutput;
    try {
      const result = await execFileAsync(binary, resolvedArgs, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 });
      output = {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: 0
      };
    } catch (error) {
      const execError = error as { stdout?: string; stderr?: string; code?: number };
      output = {
        stdout: execError.stdout ?? "",
        stderr: execError.stderr ?? String(error),
        exitCode: execError.code ?? 1
      };
    }

    if (auditLogger) {
      void auditLogger.log({
        level: "security",
        category: "tool",
        event: "shell_execute_result",
        details: {
          command: binary,
          args: resolvedArgs,
          cwd,
          timeout,
          exitCode: output.exitCode,
          durationMs: Date.now() - startedAt
        }
      });
    }
    return output;
  };
};
