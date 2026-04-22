import { describe, it, expect } from "vitest";
import { extractErrorMessage } from "./vllm-panel";

describe("extractErrorMessage (vLLM panel)", () => {
  it("unwraps `message` from a JSON error envelope", () => {
    const err = new Error(
      JSON.stringify({
        error: "rate_limited",
        message: "vLLM start is rate-limited; try again in 15s",
      }),
    );
    expect(extractErrorMessage(err)).toBe(
      "vLLM start is rate-limited; try again in 15s",
    );
  });

  it("falls back to raw message when JSON has no `message` field", () => {
    const err = new Error(JSON.stringify({ error: "rate_limited" }));
    expect(extractErrorMessage(err)).toBe('{"error":"rate_limited"}');
  });

  it("returns the raw message for plain-text errors", () => {
    const err = new Error("Network timeout");
    expect(extractErrorMessage(err)).toBe("Network timeout");
  });

  it("returns the raw message for malformed JSON", () => {
    const err = new Error("{not really json");
    expect(extractErrorMessage(err)).toBe("{not really json");
  });

  it("ignores `message` if it is not a string", () => {
    const err = new Error(JSON.stringify({ message: 42 }));
    expect(extractErrorMessage(err)).toBe('{"message":42}');
  });

  it("handles non-Error inputs", () => {
    expect(extractErrorMessage("oops")).toBe("oops");
    expect(extractErrorMessage(null)).toBe("null");
  });

  it("handles empty error message", () => {
    expect(extractErrorMessage(new Error(""))).toBe("Unknown error");
  });
});
