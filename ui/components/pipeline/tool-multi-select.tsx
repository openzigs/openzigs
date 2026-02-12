"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Check, X } from "lucide-react";

export type ToolOption = {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
};

export type ToolMultiSelectProps = {
  /** All available tools, grouped by category on the backend. */
  tools: ToolOption[];
  /** Currently selected tool names. `null` means "all tools". */
  selected: string[] | null;
  /** Called when selection changes. `null` = all tools. */
  onChange: (selected: string[] | null) => void;
  /** Placeholder text when nothing is selected. */
  placeholder?: string;
  /** If true, `null` is an option meaning "all tools". */
  allowAll?: boolean;
  /** Label above the component. */
  label?: string;
};

type GroupedTools = Record<string, ToolOption[]>;

/**
 * Multi-select dropdown for tools, grouped by category.
 * Replaces the raw comma-separated text input.
 */
export const ToolMultiSelect = ({
  tools,
  selected,
  onChange,
  placeholder = "Select tools…",
  allowAll = true,
  label,
}: ToolMultiSelectProps) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const grouped: GroupedTools = useMemo(() => {
    const result: GroupedTools = {};
    for (const tool of tools) {
      if (!tool.enabled) continue;
      const cat = tool.category || "other";
      if (!result[cat]) result[cat] = [];
      result[cat].push(tool);
    }
    // Sort categories alphabetically
    const sorted: GroupedTools = {};
    for (const key of Object.keys(result).sort()) {
      sorted[key] = result[key].sort((a, b) => a.name.localeCompare(b.name));
    }
    return sorted;
  }, [tools]);

  const filteredGrouped: GroupedTools = useMemo(() => {
    if (!search.trim()) return grouped;
    const q = search.toLowerCase();
    const result: GroupedTools = {};
    for (const [cat, catTools] of Object.entries(grouped)) {
      const filtered = catTools.filter(
        (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || cat.toLowerCase().includes(q)
      );
      if (filtered.length > 0) result[cat] = filtered;
    }
    return result;
  }, [grouped, search]);

  const isAllSelected = selected === null;
  const selectedSet = useMemo(() => new Set(selected ?? []), [selected]);

  const toggleTool = (name: string) => {
    if (isAllSelected) {
      // Switching from "all" to specific — select only this one
      onChange([name]);
      return;
    }
    const next = new Set(selectedSet);
    if (next.has(name)) {
      next.delete(name);
    } else {
      next.add(name);
    }
    onChange(next.size === 0 ? (allowAll ? null : []) : Array.from(next));
  };

  const selectCategory = (cat: string) => {
    const catNames = grouped[cat]?.map((t) => t.name) ?? [];
    if (isAllSelected) {
      onChange(catNames);
      return;
    }
    const next = new Set(selectedSet);
    const allSelected = catNames.every((n) => next.has(n));
    if (allSelected) {
      for (const n of catNames) next.delete(n);
    } else {
      for (const n of catNames) next.add(n);
    }
    onChange(next.size === 0 ? (allowAll ? null : []) : Array.from(next));
  };

  const clearAll = () => {
    onChange(allowAll ? null : []);
  };

  const displayText = isAllSelected
    ? (allowAll ? "All tools" : placeholder)
    : selectedSet.size === 0
      ? placeholder
      : `${selectedSet.size} tool${selectedSet.size !== 1 ? "s" : ""} selected`;

  return (
    <div className="relative">
      {label && <span className="text-xs text-muted-foreground">{label}</span>}

      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mt-1 flex w-full items-center justify-between rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-left"
      >
        <span className={isAllSelected || selectedSet.size === 0 ? "text-muted-foreground" : "text-foreground"}>
          {displayText}
        </span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {/* Selected chips */}
      {!isAllSelected && selectedSet.size > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {Array.from(selectedSet).slice(0, 6).map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary"
            >
              {name}
              <button type="button" onClick={() => toggleTool(name)} className="hover:text-destructive">
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          {selectedSet.size > 6 && (
            <span className="text-[10px] text-muted-foreground">+{selectedSet.size - 6} more</span>
          )}
          <button type="button" onClick={clearAll} className="text-[10px] text-destructive hover:underline ml-1">
            Clear
          </button>
        </div>
      )}

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-64 overflow-y-auto rounded-lg border border-border bg-card shadow-lg">
          {/* Search */}
          <div className="sticky top-0 bg-card p-2 border-b border-border">
            <input
              type="text"
              placeholder="Search tools…"
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>

          {/* "All tools" option */}
          {allowAll && (
            <button
              type="button"
              onClick={() => { onChange(null); }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/50 ${
                isAllSelected ? "bg-primary/5 text-primary font-semibold" : "text-foreground"
              }`}
            >
              <div className={`h-3.5 w-3.5 rounded border flex items-center justify-center ${
                isAllSelected ? "border-primary bg-primary" : "border-border"
              }`}>
                {isAllSelected && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
              </div>
              All tools (no restriction)
            </button>
          )}

          {/* Categories */}
          {Object.entries(filteredGrouped).map(([cat, catTools]) => {
            const catAllSelected = !isAllSelected && catTools.every((t) => selectedSet.has(t.name));
            const catSomeSelected = !isAllSelected && catTools.some((t) => selectedSet.has(t.name));
            return (
              <div key={cat}>
                <button
                  type="button"
                  onClick={() => selectCategory(cat)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-muted/50 border-t border-border"
                >
                  <div className={`h-3.5 w-3.5 rounded border flex items-center justify-center ${
                    catAllSelected ? "border-primary bg-primary" : catSomeSelected ? "border-primary bg-primary/30" : "border-border"
                  }`}>
                    {catAllSelected && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                    {catSomeSelected && !catAllSelected && <div className="h-1.5 w-1.5 rounded-sm bg-primary" />}
                  </div>
                  {cat}
                </button>
                {catTools.map((tool) => {
                  const checked = isAllSelected || selectedSet.has(tool.name);
                  return (
                    <button
                      key={tool.name}
                      type="button"
                      onClick={() => toggleTool(tool.name)}
                      className={`flex w-full items-center gap-2 px-3 py-1 pl-6 text-xs hover:bg-muted/50 ${
                        checked && !isAllSelected ? "bg-primary/5" : ""
                      }`}
                    >
                      <div className={`h-3.5 w-3.5 rounded border flex items-center justify-center shrink-0 ${
                        checked && !isAllSelected ? "border-primary bg-primary" : "border-border"
                      }`}>
                        {checked && !isAllSelected && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                      </div>
                      <div className="text-left min-w-0">
                        <span className="text-foreground">{tool.name}</span>
                        {tool.description && (
                          <p className="text-[10px] text-muted-foreground truncate">{tool.description}</p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })}

          {Object.keys(filteredGrouped).length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No tools match your search.</p>
          )}
        </div>
      )}

      {/* Click-away */}
      {open && (
        <div className="fixed inset-0 z-40" onClick={() => { setOpen(false); setSearch(""); }} />
      )}
    </div>
  );
};
