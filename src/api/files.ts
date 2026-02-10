import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { isPathAllowed } from "../mcp/tools/path-utils.js";

export type FilesRouterOptions = {
  allowedDirs: string[];
};

/**
 * REST API for file operations, reusing the same `allowedDirs` sandbox
 * that gates the MCP filesystem tools. All paths are resolved and validated
 * before any I/O occurs; requests outside the sandbox receive a 403.
 */
export const createFilesRouter = ({ allowedDirs }: FilesRouterOptions): Router => {
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

  return router;
};
