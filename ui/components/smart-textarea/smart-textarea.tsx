"use client";

import { forwardRef, useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import { useAutocomplete, type AutocompleteItem, type TriggerKind } from "./use-autocomplete";
import { AutocompletePopover } from "./autocomplete-popover";
import type { ToolInfo, SavedPrompt, ModelInfo } from "@/lib/types";

export type SmartTextareaProps = Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "onChange" | "value"
> & {
  /** Controlled value. */
  value: string;
  /** Controlled onChange — receives new string value. */
  onValueChange: (value: string) => void;
  /** Available tools for # trigger. */
  tools?: ToolInfo[];
  /** Saved prompts for / trigger. */
  prompts?: SavedPrompt[];
  /** Available models for @ trigger. */
  models?: ModelInfo[];
};

/**
 * Drop-in textarea replacement with inline autocomplete.
 *
 * Trigger characters:
 * - `/` — saved prompts (commands)
 * - `#` — enabled tools
 * - `@` — available models
 *
 * The component renders a standard `<textarea>` with an autocomplete popover
 * anchored above it. All native textarea props (except `value`/`onChange`)
 * are forwarded.
 */
export const SmartTextarea = forwardRef<HTMLTextAreaElement, SmartTextareaProps>(
  ({ value, onValueChange, tools, prompts, models, className, onKeyDown, ...rest }, ref) => {
    // Stable ref object for the autocomplete hook
    const stableRef = useMemo(() => ({ current: null as HTMLTextAreaElement | null }), []);
    const mergedRef = useCallback(
      (node: HTMLTextAreaElement | null) => {
        if (typeof ref === "function") ref(node);
        else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
        stableRef.current = node;
      },
      [ref, stableRef]
    );

    /** Build the autocomplete item list from tools/prompts/models. */
    const items: AutocompleteItem[] = useMemo(() => {
      const result: AutocompleteItem[] = [];

      if (Array.isArray(tools)) {
        for (const tool of tools) {
          if (!tool.enabled) continue;
          result.push({
            value: tool.name,
            label: tool.name,
            description: tool.description,
            kind: "tools" as TriggerKind,
          });
        }
      }

      if (prompts) {
        for (const prompt of prompts) {
          result.push({
            value: prompt.name,
            label: prompt.name,
            description: prompt.description || prompt.template.slice(0, 80),
            kind: "commands" as TriggerKind,
          });
        }
      }

      if (models) {
        for (const model of models) {
          result.push({
            value: model.id,
            label: model.id,
            kind: "models" as TriggerKind,
          });
        }
      }

      return result;
    }, [tools, prompts, models]);

    const autocomplete = useAutocomplete({
      items,
      value,
      onChange: onValueChange,
      textareaRef: stableRef,
    });

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (autocomplete.open) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            autocomplete.moveSelection(1);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            autocomplete.moveSelection(-1);
            return;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            autocomplete.selectActive();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            autocomplete.dismiss();
            return;
          }
        }

        onKeyDown?.(event);
      },
      [autocomplete, onKeyDown]
    );

    return (
      <div className="relative">
        {/* Popover rendered above the textarea */}
        <AutocompletePopover
          open={autocomplete.open}
          triggerKind={autocomplete.triggerKind}
          query={autocomplete.query}
          filtered={autocomplete.filtered}
          activeIndex={autocomplete.activeIndex}
          setActiveIndex={autocomplete.setActiveIndex}
          onSelect={autocomplete.onSelect}
          dismiss={autocomplete.dismiss}
          anchorRef={stableRef}
        />

        <textarea
          ref={mergedRef}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={handleKeyDown}
          className={cn(
            "w-full resize-none rounded-xl border border-input bg-background px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            className
          )}
          {...rest}
        />
      </div>
    );
  }
);

SmartTextarea.displayName = "SmartTextarea";
