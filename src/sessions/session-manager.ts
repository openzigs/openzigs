import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export type SessionChannel = "web" | "discord" | "telegram" | "slack";

export type Session = {
  id: string;
  createdAt: Date;
  lastActiveAt: Date;
  channel: SessionChannel;
  userId: string;
  metadata: Record<string, unknown>;
};

export type ConversationEvent = {
  timestamp: Date;
  type: "user" | "assistant" | "tool_call" | "tool_result";
  content: string;
  metadata?: {
    toolName?: string;
    args?: Record<string, unknown>;
    duration?: number;
  };
};

export type SessionConfig = {
  channel: SessionChannel;
  userId: string;
  metadata?: Record<string, unknown>;
};

export type SessionFilter = {
  channel?: SessionChannel;
  userId?: string;
};

export type SessionCleanupPolicy = {
  maxAgeMs: number;
  maxCount: number;
  maxSizeBytes: number;
};

export type SessionManagerOptions = {
  baseDir?: string;
  cleanupPolicy?: Partial<SessionCleanupPolicy>;
  clock?: () => Date;
};

export type SessionResume = {
  session: Session;
  history: ConversationEvent[];
};

type StoredSession = Omit<Session, "createdAt" | "lastActiveAt"> & {
  createdAt: string;
  lastActiveAt: string;
};

type StoredEvent = Omit<ConversationEvent, "timestamp"> & { timestamp: string };

const defaultSessionDir = () => path.join(os.homedir(), ".openzigs", "sessions");

const defaultCleanupPolicy: SessionCleanupPolicy = {
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxCount: 100,
  maxSizeBytes: 10 * 1024 * 1024
};

const isNotFoundError = (error: unknown) => {
  return error instanceof Error
    && "code" in error
    && (error as { code?: string }).code === "ENOENT";
};

const serializeSession = (session: Session): StoredSession => {
  return {
    ...session,
    createdAt: session.createdAt.toISOString(),
    lastActiveAt: session.lastActiveAt.toISOString()
  };
};

const deserializeSession = (session: StoredSession): Session => {
  return {
    ...session,
    createdAt: new Date(session.createdAt),
    lastActiveAt: new Date(session.lastActiveAt)
  };
};

const serializeEvent = (event: ConversationEvent): StoredEvent => {
  return {
    ...event,
    timestamp: event.timestamp.toISOString()
  };
};

const deserializeEvent = (event: StoredEvent): ConversationEvent => {
  return {
    ...event,
    timestamp: new Date(event.timestamp)
  };
};

export class SessionManager {
  private baseDir: string;
  private cleanupPolicy: SessionCleanupPolicy;
  private clock: () => Date;

  constructor(options: SessionManagerOptions = {}) {
    this.baseDir = options.baseDir ?? defaultSessionDir();
    this.cleanupPolicy = {
      ...defaultCleanupPolicy,
      ...(options.cleanupPolicy ?? {})
    };
    this.clock = options.clock ?? (() => new Date());
  }

  async createSession(config: SessionConfig): Promise<Session> {
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });

    const now = this.clock();
    const session: Session = {
      id: randomUUID(),
      createdAt: now,
      lastActiveAt: now,
      channel: config.channel,
      userId: config.userId,
      metadata: config.metadata ?? {}
    };

    await fs.writeFile(this.sessionPath(session.id), JSON.stringify(serializeSession(session), null, 2), "utf-8");
    await fs.writeFile(this.eventsPath(session.id), "", "utf-8");

    await this.cleanup();
    return session;
  }

  async getSession(id: string): Promise<Session> {
    const stored = await this.readSessionFile(id);
    if (!stored) {
      throw new Error(`Session not found: ${id}`);
    }
    return stored;
  }

  async resumeSession(id: string, limit = 10): Promise<SessionResume> {
    await this.cleanup();
    const session = await this.getSession(id);
    const history = await this.getHistory(id, limit);
    const now = this.clock();
    await this.updateSession({ ...session, lastActiveAt: now });
    return { session: { ...session, lastActiveAt: now }, history };
  }

  async listSessions(filter: SessionFilter = {}): Promise<Session[]> {
    await this.cleanup();
    const sessions = await this.loadAllSessions();

    const filtered = sessions.filter((session) => {
      if (filter.channel && session.channel !== filter.channel) {
        return false;
      }
      if (filter.userId && session.userId !== filter.userId) {
        return false;
      }
      return true;
    });

    return filtered.sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());
  }

  async deleteSession(id: string): Promise<void> {
    await Promise.all([
      fs.unlink(this.sessionPath(id)).catch((error) => {
        if (!isNotFoundError(error)) {
          throw error;
        }
      }),
      fs.unlink(this.eventsPath(id)).catch((error) => {
        if (!isNotFoundError(error)) {
          throw error;
        }
      })
    ]);
  }

  /**
   * Clear all conversation events from a session while keeping the session
   * metadata intact. Resets the JSONL events file to empty and updates
   * the lastActiveAt timestamp.
   */
  async clearSession(id: string): Promise<Session> {
    const session = await this.getSession(id);
    await fs.writeFile(this.eventsPath(id), "", "utf-8");
    const now = this.clock();
    const updated = { ...session, lastActiveAt: now };
    await this.updateSession(updated);
    return updated;
  }

  async appendEvent(sessionId: string, event: ConversationEvent): Promise<void> {
    const session = await this.getSession(sessionId);
    const storedEvent = serializeEvent(event);
    const line = `${JSON.stringify(storedEvent)}\n`;

    await fs.appendFile(this.eventsPath(sessionId), line, "utf-8");

    const now = this.clock();
    await this.updateSession({ ...session, lastActiveAt: now });
    await this.truncateIfNeeded(sessionId);
    await this.cleanup();
  }

  async getHistory(sessionId: string, limit?: number): Promise<ConversationEvent[]> {
    const events = await this.readEvents(sessionId);
    if (limit && limit > 0) {
      return events.slice(-limit);
    }
    return events;
  }

  /**
   * Fork a session at a specific event index.
   * Creates a new session pre-populated with events [0..upToIndex] from the
   * source session. Returns the new session.
   */
  async forkSession(sourceSessionId: string, upToIndex: number): Promise<Session> {
    const sourceSession = await this.getSession(sourceSessionId);
    const allEvents = await this.readEvents(sourceSessionId);
    const slicedEvents = allEvents.slice(0, upToIndex + 1);

    // Create a new session with the same channel and user
    const forked = await this.createSession({
      channel: sourceSession.channel,
      userId: sourceSession.userId,
      metadata: {
        ...sourceSession.metadata,
        forkedFrom: sourceSessionId,
        forkedAtIndex: upToIndex,
      },
    });

    // Write the events to the new session's JSONL
    if (slicedEvents.length > 0) {
      const lines = slicedEvents.map((event) => JSON.stringify(serializeEvent(event))).join("\n") + "\n";
      await fs.writeFile(this.eventsPath(forked.id), lines, "utf-8");
    }

    return forked;
  }

  private sessionPath(id: string) {
    return path.join(this.baseDir, `${id}.json`);
  }

  private eventsPath(id: string) {
    return path.join(this.baseDir, `${id}.jsonl`);
  }

  private async readSessionFile(id: string): Promise<Session | null> {
    try {
      const raw = await fs.readFile(this.sessionPath(id), "utf-8");
      const parsed = JSON.parse(raw) as StoredSession;
      return deserializeSession(parsed);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async updateSession(session: Session) {
    await fs.writeFile(this.sessionPath(session.id), JSON.stringify(serializeSession(session), null, 2), "utf-8");
  }

  private async readEvents(id: string): Promise<ConversationEvent[]> {
    try {
      const raw = await fs.readFile(this.eventsPath(id), "utf-8");
      if (!raw.trim()) {
        return [];
      }
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      return lines.map((line) => deserializeEvent(JSON.parse(line) as StoredEvent));
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }
  }

  private async loadAllSessions(): Promise<Session[]> {
    try {
      const entries = await fs.readdir(this.baseDir);
      const sessions = await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".json") && !entry.endsWith(".jsonl"))
          .map(async (entry) => {
            const raw = await fs.readFile(path.join(this.baseDir, entry), "utf-8");
            return deserializeSession(JSON.parse(raw) as StoredSession);
          })
      );
      return sessions;
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }
  }

  private async cleanup() {
    const sessions = await this.loadAllSessions();
    const now = this.clock().getTime();
    const expired = sessions.filter((session) => now - session.lastActiveAt.getTime() > this.cleanupPolicy.maxAgeMs);

    await Promise.all(expired.map((session) => this.deleteSession(session.id)));

    const remaining = sessions
      .filter((session) => !expired.some((expiredSession) => expiredSession.id === session.id))
      .sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());

    if (remaining.length > this.cleanupPolicy.maxCount) {
      const toDelete = remaining.slice(this.cleanupPolicy.maxCount);
      await Promise.all(toDelete.map((session) => this.deleteSession(session.id)));
    }
  }

  private async truncateIfNeeded(sessionId: string) {
    const maxSize = this.cleanupPolicy.maxSizeBytes;
    if (maxSize <= 0) {
      return;
    }

    const filePath = this.eventsPath(sessionId);
    const stats = await fs.stat(filePath).catch((error) => {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    });

    if (!stats || stats.size <= maxSize) {
      return;
    }

    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);

    let size = 0;
    const kept: string[] = [];

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      const lineSize = Buffer.byteLength(`${line}\n`, "utf-8");
      if (size + lineSize > maxSize) {
        break;
      }
      kept.push(line);
      size += lineSize;
    }

    kept.reverse();
    await fs.writeFile(filePath, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf-8");
  }
}
