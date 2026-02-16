/**
 * Director Mode — Transition Mapper Tests
 * Issue #248
 */

import { describe, it, expect } from "vitest";
import { mapTransition, getDefaultTransition } from "./transition-mapper.js";

describe("mapTransition", () => {
  it("returns null for 'cut' style", () => {
    expect(mapTransition("cut", 15)).toBeNull();
  });

  it("returns null for zero-duration transitions", () => {
    expect(mapTransition("crossfade", 0)).toBeNull();
  });

  it("returns null for negative duration", () => {
    expect(mapTransition("crossfade", -5)).toBeNull();
  });

  it("maps crossfade to a presentation with timing", () => {
    const result = mapTransition("crossfade", 15);
    expect(result).not.toBeNull();
    expect(result!.durationInFrames).toBe(15);
    expect(result!.presentation).toBeDefined();
    expect(result!.timing).toBeDefined();
  });

  it("maps dissolve to a presentation", () => {
    const result = mapTransition("dissolve", 20);
    expect(result).not.toBeNull();
    expect(result!.durationInFrames).toBe(20);
  });

  it("maps wipe-left to a presentation", () => {
    const result = mapTransition("wipe-left", 10);
    expect(result).not.toBeNull();
    expect(result!.durationInFrames).toBe(10);
  });

  it("maps wipe-right to a presentation", () => {
    const result = mapTransition("wipe-right", 12);
    expect(result).not.toBeNull();
    expect(result!.durationInFrames).toBe(12);
  });

  it("uses crossfade as default for unknown styles", () => {
    // Cast to bypass type checking for edge-case test
    const result = mapTransition("unknown" as "crossfade", 10);
    expect(result).not.toBeNull();
    expect(result!.durationInFrames).toBe(10);
  });
});

describe("getDefaultTransition", () => {
  it("returns mapped transition for known styles", () => {
    const result = getDefaultTransition("crossfade", 15);
    expect(result).not.toBeNull();
    expect(result!.durationInFrames).toBe(15);
  });

  it("returns null for cut", () => {
    expect(getDefaultTransition("cut", 10)).toBeNull();
  });
});
