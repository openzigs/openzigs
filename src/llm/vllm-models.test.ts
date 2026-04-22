import { describe, expect, it } from "vitest";
import {
  DEFAULT_VLLM_MODEL,
  validateModelId,
  VLLM_ALLOWED_MODELS,
} from "./vllm-models.js";

describe("validateModelId", () => {
  it("accepts each id in the allowlist", () => {
    for (const entry of VLLM_ALLOWED_MODELS) {
      const res = validateModelId(entry.id);
      expect(res.ok, `expected ${entry.id} to be valid`).toBe(true);
    }
  });

  it("rejects empty / non-string input", () => {
    expect(validateModelId("")).toEqual({
      ok: false,
      reason: expect.any(String),
    });
    expect(validateModelId("   ")).toEqual({
      ok: false,
      reason: expect.any(String),
    });
    expect(validateModelId(undefined)).toEqual({
      ok: false,
      reason: expect.any(String),
    });
    expect(validateModelId(123 as unknown)).toEqual({
      ok: false,
      reason: expect.any(String),
    });
  });

  it("rejects path traversal and shell metacharacters", () => {
    const bad = [
      "../../../etc/passwd",
      "org/..",
      "Qwen/Qwen2.5-14B-Instruct-AWQ; rm -rf /",
      "Qwen/Qwen2.5-14B-Instruct-AWQ\nsecond",
      "Qwen\\evil",
      "Qwen/evil\u0000",
      "$(curl evil)",
      "Qwen/foo bar",
    ];
    for (const id of bad) {
      const res = validateModelId(id);
      expect(res.ok, `expected ${id} to be rejected`).toBe(false);
    }
  });

  it("rejects valid-looking ids that are not in the allowlist", () => {
    const res = validateModelId("meta-llama/Meta-Llama-3-70B-Instruct-AWQ");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/allowlist/);
  });

  it("DEFAULT_VLLM_MODEL is in the allowlist", () => {
    expect(validateModelId(DEFAULT_VLLM_MODEL).ok).toBe(true);
  });
});
