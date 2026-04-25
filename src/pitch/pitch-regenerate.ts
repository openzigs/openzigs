/**
 * Pitch — per-slide regenerate as a TaskEngine background job.
 *
 * Sub-issue #957 (Epic #951). Surfaces three things:
 *
 *   1. {@link submitSlideRegenerateTask} — enqueue a per-slide regenerate
 *      job. The task runs in the background queue (NOT in-request) so the
 *      slow LLM call doesn't block the editor; the result is persisted via
 *      the `persist-pitch-slide` post-action.
 *
 *   2. {@link registerPersistPitchSlidePostAction} — register the
 *      `persist-pitch-slide` post-action with the global registry. The
 *      handler parses the stage's JSON output, validates against
 *      `SlideSchema`, and calls `pitchRepo.updateSlide()`. On parse/Zod
 *      failure it logs to AuditLogger (category `system`) and returns a
 *      structured error string (no DB write happens).
 *
 *   3. {@link buildRegeneratePromptText} — build the task prompt text in
 *      one place so tests can lock it down.
 */
import { z } from "zod";
import type { AgentTask, CreateTaskInput, TaskTrigger } from "../tasks/types.js";
import type { TaskEngine } from "../tasks/task-engine.js";
import type { PitchRepository } from "./pitch-repository.js";
import type { AuditLogger } from "../logging/audit-logger.js";
import { SlideSchema, type Deck, type Slide } from "./pitch-schema.js";
import {
  buildRegenerateSystemPrompt,
  findSlideIndex,
} from "./pitch-prompts.js";
import { parseAndValidate } from "./pitch-utils.js";
import { postActionRegistry } from "../tasks/post-action-registry.js";

/** Post-action `type` string registered with the global registry. */
export const PERSIST_PITCH_SLIDE_ACTION = "persist-pitch-slide" as const;

/** Agent archetype name (defined in `config/agents.json`). */
export const PITCH_AGENT_NAME = "pitch-writer" as const;

// ── Submit ─────────────────────────────────────────────────────────────

export interface SubmitSlideRegenerateOpts {
  taskEngine: TaskEngine;
  pitchRepo: PitchRepository;
  deckId: string;
  slideId: string;
  /** Optional revision hint from the user. */
  hint?: string;
  /** Trigger source for the new task — defaults to `"agent"`. */
  trigger?: TaskTrigger;
  /** Optional session id for analytics / context propagation. */
  sessionId?: string;
  /** Optional model override. */
  model?: string;
  /** Per-stage timeout in seconds — defaults to 120. */
  timeoutSeconds?: number;
}

export interface SlideRegenerateSubmission {
  task: AgentTask;
  /** The fully assembled prompt text — exposed so callers can audit / log it. */
  prompt: string;
}

/**
 * Enqueue a single-slide regenerate task. Loads the deck + slide from the
 * repository (so the prompt always has fresh adjacent-slide context),
 * builds the prompt, and submits a single-stage pipeline whose post-action
 * is `persist-pitch-slide` configured with `{ deckId, slideId }`.
 *
 * Throws (synchronously) when the deck or slide can't be loaded — the
 * caller should already know the IDs are valid.
 */
export function submitSlideRegenerateTask(
  opts: SubmitSlideRegenerateOpts,
): SlideRegenerateSubmission {
  const deck = opts.pitchRepo.getDeck(opts.deckId);
  if (!deck) {
    throw new Error(
      `submitSlideRegenerateTask: deck ${opts.deckId} not found`,
    );
  }
  const slideRecord = opts.pitchRepo.getSlide(opts.slideId);
  if (!slideRecord || slideRecord.deck_id !== opts.deckId) {
    throw new Error(
      `submitSlideRegenerateTask: slide ${opts.slideId} not found in deck ${opts.deckId}`,
    );
  }

  const prompt = buildRegeneratePromptText(deck, slideRecord.slide, opts.hint);

  const input: CreateTaskInput = {
    trigger: opts.trigger ?? "agent",
    goal: `Regenerate pitch slide ${opts.slideId} (deck ${opts.deckId})`,
    context: `deckId=${opts.deckId} slideId=${opts.slideId} position=${slideRecord.position}`,
    sessionId: opts.sessionId,
    model: opts.model,
    agentName: PITCH_AGENT_NAME,
    notifyOnComplete: false,
    pipeline: {
      stages: [
        {
          type: "prompt",
          name: "regenerate-pitch-slide",
          prompt,
          // No tools — the model must emit a single JSON slide payload.
          tools: [],
          timeoutSeconds: opts.timeoutSeconds ?? 120,
          postAction: {
            type: PERSIST_PITCH_SLIDE_ACTION,
            config: { deckId: opts.deckId, slideId: opts.slideId },
          },
        },
      ],
    },
  };

  const task = opts.taskEngine.submit(input, { mode: "background" });
  return { task, prompt };
}

/**
 * Build the full prompt text used by the regenerate task. The system
 * prompt is inlined into the user message because pipeline stages don't
 * carry their own `systemMessage` config.
 */
export function buildRegeneratePromptText(
  deck: Deck,
  slide: Slide,
  hint?: string,
): string {
  // Sanity-check: in tests with a deck the slide doesn't belong to,
  // findSlideIndex will return -1 and the prompt will read as if the
  // slide is the only one in the deck. That's surface-level documented
  // behaviour — the API caller has already validated via getSlide().
  const idx = findSlideIndex(deck, slide);
  const positionHint = idx >= 0 ? `slide #${idx + 1} of ${deck.slides.length}` : "single slide";
  return [
    buildRegenerateSystemPrompt(deck, slide, hint),
    "",
    `Regenerate ${positionHint}. Emit ONE JSON object conforming to the OpenZigs SlideSchema.`,
    "Do NOT include code fences, commentary, or any text outside the JSON object.",
  ].join("\n");
}

// ── Post-action ────────────────────────────────────────────────────────

const PersistConfigSchema = z.object({
  deckId: z.string().min(1),
  slideId: z.string().min(1),
});

export interface RegisterPersistPitchSlideOpts {
  pitchRepo: PitchRepository;
  /** Optional audit logger — failures are logged at category `system`. */
  auditLogger?: Pick<AuditLogger, "log">;
  /** When true, throw on duplicate registration. Defaults to false (idempotent). */
  failOnDuplicate?: boolean;
}

/**
 * Register the `persist-pitch-slide` post-action with the global registry.
 *
 * Idempotent by default — calling it twice with the same dependencies is a
 * no-op. Callers that need to swap the underlying repo (e.g. integration
 * tests) should `unregister` first.
 */
export function registerPersistPitchSlidePostAction(
  opts: RegisterPersistPitchSlideOpts,
): void {
  if (postActionRegistry.has(PERSIST_PITCH_SLIDE_ACTION)) {
    if (opts.failOnDuplicate) {
      throw new Error(
        `Post-action "${PERSIST_PITCH_SLIDE_ACTION}" already registered`,
      );
    }
    return;
  }

  postActionRegistry.register({
    type: PERSIST_PITCH_SLIDE_ACTION,
    label: "Persist Pitch Slide",
    description:
      "Parse a regenerated slide JSON payload and persist it to the pitch repository. Used by the per-slide AI regenerate task.",
    category: "Pitch",
    icon: "presentation",
    configSchema: {
      type: "object",
      properties: {
        deckId: {
          type: "string",
          title: "Deck ID",
          description: "The pitch deck whose slide is being regenerated.",
        },
        slideId: {
          type: "string",
          title: "Slide ID",
          description: "The slide being regenerated.",
        },
      },
      required: ["deckId", "slideId"],
    },
    handler: (stageOutput, config) =>
      executePersistPitchSlide(
        stageOutput,
        config,
        opts.pitchRepo,
        opts.auditLogger,
      ),
  });
}

/**
 * Test/teardown hook. Removes the post-action so a fresh registration
 * (with a new pitchRepo binding) can take effect.
 */
export function unregisterPersistPitchSlidePostAction(): void {
  postActionRegistry.unregister(PERSIST_PITCH_SLIDE_ACTION);
}

/**
 * Handler body for `persist-pitch-slide`. Exported for direct unit
 * testing (the registry test exercises the end-to-end dispatch).
 */
export async function executePersistPitchSlide(
  stageOutput: string,
  config: Record<string, unknown>,
  pitchRepo: PitchRepository,
  auditLogger?: Pick<AuditLogger, "log">,
): Promise<string> {
  const cfg = PersistConfigSchema.safeParse(config);
  if (!cfg.success) {
    const msg = `persist-pitch-slide: invalid config — ${cfg.error.message}`;
    await safeAudit(auditLogger, { event: "pitch.persist.config_invalid", error: msg });
    return JSON.stringify({ ok: false, error: msg });
  }

  let slide: Slide;
  try {
    slide = parseAndValidate(stageOutput, SlideSchema);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await safeAudit(auditLogger, {
      event: "pitch.persist.parse_failed",
      deckId: cfg.data.deckId,
      slideId: cfg.data.slideId,
      error,
    });
    return JSON.stringify({ ok: false, error: `parse: ${error}` });
  }

  try {
    const updated = pitchRepo.updateSlide(cfg.data.slideId, { slide });
    if (!updated) {
      const msg = `slide ${cfg.data.slideId} not found`;
      await safeAudit(auditLogger, {
        event: "pitch.persist.slide_missing",
        deckId: cfg.data.deckId,
        slideId: cfg.data.slideId,
        error: msg,
      });
      return JSON.stringify({ ok: false, error: msg });
    }
    return JSON.stringify({
      ok: true,
      deckId: cfg.data.deckId,
      slideId: updated.id,
      template: updated.slide.template,
      updated_at: updated.updated_at,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await safeAudit(auditLogger, {
      event: "pitch.persist.update_failed",
      deckId: cfg.data.deckId,
      slideId: cfg.data.slideId,
      error,
    });
    return JSON.stringify({ ok: false, error: `update: ${error}` });
  }
}

async function safeAudit(
  auditLogger: Pick<AuditLogger, "log"> | undefined,
  details: Record<string, unknown> & { event: string },
): Promise<void> {
  if (!auditLogger) return;
  try {
    await auditLogger.log({
      level: "error",
      category: "system",
      event: details.event,
      details,
    });
  } catch {
    // Audit logging must never throw out of the post-action handler.
  }
}
