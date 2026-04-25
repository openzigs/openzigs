/**
 * pitch-export-pdf — unit tests (Phase 6 / sub-issue #974).
 *
 * The heavy lifting is in `pitch-export-utils` (`htmlToPdf`). Here we
 * verify orchestration: deck → standalone HTML → htmlToPdf result is
 * surfaced unchanged, with the right filename + content type.
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { writeFile } from "node:fs/promises";
import { exportDeckToPdf } from "./pitch-export-pdf.js";
import { DeckSchema, BrandKitSchema } from "./pitch-schema.js";
import type { Deck, BrandKit } from "./pitch-schema.js";

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: Readable;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stderr = new Readable({ read() {} });
  child.kill = vi.fn();
  return child;
}

function buildDeck(overrides: Partial<Deck> = {}): Deck {
  return DeckSchema.parse({
    id: "deck-1",
    title: "Sample Pitch",
    brand_kit_id: "kit-1",
    aspect_ratio: "16:9",
    slides: [
      {
        template: "title",
        content: { title: "Hello" },
        speaker_notes: "",
        transition: "slide",
        fragments: [],
      },
    ],
    metadata: { source_script: "", tone: "formal" },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function buildKit(): BrandKit {
  return BrandKitSchema.parse({
    id: "kit-1",
    name: "Default",
    primaryColor: "#000000",
    secondaryColor: "#ffffff",
    accentColor: "#0066ff",
    fontHeading: "Inter",
    fontBody: "Inter",
    logoUrl: null,
    watermarkUrl: null,
    footerText: null,
  });
}

describe("exportDeckToPdf", () => {
  it("returns buffer + safe filename + pdf content type on success", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(((_bin: unknown, args: unknown[]) => {
      const tempPdfPath = (args as string[]).at(-1) as string;
      setImmediate(async () => {
        await writeFile(tempPdfPath, Buffer.from("%PDF-1.4 ok"));
        child.emit("close", 0);
      });
      return child as never;
    }) as never);

    const deck = buildDeck({ title: "My Demo Deck" });
    const result = await exportDeckToPdf(deck, buildKit(), {
      spawnImpl: spawnImpl as never,
    });

    expect(result.contentType).toBe("application/pdf");
    expect(result.filename).toBe("My_Demo_Deck.pdf");
    expect(result.buffer.toString("utf8")).toMatch(/^%PDF/);
  });

  it("propagates subprocess errors", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn((() => {
      setImmediate(() => child.emit("close", 2));
      return child as never;
    }) as never);

    await expect(
      exportDeckToPdf(buildDeck(), buildKit(), { spawnImpl: spawnImpl as never }),
    ).rejects.toThrow(/decktape exited/);
  });

  it("uses safe filename fallback for hostile titles", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(((_bin: unknown, args: unknown[]) => {
      const tempPdfPath = (args as string[]).at(-1) as string;
      setImmediate(async () => {
        await writeFile(tempPdfPath, Buffer.from("%PDF-1.4"));
        child.emit("close", 0);
      });
      return child as never;
    }) as never);

    const deck = buildDeck({ id: "abc", title: "../../etc/passwd" });
    const out = await exportDeckToPdf(deck, buildKit(), {
      spawnImpl: spawnImpl as never,
    });
    expect(out.filename).not.toContain("/");
    expect(out.filename).not.toContain("..");
    expect(out.filename.endsWith(".pdf")).toBe(true);
  });
});
