#!/usr/bin/env node
// Enforce per-area line coverage thresholds against the unified
// `coverage/coverage-summary.json` produced by `scripts/merge-coverage.mjs`.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const summaryPath = resolve(repoRoot, "coverage/coverage-summary.json");
const thresholdsPath = resolve(repoRoot, "coverage/thresholds.json");

if (!existsSync(summaryPath)) {
  console.error(`[check-coverage] missing ${summaryPath}. Run \`pnpm coverage:report\` first.`);
  process.exit(1);
}
if (!existsSync(thresholdsPath)) {
  console.error(`[check-coverage] missing ${thresholdsPath}.`);
  process.exit(1);
}

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const thresholds = JSON.parse(readFileSync(thresholdsPath, "utf8"));

const buckets = {
  backend: { lines: { total: 0, covered: 0 } },
  ui: { lines: { total: 0, covered: 0 } },
  desktop: { lines: { total: 0, covered: 0 } },
};

const norm = (p) => p.split(sep).join("/");
for (const [file, entry] of Object.entries(summary)) {
  if (file === "total") continue;
  const p = norm(file);
  let area;
  if (p.includes("/desktop/")) area = "desktop";
  else if (p.includes("/ui/")) area = "ui";
  else if (p.includes("/src/")) area = "backend";
  else continue;
  buckets[area].lines.total += entry.lines?.total ?? 0;
  buckets[area].lines.covered += entry.lines?.covered ?? 0;
}

let failed = false;
for (const area of Object.keys(buckets)) {
  const { total, covered } = buckets[area].lines;
  const pct = total === 0 ? 100 : (covered / total) * 100;
  const threshold = thresholds[area]?.lines ?? 0;
  const ok = pct >= threshold;
  const symbol = ok ? "✅" : "❌";
  const fmt = pct.toFixed(2);
  console.log(
    `${symbol} ${area.padEnd(7)} lines ${fmt}% (${covered}/${total}) — threshold ${threshold.toFixed(2)}%`,
  );
  if (!ok) {
    failed = true;
    console.error(
      `   regression detected in ${area}: ${fmt}% < ${threshold.toFixed(2)}%`,
    );
  }
}

if (failed) {
  console.error("\n[check-coverage] threshold gate failed");
  process.exit(1);
}
console.log("\n[check-coverage] all thresholds met");
