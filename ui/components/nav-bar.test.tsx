import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { NavBar, NAV_GROUPS } from "./nav-bar";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  usePathname: () => "/admin",
}));

// Mock next/link
vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

describe("NavBar", () => {
  it("renders all navigation links", () => {
    render(<NavBar />);

    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByText("Workbench")).toBeInTheDocument();
    // Dropdown group labels
    expect(screen.getByText("Studio")).toBeInTheDocument();
    expect(screen.getByText("Automation")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("renders the OpenZigs logo", () => {
    render(<NavBar />);
    expect(screen.getByRole("img", { name: "OpenZigs" })).toBeInTheDocument();
  });

  it("highlights the active admin group", () => {
    render(<NavBar />);

    const adminGroup = screen.getByText("Admin");
    expect(adminGroup.className).toContain("bg-primary");

    const chatLink = screen.getByText("Chat");
    expect(chatLink.className).not.toContain("bg-primary");
  });

  it("includes a Pitch link in the Studio group pointing at /pitch", async () => {
    // Radix dropdown content is rendered inside a portal that doesn't
    // open in jsdom without user-event keyboard nav. Asserting against
    // the source-of-truth NAV_GROUPS is faster and equivalent — the
    // render path is the same `Link` wired into every group item.
    const studio = NAV_GROUPS.find((g) => g.label === "Studio");
    expect(studio).toBeDefined();
    const pitch = studio!.items.find((it) => it.href === "/pitch");
    expect(pitch).toEqual({ href: "/pitch", label: "Pitch" });
  });
});
