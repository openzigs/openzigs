import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { HeroReelPanel } from "./hero-reel-panel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock fetchJson to prevent real API calls
vi.mock("@/lib/api", () => ({
  fetchJson: vi.fn().mockRejectedValue(new Error("not called")),
}));

// Mock toast to prevent side effects
vi.mock("@/components/toast", () => ({
  showToast: vi.fn(),
}));

const createWrapper = () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = "HeroReelPanelTestWrapper";
  return Wrapper;
};

describe("HeroReelPanel", () => {
  it("renders the header with title and description", () => {
    render(<HeroReelPanel />, { wrapper: createWrapper() });

    expect(screen.getByText("Hero Reel")).toBeInTheDocument();
    expect(screen.getByText(/fast-paced, music-driven montage/)).toBeInTheDocument();
  });

  it("renders the overview textarea", () => {
    render(<HeroReelPanel />, { wrapper: createWrapper() });

    const textarea = screen.getByPlaceholderText(/fast-paced montage/);
    expect(textarea).toBeInTheDocument();
    expect(textarea).not.toBeDisabled();
  });

  it("renders the generate button in idle state", () => {
    render(<HeroReelPanel />, { wrapper: createWrapper() });

    expect(screen.getByText("Generate Hero Reel")).toBeInTheDocument();
  });

  it("renders pipeline info section", () => {
    render(<HeroReelPanel />, { wrapper: createWrapper() });

    expect(screen.getByText("What happens next")).toBeInTheDocument();
    expect(screen.getByText(/Your images are used first/)).toBeInTheDocument();
    expect(screen.getByText(/No narrator script or TTS/)).toBeInTheDocument();
  });

  it("renders user image upload section", () => {
    render(<HeroReelPanel />, { wrapper: createWrapper() });

    expect(screen.getByText("Add Images")).toBeInTheDocument();
    expect(screen.getByText(/Drop images here or click to browse/)).toBeInTheDocument();
  });

  it("renders inspiration file upload section", () => {
    render(<HeroReelPanel />, { wrapper: createWrapper() });

    expect(screen.getByText(/Upload a markdown, PDF, image/)).toBeInTheDocument();
  });

  it("allows typing in the overview textarea", () => {
    render(<HeroReelPanel />, { wrapper: createWrapper() });

    const textarea = screen.getByPlaceholderText(/fast-paced montage/);
    fireEvent.change(textarea, { target: { value: "Brand montage, energetic and modern" } });
    expect(textarea).toHaveValue("Brand montage, energetic and modern");
  });

  it("triggers mutation on generate button click", async () => {
    const { fetchJson } = await import("@/lib/api");
    (fetchJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ produceJobId: "job-123" });

    render(<HeroReelPanel />, { wrapper: createWrapper() });

    const btn = screen.getByText("Generate Hero Reel");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(fetchJson).toHaveBeenCalledWith(
        "/api/admin/director/produce",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"hero-reel"'),
        }),
      );
    });
  });

  it("renders AI enhance button for overview", () => {
    render(<HeroReelPanel />, { wrapper: createWrapper() });

    expect(screen.getByText("AI Enhance")).toBeInTheDocument();
  });
});
