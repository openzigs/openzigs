/**
 * Test for the authenticated Present route (#1016).
 *
 * Verifies that the page:
 *   1. Mounts and fires `fetchWithAuth` against `/render?mode=present`.
 *   2. Renders an iframe whose `srcDoc` is the fetched HTML body.
 *   3. Surfaces a fetch failure as an error region instead of a blank page.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/navigation", () => ({
  useParams: () => ({ deckId: "deck-xyz" }),
}));

vi.mock("@/lib/api", () => ({
  buildUrl: (p: string) => p,
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from "@/lib/api";
import PitchPresentPage from "./page";

const fetchMock = vi.mocked(fetchWithAuth);

beforeEach(() => {
  fetchMock.mockReset();
});

describe("PitchPresentPage (#1016)", () => {
  it("calls /render?mode=present with auth and renders the HTML in a sandboxed iframe", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        "<!doctype html><html><body><div class='reveal'>hello deck</div></body></html>",
    } as unknown as Response);

    render(<PitchPresentPage />);

    // Loading state shows first.
    expect(screen.getByTestId("pitch-present-loading")).toBeInTheDocument();

    const frame = await screen.findByTestId("pitch-present-frame");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
    expect(frame.getAttribute("srcDoc") ?? frame.getAttribute("srcdoc") ?? "").toContain(
      "hello deck",
    );

    // The fetch must hit the authenticated render endpoint, not the in-app route.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/pitch/decks/deck-xyz/render?mode=present",
    );
  });

  it("renders an error region when the render fetch fails", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    } as unknown as Response);

    render(<PitchPresentPage />);

    await waitFor(() =>
      expect(screen.getByTestId("pitch-present-error")).toBeInTheDocument(),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/render failed: 500/);
  });
});
