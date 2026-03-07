"use client";

import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MDXEditorMethods } from "@mdxeditor/editor";
import { fetchJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ForwardRefEditor } from "@/components/workbench/forward-ref-editor";
import { FileSidebar } from "@/components/workbench/file-sidebar";
import { ImportDocumentDialog } from "@/components/workbench/import-document-dialog";
import { ResearchGenerateDialog } from "@/components/workbench/research-generate-dialog";
import { Save, FileText, Circle, FileUp, Microscope } from "lucide-react";
import { showToast } from "@/components/toast";
import { AskAiPanel, AskAiButton, PAGE_CONTEXTS } from "@/components/ask-ai";

const DEFAULT_ROOT = process.env.NEXT_PUBLIC_WORKBENCH_ROOT ?? ".";

export default function WorkbenchPage() {
  const editorRef = useRef<MDXEditorMethods>(null);
  const queryClient = useQueryClient();

  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [localContent, setLocalContent] = useState("# Welcome to the Workbench\n\nStart writing or open a file from the sidebar.");
  const [importOpen, setImportOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [askAiOpen, setAskAiOpen] = useState(false);

  // Fetch file content when a file is selected
  const { isFetching } = useQuery({
    queryKey: ["files", "content", activeFile],
    queryFn: async () => {
      if (!activeFile) return null;
      const data = await fetchJson<{ content: string; path: string }>(
        `/api/files/content?path=${encodeURIComponent(activeFile)}`
      );
      return data;
    },
    enabled: !!activeFile,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async ({ path, content }: { path: string; content: string }) => {
      return fetchJson<{ success: boolean; path: string }>("/api/files/save", {
        method: "POST",
        body: JSON.stringify({ path, content }),
      });
    },
    onSuccess: () => {
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ["files"] });
    },
  });

  const handleFileSelect = useCallback(
    async (filePath: string) => {
      if (!filePath) {
        // New file
        setActiveFile(null);
        setLocalContent("# Untitled\n\n");
        editorRef.current?.setMarkdown("# Untitled\n\n");
        setDirty(false);
        return;
      }

      try {
        const data = await fetchJson<{ content: string }>(
          `/api/files/content?path=${encodeURIComponent(filePath)}`
        );
        setActiveFile(filePath);
        setLocalContent(data.content);
        editorRef.current?.setMarkdown(data.content);
        setDirty(false);
      } catch (error) {
        console.error("Failed to load file:", error);
        showToast("Failed to load file. It may not be readable.", "error");
      }
    },
    []
  );

  const handleSave = useCallback(() => {
    const content = editorRef.current?.getMarkdown() ?? localContent;
    if (activeFile) {
      saveMutation.mutate({ path: activeFile, content });
    } else {
      // Prompt for file name if no active file
      const name = window.prompt("Save as (full path):", `${DEFAULT_ROOT}/untitled.md`);
      if (name) {
        setActiveFile(name);
        saveMutation.mutate({ path: name, content });
      }
    }
  }, [activeFile, localContent, saveMutation]);

  const handleChange = useCallback(
    (markdown: string) => {
      setLocalContent(markdown);
      setDirty(true);
    },
    []
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    },
    [handleSave]
  );

  const handleImportComplete = useCallback(
    (markdown: string, originalPath: string) => {
      editorRef.current?.setMarkdown(markdown);
      setLocalContent(markdown);
      // Derive a .md sibling path from the original document
      const baseName = originalPath.replace(/\.[^.]+$/, "");
      setActiveFile(`${baseName}.md`);
      setDirty(true);
    },
    []
  );

  const fileName = activeFile
    ? activeFile.split("/").pop() ?? "Untitled"
    : "Untitled";

  return (
    <div className="flex h-full" onKeyDown={handleKeyDown}>
      {/* File Sidebar */}
      <FileSidebar
        rootDir={DEFAULT_ROOT}
        onFileSelect={(p) => void handleFileSelect(p)}
        activeFile={activeFile}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />

      {/* Editor Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar: file info + save */}
        <div className="flex items-center justify-between border-b border-border bg-card px-4 py-2">
          <div className="flex items-center gap-2 text-sm">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{fileName}</span>
            {dirty && (
              <span title="Unsaved changes">
                <Circle className="h-2 w-2 fill-amber-500 text-amber-500" />
              </span>
            )}
            {isFetching && (
              <span className="text-xs text-muted-foreground">Loading…</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <AskAiButton onClick={() => setAskAiOpen(true)} />
            <button
              onClick={() => setResearchOpen(true)}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-muted hover:text-foreground"
              title="Research & Generate — autonomous research and content synthesis"
            >
              <Microscope className="h-3.5 w-3.5" />
              Research
            </button>
            <button
              onClick={() => setImportOpen(true)}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-muted hover:text-foreground"
              title="Import document (Word, PDF, etc.)"
            >
              <FileUp className="h-3.5 w-3.5" />
              Import
            </button>
            <button
              onClick={handleSave}
              disabled={saveMutation.isPending}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
                dirty
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "bg-muted text-muted-foreground"
              )}
            >
              <Save className="h-3.5 w-3.5" />
              {saveMutation.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        {/* Editor */}
        <div className="workbench-editor min-h-0 flex-1 overflow-y-auto bg-background p-4">
          <div className="mx-auto max-w-4xl">
            <ForwardRefEditor
              ref={editorRef}
              markdown={localContent}
              onChange={handleChange}
              contentEditableClassName="prose dark:prose-invert max-w-none min-h-[60vh] focus:outline-none"
            />
          </div>
        </div>

        {/* Status bar */}
        <div className="flex items-center justify-between border-t border-border bg-card px-4 py-1">
          <span className="text-[10px] text-muted-foreground">
            {activeFile ?? "New document"}
          </span>
          <span className="text-[10px] text-muted-foreground">
            Markdown • {dirty ? "Modified" : "Saved"}
          </span>
        </div>
      </div>

      {/* Import Document Dialog */}
      <ImportDocumentDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        rootDir={DEFAULT_ROOT}
        onImport={handleImportComplete}
      />
      {/* Research & Generate Dialog */}
      <ResearchGenerateDialog
        open={researchOpen}
        onOpenChange={setResearchOpen}
      />
      <AskAiPanel pageContext={PAGE_CONTEXTS["workbench"]} open={askAiOpen} onClose={() => setAskAiOpen(false)} />
    </div>
  );
}
