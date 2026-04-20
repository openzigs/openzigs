import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  SiteStructureTree,
  buildSiteTree,
  type SiteStructurePage,
} from "./site-structure-tree";

const pages: SiteStructurePage[] = [
  { url: "https://example.com/", severity: "ok", status: 200 },
  {
    url: "https://example.com/about",
    severity: "warning",
    status: 200,
    issueCount: 2,
  },
  {
    url: "https://example.com/blog",
    severity: "ok",
    status: 200,
  },
  {
    url: "https://example.com/blog/post-1",
    severity: "error",
    status: 404,
    issueCount: 5,
  },
  {
    url: "https://example.com/blog/post-2",
    severity: "ok",
    status: 200,
  },
];

describe("buildSiteTree", () => {
  it("creates a hierarchical tree from URLs", () => {
    const tree = buildSiteTree(pages);
    expect(tree.children).toHaveLength(2);
    const blog = tree.children.find((c) => c.segment === "blog");
    expect(blog?.children).toHaveLength(2);
    expect(blog?.children.map((c) => c.segment).sort()).toEqual([
      "post-1",
      "post-2",
    ]);
  });

  it("attaches root page to root node", () => {
    const tree = buildSiteTree(pages);
    expect(tree.page?.url).toBe("https://example.com/");
  });

  it("ignores invalid URLs", () => {
    const tree = buildSiteTree([
      { url: "not-a-url" },
      { url: "https://example.com/x" },
    ]);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].segment).toBe("x");
  });

  it("sorts children alphabetically", () => {
    const tree = buildSiteTree([
      { url: "https://example.com/zebra" },
      { url: "https://example.com/alpha" },
    ]);
    expect(tree.children.map((c) => c.segment)).toEqual(["alpha", "zebra"]);
  });
});

describe("SiteStructureTree", () => {
  it("renders empty state when no pages", () => {
    render(<SiteStructureTree pages={[]} />);
    expect(screen.getByTestId("site-tree-empty")).toBeInTheDocument();
  });

  it("renders the tree with status icons and issue badges", () => {
    render(<SiteStructureTree pages={pages} />);
    expect(screen.getByTestId("site-structure-tree")).toBeInTheDocument();
    expect(screen.getByLabelText("5 issues")).toBeInTheDocument();
    expect(screen.getByLabelText("2 issues")).toBeInTheDocument();
  });

  it("collapses and expands a node", () => {
    render(<SiteStructureTree pages={pages} defaultExpanded={true} />);
    expect(screen.getByText("post-1")).toBeInTheDocument();
    const blogToggle = screen.getAllByLabelText(/Collapse|Expand/)[1];
    fireEvent.click(blogToggle);
    expect(screen.queryByText("post-1")).toBeNull();
    fireEvent.click(blogToggle);
    expect(screen.getByText("post-1")).toBeInTheDocument();
  });
});
