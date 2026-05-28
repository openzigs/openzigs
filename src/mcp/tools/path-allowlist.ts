/**
 * Path allowlist guard for MCP tools that read files from disk.
 *
 * Threat model: an MCP tool that accepts a `file_path` from an LLM/agent is a
 * remote-controlled file read. Without a guard, the agent can be tricked into
 * uploading `~/.openzigs/auth.json`, `~/.ssh/id_rsa`, `/etc/passwd`, etc. to a
 * third-party service. Existence checks (`fs.access`) do nothing here — the
 * attacker is asking for a file that exists.
 *
 * The guard:
 *   1. Expands `~` → `os.homedir()` and resolves to an absolute path.
 *   2. Calls `fs.realpath` so symlinks pointing outside the allowlist are
 *      followed and then rejected.
 *   3. Requires the resolved path to live strictly under one of the allowlist
 *      roots (`~/.openzigs/renders`, `/uploads`, `/library`, `/files`, plus any
 *      caller-supplied extras such as `config.uploads.allowedDirs`).
 *   4. Optionally sniffs the file's first ~16 bytes against a magic-number
 *      table — extension is never trusted on its own.
 *
 * Sensitive files inside the openzigs home (auth.json, vault*, wizard
 * credentials) are explicitly denied even when nominally inside an allowlist
 * root, so a misconfiguration that allowlists `~/.openzigs` itself can't leak
 * them.
 */

import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";

const OPENZIGS_HOME = (): string => path.join(os.homedir(), ".openzigs");

/** Roots a tool may read from by default. */
export const DEFAULT_ALLOWLIST_ROOTS = (): string[] => {
  const home = OPENZIGS_HOME();
  return [
    path.join(home, "renders"),
    path.join(home, "uploads"),
    path.join(home, "library"),
    path.join(home, "files"),
  ];
};

/** Files inside the openzigs home that must never be read by a tool. */
const DENY_BASENAMES = new Set([
  "auth.json",
  "wizard-credentials.enc",
  "vllm-api-key",
  "config.json",
]);

const DENY_PREFIXES = ["vault"];

export interface AllowlistOptions {
  /** Extra allowed roots (e.g. from `config.uploads.allowedDirs`). */
  extraRoots?: string[];
  /** Override the home dir used to derive defaults (for tests). */
  homeDir?: string;
}

export class PathNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathNotAllowedError";
  }
}

const expandHome = (p: string, home: string): string => {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith(`~${path.sep}`)) {
    return path.join(home, p.slice(2));
  }
  return p;
};

const isDenied = (resolved: string, home: string): boolean => {
  const base = path.basename(resolved);
  if (DENY_BASENAMES.has(base)) return true;
  if (DENY_PREFIXES.some((prefix) => base.startsWith(prefix))) return true;
  // Anything directly inside the openzigs home (not a subdir) is sensitive
  // metadata; only the explicit subdirs in DEFAULT_ALLOWLIST_ROOTS are OK.
  const parent = path.dirname(resolved);
  if (parent === home) {
    return true;
  }
  return false;
};

/**
 * Resolve `inputPath` and assert it lives under an allowed root. Returns the
 * canonical absolute path the caller should use for subsequent I/O. Throws
 * `PathNotAllowedError` if the path is outside the allowlist, points at a
 * deny-listed file, or cannot be canonicalized.
 */
export const assertPathAllowed = async (
  inputPath: string,
  opts: AllowlistOptions = {},
): Promise<string> => {
  if (!inputPath || typeof inputPath !== "string") {
    throw new PathNotAllowedError("file path is required");
  }
  const home = opts.homeDir ?? os.homedir();
  const openzigsHome = path.join(home, ".openzigs");

  const expanded = expandHome(inputPath, home);
  const absolute = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(expanded);

  let resolved: string;
  try {
    resolved = await fsPromises.realpath(absolute);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PathNotAllowedError(`cannot resolve path: ${reason}`);
  }

  if (isDenied(resolved, openzigsHome)) {
    throw new PathNotAllowedError(
      `path is denied by policy: ${path.basename(resolved)}`,
    );
  }

  const defaultRoots = opts.homeDir
    ? [
        path.join(openzigsHome, "renders"),
        path.join(openzigsHome, "uploads"),
        path.join(openzigsHome, "library"),
        path.join(openzigsHome, "files"),
      ]
    : DEFAULT_ALLOWLIST_ROOTS();
  const extra = (opts.extraRoots ?? []).map((r) =>
    path.resolve(expandHome(r, home)),
  );
  const roots = [...defaultRoots, ...extra];

  const ok = roots.some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
  if (!ok) {
    throw new PathNotAllowedError(
      `path is outside the allowed directories (${roots.join(", ")})`,
    );
  }
  return resolved;
};

/** Allowed video container MIME types for upload tools. */
export const VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/x-msvideo",
] as const;

/** Allowed image MIME types for thumbnail tools (per YouTube docs). */
export const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/bmp",
] as const;

export type SniffedMime =
  | (typeof VIDEO_MIME_TYPES)[number]
  | (typeof IMAGE_MIME_TYPES)[number];

/**
 * Sniff the file's first 16 bytes and return the detected MIME, or `null` if
 * it doesn't match any known container we accept. Extension is intentionally
 * ignored — a `.mp4` file containing a shell script must not pass.
 */
export const sniffFileMime = async (
  filePath: string,
): Promise<SniffedMime | null> => {
  let handle: Awaited<ReturnType<typeof fsPromises.open>> | null = null;
  try {
    handle = await fsPromises.open(filePath, "r");
    const buf = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buf, 0, 16, 0);
    if (bytesRead < 4) return null;
    return detectMime(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
};

const detectMime = (buf: Buffer): SniffedMime | null => {
  // Images
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return "image/gif";
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return "image/bmp";
  }

  // Videos
  // ISO BMFF (mp4 / mov / m4v): bytes 4..7 == "ftyp"
  if (
    buf.length >= 12 &&
    buf[4] === 0x66 &&
    buf[5] === 0x74 &&
    buf[6] === 0x79 &&
    buf[7] === 0x70
  ) {
    const brand = buf.subarray(8, 12).toString("ascii");
    if (brand.startsWith("qt")) return "video/quicktime";
    // mp4, isom, M4V, dash, avc1, mp42, etc. all map to mp4 for upload purposes
    return "video/mp4";
  }
  // EBML (webm / mkv): 1A 45 DF A3
  if (
    buf.length >= 4 &&
    buf[0] === 0x1a &&
    buf[1] === 0x45 &&
    buf[2] === 0xdf &&
    buf[3] === 0xa3
  ) {
    // We can't distinguish webm vs mkv from the EBML header alone without
    // parsing the DocType element; YouTube accepts both as webm/mkv MIME.
    return "video/webm";
  }
  // RIFF AVI: "RIFF....AVI "
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x41 &&
    buf[9] === 0x56 &&
    buf[10] === 0x49 &&
    buf[11] === 0x20
  ) {
    return "video/x-msvideo";
  }
  return null;
};
