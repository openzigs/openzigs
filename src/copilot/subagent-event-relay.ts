import type { Server as SocketIOServer } from "socket.io";
import type { CopilotWrapper, SubagentStartedEvent, SubagentCompletedEvent, SubagentFailedEvent, SubagentSelectedEvent, SubagentDeselectedEvent } from "./copilot-wrapper.js";

/**
 * Bridges CopilotWrapper subagent EventEmitter events → Socket.IO emission.
 *
 * Each event carries `sessionId` so clients can filter by their active session.
 * Follows the same broadcast-then-client-filters pattern as TaskEventStreamer.
 */
export class SubagentEventRelay {
  private io: SocketIOServer;
  private copilot: CopilotWrapper;
  private unsubscribers: Array<() => void> = [];

  constructor(opts: { io: SocketIOServer; copilot: CopilotWrapper }) {
    this.io = opts.io;
    this.copilot = opts.copilot;
    this.wire();
  }

  private wire(): void {
    const on = (event: string, handler: (...args: unknown[]) => void) => {
      (this.copilot as unknown as import("node:events").EventEmitter).on(event, handler);
      this.unsubscribers.push(() => {
        (this.copilot as unknown as import("node:events").EventEmitter).removeListener(event, handler);
      });
    };

    on("subagent:started", (payload) => {
      this.io.emit("subagent:started", payload as SubagentStartedEvent);
    });

    on("subagent:completed", (payload) => {
      this.io.emit("subagent:completed", payload as SubagentCompletedEvent);
    });

    on("subagent:failed", (payload) => {
      this.io.emit("subagent:failed", payload as SubagentFailedEvent);
    });

    on("subagent:selected", (payload) => {
      this.io.emit("subagent:selected", payload as SubagentSelectedEvent);
    });

    on("subagent:deselected", (payload) => {
      this.io.emit("subagent:deselected", payload as SubagentDeselectedEvent);
    });
  }

  /** Remove all event listeners. */
  dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }
}
