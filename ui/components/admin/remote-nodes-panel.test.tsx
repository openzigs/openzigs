import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RemoteNodesPanel } from "./remote-nodes-panel";

vi.mock("@/lib/api", () => ({
  fetchJson: vi.fn(),
}));

vi.mock("@/components/toast", () => ({
  showToast: vi.fn(),
}));

import { fetchJson } from "@/lib/api";

const mockedFetch = fetchJson as unknown as ReturnType<typeof vi.fn>;

const buildNodes = () => ({
  nodes: [
    {
      nodeType: "image-gen",
      url: null,
      hasToken: false,
      allowLan: false,
      defaultPort: 5005,
      envVar: "OPENZIGS_IMAGE_NODE_URL",
    },
    {
      nodeType: "video-gen",
      url: "https://video.example.com",
      hasToken: true,
      allowLan: false,
      defaultPort: 5007,
      envVar: "OPENZIGS_VIDEO_NODE_URL",
    },
    {
      nodeType: "music-gen",
      url: null,
      hasToken: false,
      allowLan: false,
      defaultPort: 5009,
      envVar: null,
    },
    {
      nodeType: "rvc",
      url: null,
      hasToken: false,
      allowLan: false,
      defaultPort: 5010,
      envVar: null,
    },
    {
      nodeType: "lip-sync",
      url: null,
      hasToken: false,
      allowLan: false,
      defaultPort: 5010,
      envVar: null,
    },
  ],
});

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

describe("RemoteNodesPanel", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it("renders all configured node cards", async () => {
    mockedFetch.mockResolvedValueOnce(buildNodes());
    wrap(<RemoteNodesPanel />);
    await waitFor(() => {
      expect(screen.getByText("Image Generation")).toBeInTheDocument();
    });
    expect(screen.getByText("Video Generation")).toBeInTheDocument();
    expect(screen.getByText("Music Generation")).toBeInTheDocument();
    expect(screen.getByText("RVC Voice Conversion")).toBeInTheDocument();
    expect(screen.getByText("Lip Sync")).toBeInTheDocument();
  });

  it("shows configured marker for nodes with tokens", async () => {
    mockedFetch.mockResolvedValueOnce(buildNodes());
    wrap(<RemoteNodesPanel />);
    await waitFor(() => {
      expect(screen.getByText("(configured)")).toBeInTheDocument();
    });
  });

  it("shows error banner when query fails", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("boom"));
    wrap(<RemoteNodesPanel />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load/)).toBeInTheDocument();
    });
  });

  it("renders a Save button per node", async () => {
    mockedFetch.mockResolvedValueOnce(buildNodes());
    wrap(<RemoteNodesPanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Save").length).toBe(5);
    });
  });

  it("renders a Reset button only for configured nodes", async () => {
    mockedFetch.mockResolvedValueOnce(buildNodes());
    wrap(<RemoteNodesPanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Reset").length).toBe(1);
    });
  });

  it("toggles token visibility", async () => {
    mockedFetch.mockResolvedValueOnce(buildNodes());
    wrap(<RemoteNodesPanel />);
    await waitFor(() => {
      expect(screen.getAllByLabelText("Show token").length).toBe(5);
    });
    fireEvent.click(screen.getAllByLabelText("Show token")[0]);
    expect(screen.getAllByLabelText("Hide token").length).toBeGreaterThan(0);
  });
});
