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
// Exposes every action handler as its own button so tests can hit each
// mutation path on the editor.
vi.mock("@/components/pitch/slide-rail", () => ({
  SlideRail: ({
    items,
    onSelect,
    onAddAbove,
    onAddBelow,
    onDuplicate,
    onDelete,
    onReorder,
  }: {
    items: { id: string; titlePreview: string }[];
    onSelect: (id: string) => void;
    onAddAbove: (id: string) => void;
    onAddBelow: (id: string) => void;
    onDuplicate: (id: string) => void;
    onDelete: (id: string) => void;
    onReorder: (id: string, pos: number) => void | Promise<void>;
  }) => (
    <div data-testid="slide-rail-mock">
      {items.map((it) => (
        <div key={it.id} data-testid={`slide-rail-item-${it.id}`}>
          <button onClick={() => onSelect(it.id)}>{it.titlePreview}</button>
          <button
            data-testid={`slide-rail-add-above-${it.id}`}
            onClick={() => onAddAbove(it.id)}
          >
            +above
          </button>
          <button
            data-testid={`slide-rail-add-below-${it.id}`}
            onClick={() => onAddBelow(it.id)}
          >
            +below
          </button>
          <button
            data-testid={`slide-rail-duplicate-${it.id}`}
            onClick={() => onDuplicate(it.id)}
          >
            dup
          </button>
          <button
            data-testid={`slide-rail-delete-${it.id}`}
            onClick={() => onDelete(it.id)}
          >
            del
          </button>
          <button
            data-testid={`slide-rail-reorder-${it.id}`}
            onClick={() => onReorder(it.id, 99)}
          >
            move
          </button>
        </div>
      ))}
    </div>
  ),
}));

// Replace the new Phase-5 components with passive stand-ins so this shell
// test stays focused on top-level wiring. Each mock surfaces only what the
// shell needs to verify (mounted, received props).
vi.mock("@/components/pitch/properties-panel", () => ({
  PropertiesPanel: ({
    selectedSlide,
  }: {
    selectedSlide: { id: string } | null;
  }) => (
    <aside data-testid="pitch-editor-properties">
      <span data-testid="pitch-editor-properties-selected">
        {selectedSlide?.id ?? "—"}
      </span>
    </aside>
  ),
}));

vi.mock("@/components/pitch/script-panel", () => ({
  ScriptPanel: ({ script }: { script: string }) => (
    <div data-testid="pitch-editor-script-panel-mock">
      <textarea
        data-testid="pitch-editor-script-textarea"
        readOnly
        value={script}
      />
    </div>
  ),
}));

vi.mock("@/components/pitch/brand-kit-picker", () => ({
  BrandKitPicker: ({ selectedId }: { selectedId: string | null }) => (
    <div data-testid="pitch-editor-brand-kit-picker">{selectedId}</div>
  ),
}));

vi.mock("@/components/pitch/brand-kit-editor", () => ({
  BrandKitEditor: ({ open }: { open: boolean }) => (
    <div data-testid="pitch-editor-brand-kit-editor" data-open={open} />
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
    expect(screen.getByTestId("pitch-editor-brand-kit-picker")).toBeInTheDocument();
    expect(screen.getByTestId("pitch-editor-title")).toHaveTextContent("My Deck");
  });

  it("only disables export until Phase 6", async () => {
    render(<PitchDeckEditorPage />, { wrapper });
    await waitFor(() =>
      expect(screen.getByTestId("pitch-editor-shell")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("pitch-editor-export")).toBeDisabled();
  });

  it("forwards canvas data-pitch-field clicks (selectedField is consumed by the properties panel)", async () => {
    render(<PitchDeckEditorPage />, { wrapper });
    await waitFor(() =>
      expect(screen.getByTestId("reveal-canvas-mock")).toBeInTheDocument(),
    );
    const titleEl = document.querySelector('[data-pitch-field="title"]');
    expect(titleEl).toBeTruthy();
    fireEvent.click(titleEl!);
    // No throw — the click handler walks up looking for data-pitch-field.
  });

  it("renders the script panel mock with the deck's source script", async () => {
    render(<PitchDeckEditorPage />, { wrapper });
    await waitFor(() =>
      expect(screen.getByTestId("pitch-editor-script-panel")).toBeInTheDocument(),
    );
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

  it("cancels title edit on Escape without firing PATCH", async () => {
    render(<PitchDeckEditorPage />, { wrapper });
    await waitFor(() =>
      expect(screen.getByTestId("pitch-editor-title")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("pitch-editor-title"));
    const input = screen.getByTestId("pitch-editor-title-input");
    fireEvent.change(input, { target: { value: "Throwaway" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("pitch-editor-title-input")).toBeNull();
    const patchCalls = vi
      .mocked(fetchJson)
      .mock.calls.filter(
        ([, init]) =>
          init && (init as RequestInit).method === "PATCH",
      );
    expect(patchCalls).toHaveLength(0);
  });

  it("invokes POST when adding a slide above", async () => {
    render(<PitchDeckEditorPage />, { wrapper });
    await waitFor(() => screen.getByTestId("slide-rail-add-above-s2"));
    fireEvent.click(screen.getByTestId("slide-rail-add-above-s2"));
    await waitFor(() =>
      expect(vi.mocked(fetchJson)).toHaveBeenCalledWith(
        "/api/admin/pitch/decks/deck-1/slides",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("invokes POST when adding a slide below", async () => {
    render(<PitchDeckEditorPage />, { wrapper });
    await waitFor(() => screen.getByTestId("slide-rail-add-below-s1"));
    fireEvent.click(screen.getByTestId("slide-rail-add-below-s1"));
    await waitFor(() =>
      expect(vi.mocked(fetchJson)).toHaveBeenCalledWith(
        "/api/admin/pitch/decks/deck-1/slides",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("invokes POST when duplicating a slide", async () => {
    render(<PitchDeckEditorPage />, { wrapper });
    await waitFor(() => screen.getByTestId("slide-rail-duplicate-s1"));
    fireEvent.click(screen.getByTestId("slide-rail-duplicate-s1"));
    await waitFor(() =>
      expect(vi.mocked(fetchJson)).toHaveBeenCalledWith(
        "/api/admin/pitch/decks/deck-1/slides",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("invokes DELETE when deleting a slide", async () => {
    render(<PitchDeckEditorPage />, { wrapper });
    await waitFor(() => screen.getByTestId("slide-rail-delete-s2"));
    fireEvent.click(screen.getByTestId("slide-rail-delete-s2"));
    await waitFor(() =>
      expect(vi.mocked(fetchJson)).toHaveBeenCalledWith(
        "/api/admin/pitch/decks/deck-1/slides/s2",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });

  it("invokes PUT when reordering a slide", async () => {
    render(<PitchDeckEditorPage />, { wrapper });
    await waitFor(() => screen.getByTestId("slide-rail-reorder-s1"));
    fireEvent.click(screen.getByTestId("slide-rail-reorder-s1"));
    await waitFor(() =>
      expect(vi.mocked(fetchJson)).toHaveBeenCalledWith(
        "/api/admin/pitch/decks/deck-1/slides/s1/move",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
  });

  it("renders an error message when the deck query fails", async () => {
    vi.mocked(fetchJson).mockRejectedValueOnce(new Error("boom"));
    render(<PitchDeckEditorPage />, { wrapper });
    await waitFor(() =>
      expect(
        screen.getByText(/Could not load deck deck-1/),
      ).toBeInTheDocument(),
    );
  });
});
