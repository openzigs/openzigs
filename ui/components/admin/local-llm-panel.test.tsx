import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
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

beforeEach(() => {
  fetchJsonMock.mockReset();
  showToastMock.mockReset();
  // jsdom localStorage starts clean per test.
  window.localStorage.clear();
  // Default: status endpoint always returns baseStatus; everything else
  // resolves to {} unless an individual test overrides per-URL.
  fetchJsonMock.mockImplementation((url: string) => {
    if (url === "/api/admin/local-llm/status") return Promise.resolve(baseStatus);
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
      health: { ...baseStatus.health, status: "failed-over", failoverActive: true },
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
      expect.stringContaining("Detected at"),
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
    await waitFor(() => {
      expect(fetchJsonMock).toHaveBeenCalledWith(
        "/api/admin/local-llm/provider",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  it("does not clear provider when user cancels confirm", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /clear provider/i }));
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
        url === "/api/admin/local-llm/privacy/global" && init?.method === "POST",
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse(String(postCall![1].body))).toEqual({ globalLockdown: true });
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
    await waitFor(() => {
      expect(screen.getByText("ROTATED_KEY_PLAINTEXT_xxx")).toBeInTheDocument();
    });
    // Hide button restores the masked state.
    fireEvent.click(screen.getByRole("button", { name: /hide/i }));
    expect(screen.queryByText("ROTATED_KEY_PLAINTEXT_xxx")).not.toBeInTheDocument();
  });

  it("shows masked key when one is stored and not yet revealed", () => {
    renderPanel({
      ...baseStatus,
      vllmKey: { masked: "ABC…xyz", present: true },
    });
    expect(screen.getByText("ABC…xyz")).toBeInTheDocument();
  });
});
