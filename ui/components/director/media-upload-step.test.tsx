import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { MediaUploadStep } from "./media-upload-step";

// Mock dependencies
vi.mock("@/lib/api", () => ({
  fetchJson: vi.fn().mockRejectedValue(new Error("not called")),
}));
vi.mock("@/components/toast", () => ({
  showToast: vi.fn(),
}));
vi.mock("@/components/model-picker-select", () => ({
  InlineModelPicker: () => null,
}));

const defaultProps = {
  mode: "presentation" as const,
  clips: [],
  scriptFile: null,
  topic: "",
  sourceFiles: [],
  imageClipDurationSeconds: 3,
  onClipsChange: vi.fn(),
  onScriptChange: vi.fn(),
  onTopicChange: vi.fn(),
  onSourceFilesChange: vi.fn(),
  onImageClipDurationChange: vi.fn(),
};

describe("MediaUploadStep — duration control", () => {
  it("renders the duration control card in presentation mode", () => {
    render(<MediaUploadStep {...defaultProps} />);

    expect(screen.getByText("Default Asset Pacing (Image Assets Only)")).toBeInTheDocument();
    expect(screen.getByLabelText("Image Clip Duration (seconds)")).toBeInTheDocument();
  });

  it("displays the current duration value", () => {
    render(<MediaUploadStep {...defaultProps} imageClipDurationSeconds={5} />);

    const input = screen.getByLabelText("Image Clip Duration (seconds)") as HTMLInputElement;
    expect(input.value).toBe("5");
  });

  it("calls onImageClipDurationChange when value changes", () => {
    const onImageClipDurationChange = vi.fn();
    render(
      <MediaUploadStep
        {...defaultProps}
        onImageClipDurationChange={onImageClipDurationChange}
      />,
    );

    const input = screen.getByLabelText("Image Clip Duration (seconds)");
    fireEvent.change(input, { target: { value: "7" } });
    expect(onImageClipDurationChange).toHaveBeenCalledWith(7);
  });

  it("clamps duration to min 1 for negative input", () => {
    const onImageClipDurationChange = vi.fn();
    render(
      <MediaUploadStep
        {...defaultProps}
        onImageClipDurationChange={onImageClipDurationChange}
      />,
    );

    const input = screen.getByLabelText("Image Clip Duration (seconds)");
    fireEvent.change(input, { target: { value: "-5" } });
    expect(onImageClipDurationChange).toHaveBeenCalledWith(1);
  });

  it("clamps duration to max 10", () => {
    const onImageClipDurationChange = vi.fn();
    render(
      <MediaUploadStep
        {...defaultProps}
        onImageClipDurationChange={onImageClipDurationChange}
      />,
    );

    const input = screen.getByLabelText("Image Clip Duration (seconds)");
    fireEvent.change(input, { target: { value: "15" } });
    expect(onImageClipDurationChange).toHaveBeenCalledWith(10);
  });

  it("does not render duration control in highlight mode", () => {
    render(<MediaUploadStep {...defaultProps} mode="highlight" />);

    expect(screen.queryByText("Default Asset Pacing (Image Assets Only)")).not.toBeInTheDocument();
  });

  it("renders the input with min and max attributes", () => {
    render(<MediaUploadStep {...defaultProps} />);

    const input = screen.getByLabelText("Image Clip Duration (seconds)") as HTMLInputElement;
    expect(input.min).toBe("1");
    expect(input.max).toBe("10");
  });
});
