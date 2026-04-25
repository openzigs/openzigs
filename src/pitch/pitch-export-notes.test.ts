/**
 * pitch-export-notes — unit tests (Phase 6 / sub-issue #973).
 *
 * Same `htmlToPdf` mocking shape as `pitch-export-pdf.test.ts`. Verifies
 * the notes HTML is built and piped through the shared helper, and that
 * the filename is derived as `<title>-notes.pdf`.
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { writeFile, readFile } from "node:fs/promises";
import { exportNotesToPdf } from "./pitch-export-notes.js";
import { DeckSchema, type Deck } from "./pitch-schema.js";

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: Readable;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stderr = new Readable({ read() {} });
  child.kill = vi.fn();
  return child;
}

function deck(): Deck {
  return DeckSchema.parse({
    id: "deck-notes",
    title: "Notes Demo",
    brand_kit_id: "kit-1",
    aspect_ratio: "16:9",
    slides: [
      {
        template: "title",
        content: { title: "Hello" },
        speaker_notes: "Welcome remarks",
        transition: "slide",
        fragments: [],
      },
      {
        template: "bullet_list",
        content: { heading: "Agenda", bullets: ["one", "two"] },
        speaker_notes: "Read these aloud",
        transition: "slide",
        fragments: [],
      },
    ],
    metadata: { source_script: "", tone: "formal" },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
}

describe("exportNotesToPdf", () => {
  it("writes notes html and returns pdf buffer + correctly suffixed filename", async () => {
    let capturedHtmlPath = "";
    const child = makeFakeChild();
    const spawnImpl = vi.fn(((_bin: unknown, args: unknown[]) => {
      const argv = args as string[];
      capturedHtmlPath = argv[argv.length - 2].replace(/^file:\/\//, "");
      const tempPdfPath = argv[argv.length - 1];
      setImmediate(async () => {
        await writeFile(tempPdfPath, Buffer.from("%PDF-1.4 notes"));
        child.emit("close", 0);
      });
      return child as never;
    }) as never);

    const result = await exportNotesToPdf(deck(), {
      spawnImpl: spawnImpl as never,
    });

    expect(result.contentType).toBe("application/pdf");
    expect(result.filename).toBe("Notes_Demo-notes.pdf");
    expect(result.buffer.toString("utf8")).toMatch(/^%PDF/);

    // The notes HTML — captured pre-cleanup via spawn invocation — should
    // contain both slides with their notes.
    expect(capturedHtmlPath).toMatch(/openzigs-pitch-/);
    // The cleanup runs in `finally`, so reading the temp file post-await
    // would race; instead we inspect the spawn call args for the path.
    expect(spawnImpl).toHaveBeenCalledOnce();
    const args = spawnImpl.mock.calls[0]?.[1] as string[];
    expect(args[0]).toBe("generic");
  });

  it("propagates errors from htmlToPdf", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn((() => {
      setImmediate(() => child.emit("close", 1));
      return child as never;
    }) as never);

    await expect(
      exportNotesToPdf(deck(), { spawnImpl: spawnImpl as never }),
    ).rejects.toThrow(/decktape exited/);
  });

  it("includes slide titles and notes in the rendered HTML", async () => {
    let htmlSeen = "";
    const child = makeFakeChild();
    const spawnImpl = vi.fn(((_bin: unknown, args: unknown[]) => {
      const argv = args as string[];
      const htmlPath = argv[argv.length - 2].replace(/^file:\/\//, "");
      const tempPdfPath = argv[argv.length - 1];
      // Read the html before the helper deletes it
      readFile(htmlPath, "utf8")
        .then((s) => {
          htmlSeen = s;
        })
        .finally(async () => {
          await writeFile(tempPdfPath, Buffer.from("%PDF-1.4"));
          child.emit("close", 0);
        });
      return child as never;
    }) as never);

    await exportNotesToPdf(deck(), { spawnImpl: spawnImpl as never });

    expect(htmlSeen).toContain("Welcome remarks");
    expect(htmlSeen).toContain("Read these aloud");
    expect(htmlSeen).toContain("Hello");
    expect(htmlSeen).toContain("Agenda");
  });

  // ── Phase 7 / sub-issue #977 — abort-signal early-exit ─────────────
  it("rejects without spawning a subprocess when the AbortSignal is already aborted", async () => {
    const spawnImpl = vi.fn();
    const ac = new AbortController();
    ac.abort();

    await expect(
      exportNotesToPdf(deck(), {
        spawnImpl: spawnImpl as never,
        signal: ac.signal,
      }),
    ).rejects.toThrow(/aborted/i);

    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
