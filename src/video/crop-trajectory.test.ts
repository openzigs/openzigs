/**
 * Crop Trajectory — Unit Tests
 * Issue #818: AI Video Reframing.
 */

import { describe, it, expect } from "vitest";
import {
  interpolateCropTrajectory,
  interpolateAtTime,
  cubicEaseInOut,
  computeCropDimensions,
  generateCropFilter,
  type CropKeyframe,
} from "./crop-trajectory.js";

describe("cubicEaseInOut", () => {
  it("returns 0 for t=0", () => {
    expect(cubicEaseInOut(0, 0.7)).toBe(0);
  });

  it("returns 1 for t=1", () => {
    expect(cubicEaseInOut(1, 0.7)).toBeCloseTo(1, 5);
  });

  it("returns 0.5 at midpoint", () => {
    expect(cubicEaseInOut(0.5, 1.0)).toBeCloseTo(0.5, 5);
  });

  it("is linear when smoothing is 0", () => {
    expect(cubicEaseInOut(0.3, 0)).toBeCloseTo(0.3, 5);
    expect(cubicEaseInOut(0.7, 0)).toBeCloseTo(0.7, 5);
  });

  it("clamps to [0,1]", () => {
    expect(cubicEaseInOut(-0.5, 0.7)).toBe(0);
    expect(cubicEaseInOut(1.5, 0.7)).toBeCloseTo(1, 5);
  });
});

describe("interpolateAtTime", () => {
  const keyframes: CropKeyframe[] = [
    { timestamp: 0, x: 0, y: 0, width: 100, height: 100 },
    { timestamp: 10, x: 200, y: 100, width: 100, height: 100 },
  ];

  it("returns first keyframe at start", () => {
    const point = interpolateAtTime(keyframes, 0, 0.7);
    expect(point.x).toBe(0);
    expect(point.y).toBe(0);
  });

  it("returns last keyframe at end", () => {
    const point = interpolateAtTime(keyframes, 10, 0.7);
    expect(point.x).toBe(200);
    expect(point.y).toBe(100);
  });

  it("interpolates midpoint", () => {
    const point = interpolateAtTime(keyframes, 5, 0);
    expect(point.x).toBeCloseTo(100, 0);
    expect(point.y).toBeCloseTo(50, 0);
  });

  it("clamps before first keyframe", () => {
    const point = interpolateAtTime(keyframes, -5, 0.7);
    expect(point.x).toBe(0);
  });

  it("clamps after last keyframe", () => {
    const point = interpolateAtTime(keyframes, 15, 0.7);
    expect(point.x).toBe(200);
  });

  it("handles empty keyframes", () => {
    const point = interpolateAtTime([], 5, 0.7);
    expect(point.x).toBe(0);
    expect(point.y).toBe(0);
  });

  it("handles single keyframe", () => {
    const point = interpolateAtTime([keyframes[0]], 5, 0.7);
    expect(point.x).toBe(0);
  });
});

describe("interpolateCropTrajectory", () => {
  it("returns empty for empty keyframes", () => {
    expect(interpolateCropTrajectory([], 30)).toEqual([]);
  });

  it("returns single point for single keyframe", () => {
    const kf: CropKeyframe[] = [
      { timestamp: 0, x: 100, y: 50, width: 200, height: 200 },
    ];
    const result = interpolateCropTrajectory(kf, 30);
    expect(result).toHaveLength(1);
    expect(result[0].x).toBe(100);
  });

  it("generates trajectory at correct fps", () => {
    const kf: CropKeyframe[] = [
      { timestamp: 0, x: 0, y: 0, width: 100, height: 100 },
      { timestamp: 1, x: 100, y: 100, width: 100, height: 100 },
    ];
    const result = interpolateCropTrajectory(kf, 10, 0);
    // 1 second at 10fps = 11 points (0 to 10 inclusive)
    expect(result).toHaveLength(11);
    expect(result[0].x).toBeCloseTo(0, 0);
    expect(result[10].x).toBeCloseTo(100, 0);
  });

  it("sorts keyframes by timestamp", () => {
    const kf: CropKeyframe[] = [
      { timestamp: 2, x: 200, y: 200, width: 100, height: 100 },
      { timestamp: 0, x: 0, y: 0, width: 100, height: 100 },
    ];
    const result = interpolateCropTrajectory(kf, 5, 0);
    expect(result[0].x).toBeCloseTo(0, 0);
    expect(result[result.length - 1].x).toBeCloseTo(200, 0);
  });
});

describe("computeCropDimensions", () => {
  it("computes 9:16 crop from 1920x1080", () => {
    const { width, height } = computeCropDimensions(1920, 1080, "9:16");
    expect(width).toBe(608); // 1080 * 9/16 = 607.5, rounded to even
    expect(height).toBe(1080);
  });

  it("computes 1:1 crop from 1920x1080", () => {
    const { width, height } = computeCropDimensions(1920, 1080, "1:1");
    expect(width).toBe(1080);
    expect(height).toBe(1080);
  });

  it("computes 4:5 crop from 1920x1080", () => {
    const { width, height } = computeCropDimensions(1920, 1080, "4:5");
    expect(width).toBe(864);
    expect(height).toBe(1080);
  });

  it("handles 16:9 from already-16:9 source", () => {
    const { width, height } = computeCropDimensions(1920, 1080, "16:9");
    expect(width).toBe(1920);
    expect(height).toBe(1080);
  });

  it("handles portrait source to landscape", () => {
    const { width, height } = computeCropDimensions(1080, 1920, "16:9");
    expect(width).toBe(1080);
    expect(height).toBe(608); // 1080 / (16/9) = 607.5, rounded to even
  });

  it("ensures even dimensions", () => {
    const { width, height } = computeCropDimensions(1921, 1081, "9:16");
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
  });

  it("defaults to 16:9 for invalid aspect", () => {
    const { width, height } = computeCropDimensions(1920, 1080, "invalid");
    expect(width).toBe(1920);
    expect(height).toBe(1080);
  });
});

describe("generateCropFilter", () => {
  it("generates center crop for empty trajectory", () => {
    const filter = generateCropFilter([], 1920, 1080, 608, 1080);
    expect(filter).toBe("crop=608:1080:656:0");
  });

  it("generates crop from single point", () => {
    const filter = generateCropFilter(
      [{ timestamp: 0, x: 100, y: 0, width: 608, height: 1080 }],
      1920,
      1080,
      608,
      1080,
    );
    expect(filter).toBe("crop=608:1080:100:0");
  });
});
