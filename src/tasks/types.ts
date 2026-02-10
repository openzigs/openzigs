import type { ChannelType } from "../channels/types.js";

export type TaskTrigger = "chat" | "cron" | "agent";
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type TaskMode = "immediate" | "background";

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
  /** Optional tool allowlist. null = all enabled tools. */
  allowedTools: string[] | null;
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
  /** Optional tool allowlist for this task. */
  allowedTools?: string[];
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
  allowed_tools: string | null;
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
