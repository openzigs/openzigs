import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { isPathAllowed } from "../mcp/tools/path-utils.js";

/**
 * Promise wrapper for execFile that returns { stdout, stderr }.
 * We avoid `promisify(execFile)` because the custom promisify symbol
 * is lost when the module is auto-mocked in tests.
 */
const execFileAsync = (
  cmd: string,
  args: string[],
  opts: { maxBuffer: number; timeout: number },
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout as string, stderr: stderr as string });
    });
  });

/** File extensions the convert endpoint accepts for document import. */
export const CONVERTIBLE_EXTENSIONS = new Set([
  ".docx", ".pdf", ".pptx", ".xlsx", ".html", ".htm",
  ".rtf", ".csv", ".tsv", ".epub",
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".webp",
  ".mp3", ".wav", ".m4a", ".ogg",
]);

export type FilesRouterOptions = {
  allowedDirs: string[];
  /** URL of the MarkItDown Docker sidecar (e.g. http://markitdown-mcp-server:5301). */
  markitdownUrl?: string;
};

/**
 * REST API for file operations, reusing the same `allowedDirs` sandbox
 * that gates the MCP filesystem tools. All paths are resolved and validated
 * before any I/O occurs; requests outside the sandbox receive a 403.
 */
/**
 * Convert a document to Markdown. Attempts the Docker sidecar first;
 * falls back to a local `uvx markitdown[all]` invocation.
 */
const convertToMarkdown = async (
  filePath: string,
  sidecarUrl?: string,
): Promise<string> => {
  // ── Strategy 1: Docker sidecar ──
  if (sidecarUrl) {
    try {
      const resp = await fetch(`${sidecarUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "convert_to_markdown",
          params: { file_path: filePath },
        }),
      });
      if (resp.ok) {
        const body = (await resp.json()) as { result?: string };
        if (body.result) return body.result;
      }
      // Fall through to local CLI on non-ok responses
    } catch {
      // Sidecar unreachable — fall through
    }
  }

  // ── Strategy 2: local CLI via uvx ──
  try {
    const { stdout, stderr } = await execFileAsync(
      "uvx",
      ["--with", "markitdown[all]", "markitdown", filePath],
      { maxBuffer: 20 * 1024 * 1024, timeout: 120_000 },
    );
    const output = stdout.trim();
    if (!output) {
      throw new Error(stderr.trim() || "markitdown returned empty output");
    }
    return output;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Document conversion failed: ${msg}`);
  }
};

export const createFilesRouter = ({ allowedDirs, markitdownUrl }: FilesRouterOptions): Router => {
  const router = Router();

  const guardPath = (rawPath: string | undefined): { resolved: string } | { error: string } => {
    if (!rawPath || typeof rawPath !== "string") {
      return { error: "path query parameter is required" };
    }
    const resolved = path.resolve(rawPath);
    if (!isPathAllowed(resolved, allowedDirs)) {
      return { error: "Access denied" };
    }
    return { resolved };
  };

  /** GET /api/files/list?path=/dir — List directory entries. */
  router.get("/list", async (req, res) => {
    const result = guardPath(req.query.path as string | undefined);
    if ("error" in result) {
      const status = result.error === "Access denied" ? 403 : 400;
      res.status(status).json({ error: result.error });
      return;
    }

    try {
      const entries = await fs.readdir(result.resolved, { withFileTypes: true });
      res.json({
        entries: entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "directory" as const : "file" as const,
        })),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({ error: `Directory not found: ${result.resolved}` });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  /** GET /api/files/content?path=/file — Read file content. */
  router.get("/content", async (req, res) => {
    const result = guardPath(req.query.path as string | undefined);
    if ("error" in result) {
      const status = result.error === "Access denied" ? 403 : 400;
      res.status(status).json({ error: result.error });
      return;
    }

    try {
      const content = await fs.readFile(result.resolved, "utf-8");
      res.json({ content, path: result.resolved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({ error: `File not found: ${result.resolved}` });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  /** POST /api/files/save — Write content to a file. */
  router.post("/save", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const rawPath = typeof body.path === "string" ? body.path : undefined;
    const content = typeof body.content === "string" ? body.content : undefined;

    if (!rawPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    if (content === undefined) {
      res.status(400).json({ error: "content is required" });
      return;
    }

    const result = guardPath(rawPath);
    if ("error" in result) {
      const status = result.error === "Access denied" ? 403 : 400;
      res.status(status).json({ error: result.error });
      return;
    }

    try {
      await fs.mkdir(path.dirname(result.resolved), { recursive: true });
      await fs.writeFile(result.resolved, content, "utf-8");
      res.json({ success: true, path: result.resolved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /** POST /api/files/mkdir — Create a directory. */
  router.post("/mkdir", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const rawPath = typeof body.path === "string" ? body.path : undefined;

    const result = guardPath(rawPath);
    if ("error" in result) {
      const status = result.error === "Access denied" ? 403 : 400;
      res.status(status).json({ error: result.error });
      return;
    }

    try {
      await fs.mkdir(result.resolved, { recursive: true });
      res.json({ success: true, path: result.resolved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /** DELETE /api/files?path=/file — Delete a file. */
  router.delete("/", async (req, res) => {
    const result = guardPath(req.query.path as string | undefined);
    if ("error" in result) {
      const status = result.error === "Access denied" ? 403 : 400;
      res.status(status).json({ error: result.error });
      return;
    }

    try {
      await fs.unlink(result.resolved);
      res.json({ success: true, path: result.resolved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({ error: `File not found: ${result.resolved}` });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /api/files/convert — Convert a document to Markdown using
   * Microsoft MarkItDown (Docker sidecar → local CLI fallback).
   *
   * Body: { path: string }
   * Response: { markdown: string, originalPath: string }
   */
  router.post("/convert", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const rawPath = typeof body.path === "string" ? body.path : undefined;

    if (!rawPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const result = guardPath(rawPath);
    if ("error" in result) {
      const status = result.error === "Access denied" ? 403 : 400;
      res.status(status).json({ error: result.error });
      return;
    }

    // Validate the file exists
    try {
      await fs.access(result.resolved);
    } catch {
      res.status(404).json({ error: `File not found: ${result.resolved}` });
      return;
    }

    // Validate file extension is convertible
    const ext = path.extname(result.resolved).toLowerCase();
    if (!CONVERTIBLE_EXTENSIONS.has(ext)) {
      res.status(400).json({
        error: `Unsupported file type: ${ext}. Supported: ${[...CONVERTIBLE_EXTENSIONS].join(", ")}`,
      });
      return;
    }

    try {
      const markdown = await convertToMarkdown(result.resolved, markitdownUrl);
      res.json({ markdown, originalPath: result.resolved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: `Conversion failed: ${msg}` });
    }
  });

  return router;
};
