import { describe, expect, it, vi } from "vitest";
import { createSchedulerTools } from "./scheduler-tools.js";

const fakeJob = {
  id: "j1",
  name: "test-job",
  schedule: "0 9 * * *",
  prompt: "Do something",
  enabled: true,
  nextRun: "2026-01-02T09:00:00Z",
  lastRun: null,
  createdAt: "2026-01-01T00:00:00Z",
};

function createMockScheduler() {
  return {
    create: vi.fn().mockReturnValue(fakeJob),
    list: vi.fn().mockReturnValue([fakeJob]),
    getById: vi.fn().mockReturnValue(fakeJob),
    update: vi.fn().mockReturnValue({ ...fakeJob, name: "updated-job" }),
    delete: vi.fn().mockReturnValue(true),
    setEnabled: vi.fn().mockReturnValue({ ...fakeJob, enabled: false }),
    runNow: vi.fn().mockResolvedValue({ output: "Completed" }),
    getNextRun: vi.fn().mockReturnValue(new Date("2026-01-02T09:00:00Z")),
  };
}

describe("scheduler-tools", () => {
  it("returns 7 tool definitions", () => {
    const tools = createSchedulerTools({ scheduler: createMockScheduler() as never });
    expect(tools).toHaveLength(7);
    const names = tools.map((t) => t.name);
    expect(names).toContain("schedule-job");
    expect(names).toContain("list-jobs");
    expect(names).toContain("get-job");
    expect(names).toContain("update-job");
    expect(names).toContain("delete-job");
    expect(names).toContain("toggle-job");
    expect(names).toContain("test-job");
  });

  it("all tools have category productivity", () => {
    const tools = createSchedulerTools({ scheduler: createMockScheduler() as never });
    for (const tool of tools) {
      expect(tool.category).toBe("productivity");
    }
  });

  describe("schedule-job handler", () => {
    it("creates a job and returns JSON", async () => {
      const scheduler = createMockScheduler();
      const tools = createSchedulerTools({ scheduler: scheduler as never });
      const handler = tools.find((t) => t.name === "schedule-job")!.handler;
      const result = await handler({ name: "test-job", schedule: "0 9 * * *", prompt: "Do something" });
      expect(scheduler.create).toHaveBeenCalled();
      expect(JSON.parse(result.text)).toMatchObject({ id: "j1", name: "test-job" });
    });

    it("handles dry_run mode", async () => {
      const scheduler = createMockScheduler();
      const tools = createSchedulerTools({ scheduler: scheduler as never });
      const handler = tools.find((t) => t.name === "schedule-job")!.handler;
      const result = await handler({ name: "test-job", cronExpression: "0 9 * * *", actionPayload: { prompt: "Do something" }, dry_run: true });
      expect(scheduler.create).not.toHaveBeenCalled();
      expect(result.text).toContain("DRY RUN");
    });
  });

  describe("list-jobs handler", () => {
    it("returns list of jobs", async () => {
      const scheduler = createMockScheduler();
      const tools = createSchedulerTools({ scheduler: scheduler as never });
      const handler = tools.find((t) => t.name === "list-jobs")!.handler;
      const result = await handler({});
      expect(scheduler.list).toHaveBeenCalled();
      const parsed = JSON.parse(result.text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
    });
  });

  describe("get-job handler", () => {
    it("returns job JSON when found", async () => {
      const scheduler = createMockScheduler();
      const tools = createSchedulerTools({ scheduler: scheduler as never });
      const handler = tools.find((t) => t.name === "get-job")!.handler;
      const result = await handler({ id: "j1" });
      expect(scheduler.getById).toHaveBeenCalledWith("j1");
      expect(JSON.parse(result.text)).toMatchObject({ id: "j1" });
    });

    it("returns error when not found", async () => {
      const scheduler = createMockScheduler();
      scheduler.getById.mockReturnValue(null);
      const tools = createSchedulerTools({ scheduler: scheduler as never });
      const handler = tools.find((t) => t.name === "get-job")!.handler;
      const result = await handler({ id: "missing" });
      expect(result.isError).toBe(true);
    });
  });

  describe("update-job handler", () => {
    it("updates job and returns updated JSON", async () => {
      const scheduler = createMockScheduler();
      const tools = createSchedulerTools({ scheduler: scheduler as never });
      const handler = tools.find((t) => t.name === "update-job")!.handler;
      const result = await handler({ id: "j1", name: "updated-job" });
      expect(scheduler.update).toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
    });

    it("returns error when update throws", async () => {
      const scheduler = createMockScheduler();
      scheduler.update.mockImplementation(() => { throw new Error("Not found"); });
      const tools = createSchedulerTools({ scheduler: scheduler as never });
      const handler = tools.find((t) => t.name === "update-job")!.handler;
      const result = await handler({ id: "missing" });
      expect(result.isError).toBe(true);
    });
  });

  describe("delete-job handler", () => {
    it("deletes and returns success", async () => {
      const scheduler = createMockScheduler();
      const tools = createSchedulerTools({ scheduler: scheduler as never });
      const handler = tools.find((t) => t.name === "delete-job")!.handler;
      const result = await handler({ id: "j1" });
      expect(scheduler.delete).toHaveBeenCalledWith("j1");
      expect(result.text).toContain("deleted");
    });

    it("returns not found text when not found", async () => {
      const scheduler = createMockScheduler();
      scheduler.delete.mockReturnValue(false);
      const tools = createSchedulerTools({ scheduler: scheduler as never });
      const handler = tools.find((t) => t.name === "delete-job")!.handler;
      const result = await handler({ id: "missing" });
      expect(result.text).toBe("Job not found");
    });
  });

  describe("toggle-job handler", () => {
    it("toggles job and returns updated JSON", async () => {
      const scheduler = createMockScheduler();
      const tools = createSchedulerTools({ scheduler: scheduler as never });
      const handler = tools.find((t) => t.name === "toggle-job")!.handler;
      const result = await handler({ id: "j1", enabled: false });
      expect(scheduler.setEnabled).toHaveBeenCalledWith("j1", false);
      expect(result.isError).toBeUndefined();
    });

    it("returns error when toggle throws", async () => {
      const scheduler = createMockScheduler();
      scheduler.setEnabled.mockImplementation(() => { throw new Error("Not found"); });
      const tools = createSchedulerTools({ scheduler: scheduler as never });
      const handler = tools.find((t) => t.name === "toggle-job")!.handler;
      const result = await handler({ id: "missing", enabled: true });
      expect(result.isError).toBe(true);
    });
  });

  describe("test-job handler", () => {
    it("returns dry run preview for existing job", async () => {
      const scheduler = createMockScheduler();
      const tools = createSchedulerTools({ scheduler: scheduler as never });
      const handler = tools.find((t) => t.name === "test-job")!.handler;
      const result = await handler({ id: "j1" });
      expect(scheduler.getById).toHaveBeenCalledWith("j1");
      expect(result.text).toContain("DRY RUN");
      expect(result.isError).toBeUndefined();
    });

    it("returns error when job not found", async () => {
      const scheduler = createMockScheduler();
      scheduler.getById.mockReturnValue(null);
      const tools = createSchedulerTools({ scheduler: scheduler as never });
      const handler = tools.find((t) => t.name === "test-job")!.handler;
      const result = await handler({ id: "missing" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Job not found");
    });
  });
});
