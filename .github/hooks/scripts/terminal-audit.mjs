#!/usr/bin/env node
// Hook: PreToolUse (run_in_terminal) — Logs terminal commands for audit trail.
// Non-blocking: always allows, just logs the command.
// Cross-platform: runs on Windows, macOS, and Linux via Node.js.
import { execFileSync } from "child_process";
import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString();

let parsed;
try {
  parsed = JSON.parse(input);
} catch {}
const command = parsed?.command ?? null;

let repoRoot = ".";
try {
  repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
} catch {}

const logDir = join(repoRoot, ".github", "hooks", "logs");
mkdirSync(logDir, { recursive: true });

if (command) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  appendFileSync(join(logDir, "terminal.log"), `${ts} | terminal | ${command}\n`);
}

process.stdout.write(
  JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  }) + "\n",
);
