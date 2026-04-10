import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClipExtractorPanel } from "./clip-extractor-panel";
import { AudioCleanerPanel } from "./audio-cleaner-panel";
import { BRollPanel } from "./broll-panel";
import { NLEExportPanel } from "./nle-export-panel";

// Mock api
vi.mock("@/lib/api", () => ({
  fetchJson: vi.fn().mockResolvedValue({ jobId: "test-001", status: "queued" }),
}));

vi.mock("@/components/toast", () => ({
  showToast: vi.fn(),
}));

vi.mock("@/lib/socket-context", () => ({
  useSocket: () => ({ socket: null }),
}));

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("ClipExtractorPanel", () => {
  it("renders extract button", () => {
    render(<ClipExtractorPanel draftId="d1" videoSource="/tmp/test.mp4" />, { wrapper: createWrapper() });
    expect(screen.getByText("Extract Clips")).toBeInTheDocument();
  });

  it("shows clip count input", () => {
    render(<ClipExtractorPanel draftId="d1" videoSource="/tmp/test.mp4" />, { wrapper: createWrapper() });
    expect(screen.getByText("Clips")).toBeInTheDocument();
  });

  it("shows style selector", () => {
    render(<ClipExtractorPanel draftId="d1" videoSource="/tmp/test.mp4" />, { wrapper: createWrapper() });
    expect(screen.getByText("Style")).toBeInTheDocument();
  });

  it("disables button without source", () => {
    render(<ClipExtractorPanel draftId="d1" />, { wrapper: createWrapper() });
    const btn = screen.getByText("Extract Clips").closest("button");
    expect(btn).toBeDisabled();
  });
});

describe("AudioCleanerPanel", () => {
  it("renders clean button", () => {
    render(<AudioCleanerPanel draftId="d1" audioSource="/tmp/test.mp3" />);
    expect(screen.getByText("Clean Audio")).toBeInTheDocument();
  });

  it("shows toggle options", () => {
    render(<AudioCleanerPanel draftId="d1" audioSource="/tmp/test.mp3" />);
    expect(screen.getByText("Remove filler words")).toBeInTheDocument();
    expect(screen.getByText("Trim silence")).toBeInTheDocument();
    expect(screen.getByText("Enhance speech")).toBeInTheDocument();
    expect(screen.getByText("Noise reduction")).toBeInTheDocument();
  });

  it("shows aggressiveness select", () => {
    render(<AudioCleanerPanel draftId="d1" audioSource="/tmp/test.mp3" />);
    expect(screen.getByText("Aggressiveness")).toBeInTheDocument();
  });
});

describe("BRollPanel", () => {
  it("renders analyze button", () => {
    render(<BRollPanel draftId="d1" videoSource="/tmp/test.mp4" />, { wrapper: createWrapper() });
    expect(screen.getByText("Find B-Roll Points")).toBeInTheDocument();
  });

  it("shows density selector", () => {
    render(<BRollPanel draftId="d1" videoSource="/tmp/test.mp4" />, { wrapper: createWrapper() });
    expect(screen.getByText("Density")).toBeInTheDocument();
  });

  it("disables button without source", () => {
    render(<BRollPanel draftId="d1" />, { wrapper: createWrapper() });
    const btn = screen.getByText("Find B-Roll Points").closest("button");
    expect(btn).toBeDisabled();
  });
});

describe("NLEExportPanel", () => {
  const manifest = {
    composition: { fps: 30, width: 1920, height: 1080 },
    timeline: [],
  };

  it("renders export button", () => {
    render(<NLEExportPanel draftId="d1" manifest={manifest} />);
    expect(screen.getByText("Export FCP XML")).toBeInTheDocument();
  });

  it("shows format options", () => {
    render(<NLEExportPanel draftId="d1" manifest={manifest} />);
    expect(screen.getByText("FCP XML")).toBeInTheDocument();
    expect(screen.getByText("EDL")).toBeInTheDocument();
  });

  it("can switch to EDL format", () => {
    render(<NLEExportPanel draftId="d1" manifest={manifest} />);
    const edlBtn = screen.getByText("EDL").closest("button");
    if (edlBtn) fireEvent.click(edlBtn);
    expect(screen.getByText("Export EDL")).toBeInTheDocument();
  });
});
