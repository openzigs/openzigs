import { describe, expect, it, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createFilesRouter } from "./files.js";

let tmpRoot: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-files-api-"));

  // Seed some test data
  await fs.writeFile(path.join(tmpRoot, "hello.md"), "# Hello\n\nWorld", "utf-8");
  await fs.mkdir(path.join(tmpRoot, "subdir"), { recursive: true });
  await fs.writeFile(path.join(tmpRoot, "subdir", "nested.txt"), "nested content", "utf-8");

  const app = express();
  app.use(express.json());
  const router = createFilesRouter({ allowedDirs: [tmpRoot] });
  app.use("/api/files", router);

  server = app.listen(0);
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("GET /api/files/list", () => {
  it("lists directory entries for an allowed path", async () => {
    const res = await fetch(`${baseUrl}/api/files/list?path=${encodeURIComponent(tmpRoot)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { name: string; type: string }[] };
    const names = body.entries.map((e) => e.name);
    expect(names).toContain("hello.md");
    expect(names).toContain("subdir");
    const subdir = body.entries.find((e) => e.name === "subdir");
    expect(subdir?.type).toBe("directory");
  });

  it("returns 403 for paths outside allowedDirs", async () => {
    const res = await fetch(`${baseUrl}/api/files/list?path=${encodeURIComponent("/etc")}`);
    expect(res.status).toBe(403);
  });

  it("returns 400 when path is missing", async () => {
    const res = await fetch(`${baseUrl}/api/files/list`);
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent directory", async () => {
    const res = await fetch(`${baseUrl}/api/files/list?path=${encodeURIComponent(path.join(tmpRoot, "nope"))}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/files/content", () => {
  it("reads file content for an allowed path", async () => {
    const filePath = path.join(tmpRoot, "hello.md");
    const res = await fetch(`${baseUrl}/api/files/content?path=${encodeURIComponent(filePath)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; path: string };
    expect(body.content).toBe("# Hello\n\nWorld");
  });

  it("returns 403 for disallowed paths", async () => {
    const res = await fetch(`${baseUrl}/api/files/content?path=${encodeURIComponent("/etc/passwd")}`);
    expect(res.status).toBe(403);
  });

  it("blocks path traversal attacks", async () => {
    const traversal = path.join(tmpRoot, "..", "..", "etc", "passwd");
    const res = await fetch(`${baseUrl}/api/files/content?path=${encodeURIComponent(traversal)}`);
    expect(res.status).toBe(403);
  });

  it("returns 404 for missing files", async () => {
    const res = await fetch(`${baseUrl}/api/files/content?path=${encodeURIComponent(path.join(tmpRoot, "ghost.txt"))}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/files/save", () => {
  it("writes a file in an allowed directory", async () => {
    const filePath = path.join(tmpRoot, "new-file.md");
    const res = await fetch(`${baseUrl}/api/files/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, content: "# New\n\nContent" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("# New\n\nContent");
  });

  it("creates parent directories when saving", async () => {
    const filePath = path.join(tmpRoot, "deep", "nested", "file.md");
    const res = await fetch(`${baseUrl}/api/files/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, content: "deep content" }),
    });
    expect(res.status).toBe(200);
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("deep content");
  });

  it("returns 403 for paths outside sandbox", async () => {
    const res = await fetch(`${baseUrl}/api/files/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/evil.sh", content: "rm -rf /" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 when path is missing", async () => {
    const res = await fetch(`${baseUrl}/api/files/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "no path" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/files/mkdir", () => {
  it("creates a directory", async () => {
    const dirPath = path.join(tmpRoot, "new-dir");
    const res = await fetch(`${baseUrl}/api/files/mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dirPath }),
    });
    expect(res.status).toBe(200);
    const stat = await fs.stat(dirPath);
    expect(stat.isDirectory()).toBe(true);
  });

  it("returns 403 for disallowed paths", async () => {
    const res = await fetch(`${baseUrl}/api/files/mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/etc/evil" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/files", () => {
  it("deletes an existing file", async () => {
    const filePath = path.join(tmpRoot, "to-delete.txt");
    await fs.writeFile(filePath, "delete me", "utf-8");

    const res = await fetch(`${baseUrl}/api/files?path=${encodeURIComponent(filePath)}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("returns 403 for disallowed paths", async () => {
    const res = await fetch(`${baseUrl}/api/files?path=${encodeURIComponent("/etc/passwd")}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 for missing files", async () => {
    const res = await fetch(`${baseUrl}/api/files?path=${encodeURIComponent(path.join(tmpRoot, "nope.txt"))}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});
