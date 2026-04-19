import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock fetchJson before importing the component
const mockFetchJson = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

// Mock toast
vi.mock("@/components/toast", () => ({
  showToast: vi.fn(),
}));

import { GpuPanel } from "./gpu-panel";

const fakeProfile = {
  detected: true,
  gpus: [
    { index: 0, name: "RTX 3060", total_mb: 12288, free_mb: 11500 },
    { index: 1, name: "RTX 3060", total_mb: 12288, free_mb: 12100 },
  ],
  total_vram_gb: 24,
  largest_gpu_gb: 12,
  recommended_tier: "medium",
  recommended_tier_pooled: "ultra",
  pooling_supported: true,
  pooling_mode: "off",
  same_arch: true,
  pinning: { "image-gen": 0, audio: 0, worker: 1, lipsync: 1, sadtalker: 1 },
  detected_at: "2026-04-19T00:00:00.000Z",
};

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe("GpuPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchJson.mockImplementation((url: string) => {
      if (url === "/api/system/gpu") return Promise.resolve(fakeProfile);
      if (url.includes("/ollama/")) return Promise.reject(new Error("not available"));
      return Promise.resolve({});
    });
  });

  it("renders GPU cards with correct data", async () => {
    render(<GpuPanel />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("2 GPUs detected")).toBeInTheDocument();
    });

    expect(screen.getByText("GPU 0")).toBeInTheDocument();
    expect(screen.getByText("GPU 1")).toBeInTheDocument();
    expect(screen.getAllByText("RTX 3060")).toHaveLength(2);
    expect(screen.getByText("24 GB total VRAM")).toBeInTheDocument();
  });

  it("renders tier badges", async () => {
    render(<GpuPanel />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("medium")).toBeInTheDocument();
    });

    expect(screen.getByText("ultra")).toBeInTheDocument();
  });

  it("renders pooling and same_arch badges", async () => {
    render(<GpuPanel />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("Pooling: Yes")).toBeInTheDocument();
    });

    expect(screen.getByText("Same arch: Yes")).toBeInTheDocument();
  });

  it("renders sidecar pinning table", async () => {
    render(<GpuPanel />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("image-gen")).toBeInTheDocument();
    });

    expect(screen.getByText("audio")).toBeInTheDocument();
    expect(screen.getByText("worker")).toBeInTheDocument();
    expect(screen.getByText("lipsync")).toBeInTheDocument();
    expect(screen.getByText("sadtalker")).toBeInTheDocument();
  });

  it("renders pooling mode control", async () => {
    render(<GpuPanel />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("VRAM Pooling Mode")).toBeInTheDocument();
    });
  });

  it("calls pooling endpoint when mode changes", async () => {
    render(<GpuPanel />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("VRAM Pooling Mode")).toBeInTheDocument();
    });

    // Find the pooling select
    const select = screen.getByDisplayValue(
      "Off (single-GPU with CPU offload)",
    );
    fireEvent.change(select, { target: { value: "manual-flux" } });

    await waitFor(() => {
      expect(mockFetchJson).toHaveBeenCalledWith(
        "/api/admin/gpu/pooling",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ mode: "manual-flux" }),
        }),
      );
    });
  });

  it("calls pinning endpoint when GPU assignment changes", async () => {
    render(<GpuPanel />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("Sidecar GPU Pinning")).toBeInTheDocument();
    });

    // Find the first pinning select (image-gen, currently GPU 0)
    const selects = screen.getAllByRole("combobox");
    // The first combobox after the pooling one should be a pinning select
    const pinningSelects = selects.filter((s) =>
      s.closest("table"),
    );
    if (pinningSelects.length > 0) {
      fireEvent.change(pinningSelects[0], { target: { value: "1" } });

      await waitFor(() => {
        expect(mockFetchJson).toHaveBeenCalledWith(
          "/api/admin/gpu/pinning",
          expect.objectContaining({ method: "POST" }),
        );
      });
    }
  });

  it("renders refresh button", async () => {
    render(<GpuPanel />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("Refresh")).toBeInTheDocument();
    });
  });

  it("shows loading state initially", () => {
    mockFetchJson.mockReturnValue(new Promise(() => {})); // Never resolves
    render(<GpuPanel />, { wrapper });
    expect(screen.getByText("Loading GPU info…")).toBeInTheDocument();
  });

  it("handles no GPU detected", async () => {
    const noGpuProfile = {
      ...fakeProfile,
      detected: false,
      gpus: [],
      total_vram_gb: 0,
      pooling_supported: false,
    };
    mockFetchJson.mockImplementation((url: string) => {
      if (url === "/api/system/gpu") return Promise.resolve(noGpuProfile);
      return Promise.reject(new Error("not available"));
    });

    render(<GpuPanel />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("No GPU detected")).toBeInTheDocument();
    });
  });

  it("initializes pooling mode from profile.pooling_mode", async () => {
    const activePoolingProfile = {
      ...fakeProfile,
      pooling_mode: "manual-flux",
    };
    mockFetchJson.mockImplementation((url: string) => {
      if (url === "/api/system/gpu") return Promise.resolve(activePoolingProfile);
      return Promise.reject(new Error("not available"));
    });

    render(<GpuPanel />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("VRAM Pooling Mode")).toBeInTheDocument();
    });

    const select = screen.getByDisplayValue(
      "Manual FLUX (split across GPUs)",
    );
    expect(select).toBeInTheDocument();
  });

  it("renders VRAM bar with correct used percentage", async () => {
    render(<GpuPanel />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("GPU 0")).toBeInTheDocument();
    });

    // GPU 0: total=12288, free=11500 → used = 788 MB = 0.8 GB
    expect(screen.getByText("0.8 GB used")).toBeInTheDocument();
  });
});
