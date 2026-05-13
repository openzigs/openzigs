// Live Mac validation helper for epic #1065 / sub-issue #1066.
// Prints the same payload that GET /api/system/platform serves, so it can be
// diffed against `system_profiler SPHardwareDataType` evidence.
import {
  detectPlatformProfile,
  recommendGemma4Variant,
} from "../src/system/platform-detector.ts";

const p = detectPlatformProfile();
const r = recommendGemma4Variant(p);
const GB = 1024 * 1024 * 1024;
const round1 = (n) => Math.round((n / GB) * 10) / 10;

console.log(
  JSON.stringify(
    {
      platform: p,
      recommended: r,
      memoryGb: round1(p.totalMemoryBytes),
      unifiedMemoryGb: p.unifiedMemoryBytes ? round1(p.unifiedMemoryBytes) : null,
    },
    null,
    2,
  ),
);
