import { describe, it, expect } from "vitest";
import {
  SECRET_TOKEN_PATTERN,
  buildSecretToken,
} from "./vault-types.js";

describe("vault-types", () => {
  describe("SECRET_TOKEN_PATTERN", () => {
    it("matches valid secret tokens", () => {
      const token = "{{SECRET:a0b1c2d3-e4f5-6789-abcd-ef0123456789}}";
      SECRET_TOKEN_PATTERN.lastIndex = 0;
      const match = SECRET_TOKEN_PATTERN.exec(token);
      expect(match).not.toBeNull();
      expect(match![1]).toBe("a0b1c2d3-e4f5-6789-abcd-ef0123456789");
    });

    it("does not match invalid tokens", () => {
      SECRET_TOKEN_PATTERN.lastIndex = 0;
      expect(SECRET_TOKEN_PATTERN.test("{{SECRET:not-a-uuid}}")).toBe(false);
    });

    it("finds multiple tokens in text", () => {
      const text = "Use {{SECRET:a0b1c2d3-e4f5-6789-abcd-ef0123456789}} and {{SECRET:00000000-0000-0000-0000-000000000000}}";
      SECRET_TOKEN_PATTERN.lastIndex = 0;
      const matches: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = SECRET_TOKEN_PATTERN.exec(text)) !== null) {
        matches.push(m[1]);
      }
      expect(matches).toHaveLength(2);
    });

    it("is case-insensitive for hex chars", () => {
      SECRET_TOKEN_PATTERN.lastIndex = 0;
      expect(SECRET_TOKEN_PATTERN.test("{{SECRET:A0B1C2D3-E4F5-6789-ABCD-EF0123456789}}")).toBe(true);
    });
  });

  describe("buildSecretToken", () => {
    it("wraps id in SECRET token format", () => {
      const result = buildSecretToken("a0b1c2d3-e4f5-6789-abcd-ef0123456789");
      expect(result).toBe("{{SECRET:a0b1c2d3-e4f5-6789-abcd-ef0123456789}}");
    });

    it("round-trips with SECRET_TOKEN_PATTERN", () => {
      const id = "12345678-1234-1234-1234-123456789abc";
      const token = buildSecretToken(id);
      SECRET_TOKEN_PATTERN.lastIndex = 0;
      const match = SECRET_TOKEN_PATTERN.exec(token);
      expect(match![1]).toBe(id);
    });
  });
});
