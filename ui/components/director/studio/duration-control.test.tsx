import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { DurationControl } from "./duration-control";

describe("DurationControl", () => {
  it("renders with current duration value", () => {
    render(<DurationControl durationFrames={150} fps={30} onDurationChange={vi.fn()} />);
    expect(screen.getByTestId("duration-control")).toBeInTheDocument();
    expect(screen.getByDisplayValue("5.0")).toBeInTheDocument();
  });

  it("displays frame count", () => {
    render(<DurationControl durationFrames={90} fps={30} onDurationChange={vi.fn()} />);
    expect(screen.getByText(/90 frames/i)).toBeInTheDocument();
  });

  it("calls onDurationChange when number input changes", () => {
    const onDurationChange = vi.fn();
    render(<DurationControl durationFrames={150} fps={30} onDurationChange={onDurationChange} />);
    const input = screen.getByTestId("duration-input");
    fireEvent.change(input, { target: { value: "8" } });
    expect(onDurationChange).toHaveBeenCalledWith(240); // 8 * 30 fps
  });

  it("clamps value to max", () => {
    const onDurationChange = vi.fn();
    render(<DurationControl durationFrames={150} fps={30} onDurationChange={onDurationChange} maxSeconds={10} />);
    const input = screen.getByTestId("duration-input");
    fireEvent.change(input, { target: { value: "15" } });
    expect(onDurationChange).toHaveBeenCalledWith(300); // 10 * 30 fps
  });

  it("renders slider input", () => {
    render(<DurationControl durationFrames={150} fps={30} onDurationChange={vi.fn()} />);
    expect(screen.getByTestId("duration-slider")).toBeInTheDocument();
  });

  it("respects custom min and max", () => {
    render(<DurationControl durationFrames={150} fps={30} onDurationChange={vi.fn()} minSeconds={2} maxSeconds={20} />);
    const slider = screen.getByTestId("duration-slider") as HTMLInputElement;
    expect(slider.min).toBe("2");
    expect(slider.max).toBe("20");
  });
});
