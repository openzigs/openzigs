/**
 * pitch-export-zip — unit tests (Phase 6 / sub-issue #973).
 *
 * Verifies the output buffer is a valid zip and that it contains
 * `index.html` + `README.txt`. Also confirms file names cannot encode
 * a path-traversal attack (entries are constructed from constants).
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { exportDeckToZip } from "./pitch-export-zip.js";
import { DeckSchema, BrandKitSchema } from "./pitch-schema.js";
import type { Deck, BrandKit } from "./pitch-schema.js";

function buildDeck(overrides: Partial<Deck> = {}): Deck {
  return DeckSchema.parse({
    id: "deck-zip",
    title: "Zip Demo",
    brand_kit_id: "kit-1",
    aspect_ratio: "16:9",
    slides: [
      {
        template: "title",
        content: { title: "Hi" },
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

describe("exportDeckToZip", () => {
  it("returns a non-empty zip buffer with safe filename + zip content type", async () => {
    const out = await exportDeckToZip(buildDeck(), buildKit());
    expect(out.contentType).toBe("application/zip");
    expect(out.filename).toBe("Zip_Demo.zip");
    expect(out.buffer.length).toBeGreaterThan(0);
  });

  it("contains index.html with the deck title and a README", async () => {
    const out = await exportDeckToZip(buildDeck({ title: "Inside Test" }), buildKit());
    const z = await JSZip.loadAsync(out.buffer);
    const entries = Object.keys(z.files);
    expect(entries).toContain("index.html");
    expect(entries).toContain("README.txt");

    const html = await z.file("index.html")!.async("string");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Inside Test");

    const readme = await z.file("README.txt")!.async("string");
    expect(readme).toContain("Inside Test");
    expect(readme).toContain("Slides: 1");
  });

  it("entry names contain no path traversal characters", async () => {
    const malicious = buildDeck({
      id: "../../etc",
      title: "../../../../etc/passwd",
    });
    const out = await exportDeckToZip(malicious, buildKit());
    const z = await JSZip.loadAsync(out.buffer);
    for (const name of Object.keys(z.files)) {
      expect(name).not.toContain("..");
      expect(name).not.toMatch(/^\//);
    }
    // Filename header is also sanitized
    expect(out.filename).not.toContain("/");
    expect(out.filename).not.toContain("..");
  });
});
