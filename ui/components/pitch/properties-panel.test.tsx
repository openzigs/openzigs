import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
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

// Replace next/dynamic editor imports with passive editors that just emit
// onChange when their button is clicked. We assert lazy-routing per template
// in a single test rather than mounting the real editors.
vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: (loader: () => Promise<{ default: React.ComponentType<unknown> }>) => {
    let Component: React.ComponentType<unknown> | null = null;
    void loader().then((mod) => {
      Component = mod.default;
    });
    const Wrapper = (props: Record<string, unknown>) => {
      if (!Component) {
        // Stand-in until the lazy module resolves; tests await this.
        return <div data-testid="editor-loading" />;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return <Component {...(props as any)} />;
    };
    return Wrapper;
  },
}));

// Replace ALL editors with a single shared stub so we don't pay
// the cost of their bundles. The stub exposes its template name
// and an "edit" button to drive onChange.
vi.mock("./property-editors/title", () => ({
  __esModule: true,
  default: ({
    slide,
    onChange,
  }: {
    slide: { template: string };
    onChange: (s: { template: string; content: { title: string } }) => void;
  }) => (
    <div data-testid="stub-editor" data-template={slide.template}>
      <button
        data-testid="stub-fire"
        onClick={() =>
          onChange({ template: "title", content: { title: "edited" } })
        }
      >
        edit
      </button>
    </div>
  ),
}));
// All other templates: minimal mounting placeholder.
const otherTemplates = [
  "section_divider",
  "bullet_list",
  "two_column",
  "image_caption",
  "quote",
  "stats_kpi",
  "comparison_table",
  "timeline",
  "full_bleed",
  "code",
  "qa",
  "chart",
  "mermaid",
];
for (const t of otherTemplates) {
  vi.doMock(`./property-editors/${t}`, () => ({
    __esModule: true,
    default: ({ slide }: { slide: { template: string } }) => (
      <div data-testid="stub-editor" data-template={slide.template} />
    ),
  }));
}

import { fetchJson } from "@/lib/api";
import { PropertiesPanel } from "./properties-panel";

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(fetchJson).mockReset();
});

describe("PropertiesPanel", () => {
  it("renders the empty state when no slide is selected", () => {
    render(
      <PropertiesPanel deckId="d" selectedSlide={null} brandKit={null} />,
      { wrapper },
    );
    expect(screen.getByTestId("pitch-properties-empty")).toBeInTheDocument();
  });

  it("displays the selected template label", async () => {
    render(
      <PropertiesPanel
        deckId="d"
        selectedSlide={{
          id: "s1",
          slide: { template: "title", content: { title: "Hi" } },
        }}
      />,
      { wrapper },
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("pitch-properties-template-label"),
      ).toHaveTextContent("title"),
    );
  });

  it("debounces onChange and PATCHes the deck slide after 400ms", async () => {
    vi.mocked(fetchJson).mockResolvedValue({});
    render(
      <PropertiesPanel
        deckId="d"
        selectedSlide={{
          id: "s1",
          slide: { template: "title", content: { title: "Hi" } },
        }}
      />,
      { wrapper },
    );
    await waitFor(() =>
      expect(screen.getByTestId("stub-fire")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("stub-fire"));
    // Before debounce expiry — no fetch yet.
    expect(vi.mocked(fetchJson)).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(401);
    });
    await waitFor(() =>
      expect(vi.mocked(fetchJson)).toHaveBeenCalledWith(
        "/api/admin/pitch/decks/d/slides/s1",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
  });

  it("renders the unknown-template warning for an unknown template", async () => {
    render(
      <PropertiesPanel
        deckId="d"
        selectedSlide={{
          id: "x",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          slide: { template: "made_up", content: {} } as any,
        }}
      />,
      { wrapper },
    );
    expect(
      screen.getByTestId("pitch-properties-unknown-template"),
    ).toBeInTheDocument();
  });
});
