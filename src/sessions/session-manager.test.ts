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
});
