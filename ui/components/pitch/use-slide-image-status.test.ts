import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSlideImageStatus } from "./use-slide-image-status";

type Handler = (...args: unknown[]) => void;

const handlers: Record<string, Handler[]> = {};
const mockSocket = {
  on: vi.fn((evt: string, h: Handler) => {
    handlers[evt] ??= [];
    handlers[evt].push(h);
  }),
  off: vi.fn((evt: string, h: Handler) => {
    handlers[evt] = (handlers[evt] ?? []).filter((x) => x !== h);
  }),
  emit: vi.fn(),
};

vi.mock("@/lib/socket-context", () => ({
  useSocket: () => ({ socket: mockSocket, connected: true }),
}));

function fire(evt: string, payload: unknown) {
  for (const h of handlers[evt] ?? []) h(payload);
}

describe("useSlideImageStatus", () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) handlers[k] = [];
    mockSocket.on.mockClear();
    mockSocket.off.mockClear();
  });

  it("subscribes to the three pitch:image events for the deck", () => {
    renderHook(() => useSlideImageStatus("d1"));
    const events = mockSocket.on.mock.calls.map((c) => c[0]);
    expect(events).toEqual(
      expect.arrayContaining([
        "pitch:image:queued",
        "pitch:image:ready",
        "pitch:image:failed",
      ]),
    );
  });

  it("does not subscribe when deckId is null", () => {
    renderHook(() => useSlideImageStatus(null));
    expect(mockSocket.on).not.toHaveBeenCalled();
  });

  it("ignores events for a different deck", () => {
    const { result } = renderHook(() => useSlideImageStatus("d1"));
    act(() => {
      fire("pitch:image:queued", { deckId: "d2", slideId: "s1", slot: "bg" });
    });
    expect(result.current.statusOf("s1", "bg")).toBe("idle");
  });

  it("tracks queued → ready transitions", () => {
    const { result } = renderHook(() => useSlideImageStatus("d1"));
    act(() => {
      fire("pitch:image:queued", { deckId: "d1", slideId: "s1", slot: "bg" });
    });
    expect(result.current.statusOf("s1", "bg")).toBe("queued");
    act(() => {
      fire("pitch:image:ready", { deckId: "d1", slideId: "s1", slot: "bg" });
    });
    expect(result.current.statusOf("s1", "bg")).toBe("ready");
  });

  it("tracks failed status with error message", () => {
    const { result } = renderHook(() => useSlideImageStatus("d1"));
    act(() => {
      fire("pitch:image:failed", {
        deckId: "d1",
        slideId: "s1",
        slot: "bg",
        error: "boom",
      });
    });
    expect(result.current.statusOf("s1", "bg")).toBe("failed");
    expect(result.current.errorOf("s1", "bg")).toBe("boom");
  });

  it("aggregates counts across slots", () => {
    const { result } = renderHook(() => useSlideImageStatus("d1"));
    act(() => {
      fire("pitch:image:queued", { deckId: "d1", slideId: "s1", slot: "bg" });
      fire("pitch:image:ready", { deckId: "d1", slideId: "s2", slot: "bg" });
      fire("pitch:image:failed", { deckId: "d1", slideId: "s3", slot: "bg" });
    });
    expect(result.current.counts).toEqual({
      queued: 1,
      ready: 1,
      failed: 1,
      total: 3,
    });
  });

  it("slideStatus returns worst-of slot status (failed > queued > ready)", () => {
    const { result } = renderHook(() => useSlideImageStatus("d1"));
    act(() => {
      fire("pitch:image:ready", { deckId: "d1", slideId: "s1", slot: "left" });
      fire("pitch:image:queued", {
        deckId: "d1",
        slideId: "s1",
        slot: "right",
      });
    });
    expect(result.current.slideStatus("s1")).toBe("queued");
    act(() => {
      fire("pitch:image:failed", {
        deckId: "d1",
        slideId: "s1",
        slot: "bg",
      });
    });
    expect(result.current.slideStatus("s1")).toBe("failed");
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useSlideImageStatus("d1"));
    unmount();
    const offEvents = mockSocket.off.mock.calls.map((c) => c[0]);
    expect(offEvents).toEqual(
      expect.arrayContaining([
        "pitch:image:queued",
        "pitch:image:ready",
        "pitch:image:failed",
      ]),
    );
  });

  it("reset clears all tracked state", () => {
    const { result } = renderHook(() => useSlideImageStatus("d1"));
    act(() => {
      fire("pitch:image:ready", { deckId: "d1", slideId: "s1", slot: "bg" });
    });
    expect(result.current.statusOf("s1", "bg")).toBe("ready");
    act(() => result.current.reset());
    expect(result.current.statusOf("s1", "bg")).toBe("idle");
    expect(result.current.counts.total).toBe(0);
  });
});
