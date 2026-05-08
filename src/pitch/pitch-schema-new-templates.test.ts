/**
 * Tests for the 6 new slide templates added in epic #1045:
 *   - pricing_table   (#1046)
 *   - big_number      (#1046)
 *   - team_grid       (#1049)
 *   - logo_grid       (#1049)
 *   - roadmap         (#1052)
 *   - agenda          (#1052)
 */
import { describe, it, expect } from "vitest";
import { SlideSchema } from "./pitch-schema.js";

function parse(template: string, content: unknown) {
  return SlideSchema.parse({ template, content });
}

// ── pricing_table (#1046) ───────────────────────────────────────────────────

describe("SlideSchema: pricing_table", () => {
  const baseTier = { name: "Pro", price: "$29", features: ["Unlimited"] };
  it("accepts 2-tier minimal", () => {
    const s = parse("pricing_table", {
      heading: "Pricing",
      tiers: [baseTier, { ...baseTier, name: "Team", price: "$99" }],
    });
    expect((s as { content: { tiers: unknown[] } }).content.tiers).toHaveLength(2);
  });

  it("rejects fewer than 2 tiers", () => {
    expect(() =>
      parse("pricing_table", { heading: "P", tiers: [baseTier] }),
    ).toThrow();
  });

  it("rejects more than 4 tiers", () => {
    expect(() =>
      parse("pricing_table", {
        heading: "P",
        tiers: Array(5).fill(baseTier),
      }),
    ).toThrow();
  });

  it("enforces single highlighted tier", () => {
    expect(() =>
      parse("pricing_table", {
        heading: "P",
        tiers: [
          { ...baseTier, highlighted: true },
          { ...baseTier, name: "B", highlighted: true },
        ],
      }),
    ).toThrow();
  });

  it("allows exactly one highlighted tier", () => {
    expect(() =>
      parse("pricing_table", {
        heading: "P",
        tiers: [
          { ...baseTier, highlighted: true },
          { ...baseTier, name: "B" },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects features array > 10", () => {
    expect(() =>
      parse("pricing_table", {
        heading: "P",
        tiers: [
          { ...baseTier, features: Array(11).fill("x") },
          baseTier,
        ],
      }),
    ).toThrow();
  });

  it("rejects footnote > 160 chars", () => {
    expect(() =>
      parse("pricing_table", {
        heading: "P",
        tiers: [baseTier, baseTier],
        footnote: "x".repeat(161),
      }),
    ).toThrow();
  });
});

// ── big_number (#1046) ──────────────────────────────────────────────────────

describe("SlideSchema: big_number", () => {
  it("accepts minimal value+label", () => {
    const s = parse("big_number", { value: "42%", label: "Conversion" });
    expect((s as { content: { value: string } }).content.value).toBe("42%");
  });

  it("rejects value > 20 chars", () => {
    expect(() => parse("big_number", { value: "x".repeat(21), label: "L" })).toThrow();
  });

  it("rejects label > 80 chars", () => {
    expect(() => parse("big_number", { value: "1", label: "x".repeat(81) })).toThrow();
  });

  it("rejects support > 240 chars", () => {
    expect(() =>
      parse("big_number", { value: "1", label: "L", support: "x".repeat(241) }),
    ).toThrow();
  });

  it("accepts trend enum values", () => {
    for (const trend of ["up", "down", "flat"]) {
      expect(() => parse("big_number", { value: "1", label: "L", trend })).not.toThrow();
    }
  });

  it("rejects unknown trend value", () => {
    expect(() =>
      parse("big_number", { value: "1", label: "L", trend: "sideways" }),
    ).toThrow();
  });
});

// ── team_grid (#1049) ───────────────────────────────────────────────────────

describe("SlideSchema: team_grid", () => {
  const m = { name: "Alice", role: "CEO" };
  it("accepts 2-12 members", () => {
    expect(() => parse("team_grid", { members: [m, m] })).not.toThrow();
    expect(() => parse("team_grid", { members: Array(12).fill(m) })).not.toThrow();
  });
  it("rejects < 2 or > 12", () => {
    expect(() => parse("team_grid", { members: [m] })).toThrow();
    expect(() => parse("team_grid", { members: Array(13).fill(m) })).toThrow();
  });
  it("rejects bio > 280 chars", () => {
    expect(() =>
      parse("team_grid", { members: [{ ...m, bio: "x".repeat(281) }, m] }),
    ).toThrow();
  });
  it("rejects > 4 links", () => {
    expect(() =>
      parse("team_grid", {
        members: [
          { ...m, links: Array(5).fill({ label: "x", href: "https://x.com" }) },
          m,
        ],
      }),
    ).toThrow();
  });
});

// ── logo_grid (#1049) ───────────────────────────────────────────────────────

describe("SlideSchema: logo_grid", () => {
  const logo = { alt: "Acme", imageUrl: "https://example.com/a.png" };
  it("accepts 4-24 logos", () => {
    expect(() => parse("logo_grid", { logos: Array(4).fill(logo) })).not.toThrow();
    expect(() => parse("logo_grid", { logos: Array(24).fill(logo) })).not.toThrow();
  });
  it("rejects < 4 or > 24", () => {
    expect(() => parse("logo_grid", { logos: Array(3).fill(logo) })).toThrow();
    expect(() => parse("logo_grid", { logos: Array(25).fill(logo) })).toThrow();
  });
  it("rejects alt > 80 chars", () => {
    expect(() =>
      parse("logo_grid", {
        logos: [{ ...logo, alt: "x".repeat(81) }, logo, logo, logo],
      }),
    ).toThrow();
  });
  it("accepts grayscale boolean at content level", () => {
    const s = parse("logo_grid", {
      grayscale: true,
      logos: [logo, logo, logo, logo],
    });
    expect((s as { content: { grayscale?: boolean } }).content.grayscale).toBe(true);
  });
});

// ── roadmap (#1052) ─────────────────────────────────────────────────────────

describe("SlideSchema: roadmap", () => {
  const baseValid = {
    heading: "Roadmap",
    columns: ["Q1", "Q2"],
    tracks: ["Eng"],
    items: [{ column: 0, track: 0, label: "Ship" }],
  };
  it("accepts a minimal roadmap", () => {
    expect(() => parse("roadmap", baseValid)).not.toThrow();
  });
  it("rejects > 6 columns", () => {
    expect(() =>
      parse("roadmap", { ...baseValid, columns: Array(7).fill("Q") }),
    ).toThrow();
  });
  it("rejects > 4 tracks", () => {
    expect(() =>
      parse("roadmap", { ...baseValid, tracks: Array(5).fill("T") }),
    ).toThrow();
  });
  it("rejects > 60 items", () => {
    expect(() =>
      parse("roadmap", {
        ...baseValid,
        items: Array(61).fill({ column: 0, track: 0, label: "x" }),
      }),
    ).toThrow();
  });
  it("rejects non-integer column or track", () => {
    expect(() =>
      parse("roadmap", {
        ...baseValid,
        items: [{ column: 0.5, track: 0, label: "x" }],
      }),
    ).toThrow();
  });
  it("accepts status enum values", () => {
    for (const status of ["planned", "in_progress", "done"]) {
      expect(() =>
        parse("roadmap", {
          ...baseValid,
          items: [{ column: 0, track: 0, label: "x", status }],
        }),
      ).not.toThrow();
    }
  });
  it("rejects unknown status", () => {
    expect(() =>
      parse("roadmap", {
        ...baseValid,
        items: [{ column: 0, track: 0, label: "x", status: "blocked" }],
      }),
    ).toThrow();
  });
});

// ── agenda (#1052) ──────────────────────────────────────────────────────────

describe("SlideSchema: agenda", () => {
  it("defaults mode to auto with no items", () => {
    const s = parse("agenda", {});
    expect((s as { content: { mode: string } }).content.mode).toBe("auto");
  });
  it("accepts manual with items", () => {
    expect(() =>
      parse("agenda", { mode: "manual", items: ["Intro", "Demo"] }),
    ).not.toThrow();
  });
  it("rejects manual without items", () => {
    expect(() => parse("agenda", { mode: "manual" })).toThrow();
  });
  it("rejects manual with empty items", () => {
    expect(() => parse("agenda", { mode: "manual", items: [] })).toThrow();
  });
  it("rejects > 20 items", () => {
    expect(() =>
      parse("agenda", { mode: "manual", items: Array(21).fill("x") }),
    ).toThrow();
  });
  it("accepts numbered flag", () => {
    const s = parse("agenda", { mode: "auto", numbered: true });
    expect((s as { content: { numbered?: boolean } }).content.numbered).toBe(true);
  });
});
