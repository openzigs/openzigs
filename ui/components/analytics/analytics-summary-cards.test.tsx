import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KPICard, StatCard } from "./analytics-summary-cards";
import {
  AnalyticsContentCompare,
  type ContentMetrics,
} from "./analytics-content-compare";

describe("KPICard", () => {
  it("renders label and value", () => {
    render(<KPICard label="Views" value="1.2K" />);
    expect(screen.getByText("Views")).toBeInTheDocument();
    expect(screen.getByText("1.2K")).toBeInTheDocument();
  });

  it("shows positive delta in emerald when higherIsBetter", () => {
    render(
      <KPICard
        label="Engagement"
        value="5.0%"
        delta={{ percent: 12.3, label: "vs prev" }}
      />,
    );
    const trend = screen.getByLabelText(/vs prev: 12.3 percent/i);
    expect(trend.className).toMatch(/emerald/);
  });

  it("flips color when higherIsBetter is false", () => {
    render(
      <KPICard
        label="Bounce"
        value="40%"
        higherIsBetter={false}
        delta={{ percent: 5 }}
      />,
    );
    expect(screen.getByText(/\+5\.0%/i).className).toMatch(/red/);
  });
});

describe("StatCard", () => {
  it("renders label, value, sublabel", () => {
    render(<StatCard label="Total" value="42" sublabel="last 7d" />);
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("last 7d")).toBeInTheDocument();
  });
});

describe("AnalyticsContentCompare", () => {
  const posts: ContentMetrics[] = [
    {
      id: "p1",
      title: "Post One",
      views: 1000,
      likes: 50,
      comments: 10,
      engagement: 0.06,
      watchTime: 90,
    },
    {
      id: "p2",
      title: "Post Two",
      views: 500,
      likes: 80,
      comments: 10,
      engagement: 0.18,
      watchTime: 200,
    },
    {
      id: "p3",
      title: "Post Three",
      views: 750,
      likes: 60,
      comments: 5,
      engagement: 0.08,
      watchTime: 120,
    },
  ];

  it("renders empty state when fewer than 2 posts", () => {
    render(<AnalyticsContentCompare posts={posts.slice(0, 1)} />);
    expect(screen.getByTestId("content-compare-empty")).toBeInTheDocument();
  });

  it("defaults selection to the first two posts and highlights winners", () => {
    render(<AnalyticsContentCompare posts={posts} />);
    const viewsRow = screen.getByTestId("compare-row-views");
    expect(viewsRow.textContent).toContain("1,000");
    expect(viewsRow.textContent).toContain("500");
    // Post One has more views → A wins.
    expect(viewsRow.textContent).toMatch(/A/);
    const likesRow = screen.getByTestId("compare-row-likes");
    expect(likesRow.textContent).toMatch(/B/);
  });

  it("formats engagement as percent and watch time as m s", () => {
    render(<AnalyticsContentCompare posts={posts} />);
    const eng = screen.getByTestId("compare-row-engagement");
    expect(eng.textContent).toContain("6.0%");
    expect(eng.textContent).toContain("18.0%");
    const watch = screen.getByTestId("compare-row-watchTime");
    expect(watch.textContent).toContain("1m 30s");
  });

  it("warns when both selectors point at the same post", () => {
    render(<AnalyticsContentCompare posts={posts} />);
    const selectB = screen.getByLabelText("Post B");
    fireEvent.change(selectB, { target: { value: "p1" } });
    expect(screen.getByTestId("compare-same-post")).toBeInTheDocument();
  });
});
