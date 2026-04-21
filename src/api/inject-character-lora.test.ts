/**
 * Unit tests for the shared LoRA character injection helpers
 * (epic #868). The helper is used by both the queue API and the Creative
 * Studio /inpaint endpoint, so its behaviour must be precisely pinned —
 * any silent regression in trigger-word matching, multi-subject prompt
 * restructuring, or explicit-character lookup would leak into production
 * inference and quietly break trained character generation.
 */

import { describe, it, expect, vi } from "vitest";
import {
  injectCharacterLora,
  injectExplicitCharacterLora,
} from "./inject-character-lora.js";
import type { CharacterRepository, CharacterProfile } from "../characters/character-repository.js";
import type { MediaJobPayload } from "../queue/types.js";

function makeRepo(characters: CharacterProfile[]): CharacterRepository {
  return {
    getByStatus: vi.fn((status: string) =>
      characters.filter((c) => c.status === status),
    ),
    getById: vi.fn((id: string) => characters.find((c) => c.id === id)),
  } as unknown as CharacterRepository;
}

function makeChar(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  const base: CharacterProfile = {
    id: "char-1",
    name: "Buddy",
    description: "a golden retriever",
    triggerWord: "ohwx_dog",
    referencePhotos: [],
    photoCaptions: {},
    trainedLoraPath: "/models/lora/buddy.safetensors",
    loraScale: 0.85,
    trainingConfig: null,
    status: "ready",
    errorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return { ...base, ...overrides };
}

describe("injectCharacterLora (trigger-word match)", () => {
  it("is a no-op when the repo is undefined", () => {
    const payload: MediaJobPayload = { prompt: "ohwx_dog running" };
    injectCharacterLora(payload, undefined);
    expect(payload.lora_paths).toBeUndefined();
  });

  it("is a no-op when the prompt is empty", () => {
    const repo = makeRepo([makeChar()]);
    const payload: MediaJobPayload = { prompt: "" };
    injectCharacterLora(payload, repo);
    expect(payload.lora_paths).toBeUndefined();
  });

  it("is a no-op when caller already set lora_paths (explicit wins)", () => {
    const repo = makeRepo([makeChar()]);
    const payload: MediaJobPayload = {
      prompt: "ohwx_dog running",
      lora_paths: ["/preset/x.safetensors"],
      lora_scales: [1.0],
    };
    injectCharacterLora(payload, repo);
    expect(payload.lora_paths).toEqual(["/preset/x.safetensors"]);
  });

  it("injects the LoRA when the trigger word matches as a whole word", () => {
    const repo = makeRepo([makeChar()]);
    const payload: MediaJobPayload = { prompt: "a photo of ohwx_dog in a park" };
    injectCharacterLora(payload, repo);
    expect(payload.lora_paths).toEqual(["/models/lora/buddy.safetensors"]);
    expect(payload.lora_scales).toEqual([0.85]);
  });

  it("does NOT match when the trigger word is a substring of another word", () => {
    const repo = makeRepo([makeChar({ triggerWord: "ohwx_dog" })]);
    const payload: MediaJobPayload = { prompt: "the ohwx_dogfood brand" };
    injectCharacterLora(payload, repo);
    // "ohwx_dogfood" should not match the \bohwx_dog\b pattern.
    expect(payload.lora_paths).toBeUndefined();
  });

  it("matches case-insensitively", () => {
    const repo = makeRepo([makeChar()]);
    const payload: MediaJobPayload = { prompt: "OHWX_DOG runs fast" };
    injectCharacterLora(payload, repo);
    expect(payload.lora_paths).toEqual(["/models/lora/buddy.safetensors"]);
  });

  it("skips characters that are not 'ready' or have no trainedLoraPath", () => {
    const repo = makeRepo([
      makeChar({
        id: "c1",
        triggerWord: "ohwx_pending",
        status: "pending",
        trainedLoraPath: null,
      }),
      makeChar({
        id: "c2",
        triggerWord: "ohwx_no_path",
        status: "ready",
        trainedLoraPath: null,
      }),
    ]);
    // Neither should be considered (getByStatus("ready") returns only c2,
    // which is then skipped because trainedLoraPath is null).
    const payload: MediaJobPayload = {
      prompt: "ohwx_pending and ohwx_no_path together",
    };
    injectCharacterLora(payload, repo);
    expect(payload.lora_paths).toBeUndefined();
  });

  it("injects multiple LoRAs when several trigger words match", () => {
    const repo = makeRepo([
      makeChar({ id: "a", triggerWord: "ohwx_dog", trainedLoraPath: "/a.safetensors" }),
      makeChar({ id: "b", triggerWord: "ohwx_cat", trainedLoraPath: "/b.safetensors", loraScale: 0.7 }),
    ]);
    const payload: MediaJobPayload = {
      prompt: "ohwx_dog playing with ohwx_cat",
    };
    injectCharacterLora(payload, repo);
    expect(payload.lora_paths).toEqual(["/a.safetensors", "/b.safetensors"]);
    expect(payload.lora_scales).toEqual([0.85, 0.7]);
  });

  it("prepends a multi-subject enumeration cue when cues are detected", () => {
    const repo = makeRepo([makeChar()]);
    const payload: MediaJobPayload = {
      prompt: "ohwx_dog chasing another dog",
    };
    injectCharacterLora(payload, repo);
    expect(payload.prompt).toMatch(/^2 subjects:/);
    expect(payload.guidance_scale).toBe(6.5);
  });

  it("does NOT lower guidance_scale when caller has set one explicitly", () => {
    const repo = makeRepo([makeChar()]);
    const payload: MediaJobPayload = {
      prompt: "ohwx_dog and another dog",
      guidance_scale: 10,
    };
    injectCharacterLora(payload, repo);
    expect(payload.guidance_scale).toBe(10);
  });

  it("swallows errors so injection never crashes the request", () => {
    const repo = {
      getByStatus: vi.fn(() => {
        throw new Error("DB exploded");
      }),
    } as unknown as CharacterRepository;
    const payload: MediaJobPayload = { prompt: "ohwx_dog" };
    expect(() => injectCharacterLora(payload, repo)).not.toThrow();
    expect(payload.lora_paths).toBeUndefined();
  });
});

describe("injectExplicitCharacterLora (UI character picker)", () => {
  it("looks up the character and applies its LoRA", () => {
    const repo = makeRepo([makeChar()]);
    const payload: MediaJobPayload = { prompt: "standing in a field" };
    const char = injectExplicitCharacterLora(payload, repo, "char-1");
    expect(char.name).toBe("Buddy");
    expect(payload.lora_paths).toEqual(["/models/lora/buddy.safetensors"]);
    expect(payload.lora_scales).toEqual([0.85]);
  });

  it("prepends the trigger word to the prompt when missing", () => {
    const repo = makeRepo([makeChar()]);
    const payload: MediaJobPayload = { prompt: "running fast" };
    injectExplicitCharacterLora(payload, repo, "char-1");
    expect(payload.prompt).toBe("ohwx_dog running fast");
  });

  it("does not duplicate the trigger word when already in the prompt", () => {
    const repo = makeRepo([makeChar()]);
    const payload: MediaJobPayload = {
      prompt: "ohwx_dog running fast",
    };
    injectExplicitCharacterLora(payload, repo, "char-1");
    expect(payload.prompt).toBe("ohwx_dog running fast");
  });

  it("overrides any auto-injected lora_paths (explicit wins)", () => {
    const repo = makeRepo([makeChar()]);
    const payload: MediaJobPayload = {
      prompt: "ohwx_dog running",
      lora_paths: ["/auto/wrong.safetensors"],
      lora_scales: [1.0],
    };
    injectExplicitCharacterLora(payload, repo, "char-1");
    expect(payload.lora_paths).toEqual(["/models/lora/buddy.safetensors"]);
    expect(payload.lora_scales).toEqual([0.85]);
  });

  it("throws a 400-tagged error when the character does not exist", () => {
    const repo = makeRepo([makeChar()]);
    const payload: MediaJobPayload = { prompt: "anything" };
    try {
      injectExplicitCharacterLora(payload, repo, "missing-id");
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      expect(e.statusCode).toBe(400);
      expect(e.message).toMatch(/not found/i);
    }
  });

  it("throws a 400-tagged error when the character is not 'ready'", () => {
    const repo = makeRepo([
      makeChar({ id: "c1", status: "training", trainedLoraPath: null }),
    ]);
    const payload: MediaJobPayload = { prompt: "anything" };
    try {
      injectExplicitCharacterLora(payload, repo, "c1");
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      expect(e.statusCode).toBe(400);
      expect(e.message).toMatch(/not ready/i);
    }
  });

  it("throws a 400-tagged error when the character has no trainedLoraPath", () => {
    const repo = makeRepo([
      makeChar({ id: "c1", status: "ready", trainedLoraPath: null }),
    ]);
    const payload: MediaJobPayload = { prompt: "anything" };
    try {
      injectExplicitCharacterLora(payload, repo, "c1");
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      expect(e.statusCode).toBe(400);
    }
  });
});
