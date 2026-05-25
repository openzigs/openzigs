#!/usr/bin/env node
// Merge backend + UI coverage-final.json files into a single
// `coverage/coverage-final.json` and `coverage/coverage-summary.json`.
// Uses istanbul-lib-coverage (transitively available via vitest deps).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import libCoverage from "istanbul-lib-coverage";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const inputs = [
  process.env.BACKEND_COVERAGE ?? resolve(repoRoot, "coverage/backend/coverage-final.json"),
  process.env.UI_COVERAGE ?? resolve(repoRoot, "ui/coverage/coverage-final.json"),
];

const outDir = resolve(repoRoot, "coverage");
const outFinal = resolve(outDir, "coverage-final.json");
const outSummary = resolve(outDir, "coverage-summary.json");

const map = libCoverage.createCoverageMap({});
let merged = 0;
for (const file of inputs) {
  if (!existsSync(file)) {
    console.warn(`[merge-coverage] skipping missing input: ${file}`);
    continue;
  }
  const data = JSON.parse(readFileSync(file, "utf8"));
  map.merge(data);
  merged += 1;
}
if (merged === 0) {
  console.error("[merge-coverage] no coverage inputs found");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outFinal, JSON.stringify(map.toJSON()));

const summary = { total: emptyTotals() };
for (const file of map.files()) {
  const fc = map.fileCoverageFor(file).toSummary().toJSON();
  summary[file] = fc;
  for (const metric of ["lines", "statements", "functions", "branches", "branchesTrue"]) {
    if (!fc[metric]) continue;
    summary.total[metric].total += fc[metric].total;
    summary.total[metric].covered += fc[metric].covered;
    summary.total[metric].skipped += fc[metric].skipped ?? 0;
  }
}
for (const metric of Object.keys(summary.total)) {
  const t = summary.total[metric];
  t.pct = t.total === 0 ? 100 : Number(((t.covered / t.total) * 100).toFixed(2));
}

writeFileSync(outSummary, JSON.stringify(summary, null, 2));
console.log(
  `[merge-coverage] merged ${merged} input(s) → ${outFinal} (${map.files().length} files)`,
);
console.log(
  `[merge-coverage] total lines ${summary.total.lines.pct}% (${summary.total.lines.covered}/${summary.total.lines.total})`,
);

function emptyTotals() {
  const m = { total: 0, covered: 0, skipped: 0, pct: 0 };
  return {
    lines: { ...m },
    statements: { ...m },
    functions: { ...m },
    branches: { ...m },
    branchesTrue: { ...m },
  };
}
