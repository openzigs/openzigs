"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  Plus,
  RefreshCw,
} from "lucide-react";

type FileEntry = {
  name: string;
  type: "file" | "directory";
};

type FileSidebarProps = {
  rootDir: string;
  extraDirs?: string[];
  onFileSelect: (filePath: string) => void;
  activeFile: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
};

type FolderNodeProps = {
  dirPath: string;
  name: string;
  depth: number;
  onFileSelect: (filePath: string) => void;
  activeFile: string | null;
};

const FolderNode = ({ dirPath, name, depth, onFileSelect, activeFile }: FolderNodeProps) => {
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
  const sorted = [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

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
                <FolderNode
                  key={entryPath}
                  dirPath={entryPath}
                  name={entry.name}
                  depth={depth + 1}
                  onFileSelect={onFileSelect}
                  activeFile={activeFile}
                />
              );
            }
            return (
              <button
                key={entryPath}
                onClick={() => onFileSelect(entryPath)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition",
                  activeFile === entryPath
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

export const FileSidebar = ({
  rootDir,
  extraDirs,
  onFileSelect,
  activeFile,
  collapsed,
  onToggleCollapse,
}: FileSidebarProps) => {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["files", "list", rootDir],
    queryFn: () =>
      fetchJson<{ entries: FileEntry[] }>(
        `/api/files/list?path=${encodeURIComponent(rootDir)}`
      ),
    staleTime: 10_000,
  });

  const entries = data?.entries ?? [];
  const sorted = [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  if (collapsed) {
    return (
      <div className="flex w-10 flex-col items-center border-r border-border bg-card pt-3">
        <button
          onClick={onToggleCollapse}
          className="rounded p-1.5 text-muted-foreground transition hover:bg-accent/10 hover:text-foreground"
          title="Expand file browser"
        >
          <Folder className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-64 flex-col border-r border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Files
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onFileSelect("")}
            className="rounded p-1 text-muted-foreground transition hover:bg-accent/10 hover:text-foreground"
            title="New file"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => void refetch()}
            className="rounded p-1 text-muted-foreground transition hover:bg-accent/10 hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onToggleCollapse}
            className="rounded p-1 text-muted-foreground transition hover:bg-accent/10 hover:text-foreground"
            title="Collapse sidebar"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {isLoading && (
          <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
        )}
        {sorted.map((entry) => {
          const entryPath = `${rootDir}/${entry.name}`;
          if (entry.type === "directory") {
            return (
              <FolderNode
                key={entryPath}
                dirPath={entryPath}
                name={entry.name}
                depth={0}
                onFileSelect={onFileSelect}
                activeFile={activeFile}
              />
            );
          }
          return (
            <button
              key={entryPath}
              onClick={() => onFileSelect(entryPath)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition",
                activeFile === entryPath
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
        {extraDirs && extraDirs.length > 0 && (
          <>
            <div className="mx-2 my-1 border-t border-border" />
            {extraDirs.map((dir) => {
              const dirName = dir.split("/").pop() ?? dir;
              return (
                <FolderNode
                  key={dir}
                  dirPath={dir}
                  name={dirName}
                  depth={0}
                  onFileSelect={onFileSelect}
                  activeFile={activeFile}
                />
              );
            })}
          </>
        )}
      </div>
    </div>
  );
};
