import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "./approval-queue.js";

describe("ApprovalQueue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves approvals when approved", async () => {
    const queue = new ApprovalQueue({
      clock: () => new Date("2026-02-06T00:00:00Z"),
      timeoutMs: 1000
    });

    const resultPromise = queue.requestApproval({
      tool: "shell-execute",
      args: { command: "ls" },
      riskLevel: "high",
      explanation: "Need to run a command"
    });

    const [pending] = queue.list({ status: "pending" });
    const accepted = queue.handleDecision(pending.id, {
      approved: true,
      decidedBy: "tester",
      decidedVia: "web"
    });

    expect(accepted).toBe(true);

    const result = await resultPromise;
    expect(result.approved).toBe(true);
    expect(result.status).toBe("approved");
    expect(result.approval.decidedBy).toBe("tester");
  });

  it("ignores second decisions", async () => {
    const queue = new ApprovalQueue({
      clock: () => new Date("2026-02-06T00:00:00Z"),
      timeoutMs: 1000
    });

    const resultPromise = queue.requestApproval({
      tool: "write-file",
      args: { path: "/tmp/test.txt" },
      riskLevel: "high",
      explanation: "Need to write"
    });

    const [pending] = queue.list({ status: "pending" });
    expect(queue.handleDecision(pending.id, { approved: false, decidedVia: "web" })).toBe(true);
    expect(queue.handleDecision(pending.id, { approved: true, decidedVia: "web" })).toBe(false);

    const result = await resultPromise;
    expect(result.approved).toBe(false);
    expect(result.status).toBe("rejected");
  });

  it("expires approvals after timeout", async () => {
    vi.useFakeTimers();
    let now = new Date("2026-02-06T00:00:00Z");

    const queue = new ApprovalQueue({
      clock: () => now,
      timeoutMs: 500
    });

    const resultPromise = queue.requestApproval({
      tool: "shell-execute",
      args: { command: "ls" },
      riskLevel: "high",
      explanation: "Need approval"
    });

    now = new Date(now.getTime() + 501);
    await vi.advanceTimersByTimeAsync(501);

    const result = await resultPromise;
    expect(result.approved).toBe(false);
    expect(result.status).toBe("expired");
  });

  it("cleans up decided approvals after retention", async () => {
    vi.useFakeTimers();
    let now = new Date("2026-02-06T00:00:00Z");

    const queue = new ApprovalQueue({
      clock: () => now,
      timeoutMs: 1000,
      retentionMs: 200
    });

    const resultPromise = queue.requestApproval({
      tool: "write-file",
      args: { path: "/tmp/test.txt" },
      riskLevel: "high",
      explanation: "Need to write"
    });

    const [pending] = queue.list({ status: "pending" });
    queue.handleDecision(pending.id, { approved: true, decidedVia: "web" });
    await resultPromise;

    now = new Date(now.getTime() + 201);
    await vi.advanceTimersByTimeAsync(201);

    expect(queue.get(pending.id)).toBeUndefined();
  });
});
