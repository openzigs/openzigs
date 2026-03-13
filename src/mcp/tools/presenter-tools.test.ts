import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPresenterTools } from "./presenter-tools.js";

function createMockDeps() {
  return {
    presentationRepo: {
      listAll: vi.fn().mockReturnValue([{ id: "p1", title: "Intro to AI" }]),
      findById: vi.fn().mockReturnValue({ id: "p1", title: "Intro to AI", chapters: [] }),
      delete: vi.fn().mockReturnValue(true),
    },
    quizGenerator: {
      generate: vi.fn().mockResolvedValue([{ question: "What is AI?", answer: "Artificial Intelligence" }]),
    },
    teacherAgent: {
      ask: vi.fn().mockImplementation(async function* () {
        yield "AI is ";
        yield "a broad field.";
      }),
    },
  };
}

function getHandler(depsOverride?: ReturnType<typeof createMockDeps>) {
  const deps = depsOverride ?? createMockDeps();
  const tools = createPresenterTools(deps as any);
  return { handler: tools[0].handler, deps };
}

describe("presenter-tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates tool with correct metadata", () => {
    const tools = createPresenterTools(createMockDeps() as any);
    expect(tools[0].name).toBe("manage-presentations");
    expect(tools[0].category).toBe("knowledge");
  });

  it("list returns presentations", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "list" });
    const parsed = JSON.parse(result.text);
    expect(parsed.count).toBe(1);
  });

  it("get returns presentation by id", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "get", id: "p1" });
    expect(JSON.parse(result.text).id).toBe("p1");
  });

  it("get requires id", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "get" });
    expect(result.isError).toBe(true);
  });

  it("get returns error when not found", async () => {
    const deps = createMockDeps();
    deps.presentationRepo.findById = vi.fn().mockReturnValue(null);
    const { handler } = getHandler(deps);
    const result = await handler({ action: "get", id: "missing" });
    expect(result.isError).toBe(true);
  });

  it("delete removes presentation", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "delete", id: "p1" });
    expect(result.text).toContain("deleted");
  });

  it("delete returns error when not found", async () => {
    const deps = createMockDeps();
    deps.presentationRepo.delete = vi.fn().mockReturnValue(false);
    const { handler } = getHandler(deps);
    const result = await handler({ action: "delete", id: "missing" });
    expect(result.isError).toBe(true);
  });

  it("generate_quiz creates quizzes", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "generate_quiz", id: "p1" });
    const parsed = JSON.parse(result.text);
    expect(parsed.count).toBe(1);
  });

  it("generate_quiz requires id", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "generate_quiz" });
    expect(result.isError).toBe(true);
  });

  it("ask_question returns streamed answer", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "ask_question", id: "p1", question: "What is AI?" });
    expect(result.text).toBe("AI is a broad field.");
  });

  it("ask_question requires id and question", async () => {
    const { handler } = getHandler();
    const result = await handler({ action: "ask_question", id: "p1" });
    expect(result.isError).toBe(true);
  });
});
