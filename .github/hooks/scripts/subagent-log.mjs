#!/usr/bin/env node
// Hook: SubagentStart / SubagentStop — Logs subagent lifecycle.
// Non-blocking: always exits 0, never denies.
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
const event = parsed?.hookEventName ?? "unknown";
const agent = parsed?.agentName ?? "unknown";

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
appendFileSync(join(logDir, "subagent.log"), `${ts} | ${event} | agent=${agent}\n`);

process.stdout.write(JSON.stringify({ continue: true }) + "\n");
