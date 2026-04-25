import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("@/lib/api", () => ({
  buildUrl: (p: string) => p,
  fetchJson: vi.fn(),
}));

vi.mock("@/components/toast", () => ({
  showToast: vi.fn(),
}));

// ConfirmDialog renders a fixed overlay; our test re-uses its real impl.
import { fetchJson } from "@/lib/api";
import { ScriptPanel } from "./script-panel";

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

beforeEach(() => {
  vi.mocked(fetchJson).mockReset();
});

describe("ScriptPanel", () => {
  it("starts collapsed and expands on toggle", () => {
    render(
      <ScriptPanel
        deckId="d"
        brandKitId="k"
        script="Hello world"
        slides={[]}
        selectedSlideId={null}
        onSelectSlide={vi.fn()}
      />,
      { wrapper },
    );
    expect(screen.getByTestId("pitch-script-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("pitch-script-textarea")).toBeNull();
    fireEvent.click(screen.getByTestId("pitch-script-toggle"));
    expect(screen.getByTestId("pitch-script-textarea")).toBeInTheDocument();
  });

  it("shows a degraded-hint when no slides carry source_range", () => {
    render(
      <ScriptPanel
        deckId="d"
        brandKitId="k"
        script="Hello"
        slides={[
          { id: "s1", slide: { template: "title", content: {} } },
        ]}
        selectedSlideId="s1"
        onSelectSlide={vi.fn()}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByTestId("pitch-script-toggle"));
    expect(screen.getByTestId("pitch-script-degraded-hint")).toBeInTheDocument();
  });

  it("does NOT show the degraded hint when at least one slide has a source_range", () => {
    render(
      <ScriptPanel
        deckId="d"
        brandKitId="k"
        script="Hello world"
        slides={[
          {
            id: "s1",
            slide: {
              template: "title",
              content: {},
              source_range: { start: 0, end: 5 },
            },
          },
        ]}
        selectedSlideId="s1"
        onSelectSlide={vi.fn()}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByTestId("pitch-script-toggle"));
    expect(screen.queryByTestId("pitch-script-degraded-hint")).toBeNull();
  });

  it("opens the confirm dialog and POSTs to /decks/draft on confirm", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ deck: { id: "newd" } });
    render(
      <ScriptPanel
        deckId="d"
        brandKitId="k"
        script="A script."
        slides={[]}
        selectedSlideId={null}
        onSelectSlide={vi.fn()}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByTestId("pitch-script-toggle"));
    fireEvent.click(screen.getByTestId("pitch-script-rerun-draft"));
    // Confirm dialog rendered
    expect(
      screen.getByTestId("pitch-script-rerun-confirm-host"),
    ).toBeInTheDocument();
    // Click the "Re-draft" button (it has aria-label via title; use text).
    fireEvent.click(screen.getByText("Re-draft"));
    await waitFor(() =>
      expect(vi.mocked(fetchJson)).toHaveBeenCalledWith(
        "/api/admin/pitch/decks/draft",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const body = JSON.parse(
      (vi.mocked(fetchJson).mock.calls[0][1] as { body: string }).body,
    );
    expect(body).toMatchObject({ script: "A script.", brandKitId: "k" });
  });

  it("clicking inside the textarea selects the owning slide", () => {
    const onSelectSlide = vi.fn();
    render(
      <ScriptPanel
        deckId="d"
        brandKitId="k"
        script="Hello big world"
        slides={[
          {
            id: "s1",
            slide: {
              template: "title",
              content: {},
              source_range: { start: 0, end: 5 },
            },
          },
          {
            id: "s2",
            slide: {
              template: "title",
              content: {},
              source_range: { start: 6, end: 14 },
            },
          },
        ]}
        selectedSlideId={null}
        onSelectSlide={onSelectSlide}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByTestId("pitch-script-toggle"));
    const ta = screen.getByTestId(
      "pitch-script-textarea",
    ) as HTMLTextAreaElement;
    ta.selectionStart = 8;
    fireEvent.click(ta);
    expect(onSelectSlide).toHaveBeenCalledWith("s2");
  });

  it("supports drag handle resize via mouse events", () => {
    render(
      <ScriptPanel
        deckId="d"
        brandKitId="k"
        script="x"
        slides={[]}
        selectedSlideId={null}
        onSelectSlide={vi.fn()}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByTestId("pitch-script-toggle"));
    const handle = screen.getByTestId("pitch-script-drag-handle");
    fireEvent.mouseDown(handle, { clientY: 500 });
    fireEvent.mouseMove(document, { clientY: 400 });
    fireEvent.mouseUp(document);
    // No crash and panel remains rendered.
    expect(screen.getByTestId("pitch-script-panel")).toBeInTheDocument();
  });

  it("cancels the re-draft confirm dialog without posting", () => {
    render(
      <ScriptPanel
        deckId="d"
        brandKitId="k"
        script="A"
        slides={[]}
        selectedSlideId={null}
        onSelectSlide={vi.fn()}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByTestId("pitch-script-toggle"));
    fireEvent.click(screen.getByTestId("pitch-script-rerun-draft"));
    fireEvent.click(screen.getByText(/cancel/i));
    expect(
      screen.queryByTestId("pitch-script-rerun-confirm-host"),
    ).toBeNull();
    expect(vi.mocked(fetchJson)).not.toHaveBeenCalled();
  });
});
