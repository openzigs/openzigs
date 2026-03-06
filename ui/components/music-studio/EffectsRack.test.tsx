import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EffectsRack, DEFAULT_EFFECTS, type EffectsState } from "./EffectsRack";

// Mock the audio effects hook
vi.mock("@/hooks/useAudioEffectsChain", () => ({
  useAudioEffectsChain: vi.fn(() => ({
    connectSource: vi.fn(),
    isReady: false,
  })),
}));

describe("EffectsRack", () => {
  let onChange: ReturnType<typeof vi.fn>;
  let effects: EffectsState;

  beforeEach(() => {
    onChange = vi.fn();
    effects = { ...DEFAULT_EFFECTS };
  });

  it("renders collapsed by default", () => {
    render(<EffectsRack effects={effects} onChange={onChange} />);
    expect(screen.getByText("Effects Rack")).toBeInTheDocument();
    expect(screen.queryByText("10-Band Equalizer")).not.toBeInTheDocument();
  });

  it("expands to show sections when clicked", () => {
    render(<EffectsRack effects={effects} onChange={onChange} />);
    fireEvent.click(screen.getByText("Effects Rack"));
    expect(screen.getByText("Playback Speed")).toBeInTheDocument();
    expect(screen.getByText("10-Band Equalizer")).toBeInTheDocument();
    expect(screen.getByText("Stereo Pan")).toBeInTheDocument();
    expect(screen.getByText("Reverb")).toBeInTheDocument();
    expect(screen.getByText("Compressor")).toBeInTheDocument();
    expect(screen.getByText("Distortion")).toBeInTheDocument();
  });

  it("shows active badge when effects are modified", () => {
    const modifiedEffects = { ...DEFAULT_EFFECTS, reverbMix: 0.5 };
    render(<EffectsRack effects={modifiedEffects} onChange={onChange} />);
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("does not show active badge for defaults", () => {
    render(<EffectsRack effects={effects} onChange={onChange} />);
    expect(screen.queryByText("active")).not.toBeInTheDocument();
  });

  it("speed presets update playbackRate", () => {
    render(<EffectsRack effects={effects} onChange={onChange} />);
    fireEvent.click(screen.getByText("Effects Rack"));
    fireEvent.click(screen.getByText("Playback Speed"));
    fireEvent.click(screen.getByText("2x"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ playbackRate: 2 })
    );
  });

  it("compressor toggle calls onChange", () => {
    render(<EffectsRack effects={effects} onChange={onChange} />);
    fireEvent.click(screen.getByText("Effects Rack"));
    fireEvent.click(screen.getByText("OFF"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ compressorEnabled: true })
    );
  });

  it("reset button appears when effects are modified", () => {
    const modifiedEffects = {
      ...DEFAULT_EFFECTS,
      distortionAmount: 50,
    };
    render(<EffectsRack effects={modifiedEffects} onChange={onChange} />);
    fireEvent.click(screen.getByText("Effects Rack"));
    expect(screen.getByText("Reset All Effects")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Reset All Effects"));
    expect(onChange).toHaveBeenCalledWith(DEFAULT_EFFECTS);
  });

  it("DEFAULT_EFFECTS exports expected shape", () => {
    expect(DEFAULT_EFFECTS.eqGains).toHaveLength(10);
    expect(DEFAULT_EFFECTS.reverbMix).toBe(0);
    expect(DEFAULT_EFFECTS.stereoPosition).toBe(0);
    expect(DEFAULT_EFFECTS.playbackRate).toBe(1);
    expect(DEFAULT_EFFECTS.compressorEnabled).toBe(false);
    expect(DEFAULT_EFFECTS.distortionAmount).toBe(0);
  });
});
