import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { extractErrorMessage, VllmPanel } from "./vllm-panel";

vi.mock("@/lib/api", () => ({
  fetchJson: vi.fn(() => Promise.resolve({})),
}));

vi.mock("@/components/toast", () => ({
  showToast: vi.fn(),
}));

describe("extractErrorMessage (vLLM panel)", () => {
  it("unwraps `message` from a JSON error envelope", () => {
    const err = new Error(
      JSON.stringify({
        error: "rate_limited",
        message: "vLLM start is rate-limited; try again in 15s",
      }),
    );
    expect(extractErrorMessage(err)).toBe(
      "vLLM start is rate-limited; try again in 15s",
    );
  });

  it("falls back to raw message when JSON has no `message` field", () => {
    const err = new Error(JSON.stringify({ error: "rate_limited" }));
    expect(extractErrorMessage(err)).toBe('{"error":"rate_limited"}');
  });

  it("returns the raw message for plain-text errors", () => {
    const err = new Error("Network timeout");
    expect(extractErrorMessage(err)).toBe("Network timeout");
  });

  it("returns the raw message for malformed JSON", () => {
    const err = new Error("{not really json");
    expect(extractErrorMessage(err)).toBe("{not really json");
  });

  it("ignores `message` if it is not a string", () => {
    const err = new Error(JSON.stringify({ message: 42 }));
    expect(extractErrorMessage(err)).toBe('{"message":42}');
  });

  it("handles non-Error inputs", () => {
    expect(extractErrorMessage("oops")).toBe("oops");
    expect(extractErrorMessage(null)).toBe("null");
  });

  it("handles empty error message", () => {
    expect(extractErrorMessage(new Error(""))).toBe("Unknown error");
  });
});

// Bug #1077-A2: VllmPanel must short-circuit on Apple Silicon. Status
// polling is disabled and the model picker / Start button are replaced
// with the same "⛔ unsupported" notice the wizard renders.
describe("VllmPanel render — vLLM unsupported state", () => {
  const renderWithPlatform = (platform: {
    vllmSupported: boolean;
    vllmUnsupportedReason: string | null;
  }) => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    qc.setQueryData(["system", "platform"], platform);
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    Wrapper.displayName = "VllmPanelTestWrapper";
    return render(<VllmPanel />, { wrapper: Wrapper });
  };

  it("renders the unsupported notice with the platform reason on Apple Silicon", () => {
    renderWithPlatform({
      vllmSupported: false,
      vllmUnsupportedReason:
        "vLLM is not supported on Apple Silicon — use Ollama + MLX instead.",
    });
    const notice = screen.getByTestId("vllm-panel-unsupported-notice");
    expect(notice).toHaveTextContent(/⛔/);
    expect(notice).toHaveTextContent(/Apple Silicon/);
    expect(notice).toHaveTextContent(/Ollama \+ MLX/);
    // Model picker + Start button must NOT render.
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /start vllm/i }),
    ).not.toBeInTheDocument();
  });

  it("does not render the unsupported notice on supported hosts", () => {
    renderWithPlatform({
      vllmSupported: true,
      vllmUnsupportedReason: null,
    });
    expect(
      screen.queryByTestId("vllm-panel-unsupported-notice"),
    ).not.toBeInTheDocument();
  });
});
