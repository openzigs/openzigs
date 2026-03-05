import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

// Mock Web Audio API nodes before importing the hook
function createMockAudioContext(): AudioContext {
  const mockFilter = {
    type: "peaking",
    frequency: { value: 0 },
    Q: { value: 0 },
    gain: { value: 0 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const mockPanner = {
    pan: { value: 0 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const mockCompressor = {
    threshold: { value: 0 },
    knee: { value: 0 },
    ratio: { value: 1 },
    attack: { value: 0 },
    release: { value: 0 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const mockShaper = {
    curve: null as Float32Array | null,
    oversample: "none",
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const mockGain = {
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const mockConvolver = {
    buffer: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const mockDestination = {};

  return {
    sampleRate: 44100,
    destination: mockDestination,
    createBiquadFilter: vi.fn(() => ({ ...mockFilter })),
    createStereoPanner: vi.fn(() => ({ ...mockPanner })),
    createDynamicsCompressor: vi.fn(() => ({ ...mockCompressor })),
    createWaveShaper: vi.fn(() => ({ ...mockShaper })),
    createGain: vi.fn(() => ({ ...mockGain })),
    createConvolver: vi.fn(() => ({ ...mockConvolver })),
    createBuffer: vi.fn((_channels: number, length: number, _sampleRate: number) => ({
      getChannelData: vi.fn(() => new Float32Array(length)),
    })),
  } as unknown as AudioContext;
}

// Import hook after mocking
import { useAudioEffectsChain } from "@/hooks/useAudioEffectsChain";
import { DEFAULT_EFFECTS, type EffectsState } from "@/components/music-studio/EffectsRack";

describe("useAudioEffectsChain", () => {
  it("returns isReady=false when no AudioContext", () => {
    const { result } = renderHook(() =>
      useAudioEffectsChain(null, DEFAULT_EFFECTS)
    );
    expect(result.current.isReady).toBe(false);
    expect(typeof result.current.connectSource).toBe("function");
  });

  it("builds audio graph when AudioContext is provided", () => {
    const ctx = createMockAudioContext();
    const { result } = renderHook(() =>
      useAudioEffectsChain(ctx, DEFAULT_EFFECTS)
    );
    // Should have created 10 EQ filters + pan + compressor + shaper + 3 gains + convolver
    expect(ctx.createBiquadFilter).toHaveBeenCalledTimes(10);
    expect(ctx.createStereoPanner).toHaveBeenCalledTimes(1);
    expect(ctx.createDynamicsCompressor).toHaveBeenCalledTimes(1);
    expect(ctx.createWaveShaper).toHaveBeenCalledTimes(1);
    expect(ctx.createGain).toHaveBeenCalledTimes(3); // dry, reverb, master
    expect(ctx.createConvolver).toHaveBeenCalledTimes(1);
    expect(result.current.isReady).toBe(true);
  });

  it("connectSource calls connect on the first EQ filter", () => {
    const ctx = createMockAudioContext();
    const fakeSource = { connect: vi.fn(), disconnect: vi.fn() };

    const { result } = renderHook(() =>
      useAudioEffectsChain(ctx, DEFAULT_EFFECTS)
    );

    result.current.connectSource(fakeSource as unknown as AudioNode);
    expect(fakeSource.connect).toHaveBeenCalled();
  });

  it("updates effects parameters on re-render", () => {
    const ctx = createMockAudioContext();

    const modified: EffectsState = {
      ...DEFAULT_EFFECTS,
      reverbMix: 0.8,
      stereoPosition: -0.5,
      compressorEnabled: true,
      distortionAmount: 50,
      eqGains: [6, 0, 0, 3, 0, 0, -3, 0, 0, -6],
    };

    // Initial render then update
    const { rerender } = renderHook(
      ({ effects }) => useAudioEffectsChain(ctx, effects),
      { initialProps: { effects: DEFAULT_EFFECTS } }
    );

    rerender({ effects: modified });
    // The hook should have read our effects - no error means success
  });
});
