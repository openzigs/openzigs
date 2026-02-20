import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMediaDevices } from "./useMediaDevices";

/* ── Helpers ──────────────────────────────────────────────── */

function makeFakeTrack(kind: "audio" | "video"): MediaStreamTrack {
  return {
    kind,
    enabled: true,
    stop: vi.fn(),
    id: `${kind}-${Math.random().toString(36).slice(2, 6)}`,
  } as unknown as MediaStreamTrack;
}

function makeFakeStream(audioTracks: MediaStreamTrack[], videoTracks: MediaStreamTrack[]): MediaStream {
  return {
    getTracks: () => [...audioTracks, ...videoTracks],
    getAudioTracks: () => audioTracks,
    getVideoTracks: () => videoTracks,
  } as unknown as MediaStream;
}

let fakeAudioTrack: MediaStreamTrack;
let fakeVideoTrack: MediaStreamTrack;
let fakeStream: MediaStream;

beforeEach(() => {
  fakeAudioTrack = makeFakeTrack("audio");
  fakeVideoTrack = makeFakeTrack("video");
  fakeStream = makeFakeStream([fakeAudioTrack], [fakeVideoTrack]);

  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn().mockResolvedValue(fakeStream) },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ── Tests ────────────────────────────────────────────────── */

describe("useMediaDevices", () => {
  it("acquires a stream on mount and starts muted", async () => {
    const { result } = renderHook(() => useMediaDevices());

    // Wait for async getUserMedia to resolve
    await vi.waitFor(() => {
      expect(result.current.stream).toBe(fakeStream);
    });

    expect(result.current.isAudioMuted).toBe(true);
    expect(result.current.isVideoMuted).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.isAcquiring).toBe(false);

    // Tracks should have been disabled after acquisition
    expect(fakeAudioTrack.enabled).toBe(false);
    expect(fakeVideoTrack.enabled).toBe(false);
  });

  it("calls getUserMedia with expected constraints", async () => {
    renderHook(() => useMediaDevices({ video: true, audio: true }));

    await vi.waitFor(() => {
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    });

    const constraints = (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(constraints.audio).toBe(true);
    expect(constraints.video).toEqual(
      expect.objectContaining({ facingMode: "user" }),
    );
  });

  it("toggleAudio flips the audio track enabled flag", async () => {
    const { result } = renderHook(() => useMediaDevices());

    await vi.waitFor(() => expect(result.current.stream).toBeTruthy());

    act(() => result.current.toggleAudio());
    expect(fakeAudioTrack.enabled).toBe(true);
    expect(result.current.isAudioMuted).toBe(false);

    act(() => result.current.toggleAudio());
    expect(fakeAudioTrack.enabled).toBe(false);
    expect(result.current.isAudioMuted).toBe(true);
  });

  it("toggleVideo flips the video track enabled flag", async () => {
    const { result } = renderHook(() => useMediaDevices());

    await vi.waitFor(() => expect(result.current.stream).toBeTruthy());

    act(() => result.current.toggleVideo());
    expect(fakeVideoTrack.enabled).toBe(true);
    expect(result.current.isVideoMuted).toBe(false);

    act(() => result.current.toggleVideo());
    expect(fakeVideoTrack.enabled).toBe(false);
    expect(result.current.isVideoMuted).toBe(true);
  });

  it("releaseStream stops all tracks and nulls the stream", async () => {
    const { result } = renderHook(() => useMediaDevices());

    await vi.waitFor(() => expect(result.current.stream).toBeTruthy());

    act(() => result.current.releaseStream());

    expect(result.current.stream).toBeNull();
    expect(fakeAudioTrack.stop).toHaveBeenCalled();
    expect(fakeVideoTrack.stop).toHaveBeenCalled();
  });

  it("stops tracks on unmount", async () => {
    const { result, unmount } = renderHook(() => useMediaDevices());

    await vi.waitFor(() => expect(result.current.stream).toBeTruthy());

    unmount();

    expect(fakeAudioTrack.stop).toHaveBeenCalled();
    expect(fakeVideoTrack.stop).toHaveBeenCalled();
  });

  it("sets error state when getUserMedia rejects", async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Permission denied"),
    );

    const { result } = renderHook(() => useMediaDevices());

    await vi.waitFor(() => {
      expect(result.current.error).toBe("Permission denied");
    });

    expect(result.current.stream).toBeNull();
    expect(result.current.isAcquiring).toBe(false);
  });

  it("toggleAudio is a no-op when stream is null", async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("denied"),
    );
    const { result } = renderHook(() => useMediaDevices());

    await vi.waitFor(() => expect(result.current.error).toBeTruthy());

    // Should not throw
    act(() => result.current.toggleAudio());
    expect(result.current.isAudioMuted).toBe(true);
  });
});
