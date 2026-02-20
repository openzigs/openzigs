import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVoicePipe } from "./useVoicePipe";
import type { RemotePeer } from "./useVoiceRoom";

/* ── Mock Socket.IO context ──────────────────────────────── */

const mockSocket = {
  connected: true,
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
};

vi.mock("@/lib/socket-context", () => ({
  useSocket: () => ({ socket: mockSocket }),
}));

/* ── Mock Web Audio API + MediaRecorder ──────────────────── */

const mockDisconnect = vi.fn();
const mockConnect = vi.fn();
const mockSourceNode = { disconnect: mockDisconnect, connect: mockConnect };
const mockDestStream = {
  getAudioTracks: () => [{ enabled: true, kind: "audio" }],
  getTracks: () => [{ enabled: true, kind: "audio" }],
};
const mockDest = { stream: mockDestStream };

const mockClose = vi.fn();
const mockCreateMediaStreamSource = vi.fn().mockReturnValue(mockSourceNode);
const mockCreateMediaStreamDestination = vi.fn().mockReturnValue(mockDest);

class FakeAudioContext {
  state = "running";
  close = mockClose;
  createMediaStreamSource = mockCreateMediaStreamSource;
  createMediaStreamDestination = mockCreateMediaStreamDestination;
}

let recorderInstances: FakeMediaRecorder[] = [];

class FakeMediaRecorder {
  state = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  stream: MediaStream;

  constructor(stream: MediaStream) {
    this.stream = stream;
    recorderInstances.push(this);
  }

  start = vi.fn().mockImplementation(() => {
    this.state = "recording";
  });
  stop = vi.fn().mockImplementation(() => {
    this.state = "inactive";
  });
}

beforeEach(() => {
  recorderInstances = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  mockSocket.emit.mockClear();
  mockClose.mockClear().mockImplementation(() => {});
  mockDisconnect.mockClear();
  mockConnect.mockClear();
  // Re-set return values after vi.restoreAllMocks wipes them
  mockCreateMediaStreamSource.mockReset().mockReturnValue(mockSourceNode);
  mockCreateMediaStreamDestination.mockReset().mockReturnValue(mockDest);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ── Helpers ──────────────────────────────────────────────── */

function makeFakeStream(): MediaStream {
  return {
    getAudioTracks: () => [{ enabled: true, kind: "audio" }],
    getVideoTracks: () => [],
    getTracks: () => [{ enabled: true, kind: "audio" }],
  } as unknown as MediaStream;
}

function makeRemote(id: string): RemotePeer {
  return { peerId: id, stream: makeFakeStream() };
}

/* ── Tests ────────────────────────────────────────────────── */

describe("useVoicePipe", () => {
  it("does nothing when isHost is false", () => {
    renderHook(() =>
      useVoicePipe("pres-1", false, true, makeFakeStream(), []),
    );
    expect(mockCreateMediaStreamSource).not.toHaveBeenCalled();
    expect(recorderInstances).toHaveLength(0);
  });

  it("does nothing when isRecording is false", () => {
    renderHook(() =>
      useVoicePipe("pres-1", true, false, makeFakeStream(), []),
    );
    expect(mockCreateMediaStreamSource).not.toHaveBeenCalled();
  });

  it("does nothing when localStream is null", () => {
    renderHook(() =>
      useVoicePipe("pres-1", true, true, null, []),
    );
    expect(mockCreateMediaStreamSource).not.toHaveBeenCalled();
  });

  it("creates AudioContext and connects local stream when recording", () => {
    renderHook(() =>
      useVoicePipe("pres-1", true, true, makeFakeStream(), []),
    );
    expect(mockCreateMediaStreamDestination).toHaveBeenCalled();
    expect(mockCreateMediaStreamSource).toHaveBeenCalled(); // local mic
    expect(mockConnect).toHaveBeenCalled();
  });

  it("connects remote peer audio sources", () => {
    const remotes = [makeRemote("peer-a"), makeRemote("peer-b")];
    renderHook(() =>
      useVoicePipe("pres-1", true, true, makeFakeStream(), remotes),
    );
    // 1 local + 2 remote sources (may double due to React 18 Strict Mode)
    expect(mockCreateMediaStreamSource.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("starts a MediaRecorder when all conditions are met", () => {
    renderHook(() =>
      useVoicePipe("pres-1", true, true, makeFakeStream(), []),
    );
    expect(recorderInstances).toHaveLength(1);
    expect(recorderInstances[0].start).toHaveBeenCalledWith(3000);
  });

  it("closes AudioContext on unmount", () => {
    const { unmount } = renderHook(() =>
      useVoicePipe("pres-1", true, true, makeFakeStream(), []),
    );
    unmount();
    expect(mockClose).toHaveBeenCalled();
  });

  it("stopPipe stops the active recorder", () => {
    const { result } = renderHook(() =>
      useVoicePipe("pres-1", true, true, makeFakeStream(), []),
    );

    expect(result.current.isActive).toBe(true);

    // Manually invoke stopPipe
    act(() => result.current.stopPipe());
    expect(recorderInstances[0].stop).toHaveBeenCalled();
    expect(result.current.isActive).toBe(false);
  });
});
