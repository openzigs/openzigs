import path from "node:path";
import fs from "node:fs/promises";
import { isPathAllowed } from "./path-utils.js";

export type FilesystemHandlers = {
  readFile: (input: { path: string }) => Promise<{ content: string }>;
  listDirectory: (input: { path: string }) => Promise<{ entries: { name: string; type: "file" | "directory" }[] }>;
  writeFile: (input: { path: string; content: string }) => Promise<{ success: true }>;
};

type FilesystemOptions = {
  allowedDirs: string[];
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
    listDirectory: async ({ path: dirPath }) => {
      ensureAllowed(dirPath, allowedDirs);
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return {
        entries: entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file"
        }))
      };
    },
    writeFile: async ({ path: filePath, content }) => {
      ensureAllowed(filePath, allowedDirs);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf-8");
      return { success: true };
    }
  };
};
