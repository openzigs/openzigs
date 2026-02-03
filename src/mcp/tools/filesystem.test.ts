import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createFilesystemHandlers } from "./filesystem.js";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openzigs-fs-"));

const handlers = createFilesystemHandlers({
  allowedDirs: [tmpRoot]
});

describe("filesystem handlers", () => {
  it("reads files within allowlist", async () => {
    const filePath = path.join(tmpRoot, "hello.txt");
    await fs.writeFile(filePath, "hello", "utf-8");

    const result = await handlers.readFile({ path: filePath });
    expect(result).toEqual({ content: "hello" });
  });

  it("writes files within allowlist", async () => {
    const filePath = path.join(tmpRoot, "write.txt");
    const result = await handlers.writeFile({ path: filePath, content: "ok" });

    expect(result).toEqual({ success: true });
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("ok");
  });

  it("rejects files outside allowlist", async () => {
    const disallowedPath = path.join(process.cwd(), "package.json");

    await expect(handlers.readFile({ path: disallowedPath })).rejects.toThrow(
      /Access denied/i
    );
  });
});
