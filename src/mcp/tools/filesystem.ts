import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { isPathAllowed } from "./path-utils.js";

function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/") || filePath === "~") {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

export type FilesystemHandlers = {
  readFile: (input: { path: string }) => Promise<{ content: string }>;
  listDirectory: (input: { path: string }) => Promise<{ entries: { name: string; type: "file" | "directory" }[] }>;
  listDirectoryRecursive: (input: { path: string }) => Promise<{ entries: { name: string; type: "file" | "directory" }[] }>;
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
      const resolved = expandTilde(filePath);
      ensureAllowed(resolved, allowedDirs);
      const content = await fs.readFile(resolved, "utf-8");
      return { content };
    },
    listDirectory: async ({ path: dirPath }) => {
      const resolved = expandTilde(dirPath);
      ensureAllowed(resolved, allowedDirs);
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      return {
        entries: entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file"
        }))
      };
    },
    listDirectoryRecursive: async ({ path: dirPath }) => {
      const resolved = expandTilde(dirPath);
      ensureAllowed(resolved, allowedDirs);
      const results: { name: string; type: "file" | "directory" }[] = [];
      const walk = async (dir: string) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(dirPath, fullPath);
          if (entry.name === ".git" || entry.name === "node_modules") continue;
          results.push({
            name: relativePath,
            type: entry.isDirectory() ? "directory" : "file"
          });
          if (entry.isDirectory()) {
            await walk(fullPath);
          }
        }
      };
      await walk(dirPath);
      return { entries: results };
    },
    writeFile: async ({ path: filePath, content }) => {
      const resolved = expandTilde(filePath);
      ensureAllowed(resolved, allowedDirs);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, "utf-8");
      return { success: true };
    }
  };
};
