"use client";

import { useState } from "react";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { MoreVertical } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/confirm-dialog";

export interface SlideRailItem {
  id: string;
  position: number;
  template: string;
  /** Already-sanitized title preview (≤ 40 chars). */
  titlePreview: string;
}

export interface SlideRailProps {
  items: SlideRailItem[];
  selectedSlideId: string | null;
  onSelect: (slideId: string) => void;
  onReorder: (slideId: string, newPosition: number) => Promise<void> | void;
  onAddAbove: (slideId: string) => void;
  onAddBelow: (slideId: string) => void;
  onDuplicate: (slideId: string) => void;
  onDelete: (slideId: string) => void;
}

export const SlideRail = ({
  items,
  selectedSlideId,
  onSelect,
  onReorder,
  onAddAbove,
  onAddBelow,
  onDuplicate,
  onDelete,
}: SlideRailProps) => {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  // Local copy so we can do optimistic reorder + rollback on failure.
  const [localItems, setLocalItems] = useState<SlideRailItem[] | null>(null);
  const view = localItems ?? items;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = view.findIndex((s) => s.id === active.id);
    const newIdx = view.findIndex((s) => s.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const optimistic = arrayMove(view, oldIdx, newIdx).map((s, i) => ({
      ...s,
      position: i,
    }));
    const previous = view;
    setLocalItems(optimistic);
    try {
      await onReorder(String(active.id), newIdx);
      // Server is now source of truth; clear local override on next prop sync.
      setLocalItems(null);
    } catch {
      // Rollback.
      setLocalItems(previous);
    }
  };

  const confirmDelete = () => {
    if (pendingDelete) {
      onDelete(pendingDelete);
      setPendingDelete(null);
    }
  };

  return (
    <aside
      className="flex h-full w-44 flex-col border-r border-border bg-card"
      data-testid="slide-rail"
    >
      <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Slides ({view.length})
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={view.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="flex flex-col gap-1">
              {view.map((item, idx) => (
                <SlideRailRow
                  key={item.id}
                  item={item}
                  index={idx}
                  selected={selectedSlideId === item.id}
                  onSelect={onSelect}
                  onAddAbove={onAddAbove}
                  onAddBelow={onAddBelow}
                  onDuplicate={onDuplicate}
                  onRequestDelete={(id) => setPendingDelete(id)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </div>
      {pendingDelete && (
        <ConfirmDialog
          title="Delete slide"
          message="This action cannot be undone."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </aside>
  );
};

interface RowProps {
  item: SlideRailItem;
  index: number;
  selected: boolean;
  onSelect: (id: string) => void;
  onAddAbove: (id: string) => void;
  onAddBelow: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRequestDelete: (id: string) => void;
}

const SlideRailRow = ({
  item,
  index,
  selected,
  onSelect,
  onAddAbove,
  onAddBelow,
  onDuplicate,
  onRequestDelete,
}: RowProps) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid={`slide-rail-row-${item.id}`}
      className={`group relative cursor-pointer rounded-md border p-2 text-xs ${
        selected
          ? "border-primary bg-primary/10"
          : "border-border bg-background hover:bg-muted/50"
      }`}
      onClick={() => onSelect(item.id)}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {index + 1} · {item.template}
          </div>
          <div className="mt-0.5 truncate font-medium text-foreground">
            {item.titlePreview || "Untitled"}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Slide ${index + 1} actions`}
              data-testid={`slide-rail-actions-${item.id}`}
              className="rounded p-1 text-muted-foreground opacity-0 hover:bg-muted group-hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <MoreVertical className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onAddAbove(item.id)}>
              Add slide above
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAddBelow(item.id)}>
              Add slide below
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDuplicate(item.id)}>
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onRequestDelete(item.id)}
              className="text-red-500 focus:text-red-500"
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
};

export default SlideRail;
