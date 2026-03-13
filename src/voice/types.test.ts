import { describe, it, expect } from "vitest";
import {
  DEFAULT_VOICE_CONFIG,
  DEFAULT_LOCAL_VOICE_CONFIG,
  AVAILABLE_VOICES,
  AVAILABLE_LOCAL_VOICES,
} from "./types.js";

describe("voice/types", () => {
  describe("DEFAULT_VOICE_CONFIG", () => {
    it("has expected defaults", () => {
      expect(DEFAULT_VOICE_CONFIG.enabled).toBe(true);
      expect(DEFAULT_VOICE_CONFIG.provider).toBe("google");
      expect(DEFAULT_VOICE_CONFIG.speakingRate).toBe(1.0);
      expect(DEFAULT_VOICE_CONFIG.pitch).toBe(0.0);
      expect(DEFAULT_VOICE_CONFIG.maxCacheSizeMb).toBe(500);
      expect(DEFAULT_VOICE_CONFIG.maxTextLength).toBe(5000);
      expect(DEFAULT_VOICE_CONFIG.audioEncoding).toBe("MP3");
    });
  });

  describe("DEFAULT_LOCAL_VOICE_CONFIG", () => {
    it("overrides provider to local", () => {
      expect(DEFAULT_LOCAL_VOICE_CONFIG.provider).toBe("local");
      expect(DEFAULT_LOCAL_VOICE_CONFIG.maxTextLength).toBe(10000);
      expect(DEFAULT_LOCAL_VOICE_CONFIG.voiceName).toBe("af_heart");
    });
  });

  describe("AVAILABLE_VOICES", () => {
    it("has at least 5 voices", () => {
      expect(AVAILABLE_VOICES.length).toBeGreaterThanOrEqual(5);
    });

    it("all voices have required fields", () => {
      for (const voice of AVAILABLE_VOICES) {
        expect(voice.id).toBeTruthy();
        expect(voice.type).toBeTruthy();
        expect(voice.description).toBeTruthy();
        expect(voice.pricingTier).toBeTruthy();
      }
    });

    it("contains standard and neural voice types", () => {
      const types = new Set(AVAILABLE_VOICES.map((v) => v.type));
      expect(types.has("Standard")).toBe(true);
      expect(types.has("Neural2")).toBe(true);
    });
  });

  describe("AVAILABLE_LOCAL_VOICES", () => {
    it("has at least 10 voices", () => {
      expect(AVAILABLE_LOCAL_VOICES.length).toBeGreaterThanOrEqual(10);
    });

    it("all are Kokoro type with local pricing", () => {
      for (const voice of AVAILABLE_LOCAL_VOICES) {
        expect(voice.type).toBe("Kokoro");
        expect(voice.pricingTier).toBe("local");
      }
    });

    it("includes multiple languages", () => {
      const ids = AVAILABLE_LOCAL_VOICES.map((v) => v.id);
      const hasAmerican = ids.some((id) => id.startsWith("a"));
      const hasBritish = ids.some((id) => id.startsWith("b"));
      const hasJapanese = ids.some((id) => id.startsWith("j"));
      expect(hasAmerican).toBe(true);
      expect(hasBritish).toBe(true);
      expect(hasJapanese).toBe(true);
    });
  });
});
