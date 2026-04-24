import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api", () => ({
  fetchJson: vi.fn(),
}));

vi.mock("@/components/toast", () => ({
  ToastContainer: () => null,
  showToast: vi.fn(),
}));

import { fetchJson } from "@/lib/api";
import AdminModelsPage from "./page";

const mockedFetchJson = fetchJson as unknown as ReturnType<typeof vi.fn>;

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = "AdminModelsTestWrapper";
  return Wrapper;
}

describe("AdminModelsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the page heading", async () => {
    mockedFetchJson.mockResolvedValueOnce({
      cuda_available: true,
      device_count: 0,
      pooled_vram_gb: 0,
      per_device: [],
      pooling: { active: false },
      max_frames: {},
      audio_modes: ["off"],
    });
    render(<AdminModelsPage />, { wrapper: createWrapper() });
    expect(
      screen.getByRole("heading", { name: "Models", level: 1 }),
    ).toBeInTheDocument();
  });

  it("renders skeleton while loading", () => {
    mockedFetchJson.mockReturnValueOnce(new Promise(() => {}));
    render(<AdminModelsPage />, { wrapper: createWrapper() });
    expect(screen.getByTestId("capabilities-skeleton")).toBeInTheDocument();
  });

  it("renders GPU count, pooled VRAM, and pooling badges", async () => {
    mockedFetchJson.mockResolvedValueOnce({
      cuda_available: true,
      device_count: 2,
      pooled_vram_gb: 48,
      per_device: [
        { index: 0, name: "RTX 4090", total_gb: 24, free_gb: 22 },
        { index: 1, name: "RTX 4090", total_gb: 24, free_gb: 23 },
      ],
      pooling: {
        mode: "auto",
        active: true,
        transformer_device: "cuda:1",
        encoder_device: "cuda:0",
        vae_device: "cuda:0",
      },
      max_frames: { "ltxv-2-22b-distilled": 257 },
      audio_modes: ["off", "auto", "native"],
    });

    render(<AdminModelsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("gpu-count-badge")).toHaveTextContent(
        "2 GPUs",
      );
    });
    expect(screen.getByTestId("pooled-vram-badge")).toHaveTextContent(
      "48 GB pooled VRAM",
    );
    expect(screen.getByTestId("pooling-badge")).toHaveTextContent(
      "Pooling Active",
    );
  });

  it("renders per-LTX-model table with frames, seconds, sync-audio badge", async () => {
    mockedFetchJson.mockResolvedValueOnce({
      cuda_available: true,
      device_count: 1,
      pooled_vram_gb: 24,
      per_device: [{ index: 0, name: "RTX 4090", total_gb: 24, free_gb: 22 }],
      pooling: { active: false },
      max_frames: {
        "ltxv-2b-096-distilled": 57,
        "ltxv-2-22b-distilled": 161,
      },
      audio_modes: ["off", "auto"],
    });

    render(<AdminModelsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("ltx-models-table")).toBeInTheDocument();
    });
    expect(screen.getByText("ltxv-2b-096-distilled")).toBeInTheDocument();
    expect(screen.getByText("ltxv-2-22b-distilled")).toBeInTheDocument();
    expect(screen.getByText("57")).toBeInTheDocument();
    expect(screen.getByText("161")).toBeInTheDocument();
  });

  it("renders error banner when fetch fails", async () => {
    mockedFetchJson.mockRejectedValueOnce(new Error("Sidecar offline"));

    render(<AdminModelsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(
        screen.getByText("Failed to load capabilities"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Sidecar offline")).toBeInTheDocument();
  });
});
