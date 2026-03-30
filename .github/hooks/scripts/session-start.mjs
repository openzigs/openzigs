#!/usr/bin/env node
// Hook: SessionStart — Injects git context into every new agent session.
// Non-blocking: always exits 0, outputs systemMessage only.
// Cross-platform: runs on Windows, macOS, and Linux via Node.js.
import { execFileSync } from "child_process";

function git(...args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

const branch = git("rev-parse", "--abbrev-ref", "HEAD") ?? "detached";
const sha = git("rev-parse", "--short", "HEAD") ?? "unknown";
let dirty = "clean";
try {
  execFileSync("git", ["diff", "--quiet"], { stdio: "pipe" });
} catch {
  dirty = "dirty";
}
const lastCommit = git("log", "-1", "--format=%s") ?? "no commits";

process.stdout.write(
  JSON.stringify({
    continue: true,
    systemMessage: `Session context — branch: ${branch}, commit: ${sha} (${dirty}), last: ${lastCommit}`,
  }) + "\n",
);
