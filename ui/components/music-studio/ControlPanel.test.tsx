import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ControlPanel, type Voice2VoiceParams } from "./ControlPanel";

// Mock fetchJson
vi.mock("@/lib/api", () => ({
  fetchJson: vi.fn(),
}));

// Mock toast
vi.mock("@/components/toast", () => ({
  showToast: vi.fn(),
}));

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = "TestWrapper";
  return Wrapper;
}

const mockAssets = [
  { id: "a1", filename: "track-01.wav", prompt: "test" },
  { id: "a2", filename: "track-02.mp3" },
];

describe("ControlPanel", () => {
  let onSubmit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSubmit = vi.fn();
    vi.clearAllMocks();
  });

  it("renders Voice2Voice controls heading", () => {
    render(
      <ControlPanel audioAssets={mockAssets} onSubmit={onSubmit} isProcessing={false} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText("Voice2Voice Controls")).toBeInTheDocument();
  });

  it("renders source track options", () => {
    render(
      <ControlPanel audioAssets={mockAssets} onSubmit={onSubmit} isProcessing={false} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText("Select audio file...")).toBeInTheDocument();
    expect(screen.getByText(/track-01\.wav/)).toBeInTheDocument();
    expect(screen.getByText(/track-02\.mp3/)).toBeInTheDocument();
  });

  it("shows voice reference section with upload", () => {
    render(
      <ControlPanel audioAssets={mockAssets} onSubmit={onSubmit} isProcessing={false} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText("Voice Reference")).toBeInTheDocument();
    expect(screen.getByText("Upload")).toBeInTheDocument();
  });

  it("shows singing/speech mode toggle", () => {
    render(
      <ControlPanel audioAssets={mockAssets} onSubmit={onSubmit} isProcessing={false} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText("Singing (44.1kHz)")).toBeInTheDocument();
    expect(screen.getByText("Speech (22kHz)")).toBeInTheDocument();
  });

  it("shows pitch shift slider", () => {
    render(
      <ControlPanel audioAssets={mockAssets} onSubmit={onSubmit} isProcessing={false} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText("Pitch Shift")).toBeInTheDocument();
  });

  it("disables submit button when processing", () => {
    render(
      <ControlPanel audioAssets={mockAssets} onSubmit={onSubmit} isProcessing={true} />,
      { wrapper: createWrapper() },
    );
    const button = screen.getByText("Processing...");
    expect(button.closest("button")).toBeDisabled();
  });

  it("shows advanced settings with diffusion steps when toggled", () => {
    render(
      <ControlPanel audioAssets={mockAssets} onSubmit={onSubmit} isProcessing={false} />,
      { wrapper: createWrapper() },
    );
    expect(screen.queryByText("Diffusion Steps")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Show Advanced Settings"));
    expect(screen.getByText("Diffusion Steps")).toBeInTheDocument();
  });

  it("does not submit without source selected", () => {
    render(
      <ControlPanel audioAssets={mockAssets} onSubmit={onSubmit} isProcessing={false} />,
      { wrapper: createWrapper() },
    );
    // The button should be disabled when no source and ref selected
    const submitBtn = screen.getByText("Start Voice Conversion");
    expect(submitBtn.closest("button")).toBeDisabled();
  });

  it("exports Voice2VoiceParams with new fields", () => {
    // Type-level test: ensure the interface has the expected shape
    const params: Voice2VoiceParams = {
      source_asset_id: "a1",
      voice_reference_id: "ref-001",
      pitch_shift: 0,
      diffusion_steps: 30,
      f0_condition: true,
      vocal_volume: 1.0,
      instrumental_volume: 1.0,
      output_format: "wav",
    };
    expect(params.voice_reference_id).toBe("ref-001");
    expect(params.diffusion_steps).toBe(30);
    expect(params.f0_condition).toBe(true);
  });
});
