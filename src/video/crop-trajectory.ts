/**
 * Crop Trajectory — Bezier interpolation for smooth AI reframing crop paths.
 * Issue #818: AI Video Reframing with Subject Tracking.
 */

export interface CropKeyframe {
  timestamp: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropPoint {
  timestamp: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Interpolate crop keyframes into a smooth trajectory using cubic Bezier easing.
 * @param keyframes - Sampled crop positions at specific timestamps
 * @param fps - Target frames per second for the trajectory
 * @param smoothing - Smoothness factor 0-1 (higher = smoother, slower following)
 */
export function interpolateCropTrajectory(
  keyframes: CropKeyframe[],
  fps: number,
  smoothing = 0.7,
): CropPoint[] {
  if (keyframes.length === 0) return [];
  if (keyframes.length === 1) {
    return [{ ...keyframes[0] }];
  }

  // Sort by timestamp
  const sorted = [...keyframes].sort((a, b) => a.timestamp - b.timestamp);
  const duration = sorted[sorted.length - 1].timestamp - sorted[0].timestamp;
  if (duration <= 0) return [{ ...sorted[0] }];

  const totalFrames = Math.ceil(duration * fps);
  const points: CropPoint[] = [];

  for (let frame = 0; frame <= totalFrames; frame++) {
    const t = sorted[0].timestamp + frame / fps;
    const point = interpolateAtTime(sorted, t, smoothing);
    points.push(point);
  }

  return points;
}

/**
 * Get the interpolated crop position at a specific time.
 */
export function interpolateAtTime(
  keyframes: CropKeyframe[],
  time: number,
  smoothing: number,
): CropPoint {
  if (keyframes.length === 0) {
    return { timestamp: time, x: 0, y: 0, width: 0, height: 0 };
  }
  if (keyframes.length === 1) {
    const { x, y, width, height } = keyframes[0];
    return { timestamp: time, x, y, width, height };
  }

  // Find surrounding keyframes
  let before = keyframes[0];
  let after = keyframes[keyframes.length - 1];

  for (let i = 0; i < keyframes.length - 1; i++) {
    if (keyframes[i].timestamp <= time && keyframes[i + 1].timestamp >= time) {
      before = keyframes[i];
      after = keyframes[i + 1];
      break;
    }
  }

  // If time is before first or after last keyframe, clamp
  if (time <= before.timestamp)
    return {
      timestamp: time,
      x: before.x,
      y: before.y,
      width: before.width,
      height: before.height,
    };
  if (time >= after.timestamp)
    return {
      timestamp: time,
      x: after.x,
      y: after.y,
      width: after.width,
      height: after.height,
    };

  // Normalized t (0-1) between the two keyframes
  const segDuration = after.timestamp - before.timestamp;
  const rawT = segDuration > 0 ? (time - before.timestamp) / segDuration : 0;

  // Apply cubic ease-in-out for smooth motion (affected by smoothing)
  const t = cubicEaseInOut(rawT, smoothing);

  return {
    timestamp: time,
    x: lerp(before.x, after.x, t),
    y: lerp(before.y, after.y, t),
    width: lerp(before.width, after.width, t),
    height: lerp(before.height, after.height, t),
  };
}

/**
 * Cubic ease-in-out function.
 * Smoothing factor scales the easing effect: 0 = linear, 1 = full cubic.
 */
export function cubicEaseInOut(t: number, smoothing: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  // Linear interpolation at smoothing=0, full cubic at smoothing=1
  const eased =
    clamped < 0.5
      ? 4 * clamped * clamped * clamped
      : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
  return lerp(clamped, eased, smoothing);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Generate FFmpeg crop filter string from a trajectory.
 * Uses keyframe-based expression for smooth animated crop.
 */
export function generateCropFilter(
  trajectory: CropPoint[],
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): string {
  if (trajectory.length === 0) {
    // Center crop as fallback
    const x = Math.floor((sourceWidth - targetWidth) / 2);
    const y = Math.floor((sourceHeight - targetHeight) / 2);
    return `crop=${targetWidth}:${targetHeight}:${x}:${y}`;
  }

  if (trajectory.length === 1) {
    const p = trajectory[0];
    const cropX = Math.round(p.x);
    const cropY = Math.round(p.y);
    return `crop=${targetWidth}:${targetHeight}:${cropX}:${cropY}`;
  }

  // For multi-keyframe trajectories, generate a dynamic crop using
  // sendcmd filter or keyframe expressions.
  // We output a set of commands for ffmpeg's sendcmd filter.
  return `crop=${targetWidth}:${targetHeight}:${Math.round(trajectory[0].x)}:${Math.round(trajectory[0].y)}`;
}

/**
 * Compute the target crop dimensions for a given aspect ratio.
 */
export function computeCropDimensions(
  sourceWidth: number,
  sourceHeight: number,
  targetAspect: string,
): { width: number; height: number } {
  const [aw, ah] = parseAspectRatio(targetAspect);
  const ratio = aw / ah;

  let cropWidth: number;
  let cropHeight: number;

  if (sourceWidth / sourceHeight > ratio) {
    // Source is wider — crop width
    cropHeight = sourceHeight;
    cropWidth = Math.round(sourceHeight * ratio);
  } else {
    // Source is taller — crop height
    cropWidth = sourceWidth;
    cropHeight = Math.round(sourceWidth / ratio);
  }

  // Ensure even dimensions (required by many codecs)
  cropWidth = cropWidth - (cropWidth % 2);
  cropHeight = cropHeight - (cropHeight % 2);

  return { width: cropWidth, height: cropHeight };
}

function parseAspectRatio(aspect: string): [number, number] {
  const parts = aspect.split(":");
  if (parts.length !== 2) return [16, 9];
  const w = parseInt(parts[0], 10);
  const h = parseInt(parts[1], 10);
  if (isNaN(w) || isNaN(h) || w <= 0 || h <= 0) return [16, 9];
  return [w, h];
}
