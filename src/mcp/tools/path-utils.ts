import path from "node:path";

export const normalizeDir = (dirPath: string) => path.resolve(dirPath);

export const isPathAllowed = (filePath: string, allowedDirs: string[]) => {
  const resolvedPath = path.resolve(filePath);
  return allowedDirs.some((dir) => {
    const resolvedDir = normalizeDir(dir);
    return resolvedPath === resolvedDir || resolvedPath.startsWith(`${resolvedDir}${path.sep}`);
  });
};
