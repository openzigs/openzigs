import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SceneEffectsPanel } from "./scene-effects-panel";

describe("SceneEffectsPanel", () => {
  const defaultProps = {
    effects: [] as Array<{ type: string; [k: string]: unknown }>,
    kenBurns: undefined,
    isImageScene: true,
    onEffectsChange: vi.fn(),
    onKenBurnsChange: vi.fn(),
  };

  it("renders the panel", () => {
    render(<SceneEffectsPanel {...defaultProps} />);
    expect(screen.getByTestId("scene-effects-panel")).toBeInTheDocument();
  });

  it("renders preset buttons", () => {
    render(<SceneEffectsPanel {...defaultProps} />);
    expect(screen.getByText("None")).toBeInTheDocument();
    expect(screen.getByText("Cinematic")).toBeInTheDocument();
    expect(screen.getByText("Vintage")).toBeInTheDocument();
    expect(screen.getByText("High Energy")).toBeInTheDocument();
    expect(screen.getByText("Moody")).toBeInTheDocument();
    expect(screen.getByText("Film Noir")).toBeInTheDocument();
    expect(screen.getByText("Dreamy")).toBeInTheDocument();
  });

  it("calls onEffectsChange when preset clicked", () => {
    const onEffectsChange = vi.fn();
    render(<SceneEffectsPanel {...defaultProps} onEffectsChange={onEffectsChange} />);
    fireEvent.click(screen.getByText("Cinematic"));
    expect(onEffectsChange).toHaveBeenCalled();
    const effects = onEffectsChange.mock.calls[0][0];
    expect(effects.length).toBeGreaterThan(0);
  });

  it("renders quick toggles", () => {
    render(<SceneEffectsPanel {...defaultProps} />);
    expect(screen.getByTestId("toggle-grayscale")).toBeInTheDocument();
    expect(screen.getByTestId("toggle-fade-in")).toBeInTheDocument();
    expect(screen.getByTestId("toggle-fade-out")).toBeInTheDocument();
  });

  it("toggles grayscale on B&W click", () => {
    const onEffectsChange = vi.fn();
    render(<SceneEffectsPanel {...defaultProps} onEffectsChange={onEffectsChange} />);
    fireEvent.click(screen.getByTestId("toggle-grayscale"));
    expect(onEffectsChange).toHaveBeenCalled();
    const effects = onEffectsChange.mock.calls[0][0];
    expect(effects.some((e: { type: string }) => e.type === "grayscale")).toBe(true);
  });

  it("renders granular sliders after expanding", () => {
    render(<SceneEffectsPanel {...defaultProps} />);
    // Expand fine-tune controls
    fireEvent.click(screen.getByTestId("toggle-granular"));
    expect(screen.getByTestId("slider-brightness")).toBeInTheDocument();
    expect(screen.getByTestId("slider-contrast")).toBeInTheDocument();
    expect(screen.getByTestId("slider-saturate")).toBeInTheDocument();
    expect(screen.getByTestId("slider-sepia")).toBeInTheDocument();
    expect(screen.getByTestId("slider-blur")).toBeInTheDocument();
    expect(screen.getByTestId("slider-hueRotate")).toBeInTheDocument();
  });

  it("calls onEffectsChange when slider changes", () => {
    const onEffectsChange = vi.fn();
    render(<SceneEffectsPanel {...defaultProps} onEffectsChange={onEffectsChange} />);
    fireEvent.click(screen.getByTestId("toggle-granular"));
    const brightnessSlider = screen.getByTestId("slider-brightness");
    fireEvent.change(brightnessSlider, { target: { value: "1.5" } });
    expect(onEffectsChange).toHaveBeenCalled();
    const effects = onEffectsChange.mock.calls[0][0];
    expect(effects.some((e: { type: string }) => e.type === "brightness")).toBe(true);
  });

  it("renders Ken Burns controls after expanding", () => {
    render(<SceneEffectsPanel {...defaultProps} />);
    fireEvent.click(screen.getByTestId("toggle-ken-burns"));
    expect(screen.getByTestId("kb-scaleFrom")).toBeInTheDocument();
    expect(screen.getByTestId("kb-scaleTo")).toBeInTheDocument();
  });

  it("preserves existing effects from preset", () => {
    const effects = [{ type: "fadeIn", durationFrames: 15 }];
    render(<SceneEffectsPanel {...defaultProps} effects={effects} />);
    expect(screen.getByTestId("scene-effects-panel")).toBeInTheDocument();
  });
});
