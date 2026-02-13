import { EventEmitter } from "node:events";
import type { TaskEngine } from "./task-engine.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { TaskRepository } from "./task-repository.js";
import type { AgentTask, PipelineNode, PipelineStage, ParallelGroup } from "./types.js";

import { executePostAction } from "./post-actions.js";
import { normalizeLegacyStages } from "./pipeline-schema.js";
import { waitForTask } from "./wait-for-task.js";
import { logger } from "../logging/logger.js";

export type TaskWorkerOptions = {
  engine: TaskEngine;
  copilot: CopilotWrapper;
  /** Task repository for persisting token usage on completion. */
  taskRepository?: TaskRepository;
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
  private taskRepository?: TaskRepository;
  private maxConcurrent: number;
  private pollIntervalMs: number;
  private log: Pick<typeof logger, "info" | "warn" | "error">;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = 0;
  private stopped = false;

  constructor({
    engine,
    copilot,
    taskRepository,
    maxConcurrent = 2,
    pollIntervalMs = 2_000,
    log: logOverride,
  }: TaskWorkerOptions) {
    super();
    this.engine = engine;
    this.copilot = copilot;
    this.taskRepository = taskRepository;
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
      const toolCallLog: Array<{ tool: string; timestamp: number }> = [];

      // Pass autoApproveTools via ChatOptions so it's captured in the
      // buildSessionConfig closure — this survives JSON-RPC boundaries
      // (AsyncLocalStorage context is lost when the SDK's hooks handler
      // runs in the I/O event context of the subprocess pipe).
      for await (const chunk of this.copilot.chat(prompt, {
        model: task.model ?? undefined,
        reasoningEffort: task.reasoningEffort ?? undefined,
        availableTools,
        autoApproveTools: task.autoApproveTools ?? undefined,
        onToolCall: (toolName, args) => {
          this.log.info(`TaskWorker tool call [${task.id}]: ${toolName}(${JSON.stringify(args).slice(0, 200)})`);
          toolCallLog.push({ tool: toolName, timestamp: Date.now() });
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

      // Persist token usage before marking complete
      this.persistTokenUsage(task);

      const completed = this.engine.complete(task.id, result);
      this.log.info(`TaskWorker completed task ${task.id} (${toolCallLog.length} tool calls: ${[...new Set(toolCallLog.map(t => t.tool))].join(", ") || "none"}, availableTools: ${JSON.stringify(availableTools ?? "all")})`);
      this.emit("task:done", completed);
    } catch (error) {
      // Persist token usage even on failure
      this.persistTokenUsage(task);

      const message = error instanceof Error ? error.message : String(error);
      const failed = this.engine.fail(task.id, message);
      this.log.error(`TaskWorker failed task ${task.id}: ${message}`);
      this.emit("task:error", failed);
    }
  }

  /**
   * Resolve SDK-native availableTools for a task.
   *
   * When a task explicitly sets allowedTools (e.g. pipeline stages), we
   * respect that restriction and do NOT merge ALWAYS_ON_TOOLS — the whole
   * point of allowedTools is to scope what the agent can use.
   *
   * Returns undefined when no scoping is needed (task.allowedTools unset).
   */
  private resolveAvailableTools(task: AgentTask): string[] | undefined {
    if (!task.allowedTools) {
      return undefined;
    }
    return [...task.allowedTools];
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
   * Persist accumulated token usage from the CopilotWrapper to the task record.
   * Drains the session usage so each task only records its own consumption.
   */
  private persistTokenUsage(task: AgentTask): void {
    if (!this.taskRepository || !task.sessionId) return;
    try {
      const usage = this.copilot.clearSessionUsage(task.sessionId);
      if (usage) {
        this.taskRepository.updateTokenUsage(task.id, usage);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`Failed to persist token usage for task ${task.id}: ${msg}`);
    }
  }

  /**
   * Execute a multi-stage pipeline. Supports both sequential prompt stages
   * and parallel groups (branches executed via Promise.all).
   *
   * Stage N's output is passed as context to stage N+1, creating an accumulating
   * context chain. The parent task completes with the final stage's result.
   *
   * Backward-compatible: legacy flat PipelineStage[] (without `type` discriminator)
   * are normalized to PipelineNode[] with `type: "prompt"`.
   */
  private async executePipeline(task: AgentTask): Promise<void> {
    const rawStages = task.pipeline!.stages;

    // Normalize: if nodes lack the `type` discriminator, treat them as prompt stages.
    const nodes: PipelineNode[] = rawStages.some((s) => (s as Record<string, unknown>).type)
      ? rawStages
      : normalizeLegacyStages(rawStages as unknown as Array<Record<string, unknown>>);

    const nodeCount = nodes.length;
    this.log.info(`TaskWorker pipeline: ${nodeCount} top-level nodes for task ${task.id}`);

    const stageResults: Array<{ name: string; status: string; result?: string; error?: string }> = [];
    let accumulatedContext = task.context || "";

    try {
      for (let i = 0; i < nodeCount; i++) {
        const node = nodes[i];
        const label = `[${i + 1}/${nodeCount}] ${node.name}`;
        this.log.info(`TaskWorker pipeline node ${label}: starting (type=${node.type ?? "prompt"})`);

        const nodeResult = await this.executeNode(node, task, accumulatedContext, nodeCount, i);
        stageResults.push(...nodeResult.records);

        if (nodeResult.failed) {
          const errorMsg = `Pipeline aborted at node "${node.name}": ${nodeResult.error ?? "unknown error"}`;
          this.log.error(errorMsg);
          const failed = this.engine.fail(task.id, errorMsg);
          this.emit("task:error", failed);
          return;
        }

        if (nodeResult.context) {
          accumulatedContext += nodeResult.context;
        }
      }

      // All nodes completed — build final result
      const finalResult = this.buildPipelineResult(stageResults);
      const completed = this.engine.complete(task.id, finalResult);
      this.log.info(`TaskWorker pipeline completed task ${task.id}: ${nodeCount} nodes`);
      this.emit("task:done", completed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.engine.fail(task.id, `Pipeline error: ${message}`);
      this.log.error(`TaskWorker pipeline failed task ${task.id}: ${message}`);
      this.emit("task:error", failed);
    }
  }

  /** Result of executing a single pipeline node. */
  private executeNodeResult(
    records: Array<{ name: string; status: string; result?: string; error?: string }>,
    context: string,
    failed: boolean,
    error?: string
  ) {
    return { records, context, failed, error };
  }

  /**
   * Recursively execute a single pipeline node.
   * - "prompt" nodes: submit as a child task and wait.
   * - "parallel" nodes: execute all branches concurrently via Promise.all.
   */
  private async executeNode(
    node: PipelineNode,
    task: AgentTask,
    accumulatedContext: string,
    totalNodes: number,
    nodeIndex: number,
  ): Promise<{ records: Array<{ name: string; status: string; result?: string; error?: string }>; context: string; failed: boolean; error?: string }> {
    if (node.type === "parallel") {
      return this.executeParallelGroup(node as ParallelGroup, task, accumulatedContext);
    }

    // Prompt stage (leaf node) — type narrowed to PipelineStage
    return this.executePromptStage(node as PipelineStage, task, accumulatedContext, totalNodes, nodeIndex);
  }

  /**
   * Execute a single prompt stage as a child task.
   */
  private async executePromptStage(
    stage: PipelineStage,
    task: AgentTask,
    accumulatedContext: string,
    totalStages: number,
    stageIndex: number,
  ): Promise<{ records: Array<{ name: string; status: string; result?: string; error?: string }>; context: string; failed: boolean; error?: string }> {
    const stageLabel = `[${stageIndex + 1}/${totalStages}] ${stage.name}`;
    const timeoutMs = (stage.timeoutSeconds ?? 300) * 1_000;

    const stagePrompt = this.buildStagePrompt(
      stage.prompt,
      accumulatedContext,
      stageIndex,
      totalStages
    );

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
        notifyOnComplete: false,
        parentTaskId: task.id,
        sessionId: task.sessionId ?? undefined,
        channelType: task.channelType ?? undefined,
        chatId: task.chatId ?? undefined,
      },
      { mode: "background" }
    );

    // Wait for stage to complete
    const stageController = new AbortController();
    const stageTimer = setTimeout(() => stageController.abort(), timeoutMs);
    let completedStage: AgentTask;
    try {
      completedStage = await waitForTask(this.engine, childTask.id, stageController.signal);
    } finally {
      clearTimeout(stageTimer);
    }

    const stageRecord = {
      name: stage.name,
      status: completedStage.status,
      result: completedStage.result ?? undefined,
      error: completedStage.error ?? undefined,
    };

    this.log.info(`TaskWorker pipeline stage ${stageLabel}: ${completedStage.status}`);

    if (completedStage.status === "failed" || completedStage.status === "cancelled") {
      return this.executeNodeResult(
        [stageRecord],
        "",
        true,
        `stage "${stage.name}" ${completedStage.status}: ${completedStage.error ?? "unknown error"}`
      );
    }

    let contextDelta = "";
    if (completedStage.result) {
      contextDelta += `\n\n--- Output from stage "${stage.name}" ---\n${completedStage.result}`;
    }

    // Run deterministic post-action if configured
    const postAction = stage.postAction;
    if (postAction && completedStage.result) {
      this.log.info(`TaskWorker pipeline stage ${stageLabel}: running post-action "${postAction.type}"`);
      try {
        const actionResult = await executePostAction(postAction, completedStage.result);
        contextDelta += `\n\n--- Post-action "${postAction.type}" result ---\n${actionResult}`;
        stageRecord.result = actionResult;
      } catch (actionErr) {
        const msg = actionErr instanceof Error ? actionErr.message : String(actionErr);
        this.log.error(`TaskWorker pipeline post-action failed: ${msg}`);
        stageRecord.error = `Post-action error: ${msg}`;
      }
    }

    return this.executeNodeResult([stageRecord], contextDelta, false);
  }

  /**
   * Execute a parallel group: all branches run concurrently via Promise.all.
   * If any branch fails, the entire group is marked as failed.
   */
  private async executeParallelGroup(
    group: ParallelGroup,
    task: AgentTask,
    accumulatedContext: string,
  ): Promise<{ records: Array<{ name: string; status: string; result?: string; error?: string }>; context: string; failed: boolean; error?: string }> {
    const branchCount = group.branches.length;
    this.log.info(`TaskWorker parallel group "${group.name}": ${branchCount} branches`);

    const branchResults = await Promise.all(
      group.branches.map((branch, idx) =>
        this.executeNode(branch, task, accumulatedContext, branchCount, idx)
      )
    );

    // Aggregate results
    const allRecords: Array<{ name: string; status: string; result?: string; error?: string }> = [];
    let combinedContext = "";
    let anyFailed = false;
    let firstError: string | undefined;

    for (const result of branchResults) {
      allRecords.push(...result.records);
      combinedContext += result.context;
      if (result.failed && !anyFailed) {
        anyFailed = true;
        firstError = result.error;
      }
    }

    return this.executeNodeResult(allRecords, combinedContext, anyFailed, firstError);
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
