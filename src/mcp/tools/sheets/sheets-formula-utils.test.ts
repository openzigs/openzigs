import { describe, it, expect } from "vitest";
import {
  columnToLetter,
  letterToColumn,
  validateA1Notation,
  SHEETS_FORMULA_CHEATSHEET,
} from "./sheets-formula-utils.js";

describe("columnToLetter", () => {
  it("converts 1 → A", () => expect(columnToLetter(1)).toBe("A"));
  it("converts 26 → Z", () => expect(columnToLetter(26)).toBe("Z"));
  it("converts 27 → AA", () => expect(columnToLetter(27)).toBe("AA"));
  it("converts 52 → AZ", () => expect(columnToLetter(52)).toBe("AZ"));
  it("converts 702 → ZZ", () => expect(columnToLetter(702)).toBe("ZZ"));
  it("converts 703 → AAA", () => expect(columnToLetter(703)).toBe("AAA"));
  it("throws for 0", () => expect(() => columnToLetter(0)).toThrow());
  it("throws for negative", () => expect(() => columnToLetter(-1)).toThrow());
});

describe("letterToColumn", () => {
  it("converts A → 1", () => expect(letterToColumn("A")).toBe(1));
  it("converts Z → 26", () => expect(letterToColumn("Z")).toBe(26));
  it("converts AA → 27", () => expect(letterToColumn("AA")).toBe(27));
  it("converts AZ → 52", () => expect(letterToColumn("AZ")).toBe(52));
  it("converts ZZ → 702", () => expect(letterToColumn("ZZ")).toBe(702));
  it("is case-insensitive", () => expect(letterToColumn("aa")).toBe(27));
  it("throws for non-alpha", () =>
    expect(() => letterToColumn("A1")).toThrow());
  it("throws for empty string", () =>
    expect(() => letterToColumn("")).toThrow());
});

describe("columnToLetter ↔ letterToColumn roundtrip", () => {
  for (const n of [1, 10, 26, 27, 100, 256, 702, 703]) {
    it(`roundtrips column ${n}`, () => {
      expect(letterToColumn(columnToLetter(n))).toBe(n);
    });
  }
});

describe("validateA1Notation (re-export)", () => {
  it("accepts Sheet1!A1:D10", () =>
    expect(validateA1Notation("Sheet1!A1:D10")).toBe(true));
  it("rejects empty string", () => expect(validateA1Notation("")).toBe(false));
});

describe("SHEETS_FORMULA_CHEATSHEET", () => {
  it("is a non-empty string", () => {
    expect(typeof SHEETS_FORMULA_CHEATSHEET).toBe("string");
    expect(SHEETS_FORMULA_CHEATSHEET.length).toBeGreaterThan(100);
  });

  it("mentions common functions", () => {
    expect(SHEETS_FORMULA_CHEATSHEET).toContain("VLOOKUP");
    expect(SHEETS_FORMULA_CHEATSHEET).toContain("FILTER");
    expect(SHEETS_FORMULA_CHEATSHEET).toContain("ARRAYFORMULA");
  });
});
