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
      cfAccessClientId: "abc.access",
      hasCfAccessClientSecret: true,
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
      expect(screen.getAllByText("(configured)").length).toBeGreaterThan(0);
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

  it("renders CF Access service-token inputs per node (#1099)", async () => {
    mockedFetch.mockResolvedValueOnce(buildNodes());
    wrap(<RemoteNodesPanel />);
    await waitFor(() => {
      expect(screen.getAllByText("CF-Access-Client-Id").length).toBe(5);
    });
    expect(screen.getAllByText("CF-Access-Client-Secret").length).toBe(5);
  });

  it("hydrates CF Access Client ID from existing config (#1099)", async () => {
    mockedFetch.mockResolvedValueOnce(buildNodes());
    wrap(<RemoteNodesPanel />);
    await waitFor(() => {
      const idInputs = screen.getAllByPlaceholderText(
        "abc123.access",
      ) as HTMLInputElement[];
      expect(idInputs.find((i) => i.value === "abc.access")).toBeDefined();
    });
  });

  it("masks the CF Access secret with a placeholder when configured (#1099)", async () => {
    mockedFetch.mockResolvedValueOnce(buildNodes());
    wrap(<RemoteNodesPanel />);
    await waitFor(() => {
      const secretInputs = screen.getAllByPlaceholderText(
        /Service token secret|••••••••/,
      ) as HTMLInputElement[];
      expect(
        secretInputs.find((i) => i.placeholder === "••••••••"),
      ).toBeDefined();
      // Value never echoed back
      secretInputs.forEach((i) => expect(i.value).toBe(""));
    });
  });

  it("uses password-style CF Access Client ID inputs with a visibility toggle (#1099)", async () => {
    mockedFetch.mockResolvedValueOnce(buildNodes());
    wrap(<RemoteNodesPanel />);
    await waitFor(() => {
      expect(screen.getAllByLabelText("Show CF Access client ID").length).toBe(
        5,
      );
    });
    const idInputs = screen.getAllByPlaceholderText(
      "abc123.access",
    ) as HTMLInputElement[];
    expect(idInputs.every((input) => input.type === "password")).toBe(true);

    fireEvent.click(screen.getAllByLabelText("Show CF Access client ID")[0]);
    expect(idInputs[0].type).toBe("text");
    expect(screen.getAllByLabelText("Hide CF Access client ID").length).toBe(1);
  });

  it("submits CF Access fields in the save body (#1099)", async () => {
    mockedFetch.mockResolvedValueOnce(buildNodes());
    mockedFetch.mockResolvedValueOnce({ ok: true });
    mockedFetch.mockResolvedValueOnce(buildNodes());
    wrap(<RemoteNodesPanel />);
    await waitFor(() => {
      expect(screen.getByText("Image Generation")).toBeInTheDocument();
    });

    const urlInputs = screen.getAllByPlaceholderText(
      /https:\/\/.+\.example\.com/,
    ) as HTMLInputElement[];
    const imageUrlInput = urlInputs.find(
      (i) => i.placeholder === "https://image-gen.example.com",
    )!;
    fireEvent.change(imageUrlInput, {
      target: { value: "https://img.example.com" },
    });

    const idInputs = screen.getAllByPlaceholderText(
      "abc123.access",
    ) as HTMLInputElement[];
    fireEvent.change(idInputs[0], { target: { value: "my-cf-id" } });

    const secretInputs = screen.getAllByPlaceholderText(
      "Service token secret",
    ) as HTMLInputElement[];
    fireEvent.change(secretInputs[0], { target: { value: "my-cf-secret" } });

    fireEvent.click(screen.getAllByText("Save")[0]);

    await waitFor(() => {
      const putCall = mockedFetch.mock.calls.find(
        ([url, init]) =>
          url === "/api/admin/remote-nodes/image-gen" &&
          (init as RequestInit)?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.cfAccessClientId).toBe("my-cf-id");
      expect(body.cfAccessClientSecret).toBe("my-cf-secret");
    });
  });

  it("clears CF Access Client ID by sending empty string (#1099)", async () => {
    mockedFetch.mockResolvedValueOnce(buildNodes());
    mockedFetch.mockResolvedValueOnce({ ok: true });
    mockedFetch.mockResolvedValueOnce(buildNodes());
    wrap(<RemoteNodesPanel />);
    await waitFor(() => {
      expect(screen.getByText("Video Generation")).toBeInTheDocument();
    });

    const idInputs = screen.getAllByPlaceholderText(
      "abc123.access",
    ) as HTMLInputElement[];
    const videoIdInput = idInputs.find((i) => i.value === "abc.access")!;
    fireEvent.change(videoIdInput, { target: { value: "" } });

    fireEvent.click(screen.getAllByText("Save")[1]);

    await waitFor(() => {
      const putCall = mockedFetch.mock.calls.find(
        ([url, init]) =>
          url === "/api/admin/remote-nodes/video-gen" &&
          (init as RequestInit)?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.cfAccessClientId).toBe("");
    });
  });

  it("clears a configured CF Access secret by sending empty string (#1099)", async () => {
    mockedFetch.mockResolvedValueOnce(buildNodes());
    mockedFetch.mockResolvedValueOnce({ ok: true });
    mockedFetch.mockResolvedValueOnce(buildNodes());
    wrap(<RemoteNodesPanel />);
    await waitFor(() => {
      expect(screen.getByText("Video Generation")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Clear CF Access secret"));
    fireEvent.click(screen.getAllByText("Save")[1]);

    await waitFor(() => {
      const putCall = mockedFetch.mock.calls.find(
        ([url, init]) =>
          url === "/api/admin/remote-nodes/video-gen" &&
          (init as RequestInit)?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.cfAccessClientSecret).toBe("");
    });
  });
});
