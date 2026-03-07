"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Trigger characters that open the autocomplete popover. */
export const TRIGGER_CHARS = {
  "/": "commands" as const,
  "#": "tools" as const,
  "@": "models" as const,
  "!": "skills" as const,
};

export type TriggerKind = (typeof TRIGGER_CHARS)[keyof typeof TRIGGER_CHARS];

export type AutocompleteItem = {
  /** Unique value inserted on selection (without the trigger prefix). */
  value: string;
  /** Display label shown in the popover list. */
  label: string;
  /** Optional description text beneath the label. */
  description?: string;
  /** The kind/group this item belongs to. */
  kind: TriggerKind;
};

export type UseAutocompleteOptions = {
  /** All available items, pre-categorised by kind. */
  items: AutocompleteItem[];
  /** Current textarea value (controlled). */
  value: string;
  /** Callback to update the textarea value. */
  onChange: (value: string) => void;
  /** Ref to the underlying textarea DOM element. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
};

export type UseAutocompleteReturn = {
  /** Whether the popover should be open. */
  open: boolean;
  /** The current trigger kind (commands, tools, models) or null. */
  triggerKind: TriggerKind | null;
  /** The query string typed after the trigger character. */
  query: string;
  /** Filtered items matching the current query. */
  filtered: AutocompleteItem[];
  /** Index of the currently highlighted item. */
  activeIndex: number;
  /** Set the highlighted index directly. */
  setActiveIndex: (index: number) => void;
  /** Call when user selects an item from the popover. */
  onSelect: (item: AutocompleteItem) => void;
  /** Move the highlight by N items (positive or negative). */
  moveSelection: (delta: number) => void;
  /** Select the currently highlighted item, if any. */
  selectActive: () => void;
  /** Dismiss the popover manually. */
  dismiss: () => void;
};

/**
 * Hook that detects trigger characters (/, #, @) in a textarea and provides
 * autocomplete state. It tracks cursor position and matches text after the
 * trigger character against the provided item list.
 */
export function useAutocomplete({
  items,
  value,
  onChange,
  textareaRef,
}: UseAutocompleteOptions): UseAutocompleteReturn {
  const [open, setOpen] = useState(false);
  const [triggerKind, setTriggerKind] = useState<TriggerKind | null>(null);
  const [query, setQuery] = useState("");
  const [triggerPosition, setTriggerPosition] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const dismissed = useRef(false);

  /**
   * Scan the text behind the cursor for a trigger character.
   * Returns the trigger kind + query, or null if no active trigger.
   */
  const detect = useCallback(
    (text: string, cursorPos: number) => {
      if (cursorPos === 0) return null;

      // Walk backwards from cursor to find a trigger char
      const before = text.slice(0, cursorPos);
      // Find the last trigger char that isn't preceded by a non-whitespace char
      for (let i = before.length - 1; i >= 0; i--) {
        const ch = before[i];
        // If we hit whitespace or start of string before finding trigger, stop
        if (ch === " " || ch === "\n" || ch === "\t") return null;

        if (ch in TRIGGER_CHARS) {
          // Trigger must be at start of input or preceded by whitespace
          if (i === 0 || /\s/.test(before[i - 1])) {
            const kind = TRIGGER_CHARS[ch as keyof typeof TRIGGER_CHARS];
            const q = before.slice(i + 1);
            return { kind, query: q, position: i };
          }
          return null;
        }
      }
      return null;
    },
    []
  );

  /**
   * Called on every textarea input/cursor change to update autocomplete state.
   */
  const update = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    const cursorPos = el.selectionStart;
    const result = detect(value, cursorPos);

    if (result && !dismissed.current) {
      setTriggerKind(result.kind);
      setQuery(result.query);
      setTriggerPosition(result.position);
      setOpen(true);
    } else {
      setOpen(false);
      setTriggerKind(null);
      setQuery("");
      setTriggerPosition(null);
    }
  }, [value, detect, textareaRef]);

  // Re-detect on value or cursor changes
  useEffect(() => {
    update();
    // Reset dismissed flag when value changes (user typed something new)
    dismissed.current = false;
  }, [update]);

  /** Filter items by kind + fuzzy query match. */
  const filtered = useMemo(() => {
    if (!triggerKind) return [];
    const lowerQuery = query.toLowerCase();
    return items
      .filter((item) => item.kind === triggerKind)
      .filter(
        (item) =>
          !lowerQuery ||
          item.label.toLowerCase().includes(lowerQuery) ||
          item.value.toLowerCase().includes(lowerQuery) ||
          item.description?.toLowerCase().includes(lowerQuery)
      );
  }, [items, triggerKind, query]);

  useEffect(() => {
    if (!open || filtered.length === 0) {
      setActiveIndex(-1);
      return;
    }
    setActiveIndex(0);
  }, [open, filtered.length]);

  /** Replace the trigger + query in the textarea with the selected item value. */
  const onSelect = useCallback(
    (item: AutocompleteItem) => {
      if (triggerPosition === null) return;

      const el = textareaRef.current;
      const cursorPos = el?.selectionStart ?? value.length;

      const before = value.slice(0, triggerPosition);
      const after = value.slice(cursorPos);
      const insertion = `${item.value} `;
      const newValue = `${before}${insertion}${after}`;

      onChange(newValue);
      setOpen(false);
      setTriggerKind(null);
      setQuery("");
      setTriggerPosition(null);

      // Restore focus and cursor position
      requestAnimationFrame(() => {
        if (el) {
          el.focus();
          const newCursor = before.length + insertion.length;
          el.setSelectionRange(newCursor, newCursor);
        }
      });
    },
    [triggerPosition, value, onChange, textareaRef]
  );

  const moveSelection = useCallback(
    (delta: number) => {
      if (filtered.length === 0) return;
      setActiveIndex((prev) => {
        const next = prev < 0 ? 0 : (prev + delta + filtered.length) % filtered.length;
        return next;
      });
    },
    [filtered.length]
  );

  const selectActive = useCallback(() => {
    if (activeIndex < 0 || activeIndex >= filtered.length) return;
    onSelect(filtered[activeIndex]);
  }, [activeIndex, filtered, onSelect]);

  const dismiss = useCallback(() => {
    dismissed.current = true;
    setOpen(false);
    setTriggerKind(null);
    setQuery("");
    setTriggerPosition(null);
  }, []);

  return {
    open,
    triggerKind,
    query,
    filtered,
    activeIndex,
    setActiveIndex,
    onSelect,
    moveSelection,
    selectActive,
    dismiss,
  };
}
