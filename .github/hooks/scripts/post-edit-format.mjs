#!/usr/bin/env node
// Hook: PostToolUse (edit/create file) — Auto-formats edited files with prettier.
// Non-blocking: formatting failures are warnings, never blocks the agent.
// Cross-platform: runs on Windows, macOS, and Linux via Node.js.
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join, extname } from "path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString();

let parsed;
try {
  parsed = JSON.parse(input);
} catch {}
const filePath = parsed?.filePath ?? null;

if (filePath) {
  const ext = extname(filePath);
  if ([".ts", ".tsx", ".js", ".jsx", ".css", ".json"].includes(ext)) {
    let repoRoot = ".";
    try {
      repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {}

    // Support both Unix (prettier) and Windows (prettier.cmd)
    const binDir = join(repoRoot, "node_modules", ".bin");
    const prettierWin = join(binDir, "prettier.cmd");
    const prettierUnix = join(binDir, "prettier");
    const prettierBin = existsSync(prettierWin) ? prettierWin : prettierUnix;

    if (existsSync(prettierBin)) {
      try {
        execFileSync(prettierBin, ["--write", filePath], { stdio: "pipe" });
      } catch {}
    }
  }
}

process.stdout.write(JSON.stringify({ continue: true }) + "\n");
