import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

type ShellExecuteInput = {
  command: string;
  cwd?: string;
  timeout?: number;
};

type ShellExecuteOutput = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export const createShellExecuteHandler = () => {
  return async ({ command, cwd, timeout = 30000 }: ShellExecuteInput): Promise<ShellExecuteOutput> => {
    try {
      const result = await execAsync(command, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 });
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
