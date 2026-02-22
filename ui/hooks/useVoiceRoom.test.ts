import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup as rtlCleanup } from "@testing-library/react";
import React from "react";

/* ── Mock socket-context ─────────────────────────────────── */

const handlers = new Map<string, (...args: unknown[]) => void>();
const mockSocket = {
  connected: true,
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
};

function setupSocketMock() {
  handlers.clear();
  mockSocket.emit.mockClear();
  mockSocket.on.mockReset().mockImplementation((event: string, fn: (...args: unknown[]) => void) => {
    handlers.set(event, fn);
  });
  mockSocket.off.mockReset().mockImplementation((event: string) => {
    handlers.delete(event);
  });
}

vi.mock("@/lib/socket-context", () => ({
  useSocket: () => ({ socket: mockSocket }),
}));

/* ── Mock PeerJS ─────────────────────────────────────────── */

class MockCall {
  peer: string;
  private _handlers = new Map<string, (...args: unknown[]) => void>();
  constructor(peer: string) { this.peer = peer; }
  on(event: string, fn: (...args: unknown[]) => void) { this._handlers.set(event, fn); return this; }
  answer = vi.fn();
  close = vi.fn();
}

const mockPeerCall = vi.fn();
const mockPeerDestroy = vi.fn();

interface PeerTestHandle {
  _fireOpen: () => void;
  _fireCall: (c: MockCall) => void;
}

let lastPeerHandle: PeerTestHandle | null = null;

vi.mock("peerjs", () => {
  class FakePeer {
    private _h = new Map<string, (...args: unknown[]) => void>();
    constructor() {
      lastPeerHandle = {
        _fireOpen: () => this._h.get("open")?.("my-peer-id-000"),
        _fireCall: (c: MockCall) => this._h.get("call")?.(c),
      };
    }
    on(event: string, fn: (...args: unknown[]) => void) { this._h.set(event, fn); return this; }
    call(...args: unknown[]) { return mockPeerCall(...args); }
    destroy() { return mockPeerDestroy(); }
  }
  return { default: FakePeer };
});

/* ── Mock MediaRecorder (stubbed globally) ────────────────── */

vi.stubGlobal("MediaRecorder", class {
  state = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  start = vi.fn().mockImplementation(function (this: { state: string }) { this.state = "recording"; });
  stop = vi.fn().mockImplementation(function (this: { state: string }) { this.state = "inactive"; });
});

/* ── Import AFTER all vi.mock calls (hoisted by vitest) ──── */

import { useVoiceRoom } from "./useVoiceRoom";

/* ── Helpers ──────────────────────────────────────────────── */

// Disable StrictMode to avoid double-mount effect churn that causes OOM in jsdom
const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(React.Fragment, null, children);

function makeFakeStream(): MediaStream {
  const audioTrack = { enabled: false, kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack;
  return {
    getAudioTracks: () => [audioTrack],
    getVideoTracks: () => [],
    getTracks: () => [audioTrack],
  } as unknown as MediaStream;
}

/* ── Setup / teardown ────────────────────────────────────── */

beforeEach(() => {
  setupSocketMock();
  mockPeerCall.mockReset().mockImplementation((remotePeerId: string) => new MockCall(remotePeerId));
  mockPeerDestroy.mockReset();
  lastPeerHandle = null;
});

afterEach(() => {
  rtlCleanup();
  vi.clearAllMocks();
});

/* ── Tests ────────────────────────────────────────────────── */

describe("useVoiceRoom", () => {
  it("registers socket listeners even when localStream is null", () => {
    const { result, unmount } = renderHook(() => useVoiceRoom("pres-1", null), { wrapper });
    // PeerJS + socket discovery initializes independently of localStream
    // so participants can discover each other without a camera/mic
    expect(mockSocket.on).toHaveBeenCalledWith(
      "room:peers_updated",
      expect.any(Function),
    );
    expect(result.current.peerIds).toEqual([]);
    expect(result.current.remoteStreams).toEqual([]);
    unmount();
  });

  it("returns empty state and registers socket listeners on mount", () => {
    const { result, unmount } = renderHook(() =>
      useVoiceRoom("pres-1", makeFakeStream()),
      { wrapper },
    );
    expect(result.current.peerIds).toEqual([]);
    expect(result.current.remoteStreams).toEqual([]);
    expect(result.current.isMuted).toBe(true);
    expect(result.current.isRaisingHand).toBe(false);
    expect(handlers.has("room:peers_updated")).toBe(true);
    expect(handlers.has("room:transcription_preview")).toBe(true);
    unmount();
  });

  it("toggleMic flips the audio track enabled flag", () => {
    const stream = makeFakeStream();
    const { result, unmount } = renderHook(() => useVoiceRoom("pres-1", stream), { wrapper });

    expect(result.current.isMuted).toBe(true);
    act(() => result.current.toggleMic());
    expect(result.current.isMuted).toBe(false);
    expect(stream.getAudioTracks()[0].enabled).toBe(true);
    act(() => result.current.toggleMic());
    expect(result.current.isMuted).toBe(true);
    unmount();
  });

  it("raiseHand enables audio and lowerHand disables it", () => {
    const stream = makeFakeStream();
    const { result, unmount } = renderHook(() => useVoiceRoom("pres-1", stream), { wrapper });

    act(() => result.current.raiseHand());
    expect(result.current.isRaisingHand).toBe(true);
    expect(result.current.isMuted).toBe(false);
    expect(stream.getAudioTracks()[0].enabled).toBe(true);

    act(() => result.current.lowerHand());
    expect(result.current.isRaisingHand).toBe(false);
    expect(result.current.isMuted).toBe(true);
    expect(stream.getAudioTracks()[0].enabled).toBe(false);

    act(() => result.current.cleanup());
    expect(result.current.peerIds).toEqual([]);
    expect(result.current.remoteStreams).toEqual([]);
    unmount();
  });

  it("announces peer on open and handles incoming calls", async () => {
    const { unmount } = renderHook(() => useVoiceRoom("pres-1", makeFakeStream()), { wrapper });

    await act(async () => {
      lastPeerHandle?._fireOpen();
    });
    expect(mockSocket.emit).toHaveBeenCalledWith("room:announce_peer", {
      presentationId: "pres-1",
      peerId: "my-peer-id-000",
    });

    const incomingCall = new MockCall("incoming-peer-1");
    await act(async () => {
      lastPeerHandle?._fireCall(incomingCall);
    });
    expect(incomingCall.answer).toHaveBeenCalled();
    unmount();
  });
});
