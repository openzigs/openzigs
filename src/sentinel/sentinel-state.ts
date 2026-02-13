import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

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
  digestHour: z.number().min(0).max(23).default(9),
  auditHour: z.number().min(0).max(23).default(2),
  consecutiveFailureThreshold: z.number().min(1).default(3),
  queueDepthThreshold: z.number().min(1).default(10),
});

export type SentinelConfig = z.infer<typeof SentinelConfigSchema>;

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
  alertCount: number;
}

// ── File paths ───────────────────────────────────────────────────────

const SENTINEL_DIR = path.join(os.homedir(), ".openzigs", "sentinel");
const STATE_FILE = path.join(SENTINEL_DIR, "state.json");
const DIGEST_FILE = path.join(SENTINEL_DIR, "digest-history.jsonl");

export const getSentinelDir = () => SENTINEL_DIR;
export const getStateFilePath = () => STATE_FILE;
export const getDigestFilePath = () => DIGEST_FILE;

// ── State Persistence ────────────────────────────────────────────────

/** Ensure the sentinel directory exists. */
export const ensureSentinelDir = async (): Promise<void> => {
  await fs.mkdir(SENTINEL_DIR, { recursive: true, mode: 0o700 });
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
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tmp, STATE_FILE);
};

// ── Digest Persistence ──────────────────────────────────────────────

/** Append a digest record to the JSONL file. */
export const appendDigestRecord = async (record: DigestRecord): Promise<void> => {
  await ensureSentinelDir();
  const line = JSON.stringify(record) + "\n";
  await fs.appendFile(DIGEST_FILE, line, { encoding: "utf-8" });
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
