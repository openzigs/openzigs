/// <reference types="vitest/globals" />
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockFetchJson = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

vi.mock("@/components/toast", () => ({
  showToast: vi.fn(),
}));

const mockSocket = {
  on: vi.fn(),
  off: vi.fn(),
};
vi.mock("@/lib/socket-context", () => ({
  useSocket: () => ({ socket: mockSocket }),
}));

import {
  GpuDispatcherCard,
  GpuDispatcherSection,
  type DispatcherLaneSnapshot,
} from "./gpu-dispatcher-card";

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

const idleLane: DispatcherLaneSnapshot = {
  index: 0,
  state: "idle",
  queueDepth: 0,
};

const busyLane: DispatcherLaneSnapshot = {
  index: 1,
  state: "busy",
  queueDepth: 2,
  currentJob: {
    id: "abcdef1234567890",
    workloadType: "video",
    startedAt: Date.now() - 5000,
  },
};

const errorLane: DispatcherLaneSnapshot = {
  index: 1,
  state: "error",
  queueDepth: 0,
  lastError: "CUDA OOM at U-Net forward",
};

const blockedLane: DispatcherLaneSnapshot = {
  index: 0,
  state: "idle",
  queueDepth: 1,
  mutexBlockedBy: "video",
};

describe("GpuDispatcherSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders an empty-state hint when no dispatcher state is provided", () => {
    render(<GpuDispatcherSection />, { wrapper });
    expect(screen.getByTestId("gpu-dispatcher-empty")).toBeInTheDocument();
    expect(
      screen.getByText(/dispatcher is not active on this host/i),
    ).toBeInTheDocument();
  });

  it("renders an empty-state hint when lanes is an empty array", () => {
    render(<GpuDispatcherSection lanes={[]} />, { wrapper });
    expect(screen.getByTestId("gpu-dispatcher-empty")).toBeInTheDocument();
  });

  it("renders one card per lane in single-GPU mode", () => {
    render(<GpuDispatcherSection lanes={[idleLane]} />, { wrapper });
    expect(screen.getByTestId("gpu-dispatcher-card-0")).toBeInTheDocument();
    expect(screen.queryByTestId("gpu-dispatcher-card-1")).toBeNull();
  });

  it("renders both cards in dual-GPU mode", () => {
    render(<GpuDispatcherSection lanes={[idleLane, busyLane]} />, { wrapper });
    expect(screen.getByTestId("gpu-dispatcher-card-0")).toBeInTheDocument();
    expect(screen.getByTestId("gpu-dispatcher-card-1")).toBeInTheDocument();
  });
});

describe("GpuDispatcherCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows 'idle' badge and 'Available' label for an idle lane", () => {
    render(<GpuDispatcherCard initial={idleLane} />, { wrapper });
    expect(screen.getByTestId("gpu-dispatcher-state-0")).toHaveTextContent(
      "idle",
    );
    expect(screen.getByText("Available")).toBeInTheDocument();
  });

  it("shows the running workload and a Cancel button on a busy lane", () => {
    render(<GpuDispatcherCard initial={busyLane} />, { wrapper });
    expect(screen.getByTestId("gpu-dispatcher-state-1")).toHaveTextContent(
      "busy",
    );
    expect(screen.getByText(/Running/)).toBeInTheDocument();
    expect(screen.getByText(/Video/)).toBeInTheDocument();
    expect(screen.getByTestId("gpu-dispatcher-cancel-1")).toBeInTheDocument();
  });

  it("renders the mutex-blocked indicator when mutexBlockedBy is set", () => {
    render(<GpuDispatcherCard initial={blockedLane} />, { wrapper });
    expect(screen.getByTestId("gpu-dispatcher-mutex-0")).toHaveTextContent(
      /Video render running on another GPU/,
    );
  });

  it("renders the lastError message and a Retry button on an error lane", () => {
    render(<GpuDispatcherCard initial={errorLane} />, { wrapper });
    expect(screen.getByTestId("gpu-dispatcher-state-1")).toHaveTextContent(
      "error",
    );
    expect(screen.getByTestId("gpu-dispatcher-error-1")).toHaveTextContent(
      "CUDA OOM at U-Net forward",
    );
    expect(screen.getByTestId("gpu-dispatcher-retry-1")).toBeInTheDocument();
  });

  it("calls cancel endpoint after confirm dialog", async () => {
    mockFetchJson.mockResolvedValue({ cancelled: true });

    render(<GpuDispatcherCard initial={busyLane} />, { wrapper });
    fireEvent.click(screen.getByTestId("gpu-dispatcher-cancel-1"));
    fireEvent.click(
      await screen.findByTestId("gpu-dispatcher-cancel-confirm-1"),
    );

    await waitFor(() => {
      expect(mockFetchJson).toHaveBeenCalledWith(
        "/api/admin/gpu/dispatcher/1/cancel",
        { method: "POST" },
      );
    });
  });

  it("does NOT call cancel endpoint when user dismisses confirm dialog", async () => {
    render(<GpuDispatcherCard initial={busyLane} />, { wrapper });
    fireEvent.click(screen.getByTestId("gpu-dispatcher-cancel-1"));
    fireEvent.click(await screen.findByRole("button", { name: /keep running/i }));
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it("calls clear-error endpoint when Retry is clicked", async () => {
    mockFetchJson.mockResolvedValue({ cleared: true });
    render(<GpuDispatcherCard initial={errorLane} />, { wrapper });
    fireEvent.click(screen.getByTestId("gpu-dispatcher-retry-1"));

    await waitFor(() => {
      expect(mockFetchJson).toHaveBeenCalledWith(
        "/api/admin/gpu/dispatcher/1/clear-error",
        { method: "POST" },
      );
    });
  });

  it("subscribes and unsubscribes from the gpu:dispatcher:state socket event", () => {
    const { unmount } = render(<GpuDispatcherCard initial={idleLane} />, {
      wrapper,
    });
    expect(mockSocket.on).toHaveBeenCalledWith(
      "gpu:dispatcher:state",
      expect.any(Function),
    );
    unmount();
    expect(mockSocket.off).toHaveBeenCalledWith(
      "gpu:dispatcher:state",
      expect.any(Function),
    );
  });
});
