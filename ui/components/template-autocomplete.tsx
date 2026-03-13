"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Built-in variables resolved at execution time by the scheduler. */
export const BUILT_IN_VARIABLES: Array<{ name: string; icon: string; description: string }> = [
  { name: "today", icon: "📅", description: "Current date (YYYY-MM-DD)" },
  { name: "now", icon: "🕐", description: "Current datetime (ISO)" },
  { name: "day_of_week", icon: "📆", description: "Day name (Monday, Tuesday…)" },
  { name: "month", icon: "📆", description: "Month name" },
  { name: "year", icon: "📆", description: "Year" },
];

const BUILT_IN_NAMES = new Set(BUILT_IN_VARIABLES.map((v) => v.name));

type Props = {
  value: string;
  onChange: (value: string) => void;
  customVariables?: string[];
  className?: string;
  rows?: number;
  placeholder?: string;
};

/**
 * Textarea with `{{` autocomplete popup for template variables.
 * Shows built-in variables and custom variables extracted from the template.
 */
export function TemplateAutocomplete({ value, onChange, customVariables = [], className, rows = 8, placeholder }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showPopup, setShowPopup] = useState(false);
  const [popupPosition, setPopupPosition] = useState({ top: 0, left: 0 });
  const [filterText, setFilterText] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const popupRef = useRef<HTMLDivElement>(null);

  const allItems = [
    ...BUILT_IN_VARIABLES,
    ...customVariables
      .filter((v) => !BUILT_IN_NAMES.has(v))
      .map((v) => ({ name: v, icon: "📝", description: "(custom variable)" })),
  ];

  const filtered = filterText
    ? allItems.filter((v) => v.name.toLowerCase().startsWith(filterText.toLowerCase()))
    : allItems;

  const getCursorXY = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return { top: 0, left: 0 };
    // Simple approach: position below textarea cursor using scrollTop
    const rect = ta.getBoundingClientRect();
    const lineHeight = 20;
    const lines = value.slice(0, ta.selectionStart).split("\n");
    const currentLine = lines.length - 1;
    const visibleLine = currentLine - Math.floor(ta.scrollTop / lineHeight);
    return {
      top: Math.min(visibleLine * lineHeight + lineHeight + 4, rect.height),
      left: Math.min((lines[currentLine]?.length ?? 0) * 7.2, rect.width - 200),
    };
  }, [value]);

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      onChange(newValue);

      const cursorPos = e.target.selectionStart;
      const textBeforeCursor = newValue.slice(0, cursorPos);

      // Check if we're inside a {{ context
      const lastOpen = textBeforeCursor.lastIndexOf("{{");
      const lastClose = textBeforeCursor.lastIndexOf("}}");

      if (lastOpen > lastClose && lastOpen >= 0) {
        const partial = textBeforeCursor.slice(lastOpen + 2);
        // Only show if partial is alphanumeric/underscore (valid variable name chars)
        if (/^[\w]*$/.test(partial)) {
          setFilterText(partial);
          setShowPopup(true);
          setSelectedIndex(0);
          setPopupPosition(getCursorXY());
          return;
        }
      }

      setShowPopup(false);
    },
    [onChange, getCursorXY],
  );

  const insertVariable = useCallback(
    (varName: string) => {
      const ta = textareaRef.current;
      if (!ta) return;

      const cursorPos = ta.selectionStart;
      const textBeforeCursor = value.slice(0, cursorPos);
      const lastOpen = textBeforeCursor.lastIndexOf("{{");

      if (lastOpen >= 0) {
        const before = value.slice(0, lastOpen);
        const after = value.slice(cursorPos);
        const newValue = `${before}{{${varName}}}${after}`;
        onChange(newValue);

        // Set cursor after the inserted variable
        requestAnimationFrame(() => {
          const newPos = lastOpen + varName.length + 4; // {{ + name + }}
          ta.selectionStart = newPos;
          ta.selectionEnd = newPos;
          ta.focus();
        });
      }

      setShowPopup(false);
    },
    [value, onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!showPopup || filtered.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % filtered.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertVariable(filtered[selectedIndex].name);
      } else if (e.key === "Escape") {
        setShowPopup(false);
      }
    },
    [showPopup, filtered, selectedIndex, insertVariable],
  );

  // Close popup on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        setShowPopup(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        className={className}
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
      />
      {showPopup && filtered.length > 0 && (
        <div
          ref={popupRef}
          className="absolute z-50 w-72 max-h-48 overflow-y-auto rounded-lg border border-border bg-card shadow-lg"
          style={{ top: popupPosition.top, left: popupPosition.left }}
        >
          {filtered.map((item, i) => (
            <button
              key={item.name}
              type="button"
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                i === selectedIndex ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted"
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertVariable(item.name);
              }}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className="text-sm">{item.icon}</span>
              <span className="font-mono font-semibold">{item.name}</span>
              <span className="ml-auto text-[10px] text-muted-foreground">{item.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
