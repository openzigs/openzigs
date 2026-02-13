import type { ChannelType } from "../channels/types.js";
import type { ReasoningEffort } from "../copilot/copilot-wrapper.js";

export type TaskTrigger = "chat" | "cron" | "agent" | "webhook";
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type TaskMode = "immediate" | "background";

// ── Pipeline types ────────────────────────────────────────────────────

/** A single stage in a multi-stage pipeline. Each stage runs as its own agent task with a fresh SDK session. */
export type PipelineStage = {
  /** Discriminator — always "prompt" for a single LLM stage. Legacy stages without `type` are treated as "prompt". */
  type?: "prompt";
  /** Human-readable stage name (e.g., "clone-and-read", "review", "report"). */
  name: string;
  /** Prompt text for this stage. Supports {{variable}} interpolation. */
  prompt: string;
  /** Tool allowlist for this stage. null = all enabled tools. */
  tools?: string[] | null;
  /** Tools that bypass approval gating for this stage. */
  autoApproveTools?: string[];
  /** Model override for this stage. */
  model?: string;
  /** Per-stage timeout in seconds (default: 300). */
  timeoutSeconds?: number;
  /**
   * Optional deterministic post-action to run after this stage's LLM task completes.
   * Instead of relying on the LLM to call tools, the action executes code directly.
   * Supported actions:
   *   - "create-github-issues": Parse findings from stage output and create GitHub issues.
   */
  postAction?: PipelinePostAction;
};

/** A group of pipeline nodes executed concurrently via Promise.all. */
export type ParallelGroup = {
  type: "parallel";
  /** Human-readable group name (e.g., "research-phase"). */
  name: string;
  /** Nodes to execute in parallel. Each branch is a PipelineNode. */
  branches: PipelineNode[];
};

/** Recursive union: either a prompt stage or a parallel group containing nested nodes. */
export type PipelineNode = PipelineStage | ParallelGroup;

/** Deterministic post-action configuration for a pipeline stage. */
export type PipelinePostAction = {
  /** Action type (e.g., "create-github-issues"). */
  type: string;
  /** Action-specific configuration. */
  config?: Record<string, unknown>;
};

/** Ordered list of nodes for pipeline execution (sequential at top level, parallel within groups). */
export type PipelineDefinition = {
  stages: PipelineNode[];
};

// ── Task types ────────────────────────────────────────────────────────

export type AgentTask = {
  id: string;
  parentTaskId: string | null;
  trigger: TaskTrigger;
  status: TaskStatus;
  goal: string;
  context: string;
  result: string | null;
  error: string | null;
  sessionId: string | null;
  channelType: ChannelType | null;
  chatId: string | null;
  model: string | null;
  /** Optional reasoning effort override for reasoning-capable models. */
  reasoningEffort: ReasoningEffort | null;
  /** Optional tool allowlist. null = all enabled tools. */
  allowedTools: string[] | null;
  /** Tools that bypass normal approval gating for this task. null = no overrides. */
  autoApproveTools: string[] | null;
  /** Pipeline definition for multi-stage sequential execution. null = single-stage task. */
  pipeline: PipelineDefinition | null;
  /** Token usage data (input/output/total tokens and turns). Populated on task completion. */
  tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number; turns: number } | null;
  notifyOnComplete: boolean;
  depth: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  spawnedBy: string | null;
};

export type CreateTaskInput = {
  parentTaskId?: string;
  trigger: TaskTrigger;
  goal: string;
  context?: string;
  sessionId?: string;
  channelType?: ChannelType;
  chatId?: string;
  model?: string;
  /** Optional reasoning effort override for reasoning-capable models. */
  reasoningEffort?: ReasoningEffort;
  /** Optional tool allowlist for this task. */
  allowedTools?: string[];
  /** Tools that bypass normal approval gating for this task. */
  autoApproveTools?: string[];
  /** Pipeline definition for multi-stage sequential execution. */
  pipeline?: PipelineDefinition;
  notifyOnComplete?: boolean;
  spawnedBy?: string;
};

/** SQLite row shape for the agent_tasks table. */
export type StoredTask = {
  id: string;
  parent_task_id: string | null;
  trigger: string;
  status: string;
  goal: string;
  context: string;
  result: string | null;
  error: string | null;
  session_id: string | null;
  channel_type: string | null;
  chat_id: string | null;
  model: string | null;
  reasoning_effort: string | null;
  allowed_tools: string | null;
  auto_approve_tools: string | null;
  pipeline: string | null;
  token_usage_json: string | null;
  notify_on_complete: number;
  depth: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  spawned_by: string | null;
};

/** Recursion / safety limits for agent chaining. */
export const TASK_LIMITS = {
  /** Maximum nesting depth (root = 0). */
  maxDepth: 5,
  /** Maximum children a single task can spawn. */
  maxChildren: 10,
  /** Maximum tasks per session per minute. */
  maxRatePerMinute: 20,
} as const;
