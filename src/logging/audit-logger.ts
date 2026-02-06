import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export type AuditLevel = "info" | "warn" | "error" | "security";
export type AuditCategory = "session" | "message" | "tool" | "security" | "system";

export type AuditLogEntry = {
  id: string;
  timestamp: Date;
  level: AuditLevel;
  category: AuditCategory;
  sessionId?: string;
  userId?: string;
  event: string;
  details: Record<string, unknown>;
};

export type AuditLogEntryInput = Omit<AuditLogEntry, "id" | "timestamp"> & {
  timestamp?: Date;
};

export type AuditQuery = {
  category?: AuditCategory;
  level?: AuditLevel;
  since?: Date;
  until?: Date;
  limit?: number;
};

export type AuditLoggerOptions = {
  baseDir?: string;
  clock?: () => Date;
};

type StoredAuditEntry = Omit<AuditLogEntry, "timestamp"> & { timestamp: string };

const defaultAuditDir = () => path.join(os.homedir(), ".openzigs", "logs");

const sensitivePatterns = [
  /api[_-]?key/i,
  /password/i,
  /secret/i,
  /token/i
];

const isSensitiveKey = (key: string) => {
  return sensitivePatterns.some((pattern) => pattern.test(key));
};

const isSensitiveValue = (value: string) => {
  return sensitivePatterns.some((pattern) => pattern.test(value));
};

const redactValue = (value: unknown, key?: string): unknown => {
  if (typeof value === "string") {
    if ((key && isSensitiveKey(key)) || isSensitiveValue(value)) {
      return "[REDACTED]";
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = redactValue(childValue, childKey);
    }
    return result;
  }

  return value;
};

const redactDetails = (details: Record<string, unknown>) => {
  return redactValue(details) as Record<string, unknown>;
};

const formatDate = (date: Date) => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const isAuditFile = (name: string) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name);

const parseAuditEntry = (line: string): AuditLogEntry | null => {
  if (!line.trim()) {
    return null;
  }
  const parsed = JSON.parse(line) as StoredAuditEntry;
  return {
    ...parsed,
    timestamp: new Date(parsed.timestamp)
  };
};

export class AuditLogger {
  private baseDir: string;
  private clock: () => Date;

  constructor(options: AuditLoggerOptions = {}) {
    this.baseDir = options.baseDir ?? defaultAuditDir();
    this.clock = options.clock ?? (() => new Date());
  }

  async log(entry: AuditLogEntryInput): Promise<AuditLogEntry> {
    const timestamp = entry.timestamp ?? this.clock();
    const redactedDetails = redactDetails(entry.details ?? {});
    const fullEntry: AuditLogEntry = {
      id: randomUUID(),
      timestamp,
      level: entry.level,
      category: entry.category,
      sessionId: entry.sessionId,
      userId: entry.userId,
      event: entry.event,
      details: redactedDetails
    };

    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(this.baseDir, `audit-${formatDate(timestamp)}.jsonl`);
    const stored: StoredAuditEntry = {
      ...fullEntry,
      timestamp: fullEntry.timestamp.toISOString()
    };
    await fs.appendFile(filePath, `${JSON.stringify(stored)}\n`, "utf-8");

    return fullEntry;
  }

  async query({ category, level, since, until, limit = 100 }: AuditQuery = {}): Promise<AuditLogEntry[]> {
    const entries = await this.readAllEntries();
    const filtered = entries.filter((entry) => {
      if (category && entry.category !== category) {
        return false;
      }
      if (level && entry.level !== level) {
        return false;
      }
      if (since && entry.timestamp < since) {
        return false;
      }
      if (until && entry.timestamp > until) {
        return false;
      }
      return true;
    });

    filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return filtered.slice(0, Math.max(0, limit));
  }

  private async readAllEntries(): Promise<AuditLogEntry[]> {
    try {
      const entries = await fs.readdir(this.baseDir);
      const auditFiles = entries.filter(isAuditFile).sort();
      const records: AuditLogEntry[] = [];

      for (const file of auditFiles) {
        const raw = await fs.readFile(path.join(this.baseDir, file), "utf-8");
        const lines = raw.split("\n");
        for (const line of lines) {
          const entry = parseAuditEntry(line);
          if (entry) {
            records.push(entry);
          }
        }
      }

      return records;
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}
