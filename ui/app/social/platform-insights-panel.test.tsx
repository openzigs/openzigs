import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PlatformInsightsPanel } from "./platform-insights-panel";

vi.mock("@/lib/api", () => ({
  fetchJson: vi.fn(),
}));

import { fetchJson } from "@/lib/api";

const mocked = fetchJson as unknown as ReturnType<typeof vi.fn>;

describe("PlatformInsightsPanel", () => {
  beforeEach(() => {
    mocked.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders three platform cards (LinkedIn, Reddit, Twitter)", () => {
    render(<PlatformInsightsPanel />);
    expect(screen.getByTestId("insights-card-linkedin")).toBeInTheDocument();
    expect(screen.getByTestId("insights-card-reddit")).toBeInTheDocument();
    expect(screen.getByTestId("insights-card-twitter")).toBeInTheDocument();
  });

  it("each card lists its underlying MCP tool name (transparency)", () => {
    render(<PlatformInsightsPanel />);
    expect(screen.getByText("linkedin-profile-analytics")).toBeInTheDocument();
    expect(screen.getByText("reddit-subreddit-health")).toBeInTheDocument();
    expect(screen.getByText("twitter-account-analytics")).toBeInTheDocument();
  });

  it("shows API tier limitations as user-facing notes", () => {
    render(<PlatformInsightsPanel />);
    expect(screen.getByText(/Free tier/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Reddit does not expose post impressions/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Org-owned pages only/i)).toBeInTheDocument();
  });

  it("refuses to fetch when scope input is empty", async () => {
    render(<PlatformInsightsPanel />);
    const buttons = screen.getAllByRole("button", { name: /Fetch insights/i });
    fireEvent.click(buttons[0]);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/required/i);
    });
    expect(mocked).not.toHaveBeenCalled();
  });

  it("calls the admin invoke endpoint with the scope field and renders metric tiles", async () => {
    mocked.mockResolvedValueOnce({
      ok: true,
      tool: "twitter-account-analytics",
      text: JSON.stringify({ followers: 42, tweets: 100 }),
    });
    render(<PlatformInsightsPanel />);
    const input = screen.getByLabelText(/Twitter \/ X Username/i);
    fireEvent.change(input, { target: { value: "jack" } });
    const twitterCard = screen.getByTestId("insights-card-twitter");
    const btn = twitterCard.querySelector("button");
    fireEvent.click(btn!);
    await waitFor(() => {
      expect(mocked).toHaveBeenCalledWith(
        "/api/admin/tools/twitter-account-analytics/invoke",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ username: "jack" }),
        }),
      );
    });
    const tiles = await screen.findByTestId("insights-metric-tiles");
    expect(tiles).toHaveTextContent("Followers");
    expect(tiles).toHaveTextContent("42");
    expect(tiles).toHaveTextContent("Tweets");
  });

  it("sends organization_id (not org_urn) for LinkedIn so Zod does not strip it", async () => {
    mocked.mockResolvedValueOnce({
      ok: true,
      tool: "linkedin-profile-analytics",
      text: JSON.stringify({ followerCount: 1234 }),
    });
    render(<PlatformInsightsPanel />);
    const input = screen.getByLabelText(/LinkedIn Organization ID/i);
    fireEvent.change(input, {
      target: { value: "urn:li:organization:12345" },
    });
    const card = screen.getByTestId("insights-card-linkedin");
    fireEvent.click(card.querySelector("button")!);
    await waitFor(() => {
      expect(mocked).toHaveBeenCalledWith(
        "/api/admin/tools/linkedin-profile-analytics/invoke",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            organization_id: "urn:li:organization:12345",
          }),
        }),
      );
    });
  });

  it("surfaces backend errors", async () => {
    mocked.mockRejectedValueOnce(new Error("rate limited"));
    render(<PlatformInsightsPanel />);
    const input = screen.getByLabelText(/Reddit Subreddit/i);
    fireEvent.change(input, { target: { value: "python" } });
    const card = screen.getByTestId("insights-card-reddit");
    fireEvent.click(card.querySelector("button")!);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/rate limited/);
    });
  });
});
