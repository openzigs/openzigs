import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { GenerateAllImagesButton } from "./generate-all-images-button";

type Handler = (...args: unknown[]) => void;

const handlers: Record<string, Handler[]> = {};
const mockSocket = {
  on: vi.fn((evt: string, h: Handler) => {
    handlers[evt] ??= [];
    handlers[evt].push(h);
  }),
  off: vi.fn((evt: string, h: Handler) => {
    handlers[evt] = (handlers[evt] ?? []).filter((x) => x !== h);
  }),
  emit: vi.fn(),
};

vi.mock("@/lib/socket-context", () => ({
  useSocket: () => ({ socket: mockSocket, connected: true }),
}));

const fetchJsonMock = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}));

function fire(evt: string, payload: unknown) {
  for (const h of handlers[evt] ?? []) h(payload);
}

describe("GenerateAllImagesButton", () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) handlers[k] = [];
    fetchJsonMock.mockReset();
    mockSocket.on.mockClear();
    mockSocket.off.mockClear();
  });

  it("renders idle label by default", () => {
    render(<GenerateAllImagesButton deckId="d1" />);
    expect(
      screen.getByTestId("pitch-editor-generate-all-images"),
    ).toHaveAttribute("data-state", "idle");
    expect(screen.getByText(/Generate all images/i)).toBeInTheDocument();
  });

  it("calls the generate-all endpoint on click and shows progress", async () => {
    fetchJsonMock.mockResolvedValue({ enqueued: 3, skipped: 0, total: 3 });
    render(<GenerateAllImagesButton deckId="d1" />);
    fireEvent.click(screen.getByTestId("pitch-editor-generate-all-images"));
    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalled());
    expect(fetchJsonMock).toHaveBeenCalledWith(
      "/api/admin/pitch/decks/d1/images/generate-all",
      { method: "POST", body: JSON.stringify({}) },
    );
    await waitFor(() => {
      const btn = screen.getByTestId("pitch-editor-generate-all-images");
      expect(btn).toHaveAttribute("data-state", "in_progress");
      expect(btn.textContent).toContain("0 / 3");
    });
    expect(
      screen.getByTestId("pitch-editor-generate-all-images"),
    ).toBeDisabled();
  });

  it("updates count as ready/failed events arrive and toasts on completion", async () => {
    fetchJsonMock.mockResolvedValue({ enqueued: 2, skipped: 0, total: 2 });
    const toast = vi.fn();
    render(<GenerateAllImagesButton deckId="d1" onShowToast={toast} />);
    fireEvent.click(screen.getByTestId("pitch-editor-generate-all-images"));
    await waitFor(() =>
      expect(
        screen.getByTestId("pitch-editor-generate-all-images").textContent,
      ).toContain("0 / 2"),
    );
    act(() => {
      fire("pitch:image:ready", { deckId: "d1", slideId: "s1", slot: "bg" });
    });
    expect(
      screen.getByTestId("pitch-editor-generate-all-images").textContent,
    ).toContain("1 / 2");
    act(() => {
      fire("pitch:image:ready", { deckId: "d1", slideId: "s2", slot: "bg" });
    });
    const btn = screen.getByTestId("pitch-editor-generate-all-images");
    expect(btn).toHaveAttribute("data-state", "done");
    expect(toast).toHaveBeenCalledWith("All images generated", "success");
  });

  it("toasts an error when one or more slots fail", async () => {
    fetchJsonMock.mockResolvedValue({ enqueued: 2, skipped: 0, total: 2 });
    const toast = vi.fn();
    render(<GenerateAllImagesButton deckId="d1" onShowToast={toast} />);
    fireEvent.click(screen.getByTestId("pitch-editor-generate-all-images"));
    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalled());
    act(() => {
      fire("pitch:image:ready", { deckId: "d1", slideId: "s1", slot: "bg" });
      fire("pitch:image:failed", { deckId: "d1", slideId: "s2", slot: "bg" });
    });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.stringContaining("1 failed"),
        "error",
      ),
    );
  });

  it("flips immediately to done with a toast when nothing was enqueued", async () => {
    fetchJsonMock.mockResolvedValue({ enqueued: 0, skipped: 4, total: 4 });
    const toast = vi.fn();
    render(<GenerateAllImagesButton deckId="d1" onShowToast={toast} />);
    fireEvent.click(screen.getByTestId("pitch-editor-generate-all-images"));
    await waitFor(() =>
      expect(
        screen.getByTestId("pitch-editor-generate-all-images"),
      ).toHaveAttribute("data-state", "done"),
    );
    expect(toast).toHaveBeenCalledWith("Nothing to generate", "success");
  });

  it("returns to idle and toasts an error when the request fails", async () => {
    fetchJsonMock.mockRejectedValue(new Error("boom"));
    const toast = vi.fn();
    render(<GenerateAllImagesButton deckId="d1" onShowToast={toast} />);
    fireEvent.click(screen.getByTestId("pitch-editor-generate-all-images"));
    await waitFor(() =>
      expect(
        screen.getByTestId("pitch-editor-generate-all-images"),
      ).toHaveAttribute("data-state", "idle"),
    );
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining("Generate failed"),
      "error",
    );
  });

  it("respects the disabled prop", () => {
    render(<GenerateAllImagesButton deckId="d1" disabled />);
    expect(
      screen.getByTestId("pitch-editor-generate-all-images"),
    ).toBeDisabled();
  });

  it("transitions to an error state when failed jobs are reported (post-#1017 walkthrough fix)", async () => {
    fetchJsonMock.mockResolvedValue({ enqueued: 3, skipped: 0, total: 3 });
    const toast = vi.fn();
    render(<GenerateAllImagesButton deckId="d1" onShowToast={toast} />);
    fireEvent.click(screen.getByTestId("pitch-editor-generate-all-images"));
    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalled());

    // Simulate every enqueued slot landing in the `failed` bucket
    // (e.g. all three jobs OOM-killed after retries are exhausted).
    act(() => {
      fire("pitch:image:failed", {
        deckId: "d1",
        slideId: "s1",
        slot: "background",
        error: "CUDA out of memory",
      });
      fire("pitch:image:failed", {
        deckId: "d1",
        slideId: "s2",
        slot: "background",
        error: "CUDA out of memory",
      });
      fire("pitch:image:failed", {
        deckId: "d1",
        slideId: "s3",
        slot: "background",
        error: "CUDA out of memory",
      });
    });

    const btn = await waitFor(() => {
      const b = screen.getByTestId("pitch-editor-generate-all-images");
      expect(b).toHaveAttribute("data-state", "error");
      return b;
    });

    // Button is re-enabled so the user can click to retry.
    expect(btn).not.toBeDisabled();
    expect(btn.textContent).toContain("Retry failed (3)");

    // Inline aria-live message surfaces the failure reason.
    const inline = screen.getByTestId(
      "pitch-editor-generate-all-images-error",
    );
    expect(inline).toHaveAttribute("role", "status");
    expect(inline.textContent).toContain("3 of 3");
    expect(inline.textContent).toContain("failed");

    // Failure toast fires exactly once.
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining("3 failed"),
      "error",
    );
  });

  it("clicking the button while in error state retries the fan-out", async () => {
    fetchJsonMock
      .mockResolvedValueOnce({ enqueued: 1, skipped: 0, total: 1 })
      .mockResolvedValueOnce({ enqueued: 1, skipped: 0, total: 1 });
    render(<GenerateAllImagesButton deckId="d1" />);
    fireEvent.click(screen.getByTestId("pitch-editor-generate-all-images"));
    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledTimes(1));
    act(() => {
      fire("pitch:image:failed", {
        deckId: "d1",
        slideId: "s1",
        slot: "background",
        error: "OOM",
      });
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("pitch-editor-generate-all-images"),
      ).toHaveAttribute("data-state", "error"),
    );
    fireEvent.click(screen.getByTestId("pitch-editor-generate-all-images"));
    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledTimes(2));
    expect(
      screen.getByTestId("pitch-editor-generate-all-images"),
    ).toHaveAttribute("data-state", "in_progress");
  });
});
