import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TextOverlayEditor } from "./text-overlay-editor";

describe("TextOverlayEditor", () => {
  const defaultProps = {
    overlays: [] as Array<{ id: string; text: string; position: "center" | "bottom-third" | "top-third" | "custom"; animation: "fade-in" | "slide-up" | "typewriter" | "none"; fontSize?: number; fontWeight?: "normal" | "bold" | "light"; color?: string; backgroundColor?: string; startFrame: number; durationFrames: number }>,
    sceneDurationFrames: 90,
    fps: 30,
    onOverlaysChange: vi.fn(),
  };

  it("renders the panel", () => {
    render(<TextOverlayEditor {...defaultProps} />);
    expect(screen.getByTestId("text-overlay-editor")).toBeInTheDocument();
  });

  it("shows add overlay button", () => {
    render(<TextOverlayEditor {...defaultProps} />);
    expect(screen.getByTestId("add-overlay")).toBeInTheDocument();
  });

  it("adds a new overlay when button clicked", () => {
    const onOverlaysChange = vi.fn();
    render(<TextOverlayEditor {...defaultProps} onOverlaysChange={onOverlaysChange} />);
    fireEvent.click(screen.getByTestId("add-overlay"));
    expect(onOverlaysChange).toHaveBeenCalled();
    const overlays = onOverlaysChange.mock.calls[0][0];
    expect(overlays).toHaveLength(1);
    expect(overlays[0].text).toBe("New Text");
  });

  it("renders existing overlays", () => {
    const overlays = [
      { id: "o1", text: "Hello World", position: "center" as const, animation: "fade-in" as const, fontSize: 32, color: "#ffffff", startFrame: 0, durationFrames: 90 },
      { id: "o2", text: "Subtitle", position: "bottom-third" as const, animation: "slide-up" as const, fontSize: 24, color: "#ff0000", startFrame: 0, durationFrames: 90 },
    ];
    render(<TextOverlayEditor {...defaultProps} overlays={overlays} />);
    expect(screen.getByText(/Hello World/)).toBeInTheDocument();
    expect(screen.getByText(/Subtitle/)).toBeInTheDocument();
  });

  it("removes an overlay when delete is clicked", () => {
    const onOverlaysChange = vi.fn();
    const overlays = [
      { id: "o1", text: "Remove Me", position: "center" as const, animation: "none" as const, fontSize: 32, color: "#ffffff", startFrame: 0, durationFrames: 90 },
    ];
    render(<TextOverlayEditor {...defaultProps} overlays={overlays} onOverlaysChange={onOverlaysChange} />);
    // Expand and remove
    fireEvent.click(screen.getByTestId("overlay-toggle-o1"));
    fireEvent.click(screen.getByTestId("overlay-remove-o1"));
    expect(onOverlaysChange).toHaveBeenCalledWith([]);
  });

  it("updates overlay text", () => {
    const onOverlaysChange = vi.fn();
    const overlays = [
      { id: "o1", text: "Original", position: "center" as const, animation: "none" as const, fontSize: 32, color: "#ffffff", startFrame: 0, durationFrames: 90 },
    ];
    render(<TextOverlayEditor {...defaultProps} overlays={overlays} onOverlaysChange={onOverlaysChange} />);
    fireEvent.click(screen.getByTestId("overlay-toggle-o1"));
    const textInput = screen.getByTestId("overlay-text-input");
    fireEvent.change(textInput, { target: { value: "Updated" } });
    expect(onOverlaysChange).toHaveBeenCalled();
    const updated = onOverlaysChange.mock.calls[0][0];
    expect(updated[0].text).toBe("Updated");
  });
});
