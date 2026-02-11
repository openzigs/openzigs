import { EventEmitter } from "node:events";
import type { TaskEngine } from "./task-engine.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { AgentTask } from "./types.js";
import { ALWAYS_ON_TOOLS } from "../mcp/constants.js";
import { runWithAutoApproveContext } from "../copilot/hooks.js";
import { waitForTask } from "./wait-for-task.js";
import { logger } from "../logging/logger.js";

export type TaskWorkerOptions = {
  engine: TaskEngine;
  copilot: CopilotWrapper;
  /** Maximum concurrent background tasks. Default 2. */
  maxConcurrent?: number;
  /** Poll interval in milliseconds. Default 2000. */
  pollIntervalMs?: number;
  /** For testing: inject a logger. */
  log?: Pick<typeof logger, "info" | "warn" | "error">;
};

/**
 * Background consumer that polls the TaskEngine queue and executes tasks
 * via `CopilotWrapper.chat()`.
 *
 * The worker runs a `setInterval` loop that dequeues tasks up to
 * `maxConcurrent` and processes them asynchronously.
 */
export class TaskWorker extends EventEmitter {
  private engine: TaskEngine;
  private copilot: CopilotWrapper;
  private maxConcurrent: number;
  private pollIntervalMs: number;
  private log: Pick<typeof logger, "info" | "warn" | "error">;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = 0;
  private stopped = false;

  constructor({
    engine,
    copilot,
    maxConcurrent = 2,
    pollIntervalMs = 2_000,
    log: logOverride,
  }: TaskWorkerOptions) {
    super();
    this.engine = engine;
    this.copilot = copilot;
    this.maxConcurrent = maxConcurrent;
    this.pollIntervalMs = pollIntervalMs;
    this.log = logOverride ?? logger;
  }

  /** Start the polling loop. Idempotent. */
  start(): void {
    if (this.timer) {
      return;
    }
    this.stopped = false;
    this.log.info(`TaskWorker started (maxConcurrent=${this.maxConcurrent}, pollInterval=${this.pollIntervalMs}ms)`);
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);

    // Run immediately on start
    void this.poll();
  }

  /** Stop the polling loop and wait for in-flight tasks to drain. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Wait for in-flight tasks to finish (up to 30s)
    const deadline = Date.now() + 30_000;
    while (this.running > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    this.log.info("TaskWorker stopped");
  }

  /** Number of currently executing tasks. */
  get activeCount(): number {
    return this.running;
  }

  /** Get the current max concurrent limit. */
  get concurrencyLimit(): number {
    return this.maxConcurrent;
  }

  /** Update the max concurrent limit at runtime without restarting. */
  setMaxConcurrent(n: number): void {
    if (n < 1 || n > 10) {
      throw new RangeError("maxConcurrent must be between 1 and 10");
    }
    this.maxConcurrent = n;
    this.log.info(`TaskWorker maxConcurrent updated to ${n}`);
  }

  /** Single poll iteration: dequeue up to available capacity. */
  private async poll(): Promise<void> {
    if (this.stopped) {
      return;
    }

    const available = this.maxConcurrent - this.running;
    if (available <= 0) {
      return;
    }

    for (let i = 0; i < available; i++) {
      const task = this.engine.dequeue();
      if (!task) {
        break; // Queue is empty
      }
      this.running++;
      void this.executeTask(task).finally(() => {
        this.running--;
      });
    }
  }

  /** Execute a single task via CopilotWrapper. */
  private async executeTask(task: AgentTask): Promise<void> {
    this.log.info(`TaskWorker executing task ${task.id}: "${task.goal.slice(0, 80)}"`);
    this.emit("task:executing", task);

    // Pipeline tasks: run stages sequentially, each as its own child task
    if (task.pipeline && task.pipeline.stages.length > 0) {
      return this.executePipeline(task);
    }

    try {
      const prompt = this.buildPrompt(task);

      // Build SDK-native tool scoping: pass tool name strings instead of filtering ToolDefinition arrays.
      const availableTools = this.resolveAvailableTools(task);

      let result = "";

      // Use AsyncLocalStorage to create an isolated context for this task execution.
      await runWithAutoApproveContext(task.autoApproveTools, async () => {
        for await (const chunk of this.copilot.chat(prompt, {
          model: task.model ?? undefined,
          availableTools,
          onToolCall: (toolName, args) => {
            if (toolName === "spawn-agent" || toolName === "orchestrate-agents") {
              // Inject parent task ID, session, and channel info for recursive chaining.
              const a = args as Record<string, unknown>;
              a.parentTaskId = task.id;
              a.sessionId = task.sessionId;
              a.channelType = task.channelType;
              a.chatId = task.chatId;
            }
          },
          // Background tasks auto-skip interactive clarifications with an empty answer.
          onUserInputRequest: async () => ({ answer: "", wasFreeform: false }),
        })) {
          result += chunk;
        }
      });

      const completed = this.engine.complete(task.id, result);
      this.log.info(`TaskWorker completed task ${task.id}`);
      this.emit("task:done", completed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.engine.fail(task.id, message);
      this.log.error(`TaskWorker failed task ${task.id}: ${message}`);
      this.emit("task:error", failed);
    }
  }

  /**
   * Resolve SDK-native availableTools for a task. Merges ALWAYS_ON_TOOLS
   * into the list. Returns undefined when no scoping is needed.
   */
  private resolveAvailableTools(task: AgentTask): string[] | undefined {
    if (!task.allowedTools) {
      return undefined;
    }
    return [...new Set([...task.allowedTools, ...ALWAYS_ON_TOOLS])];
  }

  /** Build a prompt string for the background task. */
  private buildPrompt(task: AgentTask): string {
    const lines: string[] = [];

    lines.push("You are an autonomous agent executing a background task.");
    lines.push(`Task Goal: ${task.goal}`);

    if (task.context) {
      lines.push("");
      lines.push("Additional Context:");
      lines.push(task.context);
    }

    lines.push("");
    lines.push("Complete this task thoroughly and return your results. Be concise but comprehensive.");

    return lines.join("\n");
  }

  /**
   * Execute a multi-stage pipeline. Each stage runs as its own child task
   * with a fresh SDK session, solving the turn-limit problem for complex prompts.
   *
   * Stage N's output is passed as context to stage N+1, creating an accumulating
   * context chain. The parent task completes with the final stage's result.
   */
  private async executePipeline(task: AgentTask): Promise<void> {
    const { stages } = task.pipeline!;
    const stageCount = stages.length;
    this.log.info(`TaskWorker pipeline: ${stageCount} stages for task ${task.id}`);

    const controller = new AbortController();
    const stageResults: Array<{ name: string; status: string; result?: string; error?: string }> = [];
    let accumulatedContext = task.context || "";

    try {
      for (let i = 0; i < stageCount; i++) {
        const stage = stages[i];
        const stageLabel = `[${i + 1}/${stageCount}] ${stage.name}`;
        const timeoutMs = (stage.timeoutSeconds ?? 300) * 1_000;

        this.log.info(`TaskWorker pipeline stage ${stageLabel}: starting`);

        // Build stage prompt with accumulated context from previous stages
        const stagePrompt = this.buildStagePrompt(stage.prompt, accumulatedContext, i, stageCount);

        // Merge stage-level autoApproveTools with parent task's autoApproveTools
        const stageAutoApprove = [
          ...(task.autoApproveTools ?? []),
          ...(stage.autoApproveTools ?? []),
        ];

        // Submit stage as a child task
        const childTask = this.engine.submit(
          {
            trigger: task.trigger,
            goal: stagePrompt,
            context: accumulatedContext,
            model: stage.model ?? task.model ?? undefined,
            allowedTools: stage.tools ?? task.allowedTools ?? undefined,
            autoApproveTools: stageAutoApprove.length > 0 ? [...new Set(stageAutoApprove)] : undefined,
            notifyOnComplete: false, // Parent handles notification
            parentTaskId: task.id,
            sessionId: task.sessionId ?? undefined,
            channelType: task.channelType ?? undefined,
            chatId: task.chatId ?? undefined,
          },
          { mode: "background" }
        );

        // Wait for stage to complete
        const stageTimer = setTimeout(() => controller.abort(), timeoutMs);
        let completedStage: AgentTask;
        try {
          completedStage = await waitForTask(this.engine, childTask.id, controller.signal);
        } finally {
          clearTimeout(stageTimer);
        }

        const stageRecord = {
          name: stage.name,
          status: completedStage.status,
          result: completedStage.result ?? undefined,
          error: completedStage.error ?? undefined,
        };
        stageResults.push(stageRecord);

        this.log.info(`TaskWorker pipeline stage ${stageLabel}: ${completedStage.status}`);

        if (completedStage.status === "failed" || completedStage.status === "cancelled") {
          // Abort pipeline on stage failure
          const errorMsg = `Pipeline aborted: stage "${stage.name}" ${completedStage.status}: ${completedStage.error ?? "unknown error"}`;
          this.log.error(errorMsg);
          const failed = this.engine.fail(task.id, errorMsg);
          this.emit("task:error", failed);
          return;
        }

        // Accumulate context: append this stage's result for the next stage
        if (completedStage.result) {
          accumulatedContext += `\n\n--- Output from stage "${stage.name}" ---\n${completedStage.result}`;
        }
      }

      // All stages completed — build final result
      const finalResult = this.buildPipelineResult(stageResults);
      const completed = this.engine.complete(task.id, finalResult);
      this.log.info(`TaskWorker pipeline completed task ${task.id}: ${stageCount} stages`);
      this.emit("task:done", completed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.engine.fail(task.id, `Pipeline error: ${message}`);
      this.log.error(`TaskWorker pipeline failed task ${task.id}: ${message}`);
      this.emit("task:error", failed);
    }
  }

  /** Build a prompt for a pipeline stage, injecting context from prior stages. */
  private buildStagePrompt(
    stagePrompt: string,
    accumulatedContext: string,
    stageIndex: number,
    totalStages: number
  ): string {
    const lines: string[] = [];

    lines.push("You are an autonomous agent executing a pipeline stage.");
    lines.push(`This is stage ${stageIndex + 1} of ${totalStages}.`);
    lines.push("");
    lines.push("IMPORTANT: Complete ONLY the task described below. Do NOT delegate to sub-tasks or use the task tool.");
    lines.push("");
    lines.push("Stage Task:");
    lines.push(stagePrompt);

    if (accumulatedContext) {
      lines.push("");
      lines.push("Context from previous stages:");
      lines.push(accumulatedContext);
    }

    lines.push("");
    lines.push("Complete this stage thoroughly and return your results. Be concise but comprehensive.");

    return lines.join("\n");
  }

  /** Build the final result summary for a completed pipeline. */
  private buildPipelineResult(
    stageResults: Array<{ name: string; status: string; result?: string; error?: string }>
  ): string {
    const lastStage = stageResults[stageResults.length - 1];
    if (lastStage?.result) {
      // Return the last stage's result as the primary output (it has the cumulative context)
      return lastStage.result;
    }
    // Fallback: summarize all stages
    return stageResults
      .map((s) => `## ${s.name} (${s.status})\n${s.result ?? s.error ?? "No output"}`)
      .join("\n\n");
  }
}
