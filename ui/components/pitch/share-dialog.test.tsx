import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ShareDialog } from "./share-dialog";

const fetchJsonMock = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}));

const writeText = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: (s: string) => writeText(s) },
});

function token(id: string): string {
  return `tok-${id}-${"x".repeat(40)}`;
}

describe("ShareDialog", () => {
  beforeEach(() => {
    fetchJsonMock.mockReset();
    writeText.mockClear();
  });

  it("loads existing tokens when opened and renders the public URL", async () => {
    fetchJsonMock.mockResolvedValueOnce({
      tokens: [
        {
          token: token("a"),
          createdAt: Date.now(),
          expiresAt: null,
          revokedAt: null,
        },
      ],
    });

    render(
      <ShareDialog
        deckId="d1"
        open
        onOpenChange={() => {}}
        publicHost="https://example.test"
      />,
    );

    await waitFor(() =>
      expect(fetchJsonMock).toHaveBeenCalledWith(
        "/api/admin/pitch/decks/d1/share",
      ),
    );
    expect(
      await screen.findByText(`https://example.test/p/${token("a")}`),
    ).toBeInTheDocument();
  });

  it("creates a new share link, copies it, and refreshes the list", async () => {
    fetchJsonMock
      .mockResolvedValueOnce({ tokens: [] }) // initial list
      .mockResolvedValueOnce({
        token: token("new"),
        url: `/p/${token("new")}`,
        createdAt: Date.now(),
        expiresAt: null,
      })
      .mockResolvedValueOnce({
        tokens: [
          {
            token: token("new"),
            createdAt: Date.now(),
            expiresAt: null,
            revokedAt: null,
          },
        ],
      });

    const onShowToast = vi.fn();
    render(
      <ShareDialog
        deckId="d1"
        open
        onOpenChange={() => {}}
        onShowToast={onShowToast}
        publicHost="https://example.test"
      />,
    );

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("pitch-editor-share-create"));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `https://example.test/p/${token("new")}`,
      ),
    );
    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledTimes(3));
    expect(onShowToast).toHaveBeenCalledWith(
      expect.stringMatching(/copied/i),
      "success",
    );
  });

  it("revokes a token by hitting the revoke endpoint", async () => {
    fetchJsonMock
      .mockResolvedValueOnce({
        tokens: [
          {
            token: token("revoke-me"),
            createdAt: Date.now(),
            expiresAt: null,
            revokedAt: null,
          },
        ],
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ tokens: [] });

    render(
      <ShareDialog
        deckId="d1"
        open
        onOpenChange={() => {}}
        publicHost="https://example.test"
      />,
    );

    fireEvent.click(await screen.findByTestId("pitch-editor-share-revoke"));

    await waitFor(() =>
      expect(fetchJsonMock).toHaveBeenCalledWith(
        `/api/admin/pitch/decks/d1/share/${token("revoke-me")}/revoke`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("shows an error message when token issuing fails", async () => {
    fetchJsonMock
      .mockResolvedValueOnce({ tokens: [] })
      .mockRejectedValueOnce(new Error("boom"));

    render(
      <ShareDialog
        deckId="d1"
        open
        onOpenChange={() => {}}
        publicHost="https://example.test"
      />,
    );

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("pitch-editor-share-create"));

    expect(await screen.findByRole("alert")).toHaveTextContent(/boom/);
  });
});
