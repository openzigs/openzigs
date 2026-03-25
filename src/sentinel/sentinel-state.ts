import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { secureDirOptions, secureWriteOptions } from "../config/file-permissions.js";

// ── Zod Schemas ──────────────────────────────────────────────────────

export const SentinelStateSchema = z.object({
  lastTaskCheckAt: z.string().datetime(),
  lastDigestAt: z.string().datetime().nullable(),
  lastPromptAuditAt: z.string().datetime().nullable(),
  consecutiveFailures: z.number().default(0),
  totalTasksReviewed: z.number().default(0),
  alertsSent: z.number().default(0),
  enabled: z.boolean().default(true),
  modelOverride: z.string().nullable().default(null),
});

export type SentinelState = z.infer<typeof SentinelStateSchema>;

export const SentinelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().default("gpt-4o-mini"),
  checkIntervalMinutes: z.number().min(1).default(15),
  jitterMinutes: z.number().min(0).default(15),
  slowTaskThresholdMinutes: z.number().min(1).default(5),
  orphanTaskThresholdMinutes: z.number().min(1).default(30),
  digestHour: z.number().min(0).max(23).default(9),
  auditHour: z.number().min(0).max(23).default(2),
  consecutiveFailureThreshold: z.number().min(1).default(3),
  queueDepthThreshold: z.number().min(1).default(10),
  // #195: State & Memory config
  persistMarkdownDigest: z.boolean().default(true),
  markdownDigestPath: z.string().nullable().default(null),
  digestRetentionDays: z.number().min(1).default(30),
  // #196: Multi-channel alert routing
  notifyChannels: z.array(z.string()).default(["admin"]),
  criticalCooldownMinutes: z.number().min(1).default(5),
  warningCooldownMinutes: z.number().min(1).default(30),
  // #197: Advanced scheduler (node-cron v4)
  timezone: z.string().default("UTC"),
  noOverlap: z.boolean().default(true),
  maxRandomDelayMs: z.number().min(0).default(0),
});

export type SentinelConfig = z.infer<typeof SentinelConfigSchema>;

// ── Prompt Recommendation ────────────────────────────────────────────

export interface PromptRecommendation {
  prompt: string;
  sessionId: string;
  score: number;
  suggestions: string;
  rewrite: string | null;
}

// ── Digest Record ────────────────────────────────────────────────────

export interface DigestRecord {
  timestamp: string;
  period: { from: string; to: string };
  taskSummary: {
    completed: number;
    failed: number;
    cancelled: number;
    successRate: number;
  };
  tokenBurn: {
    total: number;
    avgPerTask: number;
    topConsumer: { goal: string; tokens: number } | null;
  } | null;
  promptAudit: {
    sampledCount: number;
    avgScore: number;
  } | null;
  /** Per-prompt improvement suggestions from the prompt auditor (#195). */
  promptRecommendations: PromptRecommendation[] | null;
  alertCount: number;
}

// ── File paths ───────────────────────────────────────────────────────

const SENTINEL_DIR = path.join(os.homedir(), ".openzigs", "sentinel");
const STATE_FILE = path.join(SENTINEL_DIR, "state.json");
const DIGEST_FILE = path.join(SENTINEL_DIR, "digest-history.jsonl");
const STATUS_MD_FILE = path.join(SENTINEL_DIR, "status.md");

export const getSentinelDir = () => SENTINEL_DIR;
export const getStateFilePath = () => STATE_FILE;
export const getDigestFilePath = () => DIGEST_FILE;
export const getStatusMdPath = () => STATUS_MD_FILE;

// ── State Persistence ────────────────────────────────────────────────

/** Ensure the sentinel directory exists. */
export const ensureSentinelDir = async (): Promise<void> => {
  await fs.mkdir(SENTINEL_DIR, secureDirOptions());
};

/** Create a fresh default state. */
export const defaultState = (clock?: () => Date): SentinelState => ({
  lastTaskCheckAt: (clock ?? (() => new Date()))().toISOString(),
  lastDigestAt: null,
  lastPromptAuditAt: null,
  consecutiveFailures: 0,
  totalTasksReviewed: 0,
  alertsSent: 0,
  enabled: true,
  modelOverride: null,
});

/** Read state from disk, falling back to defaults on missing/corrupt file. */
export const readState = async (clock?: () => Date): Promise<SentinelState> => {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return SentinelStateSchema.parse(parsed);
  } catch {
    // Missing or corrupt — return defaults
    return defaultState(clock);
  }
};

/** Write state to disk atomically (write-to-temp then rename). */
export const writeState = async (state: SentinelState): Promise<void> => {
  await ensureSentinelDir();
  const tmp = `${STATE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), secureWriteOptions());
  await fs.rename(tmp, STATE_FILE);
};

// ── Digest Persistence ──────────────────────────────────────────────

/** Append a digest record to the JSONL file and prune old entries. */
export const appendDigestRecord = async (record: DigestRecord, retentionDays = 30): Promise<void> => {
  await ensureSentinelDir();
  const line = JSON.stringify(record) + "\n";
  await fs.appendFile(DIGEST_FILE, line, { encoding: "utf-8" });

  // Prune entries older than retentionDays
  await pruneDigestHistory(retentionDays);
};

/** Remove digest entries older than the given retention window.
 *  Reads the entire JSONL file into memory — acceptable since digest files
 *  grow by at most one line per day (≈30 lines at default 30-day retention). */
export const pruneDigestHistory = async (retentionDays: number): Promise<number> => {
  try {
    const raw = await fs.readFile(DIGEST_FILE, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const kept: string[] = [];
    let pruned = 0;

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as DigestRecord;
        if (new Date(record.timestamp).getTime() >= cutoff) {
          kept.push(line);
        } else {
          pruned++;
        }
      } catch {
        // Skip malformed lines
        pruned++;
      }
    }

    if (pruned > 0) {
      const tmp = `${DIGEST_FILE}.tmp`;
      await fs.writeFile(tmp, kept.join("\n") + (kept.length > 0 ? "\n" : ""), { encoding: "utf-8" });
      await fs.rename(tmp, DIGEST_FILE);
    }
    return pruned;
  } catch {
    return 0;
  }
};

/** Write the human-readable status.md file. */
export const writeStatusMarkdown = async (content: string, customPath?: string | null): Promise<void> => {
  await ensureSentinelDir();
  const filePath = customPath ?? STATUS_MD_FILE;
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, { encoding: "utf-8" });
};

/** Read the status.md file content. Returns null if not found. */
export const readStatusMarkdown = async (customPath?: string | null): Promise<string | null> => {
  try {
    const filePath = customPath ?? STATUS_MD_FILE;
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
};

/** Read the most recent N digest records. */
export const readDigestHistory = async (limit = 20): Promise<DigestRecord[]> => {
  try {
    const raw = await fs.readFile(DIGEST_FILE, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const records: DigestRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as DigestRecord);
      } catch {
        // Skip malformed lines
      }
    }
    // Return most recent first
    return records.reverse().slice(0, limit);
  } catch {
    return [];
  }
};
