import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { SubagentEventRelay } from "./subagent-event-relay.js";

function createFakeCopilot() {
  return new EventEmitter() as EventEmitter & { [key: string]: unknown };
}

function createFakeIO() {
  return { emit: vi.fn() } as unknown as import("socket.io").Server;
}

describe("SubagentEventRelay", () => {
  it("relays subagent:started to Socket.IO", () => {
    const copilot = createFakeCopilot();
    const io = createFakeIO();
    new SubagentEventRelay({ io, copilot: copilot as never });

    const payload = { sessionId: "s1", agentName: "coder" };
    copilot.emit("subagent:started", payload);

    expect((io.emit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("subagent:started", payload);
  });

  it("relays subagent:completed to Socket.IO", () => {
    const copilot = createFakeCopilot();
    const io = createFakeIO();
    new SubagentEventRelay({ io, copilot: copilot as never });

    const payload = { sessionId: "s1", agentName: "coder", summary: "Done" };
    copilot.emit("subagent:completed", payload);

    expect((io.emit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("subagent:completed", payload);
  });

  it("relays subagent:failed to Socket.IO", () => {
    const copilot = createFakeCopilot();
    const io = createFakeIO();
    new SubagentEventRelay({ io, copilot: copilot as never });

    const payload = { sessionId: "s1", agentName: "researcher", error: "timeout" };
    copilot.emit("subagent:failed", payload);

    expect((io.emit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("subagent:failed", payload);
  });

  it("relays subagent:selected and subagent:deselected to Socket.IO", () => {
    const copilot = createFakeCopilot();
    const io = createFakeIO();
    new SubagentEventRelay({ io, copilot: copilot as never });

    copilot.emit("subagent:selected", { sessionId: "s1", agentName: "writer" });
    copilot.emit("subagent:deselected", { sessionId: "s1", agentName: "writer" });

    const emitMock = io.emit as ReturnType<typeof vi.fn>;
    expect(emitMock).toHaveBeenCalledWith("subagent:selected", { sessionId: "s1", agentName: "writer" });
    expect(emitMock).toHaveBeenCalledWith("subagent:deselected", { sessionId: "s1", agentName: "writer" });
  });

  it("dispose removes all listeners", () => {
    const copilot = createFakeCopilot();
    const io = createFakeIO();
    const relay = new SubagentEventRelay({ io, copilot: copilot as never });

    relay.dispose();

    copilot.emit("subagent:started", { sessionId: "s1", agentName: "coder" });
    expect((io.emit as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
