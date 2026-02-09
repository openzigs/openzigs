import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { TaskRepository } from "./task-repository.js";
import { TaskEngine } from "./task-engine.js";
import { NotificationDispatcher } from "./notification-dispatcher.js";
import type { ChannelManager } from "../channels/channel-manager.js";
import type { SessionManager } from "../sessions/session-manager.js";

const createTestDb = () => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
};

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const createMockChannelManager = () => ({
  register: vi.fn(),
  getChannel: vi.fn(),
  listChannels: vi.fn().mockReturnValue([]),
  broadcast: vi.fn(),
});

const createMockSessionManager = () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  resumeSession: vi.fn(),
  appendEvent: vi.fn().mockResolvedValue(undefined),
  forkSession: vi.fn(),
  getHistory: vi.fn(),
  deleteSession: vi.fn(),
});

describe("NotificationDispatcher", () => {
  let engine: TaskEngine;
  let channelManager: ReturnType<typeof createMockChannelManager>;
  let sessionManager: ReturnType<typeof createMockSessionManager>;
  let io: { emit: ReturnType<typeof vi.fn> };
  let now: Date;

  beforeEach(() => {
    const db = createTestDb();
    now = new Date("2026-02-09T12:00:00Z");
    const repo = new TaskRepository(db, () => now);
    repo.migrate();
    engine = new TaskEngine({ repository: repo, clock: () => now });
    channelManager = createMockChannelManager();
    sessionManager = createMockSessionManager();
    io = { emit: vi.fn() };
  });

  it("emits Socket.IO event on task completion", async () => {
    new NotificationDispatcher({
      engine,
      channelManager: channelManager as unknown as ChannelManager,
      sessionManager: sessionManager as unknown as SessionManager,
      io,
      log: silentLog,
    });

    const task = engine.submit(
      { trigger: "agent", goal: "Test goal", notifyOnComplete: true },
      { mode: "immediate" }
    );
    engine.complete(task.id, "Task result here");

    // Give event handler time to fire
    await new Promise((r) => setTimeout(r, 50));

    expect(io.emit).toHaveBeenCalledWith("task:notification", expect.objectContaining({
      type: "completed",
      task: expect.objectContaining({
        id: task.id,
        status: "completed",
        goal: "Test goal",
        result: "Task result here",
      }),
    }));
  });

  it("does not emit when notifyOnComplete is false", async () => {
    new NotificationDispatcher({
      engine,
      channelManager: channelManager as unknown as ChannelManager,
      sessionManager: sessionManager as unknown as SessionManager,
      io,
      log: silentLog,
    });

    const task = engine.submit(
      { trigger: "agent", goal: "Silent", notifyOnComplete: false },
      { mode: "immediate" }
    );
    engine.complete(task.id, "done");

    await new Promise((r) => setTimeout(r, 50));
    expect(io.emit).not.toHaveBeenCalled();
  });

  it("sends message to originating channel", async () => {
    const mockChannel = {
      id: "telegram",
      type: "telegram" as const,
      sendMessage: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      sendApprovalRequest: vi.fn(),
      onMessage: vi.fn(),
      onApprovalResponse: vi.fn(),
    };
    channelManager.getChannel.mockReturnValue(mockChannel);

    new NotificationDispatcher({
      engine,
      channelManager: channelManager as unknown as ChannelManager,
      sessionManager: sessionManager as unknown as SessionManager,
      io,
      log: silentLog,
    });

    const task = engine.submit(
      {
        trigger: "agent",
        goal: "Research topic",
        channelType: "telegram",
        chatId: "chat-42",
        notifyOnComplete: true,
      },
      { mode: "immediate" }
    );
    engine.complete(task.id, "Research results");

    await new Promise((r) => setTimeout(r, 50));

    expect(mockChannel.sendMessage).toHaveBeenCalledWith(
      "chat-42",
      expect.objectContaining({
        text: expect.stringContaining("Research topic"),
      })
    );
  });

  it("appends to session log on completion", async () => {
    new NotificationDispatcher({
      engine,
      channelManager: channelManager as unknown as ChannelManager,
      sessionManager: sessionManager as unknown as SessionManager,
      io,
      log: silentLog,
    });

    const task = engine.submit(
      {
        trigger: "agent",
        goal: "Background work",
        sessionId: "session-1",
        notifyOnComplete: true,
      },
      { mode: "immediate" }
    );
    engine.complete(task.id, "Result text");

    await new Promise((r) => setTimeout(r, 50));

    expect(sessionManager.appendEvent).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        type: "tool_result",
        content: expect.stringContaining("Background work"),
      })
    );
  });

  it("handles failure notifications", async () => {
    new NotificationDispatcher({
      engine,
      channelManager: channelManager as unknown as ChannelManager,
      sessionManager: sessionManager as unknown as SessionManager,
      io,
      log: silentLog,
    });

    const task = engine.submit(
      { trigger: "agent", goal: "Will fail", notifyOnComplete: true },
      { mode: "immediate" }
    );
    engine.fail(task.id, "Something went wrong");

    await new Promise((r) => setTimeout(r, 50));

    expect(io.emit).toHaveBeenCalledWith("task:notification", expect.objectContaining({
      type: "failed",
      task: expect.objectContaining({
        error: "Something went wrong",
      }),
    }));
  });

  it("truncates long results in channel messages", async () => {
    const mockChannel = {
      id: "telegram",
      type: "telegram" as const,
      sendMessage: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      sendApprovalRequest: vi.fn(),
      onMessage: vi.fn(),
      onApprovalResponse: vi.fn(),
    };
    channelManager.getChannel.mockReturnValue(mockChannel);

    new NotificationDispatcher({
      engine,
      channelManager: channelManager as unknown as ChannelManager,
      sessionManager: sessionManager as unknown as SessionManager,
      io,
      log: silentLog,
    });

    const longResult = "x".repeat(1000);
    const task = engine.submit(
      {
        trigger: "agent",
        goal: "Long output",
        channelType: "telegram",
        chatId: "c1",
        notifyOnComplete: true,
      },
      { mode: "immediate" }
    );
    engine.complete(task.id, longResult);

    await new Promise((r) => setTimeout(r, 50));

    const sentText = mockChannel.sendMessage.mock.calls[0][1].text as string;
    expect(sentText.length).toBeLessThan(longResult.length);
    expect(sentText).toContain("…");
  });

  it("skips channel.sendMessage for web channel (Socket.IO broadcast sufficient)", async () => {
    const mockWebChannel = {
      id: "web-chat",
      type: "web" as const,
      sendMessage: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      sendApprovalRequest: vi.fn(),
      onMessage: vi.fn(),
      onApprovalResponse: vi.fn(),
    };
    channelManager.getChannel.mockReturnValue(mockWebChannel);
    channelManager.listChannels.mockReturnValue([mockWebChannel]);

    new NotificationDispatcher({
      engine,
      channelManager: channelManager as unknown as ChannelManager,
      sessionManager: sessionManager as unknown as SessionManager,
      io,
      log: silentLog,
    });

    const task = engine.submit(
      {
        trigger: "agent",
        goal: "Web task",
        channelType: "web",
        chatId: "c1",
        notifyOnComplete: true,
      },
      { mode: "immediate" }
    );
    engine.complete(task.id, "Done");

    await new Promise((r) => setTimeout(r, 50));

    // io.emit fires (Socket.IO broadcast)
    expect(io.emit).toHaveBeenCalledWith("task:notification", expect.anything());
    // But channel.sendMessage should NOT be called for web
    expect(mockWebChannel.sendMessage).not.toHaveBeenCalled();
  });

  it("sends cross-channel notifications to other configured channels", async () => {
    const mockTelegram = {
      id: "telegram",
      type: "telegram" as const,
      sendMessage: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      sendApprovalRequest: vi.fn(),
      onMessage: vi.fn(),
      onApprovalResponse: vi.fn(),
    };
    channelManager.getChannel.mockReturnValue(undefined);
    channelManager.listChannels.mockReturnValue([mockTelegram]);

    // Return a session with a chatId for the telegram channel
    sessionManager.listSessions.mockResolvedValue([
      { id: "sess-t", channel: "telegram", userId: "tg:123", metadata: { chatId: "tg-chat-42" }, createdAt: new Date(), lastActiveAt: new Date() },
    ]);

    new NotificationDispatcher({
      engine,
      channelManager: channelManager as unknown as ChannelManager,
      sessionManager: sessionManager as unknown as SessionManager,
      io,
      log: silentLog,
    });

    // Task originated from web (not telegram)
    const task = engine.submit(
      {
        trigger: "agent",
        goal: "Cross-channel test",
        channelType: "web",
        chatId: "web-c1",
        notifyOnComplete: true,
      },
      { mode: "immediate" }
    );
    engine.complete(task.id, "Results");

    await new Promise((r) => setTimeout(r, 50));

    // Should send cross-channel notification to telegram
    expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
      "tg-chat-42",
      expect.objectContaining({ text: expect.stringContaining("Cross-channel test") })
    );
  });
});
