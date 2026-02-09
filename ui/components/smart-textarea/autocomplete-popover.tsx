"use client";

import { useEffect, useRef } from "react";
import { Command } from "cmdk";
import * as Popover from "@radix-ui/react-popover";
import { Hash, Slash, AtSign } from "lucide-react";
import type { TriggerKind, UseAutocompleteReturn } from "./use-autocomplete";

type AutocompletePopoverProps = Pick<
  UseAutocompleteReturn,
  "open" | "triggerKind" | "query" | "filtered" | "onSelect" | "dismiss"
> & {
  /** Anchor element — the textarea the popover attaches to. */
  anchorRef: React.RefObject<HTMLTextAreaElement | null>;
};

const TRIGGER_ICON: Record<TriggerKind, React.ReactNode> = {
  commands: <Slash className="h-3.5 w-3.5" />,
  tools: <Hash className="h-3.5 w-3.5" />,
  models: <AtSign className="h-3.5 w-3.5" />,
};

const TRIGGER_LABEL: Record<TriggerKind, string> = {
  commands: "Prompts",
  tools: "Tools",
  models: "Models",
};

/**
 * The autocomplete popover that appears above the textarea when a trigger
 * character is typed. Uses cmdk for keyboard navigation + filtering
 * inside a Radix Popover for positioning.
 */
export const AutocompletePopover = ({
  open,
  triggerKind,
  filtered,
  onSelect,
  dismiss,
  anchorRef,
}: AutocompletePopoverProps) => {
  const listRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        dismiss();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, dismiss]);

  if (!open || !triggerKind || filtered.length === 0) return null;

  return (
    <Popover.Root open={open} onOpenChange={(o) => !o && dismiss()}>
      <Popover.Anchor asChild>
        <span
          style={{
            position: "absolute",
            bottom: "100%",
            left: 0,
            width: "100%",
            height: 0,
            pointerEvents: "none",
          }}
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          className="z-50 w-72 rounded-xl border border-border bg-popover p-0 shadow-lg animate-in fade-in-0 zoom-in-95"
          onOpenAutoFocus={(e) => {
            // Don't steal focus from the textarea
            e.preventDefault();
          }}
          onInteractOutside={(e) => {
            // Don't close if user clicks back in textarea
            if (anchorRef.current?.contains(e.target as Node)) {
              e.preventDefault();
            }
          }}
        >
          <Command
            className="flex flex-col"
            shouldFilter={false}
            loop
          >
            {/* Header */}
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
              {TRIGGER_ICON[triggerKind]}
              <span>{TRIGGER_LABEL[triggerKind]}</span>
              <span className="ml-auto text-[10px] tabular-nums">
                {filtered.length} result{filtered.length !== 1 ? "s" : ""}
              </span>
            </div>

            {/* List */}
            <Command.List
              ref={listRef}
              className="max-h-52 overflow-y-auto px-1 py-1"
            >
              <Command.Empty className="px-3 py-2 text-xs text-muted-foreground">
                No matches
              </Command.Empty>
              {filtered.map((item) => (
                <Command.Item
                  key={`${item.kind}-${item.value}`}
                  value={item.value}
                  onSelect={() => onSelect(item)}
                  className="flex cursor-pointer flex-col gap-0.5 rounded-lg px-3 py-2 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
                >
                  <span className="font-medium">{item.label}</span>
                  {item.description && (
                    <span className="line-clamp-1 text-xs text-muted-foreground">
                      {item.description}
                    </span>
                  )}
                </Command.Item>
              ))}
            </Command.List>

            {/* Footer hint */}
            <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
              ↑↓ navigate · ↵ select · esc dismiss
            </div>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};
