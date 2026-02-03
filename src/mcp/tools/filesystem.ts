import path from "node:path";
import fs from "node:fs/promises";

export type FilesystemHandlers = {
  readFile: (input: { path: string }) => Promise<{ content: string }>;
  writeFile: (input: { path: string; content: string }) => Promise<{ success: true }>;
};

type FilesystemOptions = {
  allowedDirs: string[];
};

const normalizeDir = (dirPath: string) => path.resolve(dirPath);

const isPathAllowed = (filePath: string, allowedDirs: string[]): boolean => {
  const resolvedPath = path.resolve(filePath);
  return allowedDirs.some((dir) => {
    const resolvedDir = normalizeDir(dir);
    return resolvedPath === resolvedDir || resolvedPath.startsWith(`${resolvedDir}${path.sep}`);
  });
};

const ensureAllowed = (filePath: string, allowedDirs: string[]) => {
  if (!isPathAllowed(filePath, allowedDirs)) {
    throw new Error(`Access denied for path: ${filePath}`);
  }
};

export const createFilesystemHandlers = ({ allowedDirs }: FilesystemOptions): FilesystemHandlers => {
  return {
    readFile: async ({ path: filePath }) => {
      ensureAllowed(filePath, allowedDirs);
      const content = await fs.readFile(filePath, "utf-8");
      return { content };
    },
    writeFile: async ({ path: filePath, content }) => {
      ensureAllowed(filePath, allowedDirs);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf-8");
      return { success: true };
    }
  };
};
