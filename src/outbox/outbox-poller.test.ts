import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { OutboxPoller } from "./outbox-poller.js";
import { OutboxRepository } from "./outbox-repository.js";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((_expr: string, cb: () => void) => {
      return { stop: vi.fn(), cb };
    }),
  },
}));

function createMockTaskEngine() {
  return {
    submit: vi.fn(() => ({
      id: "task-1",
      status: "queued",
    })),
    on: vi.fn(),
    emit: vi.fn(),
  };
}

let repo: OutboxRepository;
let mockTaskEngine: ReturnType<typeof createMockTaskEngine>;

beforeEach(() => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  repo = new OutboxRepository(db);
  repo.migrate();
  mockTaskEngine = createMockTaskEngine();
});

describe("OutboxPoller", () => {
  it("poll() does nothing when queue is empty", () => {
    const poller = new OutboxPoller({
      outboxRepo: repo,
      taskEngine: mockTaskEngine as any,
    });
    poller.poll();
    expect(mockTaskEngine.submit).not.toHaveBeenCalled();
  });

  it("poll() claims due items and submits tasks", () => {
    // Insert a past-due item
    repo.insert({
      platform: "twitter",
      scheduledTime: new Date(Date.now() - 60_000),
      agentContext: "Post about launch",
    });

    const poller = new OutboxPoller({
      outboxRepo: repo,
      taskEngine: mockTaskEngine as any,
    });
    poller.poll();

    expect(mockTaskEngine.submit).toHaveBeenCalledTimes(1);
    const call = (mockTaskEngine.submit as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(call[0].trigger).toBe("cron");
    expect(call[0].goal).toContain("twitter");
    expect((call[0].goal as string)).toContain("Post about launch");
    expect(call[0].skillName).toBe("universal-publisher");
    expect(call[1].mode).toBe("background");
  });

  it("poll() includes content_body in goal when present", () => {
    repo.insert({
      platform: "twitter",
      scheduledTime: new Date(Date.now() - 60_000),
      agentContext: "Publish this tweet",
      contentBody: "Check out our new feature! #launch",
    });

    const poller = new OutboxPoller({
      outboxRepo: repo,
      taskEngine: mockTaskEngine as any,
    });
    poller.poll();

    expect(mockTaskEngine.submit).toHaveBeenCalledTimes(1);
    const call = (mockTaskEngine.submit as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    const goal = call[0].goal as string;
    expect(goal).toContain("Pre-approved content (use exactly as-is):");
    expect(goal).toContain("Check out our new feature! #launch");
  });

  it("poll() omits content_body from goal when null", () => {
    repo.insert({
      platform: "twitter",
      scheduledTime: new Date(Date.now() - 60_000),
      agentContext: "Post about launch",
    });

    const poller = new OutboxPoller({
      outboxRepo: repo,
      taskEngine: mockTaskEngine as any,
    });
    poller.poll();

    const call = (mockTaskEngine.submit as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    const goal = call[0].goal as string;
    expect(goal).not.toContain("Pre-approved content");
  });

  it("poll() does not claim future items", () => {
    repo.insert({
      platform: "pinterest",
      scheduledTime: new Date(Date.now() + 3_600_000),
      agentContext: "Scheduled for later",
    });

    const poller = new OutboxPoller({
      outboxRepo: repo,
      taskEngine: mockTaskEngine as any,
    });
    poller.poll();

    expect(mockTaskEngine.submit).not.toHaveBeenCalled();
  });

  it("poll() marks item as failed when task submission throws", () => {
    repo.insert({
      platform: "twitter",
      scheduledTime: new Date(Date.now() - 60_000),
      agentContext: "Will fail",
    });

    const failEngine = {
      submit: vi.fn(() => { throw new Error("Rate limit exceeded"); }),
    };

    const poller = new OutboxPoller({
      outboxRepo: repo,
      taskEngine: failEngine as any,
    });
    poller.poll();

    const items = repo.list({ status: "failed" });
    expect(items).toHaveLength(1);
    expect(items[0].error).toContain("Rate limit exceeded");
  });

  it("respects batchSize", () => {
    for (let i = 0; i < 5; i++) {
      repo.insert({
        platform: "twitter",
        scheduledTime: new Date(Date.now() - 60_000),
        agentContext: `Item ${i}`,
      });
    }

    const poller = new OutboxPoller({
      outboxRepo: repo,
      taskEngine: mockTaskEngine as any,
      batchSize: 2,
    });
    poller.poll();

    expect(mockTaskEngine.submit).toHaveBeenCalledTimes(2);

    // Second poll should get 2 more
    poller.poll();
    expect(mockTaskEngine.submit).toHaveBeenCalledTimes(4);
  });

  it("start() and stop() manage the cron task", async () => {
    const cronModule = await import("node-cron");
    const poller = new OutboxPoller({
      outboxRepo: repo,
      taskEngine: mockTaskEngine as any,
    });

    poller.start();
    expect(cronModule.default.schedule).toHaveBeenCalledWith("*/2 * * * *", expect.any(Function), { noOverlap: true });

    poller.stop();
    // Calling stop again should be a no-op
    poller.stop();
  });
});
