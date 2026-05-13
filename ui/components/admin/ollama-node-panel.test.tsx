import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const fetchJsonMock = vi.fn();
const showToastMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}));
vi.mock("@/components/toast", () => ({
  showToast: (...args: unknown[]) => showToastMock(...args),
}));

import { OllamaNodePanel } from "./ollama-node-panel";

const renderPanel = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = "OllamaNodePanelTestWrapper";
  return render(<OllamaNodePanel />, { wrapper: Wrapper });
};

beforeEach(() => {
  fetchJsonMock.mockReset();
  showToastMock.mockReset();
  fetchJsonMock.mockImplementation((url: string) => {
    if (url === "/api/admin/local-llm/ollama/config") {
      return Promise.resolve({
        mode: "local",
        localUrl: "http://127.0.0.1:11434",
        networkNodeUrl: "",
        networkNodeToken: "",
        hasToken: false,
      });
    }
    if (url === "/api/system/platform") {
      return Promise.resolve({
        platform: { gpuKind: "apple-silicon" },
      });
    }
    return Promise.resolve({});
  });
});

describe("OllamaNodePanel (#1077-B)", () => {
  it("renders mode toggle + local URL input by default", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("ollama-node-panel")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("ollama-mode-local")).toBeInTheDocument();
    expect(screen.getByTestId("ollama-mode-network")).toBeInTheDocument();
    expect(screen.getByLabelText("Local URL")).toHaveValue(
      "http://127.0.0.1:11434",
    );
  });

  it("shows the Apple Silicon tip banner when gpuKind=apple-silicon", async () => {
    renderPanel();
    await waitFor(() =>
      expect(
        screen.getByTestId("ollama-apple-silicon-tip"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("ollama-apple-silicon-tip")).toHaveTextContent(
      /36 GB/,
    );
  });

  it("switches to network-mode inputs when toggling", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("ollama-mode-network")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("ollama-mode-network"));
    expect(screen.getByLabelText("Network Node URL")).toBeInTheDocument();
    expect(screen.getByLabelText(/Bearer Token/)).toBeInTheDocument();
  });

  it("renders ✅ Ollama version + model count on successful test", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("ollama-test-connection")).toBeInTheDocument(),
    );
    fetchJsonMock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        version: "0.4.2",
        models: ["gemma4:31b", "llama3.1:8b"],
        modelCount: 2,
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("ollama-test-connection"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("ollama-test-result")).toHaveTextContent(
        /✅ Ollama 0\.4\.2 · 2 models/,
      ),
    );
  });

  it("renders ❌ error on failed test connection", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("ollama-test-connection")).toBeInTheDocument(),
    );
    fetchJsonMock.mockImplementationOnce(() =>
      Promise.resolve({ ok: false, error: "ECONNREFUSED" }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("ollama-test-connection"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("ollama-test-result")).toHaveTextContent(
        /❌ ECONNREFUSED/,
      ),
    );
  });

  it("PUTs the saved config on Save (network mode)", async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("ollama-mode-network")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("ollama-mode-network"));
    fireEvent.change(screen.getByLabelText("Network Node URL"), {
      target: { value: "http://192.168.1.50:11434" },
    });
    fireEvent.click(screen.getByTestId("ollama-save"));
    await waitFor(() => {
      const putCall = (
        fetchJsonMock.mock.calls as Array<[string, RequestInit]>
      ).find(
        ([url, init]) =>
          url === "/api/admin/local-llm/ollama/config" &&
          init?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      expect(JSON.parse(String(putCall![1].body))).toMatchObject({
        mode: "network",
        networkNodeUrl: "http://192.168.1.50:11434",
      });
    });
  });

  it("does not show Apple Silicon tip on non-Apple hosts", async () => {
    fetchJsonMock.mockImplementation((url: string) => {
      if (url === "/api/admin/local-llm/ollama/config") {
        return Promise.resolve({
          mode: "local",
          localUrl: "http://127.0.0.1:11434",
          networkNodeUrl: "",
          networkNodeToken: "",
          hasToken: false,
        });
      }
      if (url === "/api/system/platform") {
        return Promise.resolve({ platform: { gpuKind: "nvidia" } });
      }
      return Promise.resolve({});
    });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("ollama-node-panel")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("ollama-apple-silicon-tip"),
    ).not.toBeInTheDocument();
  });
});
