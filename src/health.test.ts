import { describe, expect, it } from "vitest";
import { getHealth } from "./health.js";

describe("getHealth", () => {
  it("returns ok status", () => {
    const result = getHealth();
    expect(result.status).toBe("ok");
  });

  it("includes uptime as a non-negative number", () => {
    const result = getHealth();
    expect(result.uptime).toBeTypeOf("number");
    expect(result.uptime).toBeGreaterThanOrEqual(0);
  });

  it("includes memoryMB as a positive number rounded to 2 decimal places", () => {
    const result = getHealth();
    expect(result.memoryMB).toBeTypeOf("number");
    expect(result.memoryMB).toBeGreaterThan(0);
    // Verify rounding to 2 decimal places
    const decimalStr = String(result.memoryMB).split(".")[1] ?? "";
    expect(decimalStr.length).toBeLessThanOrEqual(2);
  });
});
