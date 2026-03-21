import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { TemplateRepository } from "./template-repository.js";
import {
  TemplateService,
  extractVariables,
  interpolateTemplate,
} from "./template-service.js";
import type { CreateOrchestrationTemplateInput } from "./types.js";

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function makeRepo(db?: Database.Database) {
  const d = db ?? makeDb();
  const repo = new TemplateRepository(d);
  repo.migrate();
  return { db: d, repo };
}

const SAMPLE_INPUT: CreateOrchestrationTemplateInput = {
  name: "Test Template",
  description: "A test template",
  category: "custom",
  stages: [
    {
      name: "research",
      type: "parallel",
      agents: [
        { archetype: "researcher", goal: "Research {{topic}}", model: null, allowedTools: ["web-search"], autoApproveTools: [] },
      ],
      dependsOn: [],
    },
  ],
  variables: [
    { name: "topic", description: "The topic", required: true, defaultValue: null },
  ],
  aggregationPrompt: null,
};

// ── Unit tests: extractVariables / interpolateTemplate ──────────────

describe("extractVariables", () => {
  it("extracts variable names from template string", () => {
    expect(extractVariables("Research {{topic}} and {{format}}")).toEqual([
      "topic",
      "format",
    ]);
  });

  it("deduplicates variables", () => {
    expect(extractVariables("{{a}} and {{a}} and {{b}}")).toEqual(["a", "b"]);
  });

  it("returns empty array when no variables", () => {
    expect(extractVariables("No variables here")).toEqual([]);
  });
});

describe("interpolateTemplate", () => {
  it("replaces variables with values", () => {
    expect(interpolateTemplate("Hello {{name}}!", { name: "World" })).toBe(
      "Hello World!"
    );
  });

  it("leaves unresolved variables untouched", () => {
    expect(interpolateTemplate("{{a}} and {{b}}", { a: "1" })).toBe(
      "1 and {{b}}"
    );
  });

  it("handles multiple occurrences", () => {
    expect(
      interpolateTemplate("{{x}} + {{x}} = 2{{x}}", { x: "1" })
    ).toBe("1 + 1 = 21");
  });
});

// ── TemplateRepository ─────────────────────────────────────────────

describe("TemplateRepository", () => {
  let repo: TemplateRepository;

  beforeEach(() => {
    ({ repo } = makeRepo());
  });

  it("inserts and retrieves a template", () => {
    const t = repo.insert(SAMPLE_INPUT);
    expect(t.name).toBe("Test Template");
    expect(t.stages).toHaveLength(1);
    expect(t.variables).toHaveLength(1);
    expect(t.isBuiltIn).toBe(false);

    const found = repo.getById(t.id);
    expect(found).toEqual(t);
  });

  it("lists templates", () => {
    repo.insert(SAMPLE_INPUT);
    repo.insert({ ...SAMPLE_INPUT, name: "Second" });
    const list = repo.list();
    expect(list).toHaveLength(2);
  });

  it("updates a template", () => {
    const t = repo.insert(SAMPLE_INPUT);
    const updated = repo.update(t.id, { name: "Updated Name", description: "Updated" });
    expect(updated?.name).toBe("Updated Name");
    expect(updated?.description).toBe("Updated");
    // Unchanged fields remain intact
    expect(updated?.stages).toEqual(t.stages);
  });

  it("deletes a non-built-in template", () => {
    const t = repo.insert(SAMPLE_INPUT);
    expect(repo.delete(t.id)).toBe(true);
    expect(repo.getById(t.id)).toBeNull();
  });

  it("refuses to delete a built-in template", () => {
    const t = repo.insert(SAMPLE_INPUT, true);
    expect(t.isBuiltIn).toBe(true);
    expect(repo.delete(t.id)).toBe(false);
    expect(repo.getById(t.id)).not.toBeNull();
  });

  it("counts templates", () => {
    expect(repo.count()).toBe(0);
    repo.insert(SAMPLE_INPUT);
    expect(repo.count()).toBe(1);
  });

  it("getByName returns matching template", () => {
    repo.insert(SAMPLE_INPUT);
    const found = repo.getByName("Test Template");
    expect(found?.name).toBe("Test Template");
    expect(repo.getByName("Nonexistent")).toBeNull();
  });
});

// ── TemplateService ────────────────────────────────────────────────

describe("TemplateService", () => {
  let repo: TemplateRepository;
  let service: TemplateService;

  beforeEach(() => {
    ({ repo } = makeRepo());
    service = new TemplateService({ repository: repo });
  });

  it("creates a template via validated input", () => {
    const t = service.create(SAMPLE_INPUT);
    expect(t.name).toBe("Test Template");
    expect(t.id).toBeDefined();
  });

  it("rejects invalid input on create", () => {
    expect(() => service.create({ name: "" })).toThrow();
  });

  it("lists templates", () => {
    service.create(SAMPLE_INPUT);
    const list = service.list();
    expect(list).toHaveLength(1);
  });

  it("gets template by id", () => {
    const t = service.create(SAMPLE_INPUT);
    expect(service.getById(t.id)?.name).toBe("Test Template");
    expect(service.getById("nonexistent")).toBeNull();
  });

  it("updates a template", () => {
    const t = service.create(SAMPLE_INPUT);
    const updated = service.update(t.id, { name: "Renamed" });
    expect(updated?.name).toBe("Renamed");
  });

  it("returns null when updating nonexistent template", () => {
    expect(service.update("nope", { name: "Renamed" })).toBeNull();
  });

  it("deletes a user template", () => {
    const t = service.create(SAMPLE_INPUT);
    expect(service.delete(t.id)).toBe(true);
    expect(service.getById(t.id)).toBeNull();
  });

  it("throws when deleting a built-in template", () => {
    const t = repo.insert(SAMPLE_INPUT, true);
    expect(() => service.delete(t.id)).toThrow("Cannot delete built-in templates");
  });

  it("returns false when deleting nonexistent template", () => {
    expect(service.delete("nope")).toBe(false);
  });

  describe("seedBuiltIns", () => {
    it("seeds built-in templates when table is empty", () => {
      const count = service.seedBuiltIns();
      expect(count).toBe(5);
      expect(service.list().length).toBe(5);
    });

    it("does not re-seed when templates already exist", () => {
      service.create(SAMPLE_INPUT);
      const count = service.seedBuiltIns();
      expect(count).toBe(0);
    });
  });

  describe("execute", () => {
    it("throws if template not found", () => {
      expect(() => service.execute("nope", {})).toThrow("Template not found");
    });

    it("throws if taskEngine is not available", () => {
      const t = service.create(SAMPLE_INPUT);
      expect(() => service.execute(t.id, { variables: { topic: "AI" } })).toThrow(
        "TaskEngine not available"
      );
    });

    it("throws on missing required variables", () => {
      const fakeEngine = {
        submit: vi.fn().mockReturnValue({ id: "task-1" }),
      };
      const svc = new TemplateService({
        repository: repo,
        taskEngine: fakeEngine as never,
      });
      const t = svc.create(SAMPLE_INPUT);
      expect(() => svc.execute(t.id, { variables: {} })).toThrow(
        "Missing required variable: topic"
      );
    });

    it("submits tasks for each agent in each stage", () => {
      const fakeEngine = {
        submit: vi.fn().mockReturnValue({ id: "task-1" }),
      };
      const svc = new TemplateService({
        repository: repo,
        taskEngine: fakeEngine as never,
      });
      const t = svc.create({
        ...SAMPLE_INPUT,
        stages: [
          {
            name: "stage1",
            type: "parallel",
            agents: [
              { archetype: "researcher", goal: "Do {{topic}} research", model: null, allowedTools: [], autoApproveTools: [] },
              { archetype: "writer", goal: "Write about {{topic}}", model: null, allowedTools: [], autoApproveTools: [] },
            ],
            dependsOn: [],
          },
        ],
      });

      const result = svc.execute(t.id, { variables: { topic: "AI" } });
      expect(result.taskIds).toHaveLength(2);
      expect(fakeEngine.submit).toHaveBeenCalledTimes(2);

      // Verify goals are interpolated
      const firstCall = fakeEngine.submit.mock.calls[0][0];
      expect(firstCall.goal).toBe("Do AI research");
      expect(firstCall.trigger).toBe("agent");
      expect(firstCall.agentName).toBe("researcher");

      const secondCall = fakeEngine.submit.mock.calls[1][0];
      expect(secondCall.goal).toBe("Write about AI");
      expect(secondCall.agentName).toBe("writer");
    });

    it("uses default values for optional variables", () => {
      const fakeEngine = {
        submit: vi.fn().mockReturnValue({ id: "task-1" }),
      };
      const svc = new TemplateService({
        repository: repo,
        taskEngine: fakeEngine as never,
      });
      const t = svc.create({
        ...SAMPLE_INPUT,
        stages: [
          {
            name: "s1",
            type: "sequential",
            agents: [
              { archetype: "writer", goal: "Write a {{format}} about {{topic}}", model: null, allowedTools: [], autoApproveTools: [] },
            ],
            dependsOn: [],
          },
        ],
        variables: [
          { name: "topic", description: "", required: true, defaultValue: null },
          { name: "format", description: "", required: false, defaultValue: "blog post" },
        ],
      });

      svc.execute(t.id, { variables: { topic: "AI" } });
      const call = fakeEngine.submit.mock.calls[0][0];
      expect(call.goal).toBe("Write a blog post about AI");
    });

    it("defers stages with dependsOn until dependencies complete", () => {
      let taskCounter = 0;
      const emitter = new EventEmitter();
      const tasks = new Map<string, { id: string; status: string }>();

      const fakeEngine = Object.assign(emitter, {
        submit: vi.fn().mockImplementation(() => {
          const id = `task-${++taskCounter}`;
          const task = { id, status: "queued" };
          tasks.set(id, task);
          return task;
        }),
        getTask: vi.fn().mockImplementation((id: string) => tasks.get(id) ?? null),
      });

      const svc = new TemplateService({
        repository: repo,
        taskEngine: fakeEngine as never,
      });
      const t = svc.create({
        ...SAMPLE_INPUT,
        stages: [
          {
            name: "research",
            type: "parallel",
            agents: [
              { archetype: "researcher", goal: "Research {{topic}}", model: null, allowedTools: ["web-search"], autoApproveTools: [] },
            ],
            dependsOn: [],
          },
          {
            name: "synthesize",
            type: "sequential",
            agents: [
              { archetype: "writer", goal: "Synthesize {{topic}}", model: null, allowedTools: [], autoApproveTools: [] },
            ],
            dependsOn: ["research"],
          },
        ],
      });

      const result = svc.execute(t.id, { variables: { topic: "AI" } });

      // Only the "research" stage should have been submitted
      expect(fakeEngine.submit).toHaveBeenCalledTimes(1);
      expect(fakeEngine.submit.mock.calls[0][0].goal).toBe("Research AI");

      // Initial taskIds only includes the first stage
      expect(result.taskIds).toHaveLength(1);

      // Simulate task-1 completing
      tasks.get("task-1")!.status = "completed";
      emitter.emit("task:completed", { id: "task-1" });

      // Now the "synthesize" stage should have been submitted
      expect(fakeEngine.submit).toHaveBeenCalledTimes(2);
      expect(fakeEngine.submit.mock.calls[1][0].goal).toBe("Synthesize AI");
    });

    it("does not submit dependent stage until ALL deps complete", () => {
      let taskCounter = 0;
      const emitter = new EventEmitter();
      const tasks = new Map<string, { id: string; status: string }>();

      const fakeEngine = Object.assign(emitter, {
        submit: vi.fn().mockImplementation(() => {
          const id = `task-${++taskCounter}`;
          const task = { id, status: "queued" };
          tasks.set(id, task);
          return task;
        }),
        getTask: vi.fn().mockImplementation((id: string) => tasks.get(id) ?? null),
      });

      const svc = new TemplateService({
        repository: repo,
        taskEngine: fakeEngine as never,
      });
      const t = svc.create({
        ...SAMPLE_INPUT,
        stages: [
          {
            name: "gather-a",
            type: "parallel",
            agents: [
              { archetype: "researcher", goal: "Gather A for {{topic}}", model: null, allowedTools: [], autoApproveTools: [] },
            ],
            dependsOn: [],
          },
          {
            name: "gather-b",
            type: "parallel",
            agents: [
              { archetype: "researcher", goal: "Gather B for {{topic}}", model: null, allowedTools: [], autoApproveTools: [] },
            ],
            dependsOn: [],
          },
          {
            name: "merge",
            type: "sequential",
            agents: [
              { archetype: "writer", goal: "Merge {{topic}}", model: null, allowedTools: [], autoApproveTools: [] },
            ],
            dependsOn: ["gather-a", "gather-b"],
          },
        ],
      });

      svc.execute(t.id, { variables: { topic: "AI" } });

      // Two independent stages submitted
      expect(fakeEngine.submit).toHaveBeenCalledTimes(2);

      // Complete only gather-a — merge should NOT start yet
      tasks.get("task-1")!.status = "completed";
      emitter.emit("task:completed", { id: "task-1" });
      expect(fakeEngine.submit).toHaveBeenCalledTimes(2);

      // Complete gather-b — now merge should start
      tasks.get("task-2")!.status = "completed";
      emitter.emit("task:completed", { id: "task-2" });
      expect(fakeEngine.submit).toHaveBeenCalledTimes(3);
      expect(fakeEngine.submit.mock.calls[2][0].goal).toBe("Merge AI");
    });
  });
});
