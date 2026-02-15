import { describe, it, expect } from "vitest";
import { STEALTH_SCRIPTS, COMBINED_STEALTH_SCRIPT } from "./stealth.js";

describe("browser stealth", () => {
  it("provides multiple stealth scripts", () => {
    expect(STEALTH_SCRIPTS.length).toBeGreaterThanOrEqual(5);
  });

  it("combined script is a non-empty IIFE", () => {
    expect(COMBINED_STEALTH_SCRIPT).toContain("(function()");
    expect(COMBINED_STEALTH_SCRIPT.length).toBeGreaterThan(100);
  });

  it("combined script includes navigator.webdriver override", () => {
    expect(COMBINED_STEALTH_SCRIPT).toContain("navigator");
    expect(COMBINED_STEALTH_SCRIPT).toContain("webdriver");
  });

  it("combined script includes chrome.runtime shim", () => {
    expect(COMBINED_STEALTH_SCRIPT).toContain("chrome.runtime");
  });

  it("combined script patches WebGL parameters", () => {
    expect(COMBINED_STEALTH_SCRIPT).toContain("WebGLRenderingContext");
  });
});
