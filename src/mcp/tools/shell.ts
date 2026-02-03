import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isPathAllowed } from "./path-utils.js";

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
};

export const createShellExecuteHandler = (
  { allowlist = [], allowedDirs = [] }: ShellExecuteOptions = {}
) => {
  return async ({ command, args = [], cwd, timeout = 30000 }: ShellExecuteInput): Promise<ShellExecuteOutput> => {
    if (allowlist.length === 0) {
      return {
        stdout: "",
        stderr: "Shell tool disabled by default. Configure an allowlist to enable.",
        exitCode: 1
      };
    }

    if (!allowlist.includes(command)) {
      return {
        stdout: "",
        stderr: `Shell command not allowed: ${command}`,
        exitCode: 1
      };
    }

    if (cwd && allowedDirs.length > 0 && !isPathAllowed(cwd, allowedDirs)) {
      return {
        stdout: "",
        stderr: `Shell cwd not allowed: ${cwd}`,
        exitCode: 1
      };
    }

    try {
      const result = await execFileAsync(command, args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: 0
      };
    } catch (error) {
      const execError = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: execError.stdout ?? "",
        stderr: execError.stderr ?? String(error),
        exitCode: execError.code ?? 1
      };
    }
  };
};
