import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { TeacherAgent } from "./teacher-agent.js";

function makeMockCopilot() {
  return {
    chat: vi.fn(),
  };
}

function makeMockRepo() {
  return {
    findById: vi.fn(),
  };
}

function makeMockKnowledge() {
  return {
    search: vi.fn().mockResolvedValue([]),
  };
}

function makePresentation(overrides: Record<string, unknown> = {}) {
  return {
    id: "pres-1",
    title: "Test Presentation",
    chapters: JSON.stringify([
      { title: "Intro", startSeconds: 0, endSeconds: 60 },
      { title: "Main", startSeconds: 60, endSeconds: 180 },
    ]),
    script_json: JSON.stringify([
      { text: "Welcome everyone.", startTime: 0, endTime: 10 },
      { text: "Let me introduce the topic.", startTime: 10, endTime: 30 },
      { text: "Here is the main content.", startTime: 60, endTime: 90 },
      { text: "And more details.", startTime: 90, endTime: 130 },
    ]),
    ...overrides,
  };
}

async function collectStream(gen: AsyncGenerator<string>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks.join("");
}

describe("TeacherAgent", () => {
  let copilot: ReturnType<typeof makeMockCopilot>;
  let repo: ReturnType<typeof makeMockRepo>;
  let knowledge: ReturnType<typeof makeMockKnowledge>;
  let agent: TeacherAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    copilot = makeMockCopilot();
    repo = makeMockRepo();
    knowledge = makeMockKnowledge();
    agent = new TeacherAgent({
      copilotWrapper: copilot as any,
      presentationRepo: repo as any,
      knowledgeService: knowledge as any,
    });
  });

  it("yields fallback message when presentation not found", async () => {
    repo.findById.mockReturnValue(undefined);

    const result = await collectStream(
      agent.ask({ presentationId: "pres-1", question: "What?", chapterIndex: 0, timestamp: 5 }),
    );

    expect(result).toContain("couldn't find this presentation");
    expect(copilot.chat).not.toHaveBeenCalled();
  });

  it("calls copilot.chat with context from the current chapter", async () => {
    const pres = makePresentation();
    repo.findById.mockReturnValue(pres);

    async function* fakeChat() {
      yield "Here is the answer";
    }
    copilot.chat.mockReturnValue(fakeChat());

    const result = await collectStream(
      agent.ask({ presentationId: "pres-1", question: "What is the topic?", chapterIndex: 0, timestamp: 15 }),
    );

    expect(result).toBe("Here is the answer");
    expect(copilot.chat).toHaveBeenCalledOnce();

    const [message, opts] = copilot.chat.mock.calls[0];
    expect(message).toContain("Intro");
    expect(message).toContain("Welcome everyone");
    expect(message).toContain("What is the topic?");
    expect(opts.tools).toEqual([]);
    expect(opts.systemMessage.mode).toBe("replace");
  });

  it("includes knowledge base results as RAG context", async () => {
    const pres = makePresentation();
    repo.findById.mockReturnValue(pres);
    knowledge.search.mockResolvedValue([
      { text: "RAG result 1" },
      { text: "RAG result 2" },
    ]);

    async function* fakeChat() {
      yield "Answer with RAG";
    }
    copilot.chat.mockReturnValue(fakeChat());

    await collectStream(
      agent.ask({ presentationId: "pres-1", question: "Details?", chapterIndex: 1, timestamp: 70 }),
    );

    const [message] = copilot.chat.mock.calls[0];
    expect(message).toContain("Knowledge Base References");
    expect(message).toContain("RAG result 1");
    expect(message).toContain("RAG result 2");
  });

  it("works without knowledge service", async () => {
    const agentNoKnowledge = new TeacherAgent({
      copilotWrapper: copilot as any,
      presentationRepo: repo as any,
    });

    const pres = makePresentation();
    repo.findById.mockReturnValue(pres);

    async function* fakeChat() {
      yield "OK";
    }
    copilot.chat.mockReturnValue(fakeChat());

    const result = await collectStream(
      agentNoKnowledge.ask({ presentationId: "pres-1", question: "Q?", chapterIndex: 0, timestamp: 0 }),
    );

    expect(result).toBe("OK");
    expect(knowledge.search).not.toHaveBeenCalled();
  });

  it("handles knowledge search failure gracefully", async () => {
    const pres = makePresentation();
    repo.findById.mockReturnValue(pres);
    knowledge.search.mockRejectedValue(new Error("Search down"));

    async function* fakeChat() {
      yield "still works";
    }
    copilot.chat.mockReturnValue(fakeChat());

    const result = await collectStream(
      agent.ask({ presentationId: "pres-1", question: "?", chapterIndex: 0, timestamp: 0 }),
    );

    expect(result).toBe("still works");
  });

  it("handles invalid chapter index by falling back to full script", async () => {
    const pres = makePresentation();
    repo.findById.mockReturnValue(pres);

    async function* fakeChat() {
      yield "fallback";
    }
    copilot.chat.mockReturnValue(fakeChat());

    await collectStream(
      agent.ask({ presentationId: "pres-1", question: "?", chapterIndex: 999, timestamp: 0 }),
    );

    const [message] = copilot.chat.mock.calls[0];
    // Should include all script text since chapter index is out of bounds
    expect(message).toContain("Welcome everyone");
    expect(message).toContain("main content");
  });

  it("handles malformed JSON in chapters/script_json gracefully", async () => {
    const pres = makePresentation({ chapters: "not-json", script_json: "not-json" });
    repo.findById.mockReturnValue(pres);

    async function* fakeChat() {
      yield "still ok";
    }
    copilot.chat.mockReturnValue(fakeChat());

    const result = await collectStream(
      agent.ask({ presentationId: "pres-1", question: "?", chapterIndex: 0, timestamp: 0 }),
    );

    expect(result).toBe("still ok");
    const [message] = copilot.chat.mock.calls[0];
    expect(message).toContain("No script context available");
  });

  it("includes full transcript when it differs from chapter context", async () => {
    const pres = makePresentation();
    repo.findById.mockReturnValue(pres);

    async function* fakeChat() {
      yield "ok";
    }
    copilot.chat.mockReturnValue(fakeChat());

    await collectStream(
      agent.ask({ presentationId: "pres-1", question: "?", chapterIndex: 0, timestamp: 5 }),
    );

    const [message] = copilot.chat.mock.calls[0];
    expect(message).toContain("Full Presentation Transcript");
  });

  it("handles startSeconds variant in script_json", async () => {
    const pres = makePresentation({
      script_json: JSON.stringify([
        { text: "Segment A", startSeconds: 0, endSeconds: 30 },
        { text: "Segment B", startSeconds: 60, endSeconds: 90 },
      ]),
    });
    repo.findById.mockReturnValue(pres);

    async function* fakeChat() {
      yield "ok";
    }
    copilot.chat.mockReturnValue(fakeChat());

    await collectStream(
      agent.ask({ presentationId: "pres-1", question: "?", chapterIndex: 0, timestamp: 10 }),
    );

    const [message] = copilot.chat.mock.calls[0];
    // Chapter 0 context should include Segment A
    expect(message).toContain("Segment A");
    // Segment B is in full transcript, so it will appear — just confirm chapter context works
    expect(message).toContain("Intro");
  });

  it("truncates full transcript to 8000 chars", async () => {
    const longText = "A".repeat(9000);
    const pres = makePresentation({
      script_json: JSON.stringify([{ text: longText, startTime: 0, endTime: 60 }]),
    });
    repo.findById.mockReturnValue(pres);

    async function* fakeChat() {
      yield "ok";
    }
    copilot.chat.mockReturnValue(fakeChat());

    await collectStream(
      agent.ask({ presentationId: "pres-1", question: "?", chapterIndex: 0, timestamp: 5 }),
    );

    const [message] = copilot.chat.mock.calls[0];
    // Full transcript section should be truncated to 8000 + "…"
    expect(message).toContain("…");
    // Should not contain the full 9000 chars (chapter context also truncates at 4000)
    // Total message includes system prompt + headers + truncated contexts
    expect(message.length).toBeLessThan(longText.length * 2);
  });
});
