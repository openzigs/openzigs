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

export const createShellExecuteHandler = (
  { allowlist = [], allowedDirs = [], auditLogger }: ShellExecuteOptions = {}
) => {
  return async ({ command, args = [], cwd, timeout = 30000 }: ShellExecuteInput): Promise<ShellExecuteOutput> => {
    const startedAt = Date.now();
    if (auditLogger) {
      void auditLogger.log({
        level: "security",
        category: "tool",
        event: "shell_execute_requested",
        details: { command, args, cwd, timeout }
      });
    }

    if (allowlist.length === 0) {
      if (auditLogger) {
        void auditLogger.log({
          level: "security",
          category: "tool",
          event: "shell_execute_denied",
          details: { command, args, cwd, timeout, reason: "allowlist_empty" }
        });
      }
      return {
        stdout: "",
        stderr: "Shell tool disabled by default. Configure an allowlist to enable.",
        exitCode: 1
      };
    }

    if (!allowlist.includes(command)) {
      if (auditLogger) {
        void auditLogger.log({
          level: "security",
          category: "tool",
          event: "shell_execute_denied",
          details: { command, args, cwd, timeout, reason: "command_not_allowed" }
        });
      }
      return {
        stdout: "",
        stderr: `Shell command not allowed: ${command}`,
        exitCode: 1
      };
    }

    if (cwd && allowedDirs.length > 0 && !isPathAllowed(cwd, allowedDirs)) {
      if (auditLogger) {
        void auditLogger.log({
          level: "security",
          category: "tool",
          event: "shell_execute_denied",
          details: { command, args, cwd, timeout, reason: "cwd_not_allowed" }
        });
      }
      return {
        stdout: "",
        stderr: `Shell cwd not allowed: ${cwd}`,
        exitCode: 1
      };
    }

    try {
      const result = await execFileAsync(command, args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 });
      const output = {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: 0
      };
      if (auditLogger) {
        void auditLogger.log({
          level: "security",
          category: "tool",
          event: "shell_execute_result",
          details: {
            command,
            args,
            cwd,
            timeout,
            exitCode: output.exitCode,
            durationMs: Date.now() - startedAt
          }
        });
      }
      return output;
    } catch (error) {
      const execError = error as { stdout?: string; stderr?: string; code?: number };
      const output = {
        stdout: execError.stdout ?? "",
        stderr: execError.stderr ?? String(error),
        exitCode: execError.code ?? 1
      };
      if (auditLogger) {
        void auditLogger.log({
          level: "security",
          category: "tool",
          event: "shell_execute_result",
          details: {
            command,
            args,
            cwd,
            timeout,
            exitCode: output.exitCode,
            durationMs: Date.now() - startedAt
          }
        });
      }
      return output;
    }
  };
};
