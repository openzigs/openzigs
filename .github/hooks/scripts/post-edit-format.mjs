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
// VS Code may put tool input at root level OR nested under tool_input — check both.
const filePath = parsed?.tool_input?.filePath ?? parsed?.filePath ?? null;

if (filePath) {
  const ext = extname(filePath);

  let repoRoot = ".";
  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {}

  const { mkdirSync, appendFileSync } = await import("fs");
  const logDir = join(repoRoot, ".github", "hooks", "logs");
  mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  if ([".ts", ".tsx", ".js", ".jsx", ".css", ".json"].includes(ext)) {
    // Support both Unix (prettier) and Windows (prettier.cmd)
    const binDir = join(repoRoot, "node_modules", ".bin");
    const prettierWin = join(binDir, "prettier.cmd");
    const prettierUnix = join(binDir, "prettier");
    const prettierBin = existsSync(prettierWin) ? prettierWin : prettierUnix;

    let formatted = false;
    if (existsSync(prettierBin)) {
      try {
        execFileSync(prettierBin, ["--write", filePath], { stdio: "pipe" });
        formatted = true;
      } catch {}
    }

    appendFileSync(
      join(logDir, "edits.log"),
      `${ts} | PostToolUse | ${formatted ? "formatted" : "skipped"} | ${filePath}\n`,
    );
  } else {
    appendFileSync(
      join(logDir, "edits.log"),
      `${ts} | PostToolUse | edited | ${filePath}\n`,
    );
  }
}

process.stdout.write(JSON.stringify({ continue: true }) + "\n");
