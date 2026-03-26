/**
 * Cross-platform file permission helpers.
 *
 * NTFS on Windows silently ignores Unix permission modes (0o600, 0o700, etc.).
 * Calling `chmod()` on Windows is a no-op but doesn't throw — however it can
 * cause confusion and masking issues. This module centralises the permission
 * logic so callers don't need to care about the host OS.
 *
 * Issue #598
 */

import fs from "node:fs/promises";

const IS_WINDOWS = process.platform === "win32";

/**
 * Options for writing a secure file (owner-only permissions on Unix).
 * On Windows the `mode` key is omitted since NTFS ignores it.
 */
export function secureFileOptions(): { mode?: number } {
  return IS_WINDOWS ? {} : { mode: 0o600 };
}

/**
 * Options for creating a secure directory (owner-only permissions on Unix).
 * On Windows the `mode` key is omitted since NTFS ignores it.
 */
export function secureDirOptions(): { recursive: true; mode?: number } {
  return IS_WINDOWS ? { recursive: true } : { recursive: true, mode: 0o700 };
}

/**
 * Set 0o600 (owner read/write) permissions on a file.
 * No-op on Windows where NTFS does not support Unix modes.
 */
export async function chmodSecureFile(filePath: string): Promise<void> {
  if (IS_WINDOWS) return;
  await fs.chmod(filePath, 0o600);
}

/**
 * Combine common write-file options: encoding + secure mode.
 */
export function secureWriteOptions(): { encoding: BufferEncoding; mode?: number } {
  return { encoding: "utf-8", ...secureFileOptions() };
}
