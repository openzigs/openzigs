import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDatabase } from "./database.js";
import { Scheduler } from "./scheduler.js";

describe("Scheduler", () => {
  let db: Database.Database;
  let scheduler: Scheduler;
  const fixedNow = new Date("2026-01-15T12:00:00Z");

  beforeEach(() => {
    db = createTestDatabase();
    scheduler = new Scheduler({
      db,
      clock: () => fixedNow,
      auditLogDir: "/tmp/openzigs-test-audit",
    });
  });

  afterEach(() => {
    scheduler.stopAll();
    db.close();
  });

  it("creates a job with valid cron expression", () => {
    const job = scheduler.create({
      name: "daily-report",
      cronExpression: "0 9 * * *",
      timezone: "America/New_York",
      actionType: "prompt",
      actionPayload: { promptName: "daily-summary" },
    });

    expect(job.name).toBe("daily-report");
    expect(job.cronExpression).toBe("0 9 * * *");
    expect(job.timezone).toBe("America/New_York");
    expect(job.enabled).toBe(true);
    expect(job.runCount).toBe(0);
  });

  it("rejects invalid cron expression", () => {
    expect(() =>
      scheduler.create({
        name: "bad",
        cronExpression: "not-a-cron",
        actionPayload: {},
      })
    ).toThrow("Invalid cron expression");
  });

  it("lists all jobs", () => {
    scheduler.create({ name: "a", cronExpression: "* * * * *", actionPayload: {} });
    scheduler.create({ name: "b", cronExpression: "0 * * * *", actionPayload: {} });
    expect(scheduler.list()).toHaveLength(2);
  });

  it("retrieves a job by ID", () => {
    const job = scheduler.create({
      name: "test",
      cronExpression: "0 0 * * *",
      actionPayload: { key: "value" },
    });
    const found = scheduler.getById(job.id);
    expect(found!.name).toBe("test");
    expect(found!.actionPayload).toEqual({ key: "value" });
  });

  it("updates a job", () => {
    const job = scheduler.create({
      name: "old-name",
      cronExpression: "0 0 * * *",
      actionPayload: {},
    });
    const updated = scheduler.update(job.id, {
      name: "new-name",
      cronExpression: "30 8 * * 1-5",
    });
    expect(updated.name).toBe("new-name");
    expect(updated.cronExpression).toBe("30 8 * * 1-5");
  });

  it("throws when updating nonexistent job", () => {
    expect(() => scheduler.update("nonexistent", { name: "x" })).toThrow(
      "Job not found"
    );
  });

  it("rejects invalid cron on update", () => {
    const job = scheduler.create({
      name: "test",
      cronExpression: "0 0 * * *",
      actionPayload: {},
    });
    expect(() =>
      scheduler.update(job.id, { cronExpression: "bad" })
    ).toThrow("Invalid cron expression");
  });

  it("deletes a job", () => {
    const job = scheduler.create({
      name: "deleteme",
      cronExpression: "0 0 * * *",
      actionPayload: {},
    });
    expect(scheduler.delete(job.id)).toBe(true);
    expect(scheduler.getById(job.id)).toBeNull();
  });

  it("returns false when deleting nonexistent job", () => {
    expect(scheduler.delete("nonexistent")).toBe(false);
  });

  it("enables and disables a job", () => {
    const job = scheduler.create({
      name: "toggle-me",
      cronExpression: "0 0 * * *",
      actionPayload: {},
      enabled: true,
    });

    const disabled = scheduler.setEnabled(job.id, false);
    expect(disabled.enabled).toBe(false);

    const enabled = scheduler.setEnabled(job.id, true);
    expect(enabled.enabled).toBe(true);
  });

  it("creates a disabled job", () => {
    const job = scheduler.create({
      name: "disabled",
      cronExpression: "0 0 * * *",
      actionPayload: {},
      enabled: false,
    });
    expect(job.enabled).toBe(false);
  });

  it("creates a job with allowedTools", () => {
    const job = scheduler.create({
      name: "scoped-job",
      cronExpression: "0 9 * * *",
      actionType: "prompt",
      actionPayload: { promptName: "daily-summary" },
      allowedTools: ["web-search", "read-file"],
    });

    expect(job.allowedTools).toEqual(["web-search", "read-file"]);

    const found = scheduler.getById(job.id);
    expect(found!.allowedTools).toEqual(["web-search", "read-file"]);
  });

  it("creates a job without allowedTools (null by default)", () => {
    const job = scheduler.create({
      name: "unscoped-job",
      cronExpression: "0 9 * * *",
      actionPayload: {},
    });

    expect(job.allowedTools).toBeNull();
  });

  it("updates allowedTools on a job", () => {
    const job = scheduler.create({
      name: "updatable",
      cronExpression: "0 9 * * *",
      actionPayload: {},
    });

    const updated = scheduler.update(job.id, {
      allowedTools: ["shell-execute", "browser-navigate"],
    });
    expect(updated.allowedTools).toEqual(["shell-execute", "browser-navigate"]);
  });

  it("clears allowedTools by setting null", () => {
    const job = scheduler.create({
      name: "clearable",
      cronExpression: "0 9 * * *",
      actionPayload: {},
      allowedTools: ["web-search"],
    });
    expect(job.allowedTools).toEqual(["web-search"]);

    const updated = scheduler.update(job.id, { allowedTools: null });
    expect(updated.allowedTools).toBeNull();
  });

  it("emits job:executed event", async () => {
    const handler = vi.fn();
    const executingScheduler = new Scheduler({
      db,
      clock: () => fixedNow,
      auditLogDir: "/tmp/openzigs-test-audit",
      onExecute: async () => "done",
    });

    executingScheduler.on("job:executed", handler);

    const job = executingScheduler.create({
      name: "event-test",
      cronExpression: "0 0 * * *",
      actionPayload: {},
    });

    // Manually trigger via internal method (simulate cron fire)
    // We access the private method via type assertion for testing
    await (executingScheduler as unknown as { executeJob: (id: string) => Promise<void> }).executeJob(job.id);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({
      jobId: job.id,
      jobName: "event-test",
      success: true,
      result: "done",
    });

    executingScheduler.stopAll();
  });
});
