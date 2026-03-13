import { describe, it, expect } from "vitest";
import { TOOL_CATALOG } from "./tool-catalog.js";

describe("tool-catalog", () => {
  it("exports a non-empty catalog", () => {
    expect(TOOL_CATALOG.length).toBeGreaterThan(0);
  });

  it("each entry has required fields", () => {
    for (const entry of TOOL_CATALOG) {
      expect(entry.name).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.category).toBeTruthy();
      expect(entry.riskLevel).toBeTruthy();
    }
  });

  it("contains known essential tools", () => {
    const names = TOOL_CATALOG.map((t) => t.name);
    expect(names).toContain("read-file");
    expect(names).toContain("web-search");
    expect(names).toContain("shell-execute");
  });

  it("categorizes tools correctly", () => {
    const readFile = TOOL_CATALOG.find((t) => t.name === "read-file");
    expect(readFile?.category).toBe("filesystem");
    expect(readFile?.riskLevel).toBe("low");

    const shellExec = TOOL_CATALOG.find((t) => t.name === "shell-execute");
    expect(shellExec?.category).toBe("shell");
    expect(shellExec?.riskLevel).toBe("high");
  });
});
