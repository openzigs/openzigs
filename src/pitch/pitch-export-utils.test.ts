/**
 * pitch-export-utils — unit tests (Phase 6).
 *
 * Covers `safeFilename`, `htmlToPdf` (mocked spawn), and
 * `resizeImageForPptx`. NO real subprocesses, NO real PDF generation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import {
  safeFilename,
  htmlToPdf,
  resizeImageForPptx,
  PPTX_IMAGE_MAX_BYTES,
} from "./pitch-export-utils.js";

// ── safeFilename ───────────────────────────────────────────────────────

describe("safeFilename", () => {
  it("preserves allowlisted characters and adds the extension", () => {
    expect(safeFilename("My_Deck-v1.0", "abc", "pdf")).toBe("My_Deck-v1.0.pdf");
  });

  it("replaces forbidden characters with underscores", () => {
    expect(safeFilename("My Deck / v1?", "abc", ".pdf")).toBe("My_Deck_v1.pdf");
  });

  it("falls back to deck-<id> when title is empty after stripping", () => {
    expect(safeFilename("///", "id123", "pdf")).toBe("deck-id123.pdf");
    expect(safeFilename("", "id123", "pdf")).toBe("deck-id123.pdf");
    expect(safeFilename(null, "id123", "pdf")).toBe("deck-id123.pdf");
  });

  it("truncates to 120 chars", () => {
    const long = "a".repeat(200);
    const out = safeFilename(long, "x", "pdf");
    expect(out.length).toBeLessThanOrEqual(120 + ".pdf".length);
  });

  it("strips leading/trailing dots and underscores", () => {
    expect(safeFilename("...hidden", "x", "pdf")).toBe("hidden.pdf");
    expect(safeFilename("__leading__", "x", "pdf")).toBe("leading.pdf");
  });

  it("rejects path-traversal attempts", () => {
    const out = safeFilename("../../etc/passwd", "x", "pdf");
    expect(out).not.toContain("/");
    expect(out).not.toContain("..");
  });
});

// ── htmlToPdf — mocked spawn ───────────────────────────────────────────

interface FakeChild extends EventEmitter {
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stderr = new Readable({ read() {} });
  child.kill = vi.fn();
  return child;
}

describe("htmlToPdf", () => {
  let createdTempFiles: string[];

  beforeEach(() => {
    createdTempFiles = [];
  });

  afterEach(async () => {
    // Defensive — any stray temp files? (Should be none.)
    const dir = await readdir(tmpdir());
    const stray = dir.filter((f) => f.startsWith("openzigs-pitch-"));
    for (const f of stray) {
      const p = `${tmpdir()}/${f}`;
      const { unlink } = await import("node:fs/promises");
      await unlink(p).catch(() => undefined);
    }
  });

  it("happy path — writes html, spawns decktape, returns pdf bytes, cleans temp", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(((_bin: unknown, args: unknown[]) => {
      // Capture temp paths so we can write a fake PDF to the output path
      // before signaling close.
      const tempPdfPath = (args as string[])[(args as string[]).length - 1];
      createdTempFiles.push(tempPdfPath);
      // Async: write then emit close
      setImmediate(async () => {
        await writeFile(tempPdfPath, Buffer.from("%PDF-1.4 fake"));
        child.emit("close", 0);
      });
      return child as never;
    }) as never);

    const out = await htmlToPdf("<html><body>hi</body></html>", {
      spawnImpl: spawnImpl as never,
    });

    expect(out).toBeInstanceOf(Buffer);
    expect(out.toString("utf8").startsWith("%PDF")).toBe(true);
    expect(spawnImpl).toHaveBeenCalledOnce();
    // Temp files are cleaned in `finally`
    for (const f of createdTempFiles) expect(existsSync(f)).toBe(false);
  });

  it("subprocess non-zero exit — throws and cleans temp", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn((() => {
      setImmediate(() => {
        child.stderr.push("decktape boom");
        child.stderr.push(null);
        child.emit("close", 1);
      });
      return child as never;
    }) as never);

    await expect(
      htmlToPdf("<html></html>", { spawnImpl: spawnImpl as never }),
    ).rejects.toThrow(/decktape exited with code 1/);
  });

  it("timeout — fires kill, cleans temp, throws", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn((() => {
      // Never emits close until killed
      return child as never;
    }) as never);

    const promise = htmlToPdf("<html></html>", {
      spawnImpl: spawnImpl as never,
      timeoutMs: 20,
    });

    // After kill, simulate close
    setTimeout(() => child.emit("close", null), 60);

    await expect(promise).rejects.toThrow(/timed out/i);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("AbortSignal — fires kill, cleans temp, throws", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn((() => child as never) as never);

    const ac = new AbortController();
    const promise = htmlToPdf("<html></html>", {
      spawnImpl: spawnImpl as never,
      signal: ac.signal,
    });

    setTimeout(() => {
      ac.abort();
      // Simulate the child eventually dying after kill
      setTimeout(() => child.emit("close", null), 5);
    }, 10);

    await expect(promise).rejects.toThrow(/aborted/i);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("spawn error — propagates and cleans temp", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn((() => {
      setImmediate(() => child.emit("error", new Error("ENOENT decktape")));
      return child as never;
    }) as never);

    await expect(
      htmlToPdf("<html></html>", { spawnImpl: spawnImpl as never }),
    ).rejects.toThrow(/ENOENT decktape/);
  });
});

// ── resizeImageForPptx ─────────────────────────────────────────────────

describe("resizeImageForPptx", () => {
  async function makePng(w: number, h: number): Promise<Buffer> {
    return sharp({
      create: { width: w, height: h, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
  }

  it("returns a data URL with reduced dimensions", async () => {
    const huge = await makePng(4096, 4096);
    const { dataUrl, bytes } = await resizeImageForPptx(huge);
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(bytes).toBeGreaterThan(0);
  });

  it("rejects when the resized image still exceeds the cap", async () => {
    const huge = await makePng(2000, 2000);
    await expect(
      resizeImageForPptx(huge, { maxBytes: 100 }),
    ).rejects.toThrow(/exceeds.*bytes/);
  });

  it("respects custom maxEdge", async () => {
    const huge = await makePng(4096, 4096);
    const { dataUrl } = await resizeImageForPptx(huge, { maxEdge: 256 });
    // The base64-decoded size of a 256x256 PNG is much smaller than a 4096x4096
    expect(dataUrl.length).toBeLessThan(huge.byteLength);
  });

  it("default cap is the documented constant", () => {
    expect(PPTX_IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});
