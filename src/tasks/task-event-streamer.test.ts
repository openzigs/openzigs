import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskEventStreamer } from "./task-event-streamer.js";
import type { TaskToolCallEvent, TaskToolResultEvent, TaskProgressEvent } from "./task-event-streamer.js";

const createMockIO = () => ({
  emit: vi.fn(),
  on: vi.fn(),
  to: vi.fn().mockReturnThis(),
  in: vi.fn().mockReturnThis(),
});

describe("TaskEventStreamer", () => {
  let io: ReturnType<typeof createMockIO>;
  let streamer: TaskEventStreamer;

  beforeEach(() => {
    vi.useFakeTimers();
    io = createMockIO();
    streamer = new TaskEventStreamer({
      io: io as any,
      maxEventsPerSec: 5,
      chunkBatchMs: 500,
      progressDedupMs: 1000,
    });
  });

  afterEach(() => {
    streamer.dispose();
    vi.useRealTimers();
  });

  describe("emitToolCall", () => {
    it("emits task:tool-call via Socket.IO", () => {
      const event: TaskToolCallEvent = {
        taskId: "t1",
        parentTaskId: null,
        sessionId: "s1",
        tool: "web-search",
        args: { query: "test" },
      };

      streamer.emitToolCall(event);

      expect(io.emit).toHaveBeenCalledWith("task:tool-call", event);
    });

    it("emits on the EventEmitter", () => {
      const handler = vi.fn();
      streamer.on("task:tool-call", handler);

      streamer.emitToolCall({
        taskId: "t1",
        parentTaskId: null,
        sessionId: null,
        tool: "read-file",
        args: {},
      });

      expect(handler).toHaveBeenCalledOnce();
    });

    it("rate-limits tool calls per task", () => {
      for (let i = 0; i < 10; i++) {
        streamer.emitToolCall({
          taskId: "t1",
          parentTaskId: null,
          sessionId: null,
          tool: `tool-${i}`,
          args: {},
        });
      }

      // maxEventsPerSec = 5, only 5 should have been emitted
      expect(io.emit).toHaveBeenCalledTimes(5);
    });

    it("resets rate limit after 1 second", () => {
      for (let i = 0; i < 5; i++) {
        streamer.emitToolCall({
          taskId: "t1",
          parentTaskId: null,
          sessionId: null,
          tool: `tool-${i}`,
          args: {},
        });
      }
      expect(io.emit).toHaveBeenCalledTimes(5);

      // Advance 1 second
      vi.advanceTimersByTime(1000);

      streamer.emitToolCall({
        taskId: "t1",
        parentTaskId: null,
        sessionId: null,
        tool: "tool-after-reset",
        args: {},
      });
      expect(io.emit).toHaveBeenCalledTimes(6);
    });

    it("rate-limits independently per task", () => {
      for (let i = 0; i < 5; i++) {
        streamer.emitToolCall({
          taskId: "t1",
          parentTaskId: null,
          sessionId: null,
          tool: `tool-${i}`,
          args: {},
        });
      }
      // t1 is rate-limited
      streamer.emitToolCall({
        taskId: "t2",
        parentTaskId: null,
        sessionId: null,
        tool: "tool-t2",
        args: {},
      });
      // t2 should still work
      expect(io.emit).toHaveBeenCalledTimes(6);
    });
  });

  describe("emitToolResult", () => {
    it("emits task:tool-result via Socket.IO", () => {
      const event: TaskToolResultEvent = {
        taskId: "t1",
        parentTaskId: "p1",
        sessionId: "s1",
        tool: "web-search",
        result: "found 3 results",
        isError: false,
      };

      streamer.emitToolResult(event);

      expect(io.emit).toHaveBeenCalledWith("task:tool-result", event);
    });
  });

  describe("emitChunk", () => {
    it("buffers chunks and flushes on interval", () => {
      streamer.emitChunk({ taskId: "t1", parentTaskId: null, sessionId: "s1", text: "Hello " });
      streamer.emitChunk({ taskId: "t1", parentTaskId: null, sessionId: "s1", text: "World" });

      // Not yet flushed
      expect(io.emit).not.toHaveBeenCalledWith("task:chunk", expect.anything());

      // Flush on interval
      vi.advanceTimersByTime(500);

      expect(io.emit).toHaveBeenCalledWith("task:chunk", {
        taskId: "t1",
        parentTaskId: null,
        sessionId: "s1",
        text: "Hello World",
      });
    });

    it("buffers independently per task", () => {
      streamer.emitChunk({ taskId: "t1", parentTaskId: null, sessionId: "s1", text: "A" });
      streamer.emitChunk({ taskId: "t2", parentTaskId: null, sessionId: "s1", text: "B" });

      vi.advanceTimersByTime(500);

      expect(io.emit).toHaveBeenCalledWith("task:chunk", expect.objectContaining({ taskId: "t1", text: "A" }));
      expect(io.emit).toHaveBeenCalledWith("task:chunk", expect.objectContaining({ taskId: "t2", text: "B" }));
    });

    it("does not emit empty chunks", () => {
      streamer.emitChunk({ taskId: "t1", parentTaskId: null, sessionId: "s1", text: "" });

      vi.advanceTimersByTime(500);

      // The chunk with empty text shouldn't be flushed (buf.text.length > 0 check).
      // However, it was added with empty text. Let's verify behavior:
      // Actually the buffer stores text = "" which is not > 0, so no emit
      expect(io.emit).not.toHaveBeenCalledWith("task:chunk", expect.anything());
    });
  });

  describe("emitProgress", () => {
    it("emits task:progress via Socket.IO", () => {
      const event: TaskProgressEvent = {
        taskId: "t1",
        parentTaskId: null,
        sessionId: "s1",
        message: "Starting research",
        stage: "research",
      };

      streamer.emitProgress(event);

      expect(io.emit).toHaveBeenCalledWith("task:progress", event);
    });

    it("deduplicates progress by task+stage within window", () => {
      const event: TaskProgressEvent = {
        taskId: "t1",
        parentTaskId: null,
        sessionId: "s1",
        message: "In progress",
        stage: "research",
      };

      streamer.emitProgress(event);
      streamer.emitProgress({ ...event, message: "Still in progress" });

      // Only first should have been emitted
      expect(io.emit).toHaveBeenCalledTimes(1);
    });

    it("allows progress after dedup window expires", () => {
      const event: TaskProgressEvent = {
        taskId: "t1",
        parentTaskId: null,
        sessionId: "s1",
        message: "Starting",
        stage: "research",
      };

      streamer.emitProgress(event);
      vi.advanceTimersByTime(1001);
      streamer.emitProgress({ ...event, message: "Continuing" });

      expect(io.emit).toHaveBeenCalledTimes(2);
    });

    it("deduplicates independently per stage", () => {
      streamer.emitProgress({
        taskId: "t1",
        parentTaskId: null,
        sessionId: "s1",
        message: "A",
        stage: "stage1",
      });
      streamer.emitProgress({
        taskId: "t1",
        parentTaskId: null,
        sessionId: "s1",
        message: "B",
        stage: "stage2",
      });

      // Different stages → both emitted
      expect(io.emit).toHaveBeenCalledTimes(2);
    });
  });

  describe("clearTask", () => {
    it("flushes remaining chunks for the task", () => {
      streamer.emitChunk({ taskId: "t1", parentTaskId: null, sessionId: "s1", text: "leftover" });

      streamer.clearTask("t1");

      expect(io.emit).toHaveBeenCalledWith("task:chunk", expect.objectContaining({ taskId: "t1", text: "leftover" }));
    });

    it("cleans up buffering state", () => {
      streamer.emitChunk({ taskId: "t1", parentTaskId: null, sessionId: "s1", text: "data" });
      streamer.clearTask("t1");
      io.emit.mockClear();

      // Next flush should not emit for cleared task
      vi.advanceTimersByTime(500);
      expect(io.emit).not.toHaveBeenCalledWith("task:chunk", expect.objectContaining({ taskId: "t1" }));
    });
  });

  describe("dispose", () => {
    it("clears interval and buffers", () => {
      streamer.emitChunk({ taskId: "t1", parentTaskId: null, sessionId: "s1", text: "data" });
      streamer.dispose();

      // After dispose, advancing time should not cause flush
      io.emit.mockClear();
      vi.advanceTimersByTime(1000);
      expect(io.emit).not.toHaveBeenCalled();
    });
  });
});
