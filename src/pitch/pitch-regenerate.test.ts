import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { PitchRepository } from "./pitch-repository.js";
import {
  PERSIST_PITCH_SLIDE_ACTION,
  PITCH_AGENT_NAME,
  buildRegeneratePromptText,
  executePersistPitchSlide,
  registerPersistPitchSlidePostAction,
  submitSlideRegenerateTask,
  unregisterPersistPitchSlidePostAction,
} from "./pitch-regenerate.js";
import { postActionRegistry } from "../tasks/post-action-registry.js";
import type { TaskEngine, SubmitOptions } from "../tasks/task-engine.js";
import type { AgentTask, CreateTaskInput } from "../tasks/types.js";
import type { Deck, Slide } from "./pitch-schema.js";

const FROZEN_CLOCK = () => new Date("2026-04-24T12:00:00.000Z");

const TITLE_SLIDE: Slide = {
  template: "title",
  content: { title: "Hello" },
  speaker_notes: "open",
  transition: "slide",
  fragments: [],
};
const BULLETS_SLIDE: Slide = {
  template: "bullet_list",
  content: { heading: "Why us", bullets: ["Fast", "Reliable"] },
  speaker_notes: "",
  transition: "slide",
  fragments: [],
};
const QA_SLIDE: Slide = {
  template: "qa",
  content: { heading: "Questions?" },
  speaker_notes: "",
  transition: "slide",
  fragments: [],
};

function newRepo(): { repo: PitchRepository; db: Database.Database } {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // The pitch_decks table FK references brand_kits — create a stub.
  db.exec(`
    CREATE TABLE IF NOT EXISTS brand_kits (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO brand_kits (id, name) VALUES ('kit-1', 'Acme');
  `);
  const repo = new PitchRepository(db, FROZEN_CLOCK);
  repo.migrate();
  return { repo, db };
}

function seedDeck(repo: PitchRepository): Deck {
  return repo.insertDeck({
    id: "deck-1",
    title: "Demo",
    brand_kit_id: "kit-1",
    metadata: { source_script: "x", tone: "formal" },
    slides: [
      { id: "slide-title", slide: TITLE_SLIDE },
      { id: "slide-bullets", slide: BULLETS_SLIDE },
      { id: "slide-qa", slide: QA_SLIDE },
    ],
  });
}

/** Minimal in-memory TaskEngine stub — captures submitted inputs. */
function mockEngine(): {
  engine: TaskEngine;
  submit: ReturnType<typeof vi.fn>;
} {
  const submit = vi.fn(
    (input: CreateTaskInput, options: SubmitOptions): AgentTask => {
      return {
        id: "task-fake-1",
        parentTaskId: null,
        trigger: input.trigger,
        status: options.mode === "immediate" ? "running" : "queued",
        goal: input.goal,
        context: input.context ?? "",
        result: null,
        error: null,
        sessionId: input.sessionId ?? null,
        channelType: input.channelType ?? null,
        chatId: input.chatId ?? null,
        model: input.model ?? null,
        reasoningEffort: input.reasoningEffort ?? null,
        allowedTools: input.allowedTools ?? null,
        autoApproveTools: input.autoApproveTools ?? null,
        pipeline: input.pipeline ?? null,
        tokenUsage: null,
        notifyOnComplete: input.notifyOnComplete ?? false,
        depth: 0,
        createdAt: FROZEN_CLOCK(),
        startedAt: options.mode === "immediate" ? FROZEN_CLOCK() : null,
        completedAt: null,
        spawnedBy: input.spawnedBy ?? null,
        skillName: input.skillName ?? null,
        skillBody: input.skillBody ?? null,
        disabledSkills: input.disabledSkills ?? null,
        agentName: input.agentName ?? null,
        enableInSessionSubagents: input.enableInSessionSubagents ?? false,
      };
    },
  );
  const engine = { submit } as unknown as TaskEngine;
  return { engine, submit };
}

describe("submitSlideRegenerateTask", () => {
  it("submits a background pipeline task with the persist-pitch-slide post-action", () => {
    const { repo } = newRepo();
    seedDeck(repo);
    const { engine, submit } = mockEngine();

    const { task, prompt } = submitSlideRegenerateTask({
      taskEngine: engine,
      pitchRepo: repo,
      deckId: "deck-1",
      slideId: "slide-bullets",
      hint: "make it punchier",
    });

    expect(submit).toHaveBeenCalledTimes(1);
    const [input, options] = submit.mock.calls[0] as [CreateTaskInput, SubmitOptions];
    expect(options.mode).toBe("background");
    expect(input.trigger).toBe("agent");
    expect(input.agentName).toBe(PITCH_AGENT_NAME);
    expect(input.pipeline?.stages).toHaveLength(1);
    const stage = input.pipeline!.stages[0] as {
      type?: string;
      name: string;
      prompt: string;
      tools?: string[] | null;
      postAction?: { type: string; config?: Record<string, unknown> };
    };
    expect(stage.name).toBe("regenerate-pitch-slide");
    expect(stage.tools).toEqual([]);
    expect(stage.postAction?.type).toBe(PERSIST_PITCH_SLIDE_ACTION);
    expect(stage.postAction?.config).toEqual({
      deckId: "deck-1",
      slideId: "slide-bullets",
    });
    expect(prompt).toContain("make it punchier");
    expect(prompt).toContain("OpenZigs SlideSchema");
    expect(task.status).toBe("queued");
  });

  it("throws when the deck does not exist", () => {
    const { repo } = newRepo();
    const { engine } = mockEngine();
    expect(() =>
      submitSlideRegenerateTask({
        taskEngine: engine,
        pitchRepo: repo,
        deckId: "missing-deck",
        slideId: "missing-slide",
      }),
    ).toThrow(/deck missing-deck not found/);
  });

  it("throws when the slide doesn't belong to the deck", () => {
    const { repo } = newRepo();
    seedDeck(repo);
    const { engine } = mockEngine();
    expect(() =>
      submitSlideRegenerateTask({
        taskEngine: engine,
        pitchRepo: repo,
        deckId: "deck-1",
        slideId: "wrong-slide",
      }),
    ).toThrow(/slide wrong-slide not found/);
  });
});

describe("buildRegeneratePromptText", () => {
  it("includes the system prompt + adjacent slide context + JSON-only directive", () => {
    const { repo } = newRepo();
    const deck = seedDeck(repo);
    const text = buildRegeneratePromptText(deck, deck.slides[1], "punchier");
    expect(text).toContain("punchier");
    expect(text).toContain("Previous: title:");
    expect(text).toContain("Next:     qa:");
    expect(text).toContain("slide #2 of 3");
    expect(text).toContain("OpenZigs SlideSchema");
    expect(text).toMatch(/Do NOT include code fences/);
  });
});

describe("persist-pitch-slide post-action", () => {
  beforeEach(() => {
    unregisterPersistPitchSlidePostAction();
  });
  afterEach(() => {
    unregisterPersistPitchSlidePostAction();
  });

  it("registers and dispatches via the global registry", async () => {
    const { repo } = newRepo();
    seedDeck(repo);
    registerPersistPitchSlidePostAction({ pitchRepo: repo });
    expect(postActionRegistry.has(PERSIST_PITCH_SLIDE_ACTION)).toBe(true);

    const newSlide: Slide = {
      template: "bullet_list",
      content: { heading: "Updated", bullets: ["A", "B", "C"] },
      speaker_notes: "fresh",
      transition: "slide",
      fragments: [],
    };

    const out = await postActionRegistry.execute(
      {
        type: PERSIST_PITCH_SLIDE_ACTION,
        config: { deckId: "deck-1", slideId: "slide-bullets" },
      },
      JSON.stringify(newSlide),
    );

    const parsed = JSON.parse(out) as { ok: boolean; slideId?: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.slideId).toBe("slide-bullets");

    const persisted = repo.getSlide("slide-bullets");
    expect(persisted?.slide.template).toBe("bullet_list");
    if (persisted && persisted.slide.template === "bullet_list") {
      expect(persisted.slide.content.heading).toBe("Updated");
      expect(persisted.slide.content.bullets).toEqual(["A", "B", "C"]);
    }
  });

  it("idempotent registration (does not throw when called twice without failOnDuplicate)", () => {
    const { repo } = newRepo();
    registerPersistPitchSlidePostAction({ pitchRepo: repo });
    expect(() =>
      registerPersistPitchSlidePostAction({ pitchRepo: repo }),
    ).not.toThrow();
  });

  it("throws on duplicate registration when failOnDuplicate=true", () => {
    const { repo } = newRepo();
    registerPersistPitchSlidePostAction({ pitchRepo: repo });
    expect(() =>
      registerPersistPitchSlidePostAction({
        pitchRepo: repo,
        failOnDuplicate: true,
      }),
    ).toThrow(/already registered/);
  });

  it("returns a structured error and does NOT mutate the slide on invalid JSON", async () => {
    const { repo } = newRepo();
    seedDeck(repo);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    const before = repo.getSlide("slide-bullets");

    const out = await executePersistPitchSlide(
      "not even json",
      { deckId: "deck-1", slideId: "slide-bullets" },
      repo,
      { log: auditLog },
    );
    const parsed = JSON.parse(out) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/parse:/);
    expect(auditLog).toHaveBeenCalledTimes(1);
    const auditEntry = auditLog.mock.calls[0][0] as {
      level: string;
      category: string;
      event: string;
    };
    expect(auditEntry.level).toBe("error");
    expect(auditEntry.category).toBe("system");
    expect(auditEntry.event).toBe("pitch.persist.parse_failed");

    // Slide is unchanged.
    const after = repo.getSlide("slide-bullets");
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  it("returns a structured error when the slide payload fails Zod validation", async () => {
    const { repo } = newRepo();
    seedDeck(repo);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    const out = await executePersistPitchSlide(
      JSON.stringify({ template: "not_a_template", content: {} }),
      { deckId: "deck-1", slideId: "slide-bullets" },
      repo,
      { log: auditLog },
    );
    const parsed = JSON.parse(out) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/parse:/);
    expect(auditLog).toHaveBeenCalledTimes(1);
  });

  it("returns a structured error when the slide id does not exist", async () => {
    const { repo } = newRepo();
    seedDeck(repo);
    const auditLog = vi.fn().mockResolvedValue(undefined);
    const out = await executePersistPitchSlide(
      JSON.stringify(QA_SLIDE),
      { deckId: "deck-1", slideId: "no-such-slide" },
      repo,
      { log: auditLog },
    );
    const parsed = JSON.parse(out) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/not found/);
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog.mock.calls[0][0].event).toBe("pitch.persist.slide_missing");
  });

  it("rejects malformed config without touching the repo", async () => {
    const { repo } = newRepo();
    seedDeck(repo);
    const updateSpy = vi.spyOn(repo, "updateSlide");
    const out = await executePersistPitchSlide(
      JSON.stringify(QA_SLIDE),
      { deckId: 123 as unknown as string, slideId: "slide-bullets" },
      repo,
    );
    const parsed = JSON.parse(out) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/invalid config/);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("swallows audit-logger failures (post-action must not throw outward)", async () => {
    const { repo } = newRepo();
    seedDeck(repo);
    const auditLog = vi.fn().mockRejectedValue(new Error("disk full"));
    const out = await executePersistPitchSlide(
      "not json",
      { deckId: "deck-1", slideId: "slide-bullets" },
      repo,
      { log: auditLog },
    );
    // Returns the structured error, doesn't propagate the audit failure.
    const parsed = JSON.parse(out) as { ok: boolean };
    expect(parsed.ok).toBe(false);
  });
});
