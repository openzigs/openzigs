import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const fetchJsonMock = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}));

import { SystemRequirementsCard } from "./system-requirements-card";

const sample = {
  platform: {
    os: "macos",
    arch: "arm64",
    chip: "Apple M4 Max",
    gpuKind: "apple-silicon",
    recommendedBackend: "ollama-mlx",
  },
  recommended: {
    modelId: "gemma4:31b",
    quantisation: "Q4_K_M",
    rationale: "Apple Silicon w/ unified memory ≥ 64 GB.",
    minMemoryBytes: 32 * 1024 * 1024 * 1024,
  },
  memoryGb: 64,
  unifiedMemoryGb: 64,
  largestGpuVramGb: null,
};

describe("SystemRequirementsCard", () => {
  beforeEach(() => fetchJsonMock.mockReset());

  it("renders detected hardware + recommendation", async () => {
    fetchJsonMock.mockResolvedValueOnce(sample);
    render(<SystemRequirementsCard />);
    await waitFor(() => {
      expect(screen.getByText("gemma4:31b")).toBeInTheDocument();
    });
    expect(screen.getByText(/Apple Silicon GPU \(Metal\)/)).toBeInTheDocument();
    expect(screen.queryByText(/VRAM/)).not.toBeInTheDocument();
    expect(screen.getByText("Unified Memory")).toBeInTheDocument();
    expect(screen.queryByText(/^Memory$/)).not.toBeInTheDocument();
    expect(screen.getByText("ollama-mlx")).toBeInTheDocument();
    expect(screen.getAllByText(/64 GB/).length).toBeGreaterThan(0);
  });

  it("uses 'Memory' label and renders VRAM on non-Mac hosts", async () => {
    const linuxSample = {
      ...sample,
      platform: {
        os: "linux",
        arch: "x64",
        chip: null,
        gpuKind: "nvidia",
        recommendedBackend: "ollama",
      },
      largestGpuVramGb: 24,
    };
    fetchJsonMock.mockResolvedValueOnce(linuxSample);
    render(<SystemRequirementsCard />);
    await waitFor(() => {
      expect(screen.getByText(/^Memory$/)).toBeInTheDocument();
    });
    expect(screen.queryByText("Unified Memory")).not.toBeInTheDocument();
    expect(screen.getByText(/24 GB VRAM/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Apple Silicon GPU \(Metal\)/),
    ).not.toBeInTheDocument();
  });

  it("warns when memory is below recommended", async () => {
    fetchJsonMock.mockResolvedValueOnce({ ...sample, memoryGb: 8 });
    render(<SystemRequirementsCard />);
    await waitFor(() => {
      expect(screen.getByText(/underprovisioned/)).toBeInTheDocument();
    });
  });

  it("renders error state on fetch failure", async () => {
    fetchJsonMock.mockRejectedValueOnce(new Error("boom"));
    render(<SystemRequirementsCard />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load/)).toBeInTheDocument();
    });
  });

  it("links to offline setup wizard", async () => {
    fetchJsonMock.mockResolvedValueOnce(sample);
    render(<SystemRequirementsCard />);
    await waitFor(() => {
      const link = screen.getByText(/offline setup wizard/i).closest("a");
      expect(link).toHaveAttribute("href", "/setup/offline");
    });
  });
});
