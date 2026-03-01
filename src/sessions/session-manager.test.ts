import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager, type ConversationEvent } from "./session-manager.js";

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const createTempDir = async () => {
  return fs.mkdtemp(path.join(os.tmpdir(), "openzigs-sessions-"));
};

describe("SessionManager", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  it("creates a session with a UUID and timestamps", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const now = new Date("2026-02-03T00:00:00Z");
    const manager = new SessionManager({ baseDir, clock: () => now });

    const session = await manager.createSession({ channel: "web", userId: "user-123" });

    expect(session.id).toMatch(uuidRegex);
    expect(session.createdAt.toISOString()).toBe(now.toISOString());
    expect(session.lastActiveAt.toISOString()).toBe(now.toISOString());
  });

  it("appends events to JSONL history", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const manager = new SessionManager({ baseDir });
    const session = await manager.createSession({ channel: "web", userId: "user-123" });

    const events: ConversationEvent[] = [
      { timestamp: new Date(), type: "user", content: "Hello" },
      { timestamp: new Date(), type: "tool_call", content: "", metadata: { toolName: "read-file" } },
      { timestamp: new Date(), type: "assistant", content: "Hi there" }
    ];

    for (const event of events) {
      await manager.appendEvent(session.id, event);
    }

    const history = await manager.getHistory(session.id);
    expect(history).toHaveLength(3);

    const raw = await fs.readFile(path.join(baseDir, `${session.id}.jsonl`), "utf-8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(3);
  });

  it("persists sessions across manager restarts", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const manager = new SessionManager({ baseDir });
    const session = await manager.createSession({ channel: "discord", userId: "user-456" });
    await manager.appendEvent(session.id, { timestamp: new Date(), type: "user", content: "Hi" });

    const managerRestarted = new SessionManager({ baseDir });
    const loaded = await managerRestarted.getSession(session.id);
    const history = await managerRestarted.getHistory(session.id);

    expect(loaded.id).toBe(session.id);
    expect(history).toHaveLength(1);
  });

  it("resumes with the last 10 messages", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    let now = new Date("2026-02-03T00:00:00Z");
    const manager = new SessionManager({ baseDir, clock: () => now });
    const session = await manager.createSession({ channel: "slack", userId: "user-789" });

    for (let index = 0; index < 12; index += 1) {
      await manager.appendEvent(session.id, {
        timestamp: new Date(Date.now() + index * 1000),
        type: "user",
        content: `message-${index}`
      });
    }

    now = new Date("2026-02-03T00:10:00Z");
    const resumed = await manager.resumeSession(session.id);

    expect(resumed.history).toHaveLength(10);
    expect(resumed.history[0].content).toBe("message-2");
    expect(resumed.history[9].content).toBe("message-11");
    expect(resumed.session.lastActiveAt.toISOString()).toBe(now.toISOString());
  });

  it("cleans up expired sessions before listing or resuming", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    let now = new Date("2026-02-03T00:00:00Z");
    const manager = new SessionManager({
      baseDir,
      clock: () => now,
      cleanupPolicy: { maxAgeMs: 1000, maxCount: 100, maxSizeBytes: 10 * 1024 * 1024 }
    });

    const session = await manager.createSession({ channel: "web", userId: "user-1" });

    now = new Date("2026-02-03T00:00:02Z");

    await expect(manager.resumeSession(session.id)).rejects.toThrow("Session not found");

    const sessions = await manager.listSessions();
    expect(sessions).toHaveLength(0);
  });

  it("lists sessions sorted by last active time", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    let now = new Date("2026-02-03T00:00:00Z");
    const manager = new SessionManager({ baseDir, clock: () => now });

    const first = await manager.createSession({ channel: "web", userId: "user-1" });
    now = new Date("2026-02-03T00:01:00Z");
    const second = await manager.createSession({ channel: "web", userId: "user-2" });

    now = new Date("2026-02-03T00:02:00Z");
    await manager.appendEvent(first.id, { timestamp: now, type: "user", content: "Ping" });

    const sessions = await manager.listSessions();
    expect(sessions[0].id).toBe(first.id);
    expect(sessions[1].id).toBe(second.id);
  });

  // ── NEW: Additional coverage ────────────────────────────────────

  it("throws when getting a non-existent session", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const manager = new SessionManager({ baseDir });
    await expect(manager.getSession("nonexistent")).rejects.toThrow("Session not found");
  });

  it("deletes a session and its events", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const manager = new SessionManager({ baseDir });
    const session = await manager.createSession({ channel: "web", userId: "user-1" });
    await manager.appendEvent(session.id, { timestamp: new Date(), type: "user", content: "hi" });

    await manager.deleteSession(session.id);

    await expect(manager.getSession(session.id)).rejects.toThrow("Session not found");
  });

  it("deleteSession does not throw for non-existent session", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const manager = new SessionManager({ baseDir });
    // Should not throw even if file doesn't exist
    await expect(manager.deleteSession("nonexistent")).resolves.toBeUndefined();
  });

  it("clearSession sets ended metadata", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const now = new Date("2026-02-03T00:00:00Z");
    const manager = new SessionManager({ baseDir, clock: () => now });
    const session = await manager.createSession({ channel: "web", userId: "user-1" });

    const cleared = await manager.clearSession(session.id);
    expect(cleared.metadata.ended).toBe(true);
    expect(cleared.metadata.endedAt).toBeDefined();
  });

  it("getHistory returns all events without limit", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const manager = new SessionManager({ baseDir });
    const session = await manager.createSession({ channel: "web", userId: "user-1" });

    for (let i = 0; i < 5; i++) {
      await manager.appendEvent(session.id, { timestamp: new Date(), type: "user", content: `msg-${i}` });
    }

    const history = await manager.getHistory(session.id);
    expect(history).toHaveLength(5);
  });

  it("getHistory returns empty for non-existent events file", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const manager = new SessionManager({ baseDir });
    const history = await manager.getHistory("nonexistent");
    expect(history).toEqual([]);
  });

  it("filters sessions by channel", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const manager = new SessionManager({ baseDir });
    await manager.createSession({ channel: "web", userId: "user-1" });
    await manager.createSession({ channel: "discord", userId: "user-2" });

    const webSessions = await manager.listSessions({ channel: "web" });
    expect(webSessions).toHaveLength(1);
    expect(webSessions[0].channel).toBe("web");
  });

  it("filters sessions by userId", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const manager = new SessionManager({ baseDir });
    await manager.createSession({ channel: "web", userId: "user-1" });
    await manager.createSession({ channel: "web", userId: "user-2" });

    const user1Sessions = await manager.listSessions({ userId: "user-1" });
    expect(user1Sessions).toHaveLength(1);
    expect(user1Sessions[0].userId).toBe("user-1");
  });

  it("forkSession copies events up to specified index", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const manager = new SessionManager({ baseDir });
    const original = await manager.createSession({ channel: "web", userId: "user-1" });

    for (let i = 0; i < 5; i++) {
      await manager.appendEvent(original.id, { timestamp: new Date(), type: "user", content: `msg-${i}` });
    }

    const forked = await manager.forkSession(original.id, 2);
    expect(forked.id).not.toBe(original.id);
    expect(forked.metadata.forkedFrom).toBe(original.id);
    expect(forked.metadata.forkedAtIndex).toBe(2);

    const forkedHistory = await manager.getHistory(forked.id);
    expect(forkedHistory).toHaveLength(3); // indices 0, 1, 2
    expect(forkedHistory[0].content).toBe("msg-0");
    expect(forkedHistory[2].content).toBe("msg-2");
  });

  it("truncates oversized event files", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const manager = new SessionManager({
      baseDir,
      cleanupPolicy: { maxSizeBytes: 200, maxAgeMs: 999999999, maxCount: 100 },
    });
    const session = await manager.createSession({ channel: "web", userId: "user-1" });

    // Append many events to exceed 200 bytes
    for (let i = 0; i < 20; i++) {
      await manager.appendEvent(session.id, { timestamp: new Date(), type: "user", content: `long-message-${i}-padding` });
    }

    const history = await manager.getHistory(session.id);
    // Should have been truncated to fit within 200 bytes
    expect(history.length).toBeLessThan(20);
    expect(history.length).toBeGreaterThan(0);
  });

  it("enforces maxCount cleanup", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const now = new Date("2026-02-03T00:00:00Z");
    const manager = new SessionManager({
      baseDir,
      clock: () => now,
      cleanupPolicy: { maxCount: 2, maxAgeMs: 999999999, maxSizeBytes: 10 * 1024 * 1024 },
    });

    await manager.createSession({ channel: "web", userId: "user-1" });
    await manager.createSession({ channel: "web", userId: "user-2" });
    await manager.createSession({ channel: "web", userId: "user-3" });

    const sessions = await manager.listSessions();
    expect(sessions.length).toBeLessThanOrEqual(2);
  });

  it("creates session with custom metadata", async () => {
    const baseDir = await createTempDir();
    cleanupDirs.push(baseDir);

    const manager = new SessionManager({ baseDir });
    const session = await manager.createSession({
      channel: "telegram",
      userId: "user-1",
      metadata: { botName: "testbot", chatId: 12345 },
    });

    expect(session.metadata.botName).toBe("testbot");
    expect(session.metadata.chatId).toBe(12345);

    // Persists across reload
    const reloaded = await manager.getSession(session.id);
    expect(reloaded.metadata.botName).toBe("testbot");
  });
});
