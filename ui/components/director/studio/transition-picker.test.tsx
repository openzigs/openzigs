import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TransitionPicker, TransitionIndicator } from "./transition-picker";

describe("TransitionPicker", () => {
  const defaultProps = {
    currentStyle: "crossfade" as const,
    currentDuration: 15,
    fps: 30,
    onStyleChange: vi.fn(),
    onDurationChange: vi.fn(),
  };

  it("renders with all transition style buttons", () => {
    render(<TransitionPicker {...defaultProps} />);
    expect(screen.getByTestId("transition-picker")).toBeInTheDocument();
    expect(screen.getByText("Crossfade")).toBeInTheDocument();
    expect(screen.getByText("Wipe Left")).toBeInTheDocument();
    expect(screen.getByText("Dissolve")).toBeInTheDocument();
    expect(screen.getByText("Slide")).toBeInTheDocument();
    expect(screen.getByText("Flip")).toBeInTheDocument();
  });

  it("highlights selected style", () => {
    render(<TransitionPicker {...defaultProps} currentStyle="dissolve" />);
    const dissolveBtn = screen.getByTestId("transition-dissolve");
    expect(dissolveBtn.className).toContain("bg-primary");
  });

  it("calls onStyleChange when style button clicked", () => {
    const onStyleChange = vi.fn();
    render(<TransitionPicker {...defaultProps} onStyleChange={onStyleChange} />);
    fireEvent.click(screen.getByText("Slide"));
    expect(onStyleChange).toHaveBeenCalledWith("slide");
  });

  it("renders duration controls", () => {
    render(<TransitionPicker {...defaultProps} />);
    expect(screen.getByText("1s")).toBeInTheDocument();
    expect(screen.getByText("0.5s")).toBeInTheDocument();
    expect(screen.getByText("2s")).toBeInTheDocument();
  });

  it("calls onDurationChange when duration button clicked", () => {
    const onDurationChange = vi.fn();
    render(<TransitionPicker {...defaultProps} onDurationChange={onDurationChange} />);
    fireEvent.click(screen.getByText("1.5s"));
    expect(onDurationChange).toHaveBeenCalledWith(45);
  });

  it("hides duration selector for cut style", () => {
    render(<TransitionPicker {...defaultProps} currentStyle="cut" />);
    expect(screen.queryByTestId("transition-durations")).not.toBeInTheDocument();
  });
});

describe("TransitionIndicator", () => {
  it("renders and is clickable", () => {
    const onClick = vi.fn();
    render(<TransitionIndicator style="wipe-left" onClick={onClick} />);
    expect(screen.getByTestId("transition-indicator")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("transition-indicator"));
    expect(onClick).toHaveBeenCalled();
  });
});
