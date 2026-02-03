import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
};

export const createShellExecuteHandler = ({ allowlist = [] }: ShellExecuteOptions = {}) => {
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
