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

    // Manually trigger execution (method is now public for Run Now support)
    await executingScheduler.executeJob(job.id);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({
      jobId: job.id,
      jobName: "event-test",
      success: true,
      result: "done",
    });

    executingScheduler.stopAll();
  });

  it("executeJob updates runCount and lastRunAt", async () => {
    const executingScheduler = new Scheduler({
      db,
      clock: () => fixedNow,
      auditLogDir: "/tmp/openzigs-test-audit",
      onExecute: async () => "ok",
    });

    const job = executingScheduler.create({
      name: "run-now-test",
      cronExpression: "0 0 * * *",
      actionPayload: {},
    });

    expect(job.runCount).toBe(0);
    expect(job.lastRunAt).toBeNull();

    await executingScheduler.executeJob(job.id);

    const updated = executingScheduler.getById(job.id)!;
    expect(updated.runCount).toBe(1);
    expect(updated.lastRunAt).toEqual(fixedNow);

    executingScheduler.stopAll();
  });

  it("executeJob skips disabled jobs", async () => {
    const handler = vi.fn();
    const executingScheduler = new Scheduler({
      db,
      clock: () => fixedNow,
      auditLogDir: "/tmp/openzigs-test-audit",
      onExecute: async () => "done",
    });

    executingScheduler.on("job:executed", handler);

    const job = executingScheduler.create({
      name: "disabled-run",
      cronExpression: "0 0 * * *",
      actionPayload: {},
      enabled: false,
    });

    await executingScheduler.executeJob(job.id);

    // Should not emit — job is disabled
    expect(handler).not.toHaveBeenCalled();

    executingScheduler.stopAll();
  });

  it("stores and retrieves autoApproveTools on a job", () => {
    const job = scheduler.create({
      name: "auto-approve-job",
      cronExpression: "0 9 * * *",
      actionPayload: { promptName: "test" },
      autoApproveTools: ["shell-execute", "file-write"],
    });

    expect(job.autoApproveTools).toEqual(["shell-execute", "file-write"]);

    const fetched = scheduler.getById(job.id)!;
    expect(fetched.autoApproveTools).toEqual(["shell-execute", "file-write"]);
  });

  it("update can clear autoApproveTools with null", () => {
    const job = scheduler.create({
      name: "clear-approve",
      cronExpression: "0 9 * * *",
      actionPayload: {},
      autoApproveTools: ["shell-execute"],
    });

    expect(job.autoApproveTools).toEqual(["shell-execute"]);

    const updated = scheduler.update(job.id, { autoApproveTools: null });
    expect(updated.autoApproveTools).toBeNull();
  });

  it("job defaults autoApproveTools to null when not provided", () => {
    const job = scheduler.create({
      name: "no-approve",
      cronExpression: "0 9 * * *",
      actionPayload: {},
    });

    expect(job.autoApproveTools).toBeNull();
  });

  // ── Additional coverage tests ──

  it("creates a job with model and reasoningEffort", () => {
    const job = scheduler.create({
      name: "model-job",
      cronExpression: "0 9 * * *",
      actionPayload: {},
      model: "gpt-4",
      reasoningEffort: "high",
    });
    expect(job.model).toBe("gpt-4");
    expect(job.reasoningEffort).toBe("high");
  });

  it("defaults model and reasoningEffort to null", () => {
    const job = scheduler.create({
      name: "no-model",
      cronExpression: "0 9 * * *",
      actionPayload: {},
    });
    expect(job.model).toBeNull();
    expect(job.reasoningEffort).toBeNull();
  });

  it("updates model on existing job", () => {
    const job = scheduler.create({
      name: "update-model",
      cronExpression: "0 9 * * *",
      actionPayload: {},
    });
    const updated = scheduler.update(job.id, { model: "claude-3" });
    expect(updated.model).toBe("claude-3");
  });

  it("clears model by setting null", () => {
    const job = scheduler.create({
      name: "clear-model",
      cronExpression: "0 9 * * *",
      actionPayload: {},
      model: "gpt-4",
    });
    expect(job.model).toBe("gpt-4");
    const updated = scheduler.update(job.id, { model: null });
    expect(updated.model).toBeNull();
  });

  it("updates reasoningEffort", () => {
    const job = scheduler.create({
      name: "effort-update",
      cronExpression: "0 9 * * *",
      actionPayload: {},
    });
    const updated = scheduler.update(job.id, { reasoningEffort: "low" });
    expect(updated.reasoningEffort).toBe("low");
  });

  it("clears reasoningEffort by setting null", () => {
    const job = scheduler.create({
      name: "clear-effort",
      cronExpression: "0 9 * * *",
      actionPayload: {},
      reasoningEffort: "high",
    });
    const updated = scheduler.update(job.id, { reasoningEffort: null });
    expect(updated.reasoningEffort).toBeNull();
  });

  it("defaults timezone to UTC", () => {
    const job = scheduler.create({
      name: "tz-default",
      cronExpression: "0 9 * * *",
      actionPayload: {},
    });
    expect(job.timezone).toBe("UTC");
  });

  it("defaults actionType to prompt", () => {
    const job = scheduler.create({
      name: "type-default",
      cronExpression: "0 9 * * *",
      actionPayload: {},
    });
    expect(job.actionType).toBe("prompt");
  });

  it("creates a job with custom actionType", () => {
    const job = scheduler.create({
      name: "shell-job",
      cronExpression: "0 9 * * *",
      actionType: "shell",
      actionPayload: { command: "ls" },
    });
    expect(job.actionType).toBe("shell");
  });

  it("executeJob captures error from onExecute", async () => {
    const handler = vi.fn();
    const failScheduler = new Scheduler({
      db,
      clock: () => fixedNow,
      auditLogDir: "/tmp/openzigs-test-audit",
      onExecute: async () => { throw new Error("boom"); },
    });
    failScheduler.on("job:executed", handler);

    const job = failScheduler.create({
      name: "error-job",
      cronExpression: "0 0 * * *",
      actionPayload: {},
    });

    await failScheduler.executeJob(job.id);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({
      success: false,
      error: "boom",
    });
    failScheduler.stopAll();
  });

  it("executeJob with no handler returns default message", async () => {
    const handler = vi.fn();
    const noHandlerScheduler = new Scheduler({
      db,
      clock: () => fixedNow,
      auditLogDir: "/tmp/openzigs-test-audit",
    });
    noHandlerScheduler.on("job:executed", handler);

    const job = noHandlerScheduler.create({
      name: "no-handler",
      cronExpression: "0 0 * * *",
      actionPayload: {},
    });

    await noHandlerScheduler.executeJob(job.id);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].result).toContain("no handler");
    noHandlerScheduler.stopAll();
  });

  it("executeJob skips nonexistent job", async () => {
    const handler = vi.fn();
    scheduler.on("job:executed", handler);
    await scheduler.executeJob("nonexistent-id");
    expect(handler).not.toHaveBeenCalled();
  });

  it("startAll starts only enabled jobs", () => {
    scheduler.create({ name: "enabled", cronExpression: "0 9 * * *", actionPayload: {}, enabled: true });
    scheduler.create({ name: "disabled", cronExpression: "0 9 * * *", actionPayload: {}, enabled: false });
    // startAll should not throw
    scheduler.startAll();
    // Both jobs should exist
    expect(scheduler.list()).toHaveLength(2);
  });

  it("stopAll stops all tasks", () => {
    scheduler.create({ name: "s1", cronExpression: "0 9 * * *", actionPayload: {} });
    scheduler.create({ name: "s2", cronExpression: "0 10 * * *", actionPayload: {} });
    scheduler.startAll();
    // Should not throw
    scheduler.stopAll();
  });

  it("update changes timezone", () => {
    const job = scheduler.create({
      name: "tz-update",
      cronExpression: "0 9 * * *",
      actionPayload: {},
    });
    const updated = scheduler.update(job.id, { timezone: "America/Chicago" });
    expect(updated.timezone).toBe("America/Chicago");
  });

  it("update changes actionPayload", () => {
    const job = scheduler.create({
      name: "payload-update",
      cronExpression: "0 9 * * *",
      actionPayload: { key: "old" },
    });
    const updated = scheduler.update(job.id, { actionPayload: { key: "new" } });
    expect(updated.actionPayload).toEqual({ key: "new" });
  });

  it("update re-enables disabled job and restarts task", () => {
    const job = scheduler.create({
      name: "re-enable",
      cronExpression: "0 9 * * *",
      actionPayload: {},
      enabled: false,
    });
    expect(job.enabled).toBe(false);
    const updated = scheduler.update(job.id, { enabled: true });
    expect(updated.enabled).toBe(true);
  });

  it("update autoApproveTools on a job", () => {
    const job = scheduler.create({
      name: "auto-update",
      cronExpression: "0 9 * * *",
      actionPayload: {},
    });
    const updated = scheduler.update(job.id, { autoApproveTools: ["shell-execute"] });
    expect(updated.autoApproveTools).toEqual(["shell-execute"]);
  });

  it("setTaskEngine sets the task engine", () => {
    const mockEngine = {} as never;
    scheduler.setTaskEngine(mockEngine);
    // Should not throw
  });

  it("creates multiple jobs and lists them all", () => {
    scheduler.create({ name: "first", cronExpression: "0 1 * * *", actionPayload: {} });
    scheduler.create({ name: "second", cronExpression: "0 2 * * *", actionPayload: {} });
    const jobs = scheduler.list();
    expect(jobs).toHaveLength(2);
    const names = jobs.map((j) => j.name).sort();
    expect(names).toEqual(["first", "second"]);
  });

  // ── Skill resolver tests ──

  it("executeJob resolves skill from promptResolver suggestedSkill", async () => {
    const submitSpy = vi.fn();
    const mockTaskEngine = {
      submit: submitSpy.mockReturnValue({ id: "task-1" }),
    };

    const skillScheduler = new Scheduler({
      db,
      clock: () => fixedNow,
      auditLogDir: "/tmp/openzigs-test-audit",
      promptResolver: (name: string) => {
        if (name === "video-prompt") {
          return {
            text: "Create a video",
            preferredTools: null,
            stages: null,
            suggestedSkill: "media-director",
          };
        }
        return null;
      },
      skillResolver: (skillName: string) => {
        if (skillName === "media-director") {
          return {
            body: "You are a media director.\n\nDirect media production.",
            allowedTools: ["generate-video", "generate-image"],
          };
        }
        return null;
      },
    });
    skillScheduler.setTaskEngine(mockTaskEngine as never);

    const job = skillScheduler.create({
      name: "skill-test",
      cronExpression: "0 9 * * *",
      actionType: "prompt",
      actionPayload: { promptName: "video-prompt" },
    });

    await skillScheduler.executeJob(job.id);

    expect(submitSpy).toHaveBeenCalledOnce();
    const [taskInput] = submitSpy.mock.calls[0];
    expect(taskInput.skillName).toBe("media-director");
    expect(taskInput.skillBody).toBe("You are a media director.\n\nDirect media production.");
    // Skill tools should be merged into allowedTools
    expect(taskInput.allowedTools).toContain("generate-video");
    expect(taskInput.allowedTools).toContain("generate-image");

    skillScheduler.stopAll();
  });

  it("executeJob uses explicit jobSkillName over suggestedSkill", async () => {
    const submitSpy = vi.fn();
    const mockTaskEngine = {
      submit: submitSpy.mockReturnValue({ id: "task-2" }),
    };

    const skillScheduler = new Scheduler({
      db,
      clock: () => fixedNow,
      auditLogDir: "/tmp/openzigs-test-audit",
      promptResolver: (name: string) => {
        if (name === "generic-prompt") {
          return {
            text: "Do something",
            preferredTools: null,
            stages: null,
            suggestedSkill: "default-skill",
          };
        }
        return null;
      },
      skillResolver: (skillName: string) => {
        if (skillName === "override-skill") {
          return { body: "Override skill body", allowedTools: ["special-tool"] };
        }
        if (skillName === "default-skill") {
          return { body: "Default skill body", allowedTools: [] };
        }
        return null;
      },
    });
    skillScheduler.setTaskEngine(mockTaskEngine as never);

    const job = skillScheduler.create({
      name: "override-test",
      cronExpression: "0 9 * * *",
      actionType: "prompt",
      actionPayload: { promptName: "generic-prompt", skillName: "override-skill" },
    });

    await skillScheduler.executeJob(job.id);

    const [taskInput] = submitSpy.mock.calls[0];
    expect(taskInput.skillName).toBe("override-skill");
    expect(taskInput.skillBody).toBe("Override skill body");

    skillScheduler.stopAll();
  });

  it("executeJob merges job allowedTools with skill allowedTools", async () => {
    const submitSpy = vi.fn();
    const mockTaskEngine = {
      submit: submitSpy.mockReturnValue({ id: "task-3" }),
    };

    const skillScheduler = new Scheduler({
      db,
      clock: () => fixedNow,
      auditLogDir: "/tmp/openzigs-test-audit",
      promptResolver: () => ({
        text: "Go",
        preferredTools: null,
        stages: null,
        suggestedSkill: "my-skill",
      }),
      skillResolver: () => ({
        body: "Skill body",
        allowedTools: ["skill-tool-a", "skill-tool-b"],
      }),
    });
    skillScheduler.setTaskEngine(mockTaskEngine as never);

    const job = skillScheduler.create({
      name: "merge-test",
      cronExpression: "0 9 * * *",
      actionType: "prompt",
      actionPayload: { promptName: "any" },
      allowedTools: ["job-tool-x"],
    });

    await skillScheduler.executeJob(job.id);

    const [taskInput] = submitSpy.mock.calls[0];
    expect(taskInput.allowedTools).toContain("job-tool-x");
    expect(taskInput.allowedTools).toContain("skill-tool-a");
    expect(taskInput.allowedTools).toContain("skill-tool-b");

    skillScheduler.stopAll();
  });

  it("executeJob computes disabledSkills when allSkillNames is provided", async () => {
    const submitSpy = vi.fn();
    const mockTaskEngine = {
      submit: submitSpy.mockReturnValue({ id: "task-disabled-1" }),
    };

    const skillScheduler = new Scheduler({
      db,
      clock: () => fixedNow,
      auditLogDir: "/tmp/openzigs-test-audit",
      promptResolver: () => ({
        text: "Do media",
        preferredTools: null,
        stages: null,
        suggestedSkill: "media-director",
      }),
      skillResolver: (skillName: string) => {
        if (skillName === "media-director") {
          return { body: "Media body", allowedTools: ["generate-video"] };
        }
        return null;
      },
      allSkillNames: () => ["media-director", "content-creator", "knowledge-curator", "pinterest-marketer"],
    });
    skillScheduler.setTaskEngine(mockTaskEngine as never);

    const job = skillScheduler.create({
      name: "disabled-skills-test",
      cronExpression: "0 9 * * *",
      actionType: "prompt",
      actionPayload: { promptName: "media-prompt" },
    });

    await skillScheduler.executeJob(job.id);

    const [taskInput] = submitSpy.mock.calls[0];
    expect(taskInput.disabledSkills).toEqual(
      expect.arrayContaining(["content-creator", "knowledge-curator", "pinterest-marketer"])
    );
    expect(taskInput.disabledSkills).not.toContain("media-director");

    skillScheduler.stopAll();
  });

  it("executeJob passes agentName from job payload", async () => {
    const submitSpy = vi.fn();
    const mockTaskEngine = {
      submit: submitSpy.mockReturnValue({ id: "task-agent-1" }),
    };

    const agentScheduler = new Scheduler({
      db,
      clock: () => fixedNow,
      auditLogDir: "/tmp/openzigs-test-audit",
      promptResolver: () => ({
        text: "Research topic",
        preferredTools: null,
        stages: null,
        suggestedSkill: null,
      }),
    });
    agentScheduler.setTaskEngine(mockTaskEngine as never);

    const job = agentScheduler.create({
      name: "agent-test",
      cronExpression: "0 9 * * *",
      actionType: "prompt",
      actionPayload: { promptName: "research-prompt", agentName: "scheduled-researcher" },
    });

    await agentScheduler.executeJob(job.id);

    const [taskInput] = submitSpy.mock.calls[0];
    expect(taskInput.agentName).toBe("scheduled-researcher");

    agentScheduler.stopAll();
  });

  it("executeJob does not set disabledSkills without allSkillNames", async () => {
    const submitSpy = vi.fn();
    const mockTaskEngine = {
      submit: submitSpy.mockReturnValue({ id: "task-no-disabled" }),
    };

    const noAllSkillScheduler = new Scheduler({
      db,
      clock: () => fixedNow,
      auditLogDir: "/tmp/openzigs-test-audit",
      promptResolver: () => ({
        text: "Run skill",
        preferredTools: null,
        stages: null,
        suggestedSkill: "pinterest-marketer",
      }),
      skillResolver: () => ({ body: "Pin body", allowedTools: ["pin-tool"] }),
      // No allSkillNames provided
    });
    noAllSkillScheduler.setTaskEngine(mockTaskEngine as never);

    const job = noAllSkillScheduler.create({
      name: "no-disabled-test",
      cronExpression: "0 9 * * *",
      actionType: "prompt",
      actionPayload: { promptName: "pin-prompt" },
    });

    await noAllSkillScheduler.executeJob(job.id);

    const [taskInput] = submitSpy.mock.calls[0];
    expect(taskInput.disabledSkills).toBeUndefined();

    noAllSkillScheduler.stopAll();
  });
});
