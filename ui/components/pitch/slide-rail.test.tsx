import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

// Capture the onDragEnd handler so we can fire synthetic drag events.
let capturedOnDragEnd: ((event: unknown) => void) | undefined;

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragEnd,
  }: {
    children: ReactNode;
    onDragEnd: (e: unknown) => void;
  }) => {
    capturedOnDragEnd = onDragEnd;
    return <>{children}</>;
  },
  PointerSensor: class {},
  useSensor: () => ({}),
  useSensors: (..._args: unknown[]) => [],
  closestCenter: () => null,
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <>{children}</>,
  arrayMove: <T,>(arr: T[], from: number, to: number): T[] => {
    const next = arr.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  },
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: null,
    isDragging: false,
  }),
  verticalListSortingStrategy: () => null,
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

// Render Radix DropdownMenu items inline so jsdom can find them with getByText
// without requiring a real `pointerdown` to open the popover.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({
    children,
    onSelect,
    className,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    className?: string;
  }) => (
    <button type="button" onClick={() => onSelect?.()} className={className}>
      {children}
    </button>
  ),
}));

import { SlideRail, type SlideRailItem } from "./slide-rail";

const items: SlideRailItem[] = [
  { id: "s1", position: 0, template: "title", titlePreview: "Welcome" },
  { id: "s2", position: 1, template: "bullet_list", titlePreview: "Why us" },
  { id: "s3", position: 2, template: "qa", titlePreview: "Questions" },
];

const baseHandlers = {
  selectedSlideId: null,
  onSelect: vi.fn(),
  onReorder: vi.fn().mockResolvedValue(undefined),
  onAddAbove: vi.fn(),
  onAddBelow: vi.fn(),
  onDuplicate: vi.fn(),
  onDelete: vi.fn(),
};

describe("SlideRail", () => {
  beforeEach(() => {
    Object.values(baseHandlers).forEach((h) => {
      if (typeof h === "function" && "mockClear" in h) {
        (h as { mockClear: () => void }).mockClear();
      }
    });
    capturedOnDragEnd = undefined;
  });

  it("renders all slide rows", () => {
    render(<SlideRail items={items} {...baseHandlers} />);
    expect(screen.getByTestId("slide-rail")).toBeInTheDocument();
    expect(screen.getByTestId("slide-rail-row-s1")).toBeInTheDocument();
    expect(screen.getByTestId("slide-rail-row-s2")).toBeInTheDocument();
    expect(screen.getByTestId("slide-rail-row-s3")).toBeInTheDocument();
    expect(screen.getByText("Welcome")).toBeInTheDocument();
    expect(screen.getByText(/Slides \(3\)/)).toBeInTheDocument();
  });

  it("calls onSelect when a row is clicked", () => {
    render(<SlideRail items={items} {...baseHandlers} />);
    fireEvent.click(screen.getByTestId("slide-rail-row-s2"));
    expect(baseHandlers.onSelect).toHaveBeenCalledWith("s2");
  });

  it("highlights the selected slide", () => {
    render(
      <SlideRail items={items} {...baseHandlers} selectedSlideId="s2" />,
    );
    const row = screen.getByTestId("slide-rail-row-s2");
    expect(row.className).toContain("border-primary");
  });

  it("fires onReorder with the new index after a drag-end event", async () => {
    render(<SlideRail items={items} {...baseHandlers} />);
    expect(capturedOnDragEnd).toBeTypeOf("function");
    await act(async () => {
      capturedOnDragEnd?.({ active: { id: "s1" }, over: { id: "s3" } });
      // flush microtasks
      await Promise.resolve();
    });
    expect(baseHandlers.onReorder).toHaveBeenCalledWith("s1", 2);
  });

  it("rolls back optimistic order when onReorder rejects", async () => {
    const failing = {
      ...baseHandlers,
      onReorder: vi.fn().mockRejectedValue(new Error("nope")),
    };
    render(<SlideRail items={items} {...failing} />);
    await act(async () => {
      capturedOnDragEnd?.({ active: { id: "s1" }, over: { id: "s3" } });
      await Promise.resolve();
      await Promise.resolve();
    });
    // After rollback, s1 should still appear before s3 in the DOM.
    const rows = screen.getAllByTestId(/^slide-rail-row-/);
    expect(rows[0]!.getAttribute("data-testid")).toBe("slide-rail-row-s1");
  });

  it("ignores drag-end when there is no over target", async () => {
    render(<SlideRail items={items} {...baseHandlers} />);
    await act(async () => {
      capturedOnDragEnd?.({ active: { id: "s1" }, over: null });
    });
    expect(baseHandlers.onReorder).not.toHaveBeenCalled();
  });

  it("opens the overflow menu and fires the right action handlers", () => {
    render(<SlideRail items={items} {...baseHandlers} />);
    const row = screen.getByTestId("slide-rail-row-s2");
    fireEvent.click(within(row).getByText("Add slide above"));
    expect(baseHandlers.onAddAbove).toHaveBeenCalledWith("s2");

    fireEvent.click(within(row).getByText("Add slide below"));
    expect(baseHandlers.onAddBelow).toHaveBeenCalledWith("s2");

    fireEvent.click(within(row).getByText("Duplicate"));
    expect(baseHandlers.onDuplicate).toHaveBeenCalledWith("s2");
  });

  it("requires confirmation before deleting a slide", () => {
    render(<SlideRail items={items} {...baseHandlers} />);
    const row = screen.getByTestId("slide-rail-row-s2");
    fireEvent.click(within(row).getByText("Delete"));
    expect(baseHandlers.onDelete).not.toHaveBeenCalled();
    expect(screen.getByText("Delete slide")).toBeInTheDocument();

    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByText("Delete"));
    expect(baseHandlers.onDelete).toHaveBeenCalledWith("s2");
  });

  // ── #993 image-status badges ────────────────────────────────────────

  it("renders no image-status badge when status is idle", () => {
    render(<SlideRail items={items} {...baseHandlers} />);
    expect(
      screen.queryByTestId(/^slide-rail-image-status-/),
    ).not.toBeInTheDocument();
  });

  it("renders queued / ready / failed badges from imageStatusOf (#993)", () => {
    const statusMap: Record<string, "queued" | "ready" | "failed"> = {
      s1: "queued",
      s2: "ready",
      s3: "failed",
    };
    render(
      <SlideRail
        items={items}
        {...baseHandlers}
        imageStatusOf={(id) => statusMap[id] ?? "idle"}
      />,
    );
    expect(
      screen.getByTestId("slide-rail-image-status-1"),
    ).toHaveAttribute("data-status", "queued");
    expect(
      screen.getByTestId("slide-rail-image-status-2"),
    ).toHaveAttribute("data-status", "ready");
    expect(
      screen.getByTestId("slide-rail-image-status-3"),
    ).toHaveAttribute("data-status", "failed");
  });

  it("clicking a failed badge invokes onRetryImage with slide id (#993)", () => {
    const onRetryImage = vi.fn();
    render(
      <SlideRail
        items={items}
        {...baseHandlers}
        imageStatusOf={() => "failed"}
        onRetryImage={onRetryImage}
      />,
    );
    fireEvent.click(screen.getByTestId("slide-rail-image-status-1"));
    expect(onRetryImage).toHaveBeenCalledWith("s1");
  });
});
