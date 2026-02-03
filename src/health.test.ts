import { describe, expect, it } from "vitest";
import { getHealth } from "./health.js";

describe("getHealth", () => {
  it("returns ok status", () => {
    expect(getHealth()).toEqual({ status: "ok" });
  });
});
