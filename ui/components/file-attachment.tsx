"use client";

import { useCallback, useRef, useState, type DragEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Paperclip, X, File, Folder } from "lucide-react";
import type { ChatAttachment } from "@/lib/types";

const MAX_ATTACHMENTS = 10;

/* ── Attachment Chip ── */

export const AttachmentChip = ({
  attachment,
  onRemove,
}: {
  attachment: ChatAttachment;
  onRemove: () => void;
}) => (
  <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-foreground">
    {attachment.type === "directory" ? (
      <Folder className="h-3 w-3 text-muted-foreground" />
    ) : (
      <File className="h-3 w-3 text-muted-foreground" />
    )}
    <span className="max-w-[120px] truncate">{attachment.name}</span>
    <button
      type="button"
      onClick={onRemove}
      className="ml-0.5 rounded-full p-0.5 hover:bg-destructive/10 hover:text-destructive focus:outline-none focus:ring-1 focus:ring-destructive"
      aria-label={`Remove ${attachment.name}`}
    >
      <X className="h-3 w-3" />
    </button>
  </span>
);

/* ── File Attachment Button ── */

export const FileAttachmentButton = ({
  onAttach,
  disabled,
  attachmentCount,
}: {
  onAttach: (files: ChatAttachment[]) => void;
  disabled?: boolean;
  attachmentCount: number;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const fileList = e.target.files;
      if (!fileList) return;
      const remaining = MAX_ATTACHMENTS - attachmentCount;
      const newAttachments: ChatAttachment[] = [];
      for (let i = 0; i < Math.min(fileList.length, remaining); i++) {
        const file = fileList[i];
        newAttachments.push({
          type: "file",
          path: file.name,
          name: file.name,
        });
      }
      if (newAttachments.length > 0) onAttach(newAttachments);
      // Reset so the same file can be re-picked
      if (inputRef.current) inputRef.current.value = "";
    },
    [onAttach, attachmentCount]
  );

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 rounded-lg"
            disabled={disabled || attachmentCount >= MAX_ATTACHMENTS}
            onClick={() => inputRef.current?.click()}
            aria-label="Attach files"
          >
            <Paperclip className="h-4 w-4 text-muted-foreground" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {attachmentCount >= MAX_ATTACHMENTS ? (
            <p>Maximum {MAX_ATTACHMENTS} attachments reached</p>
          ) : (
            <p>Attach files ({attachmentCount}/{MAX_ATTACHMENTS})</p>
          )}
        </TooltipContent>
      </Tooltip>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleChange}
        tabIndex={-1}
      />
    </TooltipProvider>
  );
};

/* ── File Drop Zone ── */

export const FileDropZone = ({
  children,
  onDrop,
  attachmentCount,
  disabled,
}: {
  children: ReactNode;
  onDrop: (files: ChatAttachment[]) => void;
  attachmentCount: number;
  disabled?: boolean;
}) => {
  const [dragActive, setDragActive] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled) return;
      dragCounterRef.current++;
      setDragActive(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      setDragActive(false);
      dragCounterRef.current = 0;
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      dragCounterRef.current = 0;

      if (disabled) return;

      const items = e.dataTransfer?.files;
      if (!items) return;

      const remaining = MAX_ATTACHMENTS - attachmentCount;
      const newAttachments: ChatAttachment[] = [];
      for (let i = 0; i < Math.min(items.length, remaining); i++) {
        const file = items[i];
        newAttachments.push({
          type: "file",
          path: file.name,
          name: file.name,
        });
      }
      if (newAttachments.length > 0) onDrop(newAttachments);
    },
    [onDrop, attachmentCount, disabled]
  );

  return (
    <div
      className={cn(
        "relative rounded-lg transition-colors",
        dragActive && !disabled && "ring-2 ring-dashed ring-primary/50 bg-primary/5"
      )}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}
      {dragActive && !disabled && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-primary/5">
          <p className="text-sm font-medium text-primary">Drop files to attach</p>
        </div>
      )}
    </div>
  );
};

/* ── Attachment Bar (chips below textarea) ── */

export const AttachmentBar = ({
  attachments,
  onRemove,
}: {
  attachments: ChatAttachment[];
  onRemove: (index: number) => void;
}) => {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 px-1 pt-2" role="list" aria-label="Attached files">
      {attachments.map((att, i) => (
        <AttachmentChip key={`${att.path}-${i}`} attachment={att} onRemove={() => onRemove(i)} />
      ))}
    </div>
  );
};
