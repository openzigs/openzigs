import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Mock shadcn/Radix Select primitives so SelectItem renders inline (Radix
// only mounts items when the popover opens; jsdom + pointer events are
// flaky). Passing through `disabled` + `data-testid` lets us assert the
// vLLM-disabled affordance directly.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({
    children,
    ...props
  }: { children: ReactNode } & Record<string, unknown>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    children,
    value,
    disabled,
    ...props
  }: {
    children: ReactNode;
    value: string;
    disabled?: boolean;
  } & Record<string, unknown>) => (
    <div
      role="option"
      data-value={value}
      aria-disabled={disabled ? "true" : undefined}
      {...props}
    >
      {children}
    </div>
  ),
}));

import { LocalLlmPanel } from "./local-llm-panel";

// Mock the api module so we can intercept fetchJson cleanly.
const fetchJsonMock = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}));

// Mock toast to silence + assert.
const showToastMock = vi.fn();
vi.mock("@/components/toast", () => ({
  showToast: (...args: unknown[]) => showToastMock(...args),
}));

interface StatusPayload {
  provider: {
    type: "local-copilot";
    endpoint: string;
    model: string;
    timeoutMs?: number;
    hasApiKey: boolean;
  } | null;
  privacyMode: { globalLockdown: boolean };
  health: {
    status: "healthy" | "degraded" | "failed-over" | "disabled";
    lastProbeAt: string | null;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    failoverActive: boolean;
  };
  vllmKey: { masked: string | null; present: boolean };
}

const baseStatus: StatusPayload = {
  provider: {
    type: "local-copilot",
    endpoint: "http://127.0.0.1:11434/v1",
    model: "gemma4:26b",
    hasApiKey: false,
  },
  privacyMode: { globalLockdown: false },
  health: {
    status: "healthy",
    lastProbeAt: "2026-02-09T12:00:00.000Z",
    consecutiveFailures: 0,
    consecutiveSuccesses: 5,
    failoverActive: false,
  },
  vllmKey: { masked: null, present: false },
};

const renderPanel = (status: StatusPayload = baseStatus) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["local-llm", "status"], status);
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = "LocalLlmPanelTestWrapper";
  return render(<LocalLlmPanel />, { wrapper: Wrapper });
};

const renderPanelWithPlatform = (
  platform: { vllmSupported: boolean; vllmUnsupportedReason: string | null },
  status: StatusPayload = baseStatus,
) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["local-llm", "status"], status);
  qc.setQueryData(["system", "platform"], platform);
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = "LocalLlmPanelPlatformWrapper";
  return render(<LocalLlmPanel />, { wrapper: Wrapper });
};

beforeEach(() => {
  fetchJsonMock.mockReset();
  showToastMock.mockReset();
  // jsdom localStorage starts clean per test.
  window.localStorage.clear();
  // Default: status endpoint always returns baseStatus; everything else
  // resolves to {} unless an individual test overrides per-URL.
  fetchJsonMock.mockImplementation((url: string) => {
    if (url === "/api/admin/local-llm/status")
      return Promise.resolve(baseStatus);
    if (url === "/api/admin/local-llm/router")
      return Promise.resolve({
        enabled: true,
        cloudThresholdTokens: 4096,
        thresholdStops: [256, 1024, 4096, 8192],
      });
    return Promise.resolve({});
  });
  // Mock window.confirm to return true unless overridden.
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LocalLlmPanel", () => {
  it("renders endpoint + model from current provider", () => {
    renderPanel();
    expect(screen.getByLabelText("Endpoint URL")).toHaveValue(
      "http://127.0.0.1:11434/v1",
    );
    expect(screen.getByLabelText("Model name")).toHaveValue("gemma4:26b");
  });

  it("shows healthy badge when health.status is healthy", () => {
    renderPanel();
    const badge = screen.getByTestId("health-badge");
    expect(badge).toHaveTextContent("Healthy");
    expect(badge.className).toMatch(/green/);
  });

  it("shows failed-over badge when failover is active", () => {
    renderPanel({
      ...baseStatus,
      health: {
        ...baseStatus.health,
        status: "failed-over",
        failoverActive: true,
      },
    });
    expect(screen.getByTestId("health-badge")).toHaveTextContent("Failed over");
  });

  it("hydrates form from autodetect on success", async () => {
    fetchJsonMock.mockImplementation((url: string) => {
      if (url === "/api/admin/local-llm/status")
        return Promise.resolve({ ...baseStatus, provider: null });
      if (url === "/api/admin/local-llm/autodetect")
        return Promise.resolve({
          ollama: {
            endpoint: "http://127.0.0.1:11434/v1",
            models: ["llama3.1:8b"],
            recommendedModel: "llama3.1:8b",
          },
          vllm: null,
        });
      return Promise.resolve({});
    });
    renderPanel({ ...baseStatus, provider: null });
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));
    await waitFor(() => {
      expect(screen.getByLabelText("Model name")).toHaveValue("llama3.1:8b");
    });
    expect(showToastMock).toHaveBeenCalledWith(
      expect.stringContaining("Connection OK"),
      "success",
    );
  });

  it("warns when autodetect finds nothing", async () => {
    fetchJsonMock.mockImplementation((url: string) => {
      if (url === "/api/admin/local-llm/status")
        return Promise.resolve({ ...baseStatus, provider: null });
      if (url === "/api/admin/local-llm/autodetect")
        return Promise.resolve({ ollama: null, vllm: null });
      return Promise.resolve({});
    });
    renderPanel({ ...baseStatus, provider: null });
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));
    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(
        expect.stringContaining("No local LLM detected"),
        "info",
      ),
    );
  });

  it("POSTs provider on save", async () => {
    renderPanel();
    // Mark form dirty.
    fireEvent.change(screen.getByLabelText("Model name"), {
      target: { value: "qwen2.5:14b" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save provider/i }));
    await waitFor(() => {
      expect(fetchJsonMock).toHaveBeenCalledWith(
        "/api/admin/local-llm/provider",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const postCall = (
      fetchJsonMock.mock.calls as Array<[string, RequestInit]>
    ).find(
      ([url, init]) =>
        url === "/api/admin/local-llm/provider" && init?.method === "POST",
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse(String(postCall![1].body))).toMatchObject({
      type: "local-copilot",
      endpoint: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:14b",
    });
  });

  it("DELETEs provider on clear (after confirm)", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /clear provider/i }));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(() => {
      expect(fetchJsonMock).toHaveBeenCalledWith(
        "/api/admin/local-llm/provider",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  it("does not clear provider when user cancels confirm", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /clear provider/i }));
    fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    expect(fetchJsonMock).not.toHaveBeenCalledWith(
      "/api/admin/local-llm/provider",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("persists per-session privacy choice to localStorage", () => {
    renderPanel();
    const checkbox = screen.getByLabelText(
      /per-session privacy mode/i,
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(window.localStorage.getItem("openzigs:privacy-mode")).toBe("true");
    expect(checkbox.checked).toBe(true);
  });

  it("hydrates per-session privacy from localStorage on mount", async () => {
    window.localStorage.setItem("openzigs:privacy-mode", "true");
    renderPanel();
    await waitFor(() => {
      const cb = screen.getByLabelText(
        /per-session privacy mode/i,
      ) as HTMLInputElement;
      expect(cb.checked).toBe(true);
    });
  });

  it("POSTs global lockdown toggle", async () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText("Global privacy lockdown"));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(() => {
      expect(fetchJsonMock).toHaveBeenCalledWith(
        "/api/admin/local-llm/privacy/global",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const postCall = (
      fetchJsonMock.mock.calls as Array<[string, RequestInit]>
    ).find(
      ([url, init]) =>
        url === "/api/admin/local-llm/privacy/global" &&
        init?.method === "POST",
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse(String(postCall![1].body))).toEqual({
      globalLockdown: true,
    });
  });

  it("reveals rotated vLLM key once and shows it inline", async () => {
    fetchJsonMock.mockImplementation((url: string) => {
      if (url === "/api/admin/local-llm/status")
        return Promise.resolve(baseStatus);
      if (url === "/api/admin/local-llm/vllm-key/rotate")
        return Promise.resolve({
          apiKey: "ROTATED_KEY_PLAINTEXT_xxx",
          masked: "ROT\u2026xxx",
        });
      return Promise.resolve({});
    });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /rotate key/i }));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(() => {
      expect(screen.getByText("ROTATED_KEY_PLAINTEXT_xxx")).toBeInTheDocument();
    });
    // Hide button restores the masked state.
    fireEvent.click(screen.getByRole("button", { name: /hide/i }));
    expect(
      screen.queryByText("ROTATED_KEY_PLAINTEXT_xxx"),
    ).not.toBeInTheDocument();
  });

  it("shows masked key when one is stored and not yet revealed", () => {
    renderPanel({
      ...baseStatus,
      vllmKey: { masked: "ABC…xyz", present: true },
    });
    expect(screen.getByText("ABC…xyz")).toBeInTheDocument();
  });

  describe("smart router section", () => {
    it("renders toggle in the configured state from GET /router", async () => {
      fetchJsonMock.mockImplementation((url: string) => {
        if (url === "/api/admin/local-llm/status")
          return Promise.resolve(baseStatus);
        if (url === "/api/admin/local-llm/router")
          return Promise.resolve({
            enabled: false,
            cloudThresholdTokens: 1024,
            thresholdStops: [256, 1024, 4096, 8192],
          });
        return Promise.resolve({});
      });
      renderPanel();
      await waitFor(() => {
        const toggle = screen.getByTestId(
          "smart-router-toggle",
        ) as HTMLInputElement;
        expect(toggle.checked).toBe(false);
      });
      expect(
        screen.getByTestId("smart-router-threshold-value"),
      ).toHaveTextContent("1024");
    });

    it("toggling the checkbox POSTs the new state preserving threshold", async () => {
      renderPanel();
      // Wait for router GET to settle so the toggle reflects defaults.
      await waitFor(() => {
        expect(screen.getByTestId("smart-router-toggle")).toBeInTheDocument();
      });
      const toggle = screen.getByTestId(
        "smart-router-toggle",
      ) as HTMLInputElement;
      // Initial state from default mock: enabled=true, threshold=4096.
      expect(toggle.checked).toBe(true);
      fireEvent.click(toggle);
      await waitFor(() => {
        const calls = fetchJsonMock.mock.calls as Array<[string, RequestInit]>;
        const postCall = calls.find(
          ([url, init]) =>
            url === "/api/admin/local-llm/router" && init?.method === "POST",
        );
        expect(postCall).toBeDefined();
        expect(JSON.parse(String(postCall![1].body))).toEqual({
          enabled: false,
          cloudThresholdTokens: 4096,
        });
      });
    });

    it("changing the slider POSTs the new threshold", async () => {
      renderPanel();
      await waitFor(() => {
        expect(
          screen.getByTestId("smart-router-threshold"),
        ).toBeInTheDocument();
      });
      const slider = screen.getByTestId(
        "smart-router-threshold",
      ) as HTMLInputElement;
      // Stops = [256, 1024, 4096, 8192]. Move slider to index 0 → 256.
      fireEvent.change(slider, { target: { value: "0" } });
      await waitFor(() => {
        const calls = fetchJsonMock.mock.calls as Array<[string, RequestInit]>;
        const postCall = calls.find(
          ([url, init]) =>
            url === "/api/admin/local-llm/router" && init?.method === "POST",
        );
        expect(postCall).toBeDefined();
        expect(JSON.parse(String(postCall![1].body))).toEqual({
          enabled: true,
          cloudThresholdTokens: 256,
        });
      });
    });
  });

  /**
   * Bug #1064-#7 / #10 regression guard.
   *
   * Symptom: clicking "Test connection" while `statusQuery.data` is still
   * undefined (no provider configured / first paint) triggered
   *   `TypeError: Cannot read properties of undefined (reading 'length')`
   * inside the `dirty` useMemo, crashing the panel into the Next.js error
   * overlay and unmounting it.
   *
   * Fix: defensively null-coalesce `endpoint`/`model`/`apiKey` in the
   * memo so a stray undefined from any upstream payload can never crash
   * the render.
   */
  describe("bug #1064-#7: undefined statusQuery.data must not crash on Test connection", () => {
    const renderPanelWithoutSeed = () => {
      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      // Intentionally do NOT seed the local-llm/status query — so
      // `statusQuery.data` is undefined on first render, exactly like a
      // fresh admin tab where no provider has been configured yet.
      const Wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      );
      Wrapper.displayName = "LocalLlmPanelNoSeedWrapper";
      return render(<LocalLlmPanel />, { wrapper: Wrapper });
    };

    it("renders without crashing when statusQuery.data is undefined", () => {
      // Make autodetect resolve to nothing so we can exercise the click
      // path without flake.
      fetchJsonMock.mockImplementation((url: string) => {
        if (url === "/api/admin/local-llm/autodetect")
          return Promise.resolve({ ollama: null, vllm: null });
        // Leave /status pending forever (never resolves) so data stays undefined.
        if (url === "/api/admin/local-llm/status") return new Promise(() => {});
        if (url === "/api/admin/local-llm/router") return new Promise(() => {});
        return Promise.resolve({});
      });
      // Should not throw during render.
      expect(() => renderPanelWithoutSeed()).not.toThrow();
      // The Test-connection button is reachable and not crashed away.
      expect(
        screen.getByRole("button", { name: /test connection/i }),
      ).toBeInTheDocument();
    });

    it("clicking Test connection while status is undefined does not crash and shows feedback", async () => {
      fetchJsonMock.mockImplementation((url: string) => {
        if (url === "/api/admin/local-llm/autodetect")
          return Promise.resolve({ ollama: null, vllm: null });
        if (url === "/api/admin/local-llm/status") return new Promise(() => {});
        if (url === "/api/admin/local-llm/router") return new Promise(() => {});
        return Promise.resolve({});
      });
      renderPanelWithoutSeed();
      const btn = screen.getByRole("button", { name: /test connection/i });
      // The actual regression: the click used to throw inside the dirty
      // useMemo when endpoint/model became undefined during the resulting
      // re-render. We assert click + post-click render are both crash-free.
      expect(() => fireEvent.click(btn)).not.toThrow();
      await waitFor(() => {
        expect(showToastMock).toHaveBeenCalledWith(
          expect.stringContaining("No local LLM detected"),
          "info",
        );
      });
      // Panel is still mounted (would have unmounted on crash).
      expect(
        screen.getByRole("button", { name: /test connection/i }),
      ).toBeInTheDocument();
    });
  });

  // Bug #1077-A1: admin combobox parity with the setup wizard. On Apple
  // Silicon (or any host where the platform endpoint reports
  // vllmSupported=false), the vLLM preset must be disabled and the reason
  // surfaced inline — same "label-don't-hide" UX the wizard uses.
  describe("vLLM unsupported state (admin parity bug #1077-A1)", () => {
    it("disables the vLLM preset and shows the unsupported reason on Apple Silicon", () => {
      renderPanelWithPlatform({
        vllmSupported: false,
        vllmUnsupportedReason:
          "vLLM is not supported on Apple Silicon — use Ollama + MLX instead.",
      });
      const vllmItem = screen.getByTestId("provider-preset-vllm");
      expect(vllmItem).toHaveAttribute("aria-disabled", "true");
      expect(vllmItem.textContent).toMatch(/⛔/);
      expect(vllmItem.textContent).toMatch(/Apple Silicon/);
      const notice = screen.getByTestId("vllm-unsupported-notice");
      expect(notice).toHaveTextContent(
        /vLLM is not supported on Apple Silicon/,
      );
    });

    it("leaves the vLLM preset enabled on supported hosts", () => {
      renderPanelWithPlatform({
        vllmSupported: true,
        vllmUnsupportedReason: null,
      });
      const vllmItem = screen.getByTestId("provider-preset-vllm");
      expect(vllmItem).not.toHaveAttribute("aria-disabled", "true");
      expect(vllmItem.textContent).not.toMatch(/⛔/);
      expect(
        screen.queryByTestId("vllm-unsupported-notice"),
      ).not.toBeInTheDocument();
    });
  });
});
