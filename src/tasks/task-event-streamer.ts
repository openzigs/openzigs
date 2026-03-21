import { EventEmitter } from "node:events";
import type { Server as SocketIOServer } from "socket.io";

// ── Event payload types ───────────────────────────────────────────────

export interface TaskToolCallEvent {
  taskId: string;
  parentTaskId: string | null;
  sessionId: string | null;
  tool: string;
  args: Record<string, unknown>;
}

export interface TaskToolResultEvent {
  taskId: string;
  parentTaskId: string | null;
  sessionId: string | null;
  tool: string;
  result: string;
  isError: boolean;
}

export interface TaskProgressEvent {
  taskId: string;
  parentTaskId: string | null;
  sessionId: string | null;
  message: string;
  stage?: string;
}

export interface TaskChunkEvent {
  taskId: string;
  parentTaskId: string | null;
  sessionId: string | null;
  text: string;
}

// ── Streamer ──────────────────────────────────────────────────────────

export type TaskEventStreamerOptions = {
  io: SocketIOServer;
  /** Max events per second per task for tool-call/result. Default 10. */
  maxEventsPerSec?: number;
  /** Chunk batch interval in ms. Default 500. */
  chunkBatchMs?: number;
  /** Progress dedup window in ms. Default 1000. */
  progressDedupMs?: number;
};

/**
 * Bridges task execution hooks → Socket.IO emission with throttling.
 *
 * - Tool call/result: emitted immediately (low frequency)
 * - Text chunks: buffered and flushed every `chunkBatchMs`
 * - Progress events: deduplicated by `stage` within `progressDedupMs`
 *
 * All events are scoped to connected clients. Because the server currently
 * broadcasts on the default namespace (no per-session rooms), we emit to
 * all clients and let the client filter by sessionId. Session-scoped rooms
 * can be added later as an optimisation.
 */
export class TaskEventStreamer extends EventEmitter {
  private io: SocketIOServer;
  private maxEventsPerSec: number;
  private chunkBatchMs: number;
  private progressDedupMs: number;

  // Rate-limit state per task
  private eventCounts = new Map<string, { count: number; resetAt: number }>();

  // Chunk buffering per task
  private chunkBuffers = new Map<string, { text: string; meta: Omit<TaskChunkEvent, "text"> }>();
  private chunkTimer: ReturnType<typeof setInterval> | null = null;

  // Progress dedup per task+stage
  private lastProgress = new Map<string, number>();

  constructor(opts: TaskEventStreamerOptions) {
    super();
    this.io = opts.io;
    this.maxEventsPerSec = opts.maxEventsPerSec ?? 10;
    this.chunkBatchMs = opts.chunkBatchMs ?? 500;
    this.progressDedupMs = opts.progressDedupMs ?? 1000;

    this.chunkTimer = setInterval(() => this.flushChunks(), this.chunkBatchMs);
  }

  /** Clean up timers. */
  dispose(): void {
    if (this.chunkTimer) {
      clearInterval(this.chunkTimer);
      this.chunkTimer = null;
    }
    this.chunkBuffers.clear();
    this.eventCounts.clear();
    this.lastProgress.clear();
  }

  /** Emit a tool-call event. */
  emitToolCall(event: TaskToolCallEvent): void {
    if (!this.checkRate(event.taskId)) return;
    this.io.emit("task:tool-call", event);
    this.emit("task:tool-call", event);
  }

  /** Emit a tool-result event. */
  emitToolResult(event: TaskToolResultEvent): void {
    if (!this.checkRate(event.taskId)) return;
    this.io.emit("task:tool-result", event);
    this.emit("task:tool-result", event);
  }

  /** Buffer a text chunk for batched emission. */
  emitChunk(event: TaskChunkEvent): void {
    const existing = this.chunkBuffers.get(event.taskId);
    if (existing) {
      existing.text += event.text;
    } else {
      const { text, ...meta } = event;
      this.chunkBuffers.set(event.taskId, { text, meta });
    }
  }

  /** Emit a progress event (deduplicated by stage). */
  emitProgress(event: TaskProgressEvent): void {
    const key = `${event.taskId}:${event.stage ?? ""}`;
    const now = Date.now();
    const last = this.lastProgress.get(key);
    if (last && now - last < this.progressDedupMs) {
      return; // deduplicated
    }
    this.lastProgress.set(key, now);
    this.io.emit("task:progress", event);
    this.emit("task:progress", event);
  }

  /** Flush all buffered chunks. Called on interval and on dispose. */
  flushChunks(): void {
    for (const [taskId, buf] of this.chunkBuffers) {
      if (buf.text.length > 0) {
        const event: TaskChunkEvent = { ...buf.meta, taskId, text: buf.text };
        this.io.emit("task:chunk", event);
        this.emit("task:chunk", event);
        buf.text = "";
      }
    }
  }

  /** Remove buffering state for a completed/failed task. */
  clearTask(taskId: string): void {
    // Flush remaining chunks first
    const buf = this.chunkBuffers.get(taskId);
    if (buf && buf.text.length > 0) {
      const event: TaskChunkEvent = { ...buf.meta, taskId, text: buf.text };
      this.io.emit("task:chunk", event);
      this.emit("task:chunk", event);
    }
    this.chunkBuffers.delete(taskId);
    this.eventCounts.delete(taskId);
    // Clean up progress dedup keys for this task
    for (const key of this.lastProgress.keys()) {
      if (key.startsWith(`${taskId}:`)) {
        this.lastProgress.delete(key);
      }
    }
  }

  // ── Rate limiting ─────────────────────────────────────────────────

  private checkRate(taskId: string): boolean {
    const now = Date.now();
    let entry = this.eventCounts.get(taskId);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + 1000 };
      this.eventCounts.set(taskId, entry);
    }
    if (entry.count >= this.maxEventsPerSec) {
      return false;
    }
    entry.count++;
    return true;
  }
}
