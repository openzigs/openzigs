/**
 * Path validation utilities for preventing directory traversal attacks.
 *
 * Issue #580: Blocks path injection by ensuring all resolved paths stay
 * within their designated base directories.
 */

import path from "node:path";

/**
 * Resolve a user-supplied path relative to a base directory and validate
 * that the result stays within the base.  Throws on traversal attempts.
 *
 * @param userPath  Untrusted path from user input
 * @param baseDir   Trusted base directory the path must stay within
 * @returns         The resolved absolute path
 * @throws          Error if the path escapes the base directory
 */
export function sanitizePath(userPath: string, baseDir: string): string {
  if (userPath.includes("\0")) {
    throw new Error("Path contains null bytes");
  }
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, userPath);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }
  return resolved;
}

/**
 * Validate that an already-resolved absolute path is within the allowed
 * base directory.  This is a post-resolve check for cases where the path
 * has already been resolved elsewhere.
 *
 * @param resolvedPath  Already-resolved absolute path
 * @param baseDir       Trusted base directory
 * @returns             The validated resolved path
 * @throws              Error if the path is outside the base directory
 */
export function validateResolvedPath(resolvedPath: string, baseDir: string): string {
  if (resolvedPath.includes("\0")) {
    throw new Error("Path contains null bytes");
  }
  const resolvedBase = path.resolve(baseDir);
  const normalizedPath = path.resolve(resolvedPath);
  if (normalizedPath !== resolvedBase && !normalizedPath.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Path outside allowed directory: ${resolvedPath}`);
  }
  return normalizedPath;
}

/**
 * Validate a single path component (filename, session ID, document ID, etc.)
 * that must not contain directory separators, traversal sequences, or null bytes.
 *
 * @param component   Untrusted path component
 * @param label       Human-readable label for error messages (e.g. "session ID")
 * @returns           The validated component string
 * @throws            Error if the component is invalid
 */
export function sanitizePathComponent(component: string, label = "path component"): string {
  if (component.includes("\0")) {
    throw new Error(`${label} contains null bytes`);
  }
  if (component.includes("..") || component.includes("/") || component.includes("\\")) {
    throw new Error(`Invalid ${label}: ${component}`);
  }
  return component;
}
