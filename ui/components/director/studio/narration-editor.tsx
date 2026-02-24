"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Mic, Sparkles, ChevronDown } from "lucide-react";

export interface NarrationDirective {
  tag: string;
  label: string;
  description: string;
}

export interface VoicePreset {
  id: string;
  label: string;
  language: string;
  gender: string;
  style: string;
}

interface NarrationEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave: (value: string) => void;
  directives?: NarrationDirective[];
  voices?: VoicePreset[];
  /** F5-TTS emotion labels for emotion tag insertion */
  emotionTags?: string[];
  disabled?: boolean;
}

/**
 * Script narration editor with directive autocomplete.
 * Triggers autocomplete on `[` character to insert speech directives.
 */
export function NarrationEditor({
  value,
  onChange,
  onSave,
  directives = [],
  voices = [],
  emotionTags = [],
  disabled = false,
}: NarrationEditorProps) {
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteFilter, setAutocompleteFilter] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  const [showEmotionPicker, setShowEmotionPicker] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autocompleteRef = useRef<HTMLDivElement>(null);
  const [dirty, setDirty] = useState(false);

  // Combined items: directives + extra voice presets
  const allDirectives: NarrationDirective[] = [
    ...directives,
    ...voices
      .filter((v) => !directives.some((d) => d.tag.includes(v.id)))
      .map((v) => ({
        tag: `[VOICE: ${v.id}]`,
        label: `Voice: ${v.style}`,
        description: `Switch to ${v.id} — ${v.style}`,
      })),
  ];

  const filteredDirectives = autocompleteFilter
    ? allDirectives.filter(
        (d) =>
          d.tag.toLowerCase().includes(autocompleteFilter.toLowerCase()) ||
          d.label.toLowerCase().includes(autocompleteFilter.toLowerCase()),
      )
    : allDirectives;

  const insertDirective = useCallback(
    (tag: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const cursor = textarea.selectionStart;
      const textBefore = value.slice(0, cursor);
      const textAfter = value.slice(cursor);

      // Replace from the last `[` to cursor
      const lastBracket = textBefore.lastIndexOf("[");
      const prefix = lastBracket >= 0 ? value.slice(0, lastBracket) : textBefore;
      const newValue = prefix + tag + textAfter;

      onChange(newValue);
      setDirty(true);
      setShowAutocomplete(false);
      setAutocompleteFilter("");

      // Re-focus and position cursor after the inserted tag
      requestAnimationFrame(() => {
        textarea.focus();
        const newCursor = prefix.length + tag.length;
        textarea.setSelectionRange(newCursor, newCursor);
      });
    },
    [value, onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showAutocomplete) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIdx((i) => Math.min(i + 1, filteredDirectives.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIdx((i) => Math.max(i - 1, 0));
        } else if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          if (filteredDirectives[selectedIdx]) {
            insertDirective(filteredDirectives[selectedIdx].tag);
          }
        } else if (e.key === "Escape") {
          e.preventDefault();
          setShowAutocomplete(false);
        }
      }
    },
    [showAutocomplete, filteredDirectives, selectedIdx, insertDirective],
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      onChange(newValue);
      setDirty(true);

      // Check if we should show autocomplete
      const textarea = textareaRef.current;
      if (!textarea) return;
      const cursor = textarea.selectionStart;
      const textBefore = newValue.slice(0, cursor);

      // Find the last `[` that doesn't have a closing `]`
      const lastBracket = textBefore.lastIndexOf("[");
      if (lastBracket >= 0 && !textBefore.slice(lastBracket).includes("]")) {
        const filterText = textBefore.slice(lastBracket);
        setAutocompleteFilter(filterText);
        setShowAutocomplete(true);
        setSelectedIdx(0);
      } else {
        setShowAutocomplete(false);
        setAutocompleteFilter("");
      }
    },
    [onChange],
  );

  // Close autocomplete on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        autocompleteRef.current &&
        !autocompleteRef.current.contains(e.target as Node) &&
        textareaRef.current &&
        !textareaRef.current.contains(e.target as Node)
      ) {
        setShowAutocomplete(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    if (showAutocomplete && autocompleteRef.current) {
      const items = autocompleteRef.current.querySelectorAll("[data-autocomplete-item]");
      items[selectedIdx]?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIdx, showAutocomplete]);

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Mic className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-[11px] font-medium text-foreground">Narration</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowVoicePicker((v) => !v)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted transition"
            title="Insert directive"
          >
            <Sparkles className="h-3 w-3" />
            Directives
            <ChevronDown className="h-3 w-3" />
          </button>
          {emotionTags.length > 0 && (
            <button
              onClick={() => setShowEmotionPicker((v) => !v)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted transition"
              title="Insert F5-TTS emotion tag"
            >
              <Mic className="h-3 w-3" />
              Emotions
              <ChevronDown className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Voice directive quick-insert panel */}
      {showVoicePicker && (
        <div className="mb-2 grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/50 p-2">
          {allDirectives.slice(0, 14).map((d) => (
            <button
              key={d.tag}
              onClick={() => {
                insertDirectiveAtEnd(d.tag);
                setShowVoicePicker(false);
              }}
              className="rounded px-2 py-1 text-left text-[10px] hover:bg-muted transition"
              title={d.description}
            >
              <span className="block font-medium text-foreground">{d.label}</span>
              <span className="block text-muted-foreground font-mono">{d.tag}</span>
            </button>
          ))}
        </div>
      )}

      {/* F5-TTS emotion tag quick-insert panel */}
      {showEmotionPicker && emotionTags.length > 0 && (
        <div className="mb-2 rounded-md border border-border bg-muted/50 p-2">
          <p className="mb-1.5 text-[10px] text-muted-foreground">
            Insert an emotion tag — F5-TTS will use the matching reference clip.
          </p>
          <div className="flex flex-wrap gap-1">
            {emotionTags.map((emotion) => (
              <button
                key={emotion}
                onClick={() => {
                  insertDirectiveAtEnd(`(${emotion})`);
                  setShowEmotionPicker(false);
                }}
                className="rounded-full border border-border px-2.5 py-1 text-[10px] font-medium text-foreground hover:border-primary/40 hover:bg-primary/5 transition"
              >
                ({emotion})
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="relative">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (dirty) {
              onSave(value);
              setDirty(false);
            }
          }}
          disabled={disabled}
          rows={4}
          placeholder="Enter narration script… Type [ for speech directives"
          className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs font-mono leading-relaxed placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
        />

        {/* Autocomplete dropdown */}
        {showAutocomplete && filteredDirectives.length > 0 && (
          <div
            ref={autocompleteRef}
            className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-popover shadow-lg"
          >
            {filteredDirectives.map((d, i) => (
              <button
                key={d.tag}
                data-autocomplete-item
                onClick={() => insertDirective(d.tag)}
                className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs transition ${i === selectedIdx ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                  }`}
              >
                <span className="shrink-0 font-mono text-[10px] text-primary">{d.tag}</span>
                <span className="text-muted-foreground">{d.description}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {dirty && (
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[10px] text-amber-500">Unsaved changes</span>
          <button
            onClick={() => {
              onSave(value);
              setDirty(false);
            }}
            className="rounded bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground hover:bg-primary/90 transition"
          >
            Save
          </button>
        </div>
      )}

      <p className="mt-1 text-[9px] text-muted-foreground">
        Type <span className="font-mono">[</span> for speech directives • <span className="font-mono">(Emotion)</span> for F5-TTS • <span className="font-mono">*word*</span> for emphasis
      </p>
    </div>
  );

  function insertDirectiveAtEnd(tag: string) {
    const textarea = textareaRef.current;
    if (!textarea) {
      onChange(value + tag);
      setDirty(true);
      return;
    }
    const cursor = textarea.selectionStart;
    const newValue = value.slice(0, cursor) + tag + value.slice(cursor);
    onChange(newValue);
    setDirty(true);
    requestAnimationFrame(() => {
      textarea.focus();
      const newCursor = cursor + tag.length;
      textarea.setSelectionRange(newCursor, newCursor);
    });
  }
}
