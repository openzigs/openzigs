import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSchedulerTools } from "../scheduler-tools.js";

describe("Tier 2: manage-scheduled-jobs handler", () => {
  const mockScheduler = {
    create: vi.fn().mockReturnValue({
      id: "sched-1",
      name: "Monday Post",
      cronExpression: "0 9 * * 1",
      enabled: true,
    }),
    list: vi.fn().mockReturnValue([
      { id: "sched-1", name: "Monday Post", cronExpression: "0 9 * * 1", enabled: true },
    ]),
    getById: vi.fn().mockReturnValue({
      id: "sched-1",
      name: "Monday Post",
      cronExpression: "0 9 * * 1",
      enabled: true,
    }),
    delete: vi.fn().mockReturnValue(true),
    update: vi.fn().mockReturnValue({
      id: "sched-1",
      name: "Monday Post",
      cronExpression: "0 9 * * 1",
      enabled: false,
    }),
  };

  let handlers: Map<string, (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>>;

  beforeEach(() => {
    vi.clearAllMocks();
    const tools = createSchedulerTools({ scheduler: mockScheduler as never });
    handlers = new Map(tools.map((t) => [t.name, t.handler]));
  });

  it("lists all scheduled jobs", async () => {
    const handler = handlers.get("list-jobs")!;
    const result = await handler({});
    expect(mockScheduler.list).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
  });

  it("gets a job by id", async () => {
    const handler = handlers.get("get-job")!;
    const result = await handler({ id: "sched-1" });
    expect(mockScheduler.getById).toHaveBeenCalledWith("sched-1");
    expect(result.isError).toBeUndefined();
  });

  it("deletes a job", async () => {
    const handler = handlers.get("delete-job")!;
    const result = await handler({ id: "sched-1" });
    expect(mockScheduler.delete).toHaveBeenCalledWith("sched-1");
    expect(result.isError).toBeUndefined();
  });
});
