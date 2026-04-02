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

import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";

const branch = git("rev-parse", "--abbrev-ref", "HEAD") ?? "detached";
const sha = git("rev-parse", "--short", "HEAD") ?? "unknown";
let dirty = "clean";
try {
  execFileSync("git", ["diff", "--quiet"], { stdio: "pipe" });
} catch {
  dirty = "dirty";
}
const lastCommit = git("log", "-1", "--format=%s") ?? "no commits";

let repoRoot = ".";
try {
  repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
} catch {}

const logDir = join(repoRoot, ".github", "hooks", "logs");
mkdirSync(logDir, { recursive: true });
const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
appendFileSync(
  join(logDir, "session.log"),
  `${ts} | SessionStart | branch=${branch} sha=${sha} (${dirty}) | ${lastCommit}\n`,
);

const contextMsg = `Session context — branch: ${branch}, commit: ${sha} (${dirty}), last: ${lastCommit}`;

// Use hookSpecificOutput.additionalContext to inject context into the model's conversation.
// (systemMessage only shows as a user-visible warning and never reaches the model.)
process.stdout.write(
  JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: contextMsg,
    },
  }) + "\n",
);
