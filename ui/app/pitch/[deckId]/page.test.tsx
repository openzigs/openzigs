import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useParams: () => ({ deckId: "deck-1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// Mock socket
vi.mock("@/lib/socket-context", () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

// Mock the API helpers + global fetch (used for /render).
vi.mock("@/lib/api", () => ({
  buildUrl: (p: string) => p,
  fetchJson: vi.fn(),
}));

// Replace RevealCanvas with a passive renderer so the test can assert clicks.
vi.mock("@/components/pitch/reveal-canvas", () => ({
  RevealCanvas: ({
    html,
    onContainerClick,
  }: {
    html: string;
    onContainerClick?: (el: HTMLElement) => void;
  }) => (
    <div
      data-testid="reveal-canvas-mock"
      onClick={(e) => onContainerClick?.(e.target as HTMLElement)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ),
}));

// Replace SlideRail with a minimal stand-in so we don't fight @dnd-kit here.
vi.mock("@/components/pitch/slide-rail", () => ({
  SlideRail: ({
    items,
    onSelect,
  }: {
    items: { id: string; titlePreview: string }[];
    onSelect: (id: string) => void;
  }) => (
    <div data-testid="slide-rail-mock">
      {items.map((it) => (
        <button key={it.id} onClick={() => onSelect(it.id)}>
          {it.titlePreview}
        </button>
      ))}
    </div>
  ),
}));

import { fetchJson } from "@/lib/api";
import PitchDeckEditorPage from "./page";

const sampleDeck = {
  deck: {
    id: "deck-1",
    title: "My Deck",
    brand_kit_id: "kit-1",
    aspect_ratio: "16:9",
    metadata: { source_script: "Intro line.\nMore here.", tone: "formal" },
    created_at: "2026-04-25T00:00:00Z",
    updated_at: "2026-04-25T00:00:00Z",
  },
  slides: [
    {
      id: "s1",
      deck_id: "deck-1",
      position: 0,
      slide: { template: "title", content: { title: "Welcome" }, speaker_notes: "" },
      created_at: "2026-04-25T00:00:00Z",
      updated_at: "2026-04-25T00:00:00Z",
    },
    {
      id: "s2",
      deck_id: "deck-1",
      position: 1,
      slide: { template: "qa", content: { heading: "Questions?" }, speaker_notes: "" },
      created_at: "2026-04-25T00:00:00Z",
      updated_at: "2026-04-25T00:00:00Z",
    },
  ],
};

const sampleHtml =
  '<div class="pitch-deck-wrap"><div class="reveal"><div class="slides"><section><h1 data-pitch-field="title">Welcome</h1></section></div></div></div>';

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

describe("PitchDeckEditorPage", () => {
  beforeEach(() => {
    vi.mocked(fetchJson).mockReset();
    vi.mocked(fetchJson).mockResolvedValue(sampleDeck);
    // Mock global fetch for the render endpoint.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => sampleHtml,
    }) as unknown as typeof fetch;
  });

  it("renders all four editor zones once data loads", async () => {
    render(<PitchDeckEditorPage />, { wrapper });
    await waitFor(() => {
      expect(screen.getByTestId("pitch-editor-shell")).toBeInTheDocument();
    });
    expect(screen.getByTestId("pitch-editor-topbar")).toBeInTheDocument();
    expect(screen.getByTestId("slide-rail-mock")).toBeInTheDocument();
    expect(screen.getByTestId("pitch-editor-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("pitch-editor-properties")).toBeInTheDocument();
    expect(screen.getByTestId("pitch-editor-script-panel")).toBeInTheDocument();
    expect(screen.getByTestId("pitch-editor-title")).toHaveTextContent("My Deck");
  });

  it("disables stub buttons for deferred features", async () => {
    render(<PitchDeckEditorPage />, { wrapper });
    await waitFor(() =>
      expect(screen.getByTestId("pitch-editor-shell")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("pitch-editor-brand-kit")).toBeDisabled();
    expect(screen.getByTestId("pitch-editor-export")).toBeDisabled();
  });

  it("updates the selected indicator when a data-pitch-field element is clicked", async () => {
    render(<PitchDeckEditorPage />, { wrapper });
    await waitFor(() =>
      expect(screen.getByTestId("reveal-canvas-mock")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("pitch-editor-selected-field")).toHaveTextContent(
      "Selected: —",
    );
    const titleEl = document.querySelector('[data-pitch-field="title"]');
    expect(titleEl).toBeTruthy();
    fireEvent.click(titleEl!);
    expect(screen.getByTestId("pitch-editor-selected-field")).toHaveTextContent(
      "Selected: title",
    );
  });

  it("opens the script panel and shows source_script read-only", async () => {
    render(<PitchDeckEditorPage />, { wrapper });
    await waitFor(() =>
      expect(screen.getByTestId("pitch-editor-script-panel")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("pitch-editor-script-toggle"));
    const ta = screen.getByTestId(
      "pitch-editor-script-textarea",
    ) as HTMLTextAreaElement;
    expect(ta.readOnly).toBe(true);
    expect(ta.value).toContain("Intro line.");
  });

  it("enters title-edit mode and submits a rename via PATCH", async () => {
    render(<PitchDeckEditorPage />, { wrapper });
    await waitFor(() =>
      expect(screen.getByTestId("pitch-editor-title")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("pitch-editor-title"));
    const input = screen.getByTestId(
      "pitch-editor-title-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(vi.mocked(fetchJson)).toHaveBeenCalledWith(
        "/api/admin/pitch/decks/deck-1",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
  });
});
