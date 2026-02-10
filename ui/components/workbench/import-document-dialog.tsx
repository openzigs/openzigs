"use client";

import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  FileUp,
  Loader2,
  AlertCircle,
} from "lucide-react";

/** Extensions accepted by the backend convert endpoint. */
const CONVERTIBLE_EXTENSIONS = new Set([
  ".docx", ".pdf", ".pptx", ".xlsx", ".html", ".htm",
  ".rtf", ".csv", ".tsv", ".epub",
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".webp",
  ".mp3", ".wav", ".m4a", ".ogg",
]);

const isConvertible = (name: string): boolean => {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return CONVERTIBLE_EXTENSIONS.has(ext);
};

type FileEntry = { name: string; type: "file" | "directory" };

type ImportDocumentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rootDir: string;
  onImport: (markdown: string, originalPath: string) => void;
};

/* ------------------------------------------------------------------ */
/*  Recursive folder/file browser filtered to convertible documents   */
/* ------------------------------------------------------------------ */

type BrowseFolderProps = {
  dirPath: string;
  name: string;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
};

const BrowseFolder = ({ dirPath, name, depth, selectedPath, onSelect }: BrowseFolderProps) => {
  const [expanded, setExpanded] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["files", "list", dirPath],
    queryFn: () =>
      fetchJson<{ entries: FileEntry[] }>(
        `/api/files/list?path=${encodeURIComponent(dirPath)}`
      ),
    enabled: expanded,
    staleTime: 10_000,
  });

  const entries = data?.entries ?? [];
  // Show directories + only convertible files
  const filtered = entries.filter(
    (e) => e.type === "directory" || isConvertible(e.name)
  );
  const sorted = [...filtered].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // If nothing is convertible and no subdirs, don't render this folder at all
  // (only after loading – show it while loading so user can explore)
  if (expanded && !isLoading && sorted.length === 0) {
    return null;
  }

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition hover:bg-accent/10",
          "text-muted-foreground hover:text-foreground"
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        {expanded ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        )}
        <span className="truncate">{name}</span>
      </button>

      {expanded && (
        <div>
          {isLoading && (
            <div
              className="px-2 py-1 text-[10px] text-muted-foreground"
              style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
            >
              Loading…
            </div>
          )}
          {sorted.map((entry) => {
            const entryPath = `${dirPath}/${entry.name}`;
            if (entry.type === "directory") {
              return (
                <BrowseFolder
                  key={entryPath}
                  dirPath={entryPath}
                  name={entry.name}
                  depth={depth + 1}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                />
              );
            }
            return (
              <button
                key={entryPath}
                onClick={() => onSelect(entryPath)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition",
                  selectedPath === entryPath
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:bg-accent/10 hover:text-foreground"
                )}
                style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
              >
                <File className="h-3 w-3 shrink-0" />
                <span className="truncate">{entry.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Main dialog                                                       */
/* ------------------------------------------------------------------ */

export const ImportDocumentDialog = ({
  open,
  onOpenChange,
  rootDir,
  onImport,
}: ImportDocumentDialogProps) => {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const { data, isLoading: rootLoading } = useQuery({
    queryKey: ["files", "list", rootDir],
    queryFn: () =>
      fetchJson<{ entries: FileEntry[] }>(
        `/api/files/list?path=${encodeURIComponent(rootDir)}`
      ),
    enabled: open,
    staleTime: 10_000,
  });

  const convertMutation = useMutation({
    mutationFn: async (filePath: string) => {
      return fetchJson<{ markdown: string; originalPath: string }>(
        "/api/files/convert",
        {
          method: "POST",
          body: JSON.stringify({ path: filePath }),
        }
      );
    },
    onSuccess: (result) => {
      onImport(result.markdown, result.originalPath);
      onOpenChange(false);
      setSelectedPath(null);
    },
  });

  const handleImport = useCallback(() => {
    if (selectedPath) {
      convertMutation.mutate(selectedPath);
    }
  }, [selectedPath, convertMutation]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setSelectedPath(null);
        convertMutation.reset();
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, convertMutation]
  );

  const entries = data?.entries ?? [];
  const filtered = entries.filter(
    (e) => e.type === "directory" || isConvertible(e.name)
  );
  const sorted = [...filtered].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp className="h-5 w-5" />
            Import Document
          </DialogTitle>
          <DialogDescription>
            Select a document to convert to Markdown. Supported formats include
            Word, PDF, PowerPoint, Excel, HTML, images, and audio files.
          </DialogDescription>
        </DialogHeader>

        {/* File browser */}
        <div className="max-h-72 overflow-y-auto rounded-lg border border-border bg-background p-2">
          {rootLoading && (
            <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading files…
            </div>
          )}
          {!rootLoading && sorted.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              No convertible documents found.
            </div>
          )}
          {sorted.map((entry) => {
            const entryPath = `${rootDir}/${entry.name}`;
            if (entry.type === "directory") {
              return (
                <BrowseFolder
                  key={entryPath}
                  dirPath={entryPath}
                  name={entry.name}
                  depth={0}
                  selectedPath={selectedPath}
                  onSelect={setSelectedPath}
                />
              );
            }
            return (
              <button
                key={entryPath}
                onClick={() => setSelectedPath(entryPath)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition",
                  selectedPath === entryPath
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:bg-accent/10 hover:text-foreground"
                )}
                style={{ paddingLeft: "8px" }}
              >
                <File className="h-3 w-3 shrink-0" />
                <span className="truncate">{entry.name}</span>
              </button>
            );
          })}
        </div>

        {/* Selected file indicator */}
        {selectedPath && (
          <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            Selected: <span className="font-medium text-foreground">{selectedPath.split("/").pop()}</span>
          </div>
        )}

        {/* Conversion error display */}
        {convertMutation.isError && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{convertMutation.error instanceof Error ? convertMutation.error.message : "Conversion failed"}</span>
          </div>
        )}

        <DialogFooter>
          <button
            onClick={() => handleOpenChange(false)}
            disabled={convertMutation.isPending}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={!selectedPath || convertMutation.isPending}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
              selectedPath && !convertMutation.isPending
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground cursor-not-allowed"
            )}
          >
            {convertMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Converting…
              </>
            ) : (
              <>
                <FileUp className="h-3.5 w-3.5" />
                Import
              </>
            )}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
