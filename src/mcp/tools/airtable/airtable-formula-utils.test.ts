import { describe, it, expect } from "vitest";
import {
  validateAirtableFormula,
  AIRTABLE_FORMULA_CHEATSHEET,
} from "./airtable-formula-utils.js";

describe("validateAirtableFormula", () => {
  it("accepts a simple equality filter", () => {
    expect(validateAirtableFormula("{Status}='Active'")).toEqual({
      valid: true,
    });
  });

  it("accepts AND with multiple conditions", () => {
    const result = validateAirtableFormula(
      "AND({Score}>80, {Status}!='Archived')",
    );
    expect(result.valid).toBe(true);
  });

  it("accepts nested function calls", () => {
    const result = validateAirtableFormula(
      "OR(FIND('urgent', LOWER({Tags})), {Priority}='High')",
    );
    expect(result.valid).toBe(true);
  });

  it("accepts date functions", () => {
    expect(validateAirtableFormula("IS_AFTER({Due Date}, TODAY())")).toEqual({
      valid: true,
    });
  });

  it("rejects empty string", () => {
    expect(validateAirtableFormula("")).toEqual({
      valid: false,
      error: "Formula is empty",
    });
  });

  it("rejects whitespace-only string", () => {
    expect(validateAirtableFormula("   ")).toEqual({
      valid: false,
      error: "Formula is empty",
    });
  });

  it("rejects unmatched opening brace", () => {
    expect(validateAirtableFormula("{Name='x'")).toEqual({
      valid: false,
      error: "Unmatched opening brace '{'",
    });
  });

  it("rejects unmatched closing brace", () => {
    expect(validateAirtableFormula("Name}='x'")).toEqual({
      valid: false,
      error: "Unmatched closing brace '}'",
    });
  });

  it("rejects unmatched opening paren", () => {
    expect(validateAirtableFormula("AND({A}='x'")).toEqual({
      valid: false,
      error: "Unmatched opening parenthesis '('",
    });
  });

  it("rejects unmatched closing paren", () => {
    expect(validateAirtableFormula("{A}='x')")).toEqual({
      valid: false,
      error: "Unmatched closing parenthesis ')'",
    });
  });

  it("rejects unmatched double quote", () => {
    expect(validateAirtableFormula('{A}="x')).toEqual({
      valid: false,
      error: "Unmatched double quote",
    });
  });

  it("rejects unmatched single quote", () => {
    expect(validateAirtableFormula("{A}='x")).toEqual({
      valid: false,
      error: "Unmatched single quote",
    });
  });

  it("treats parens inside strings as literal characters", () => {
    const result = validateAirtableFormula("{Name}='Hello (World)'");
    expect(result.valid).toBe(true);
  });
});

describe("AIRTABLE_FORMULA_CHEATSHEET", () => {
  it("is a non-empty string", () => {
    expect(typeof AIRTABLE_FORMULA_CHEATSHEET).toBe("string");
    expect(AIRTABLE_FORMULA_CHEATSHEET.length).toBeGreaterThan(100);
  });

  it("mentions common formula functions", () => {
    expect(AIRTABLE_FORMULA_CHEATSHEET).toContain("AND(");
    expect(AIRTABLE_FORMULA_CHEATSHEET).toContain("OR(");
    expect(AIRTABLE_FORMULA_CHEATSHEET).toContain("IF(");
    expect(AIRTABLE_FORMULA_CHEATSHEET).toContain("FIND(");
  });
});
