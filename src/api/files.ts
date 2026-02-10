import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { isPathAllowed } from "../mcp/tools/path-utils.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";

/** File extensions the convert endpoint accepts for document import. */
export const CONVERTIBLE_EXTENSIONS = new Set([
  ".docx", ".pdf", ".pptx", ".xlsx", ".html", ".htm",
  ".rtf", ".csv", ".tsv", ".epub",
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".webp",
  ".mp3", ".wav", ".m4a", ".ogg",
]);

export type FilesRouterOptions = {
  allowedDirs: string[];
  copilot?: CopilotWrapper;
};

/**
 * REST API for file operations, reusing the same `allowedDirs` sandbox
 * that gates the MCP filesystem tools. All paths are resolved and validated
 * before any I/O occurs; requests outside the sandbox receive a 403.
 */
export const createFilesRouter = ({ allowedDirs, copilot }: FilesRouterOptions): Router => {
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
   * POST /api/files/convert — Convert a document to Markdown via the LLM +
   * the `convert-to-markdown` MCP tool (MarkItDown sidecar).
   *
   * Body: { path: string, model?: string }
   * Response: { markdown: string, originalPath: string }
   */
  router.post("/convert", async (req, res) => {
    if (!copilot) {
      res.status(503).json({ error: "Copilot service is not available" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const rawPath = typeof body.path === "string" ? body.path : undefined;
    const model = typeof body.model === "string" ? body.model : undefined;

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

    // Build the prompt that forces the LLM to use the convert-to-markdown tool
    const systemPrompt = [
      "System: You are a document conversion assistant. The user wants to edit a document in a Markdown editor.",
      `Use the convert-to-markdown tool to convert the file at "${result.resolved}" to Markdown.`,
      "Return ONLY the raw Markdown content from the tool's output.",
      "Do not add any conversational text, greetings, explanations, or markdown code fences.",
      "If the tool fails, respond with exactly: CONVERSION_ERROR: <reason>",
      "",
      `User: Convert the file at "${result.resolved}" to Markdown.`,
    ].join("\n");

    try {
      let markdown = "";
      for await (const chunk of copilot.chat(systemPrompt, { model })) {
        markdown += chunk;
      }

      // Strip accidental markdown code fences the LLM may wrap around output
      markdown = markdown.trim();
      const fenceMatch = markdown.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
      if (fenceMatch) {
        markdown = fenceMatch[1];
      }

      // Check for conversion error
      if (markdown.startsWith("CONVERSION_ERROR:")) {
        res.status(502).json({
          error: markdown.slice("CONVERSION_ERROR:".length).trim(),
        });
        return;
      }

      if (!markdown) {
        res.status(502).json({ error: "Conversion returned empty content" });
        return;
      }

      res.json({ markdown, originalPath: result.resolved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Conversion failed: ${msg}` });
    }
  });

  return router;
};
