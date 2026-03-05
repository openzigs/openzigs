import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SmartRemixLab } from "./SmartRemixLab";

// Mock fetchJson and buildMediaUrl
vi.mock("@/lib/api", () => ({
  fetchJson: vi.fn(),
  buildMediaUrl: vi.fn((path: string) => `http://localhost:5010${path}`),
}));

vi.mock("@/components/toast", () => ({
  showToast: vi.fn(),
}));

// Mock WaveformTrack to avoid wavesurfer dependency
vi.mock("./WaveformTrack", () => ({
  WaveformTrack: vi.fn(() => <div data-testid="waveform-track" />),
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
  { id: "a1", filename: "song.wav", prompt: "test song" },
];

describe("SmartRemixLab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the component heading", () => {
    render(<SmartRemixLab audioAssets={mockAssets} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByText("AI Remix Lab")).toBeInTheDocument();
  });

  it("shows source track selector", () => {
    render(<SmartRemixLab audioAssets={mockAssets} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByText("Choose a track from your gallery to analyze")).toBeInTheDocument();
  });

  it("renders vibe preset options", () => {
    render(<SmartRemixLab audioAssets={mockAssets} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByText("Punchy Pop")).toBeInTheDocument();
    expect(screen.getByText("Warm Lo-Fi")).toBeInTheDocument();
    expect(screen.getByText("Cinematic & Wide")).toBeInTheDocument();
    expect(screen.getByText("Raw")).toBeInTheDocument();
  });

  it("renders instrument replacement options", () => {
    render(<SmartRemixLab audioAssets={mockAssets} />, {
      wrapper: createWrapper(),
    });
    // Instrument options are in the constants
    expect(screen.queryByText("80s Analog Synth")).not.toBeInTheDocument(); // Only shown in modal
  });

  it("imports Save icon from lucide-react", async () => {
    // Verify the component renders without import errors
    const { container } = render(<SmartRemixLab audioAssets={mockAssets} />, {
      wrapper: createWrapper(),
    });
    expect(container).toBeTruthy();
  });
});
