"use client";

import { useState } from "react";
import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import {
  useKnowledgeStats,
  useKnowledgeDocuments,
  useKnowledgeSearch,
  useReindexAll,
  useReindexDocument,
  useDeleteDocument,
  useConverters,
  useConvertFiles,
} from "@/lib/hooks/use-knowledge";
import type { KnowledgeDocument } from "@/lib/types";
import { AskAiPanel, AskAiButton, PAGE_CONTEXTS } from "@/components/ask-ai";

export default function KnowledgePage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [activeTab, setActiveTab] = useState<"overview" | "documents" | "search" | "converters">("overview");
  const [askAiOpen, setAskAiOpen] = useState(false);

  const statsQuery = useKnowledgeStats();
  const docsQuery = useKnowledgeDocuments();
  const searchResults = useKnowledgeSearch(activeSearch);
  const reindexAll = useReindexAll();
  const reindexDoc = useReindexDocument();
  const deleteDoc = useDeleteDocument();
  const convertersQuery = useConverters();
  const convertFiles = useConvertFiles();

  const stats = statsQuery.data;
  const documents = docsQuery.data?.documents ?? [];
  const converters = convertersQuery.data?.converters ?? [];

  // Conversion file paths
  const [convertInput, setConvertInput] = useState("");

  const handleSearch = () => {
    if (searchQuery.trim()) {
      setActiveSearch(searchQuery.trim());
      setActiveTab("search");
    }
  };

  const handleReindexAll = () => {
    reindexAll.mutate(undefined, {
      onSuccess: () => showToast("Re-indexing complete", "success"),
      onError: (err) => showToast(`Re-index failed: ${err.message}`, "error"),
    });
  };

  const handleReindexDoc = (doc: KnowledgeDocument) => {
    reindexDoc.mutate(doc.id, {
      onSuccess: () => showToast(`Re-indexed ${doc.relativePath}`, "success"),
      onError: (err) => showToast(`Failed: ${err.message}`, "error"),
    });
  };

  const handleDeleteDoc = (doc: KnowledgeDocument) => {
    if (!confirm(`Remove "${doc.relativePath}" from the knowledge base?`)) return;
    deleteDoc.mutate(doc.id, {
      onSuccess: () => showToast(`Removed ${doc.relativePath}`, "success"),
      onError: (err) => showToast(`Failed: ${err.message}`, "error"),
    });
  };

  const handleConvert = () => {
    const paths = convertInput
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (paths.length === 0) {
      showToast("Enter at least one file path to convert.", "error");
      return;
    }

    convertFiles.mutate(paths, {
      onSuccess: (data) => {
        const ok = data.results.filter((r) => r.ok).length;
        const failed = data.results.filter((r) => !r.ok).length;
        if (failed > 0) {
          showToast(`Converted ${ok} file(s), ${failed} failed`, failed > 0 ? "error" : "success");
        } else {
          showToast(`Converted and indexed ${ok} file(s)`, "success");
        }
        setConvertInput("");
      },
      onError: (err) => showToast(`Conversion failed: ${err.message}`, "error"),
    });
  };

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const statusColor = (status: string): string => {
    switch (status) {
      case "indexed": return "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10";
      case "failed": return "text-red-600 dark:text-red-400 bg-red-500/10";
      case "processing": return "text-amber-600 dark:text-amber-400 bg-amber-500/10";
      default: return "text-muted-foreground bg-muted";
    }
  };

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 lg:px-12">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">OpenZigs</p>
          <h1 className="mt-1 text-3xl font-semibold text-foreground">Knowledge Manager</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your local knowledge base for semantic RAG search.
          </p>
        </div>
        <AskAiButton onClick={() => setAskAiOpen(true)} />
      </header>

      {/* Search Bar */}
      <div className="mb-6 flex items-center gap-3">
        <input
          type="text"
          placeholder="Search knowledge base…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          className="flex-1 rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground"
        />
        <button
          onClick={handleSearch}
          disabled={!searchQuery.trim()}
          className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-40"
        >
          Search
        </button>
        <button
          onClick={handleReindexAll}
          disabled={reindexAll.isPending}
          className="rounded-xl border border-primary px-5 py-2.5 text-sm font-semibold text-primary hover:bg-primary/5"
        >
          {reindexAll.isPending ? "Re-indexing…" : "Re-index All"}
        </button>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex gap-1 rounded-xl border border-border bg-card p-1">
        {(["overview", "documents", "search", "converters"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 rounded-lg px-4 py-2 text-xs font-semibold capitalize transition ${
              activeTab === tab
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent/10 hover:text-foreground"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Overview Tab */}
      {activeTab === "overview" && (
        <SectionCard title="Knowledge Base Overview">
          {statsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : stats ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatBox label="Documents" value={stats.totalDocuments} />
              <StatBox label="Chunks" value={stats.totalChunks} />
              <StatBox label="Indexed" value={stats.indexedDocuments} accent="emerald" />
              <StatBox label="Failed" value={stats.failedDocuments} accent={stats.failedDocuments > 0 ? "red" : undefined} />
              <StatBox label="Pending" value={stats.pendingDocuments} />
              <StatBox label="Total Size" value={formatBytes(stats.totalSizeBytes)} />
              <div className="col-span-2 rounded-xl border border-border bg-card p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Last Indexed</p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {stats.lastIndexedAt ? new Date(stats.lastIndexedAt).toLocaleString() : "Never"}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Knowledge base not available.</p>
          )}
        </SectionCard>
      )}

      {/* Documents Tab */}
      {activeTab === "documents" && (
        <SectionCard title={`Documents (${documents.length})`}>
          {docsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No documents found. Add files to your knowledge directory to get started.
            </p>
          ) : (
            <div className="space-y-2">
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between rounded-xl border border-border bg-card p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{doc.relativePath}</p>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusColor(doc.status)}`}>
                        {doc.status}
                      </span>
                      <span>{doc.sourceType}</span>
                      <span>{formatBytes(doc.sizeBytes)}</span>
                      <span>{doc.chunkCount} chunks</span>
                      {doc.error && (
                        <span className="truncate text-red-500" title={doc.error}>
                          Error: {doc.error}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="ml-3 flex shrink-0 gap-2">
                    <button
                      onClick={() => handleReindexDoc(doc)}
                      disabled={reindexDoc.isPending}
                      className="rounded-lg border border-primary/30 px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/5"
                    >
                      Re-index
                    </button>
                    <button
                      onClick={() => handleDeleteDoc(doc)}
                      disabled={deleteDoc.isPending}
                      className="rounded-lg border border-destructive/30 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/5"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {/* Search Tab */}
      {activeTab === "search" && (
        <SectionCard title={activeSearch ? `Results for "${activeSearch}"` : "Search Results"}>
          {!activeSearch ? (
            <p className="text-sm text-muted-foreground">
              Enter a query above and press Search to find relevant knowledge.
            </p>
          ) : searchResults.isLoading ? (
            <p className="text-sm text-muted-foreground">Searching…</p>
          ) : (searchResults.data?.results?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">
              No results found for &ldquo;{activeSearch}&rdquo;.
            </p>
          ) : (
            <div className="space-y-3">
              {searchResults.data?.results.map((result, i) => (
                <div key={`${result.documentId}-${result.chunkIndex}`} className="rounded-xl border border-border bg-card p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold text-muted-foreground">#{i + 1}</span>
                      <span className="text-xs font-medium text-foreground">{result.sourcePath}</span>
                      {result.sectionHeading && (
                        <span className="text-[11px] text-muted-foreground">§ {result.sectionHeading}</span>
                      )}
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      result.score > 0.7
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : result.score > 0.4
                          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                          : "bg-muted text-muted-foreground"
                    }`}>
                      {(result.score * 100).toFixed(1)}%
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground leading-relaxed">
                    {result.text}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {/* Converters Tab */}
      {activeTab === "converters" && (
        <>
          <SectionCard title="Available Converters">
            <p className="mb-4 text-xs text-muted-foreground">
                Converters automatically transform non-text files (PDFs, DOCX, XLSX, images, audio/video)
              searchable text when added to the knowledge directory.
            </p>
            {convertersQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : converters.length === 0 ? (
              <p className="text-sm text-muted-foreground">No converters registered.</p>
            ) : (
              <div className="space-y-2">
                {converters.map((conv) => (
                  <div
                    key={conv.name}
                    className="flex items-center justify-between rounded-xl border border-border bg-card p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-block h-2 w-2 rounded-full ${
                            conv.available ? "bg-emerald-500" : "bg-red-400"
                          }`}
                        />
                        <p className="text-sm font-semibold capitalize text-foreground">
                          {conv.name}
                        </p>
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Extensions: {conv.extensions.join(", ")}
                      </p>
                      {!conv.available && conv.reason && (
                        <p className="mt-0.5 text-[11px] text-red-500">{conv.reason}</p>
                      )}
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                        conv.available
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : "bg-red-500/10 text-red-600 dark:text-red-400"
                      }`}
                    >
                      {conv.available ? "Available" : "Unavailable"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <div className="mt-6" />

          <SectionCard title="Convert Files">
            <p className="mb-3 text-xs text-muted-foreground">
              Enter absolute file paths (one per line) to copy into the knowledge directory and
              convert automatically. Files are converted using the appropriate converter based on
              their extension.
            </p>
            <textarea
              className="w-full rounded-lg border border-border bg-card px-3 py-2 font-mono text-sm text-foreground"
              rows={5}
              placeholder={"/path/to/document.pdf\n/path/to/report.docx\n~/Documents/notes.pdf"}
              value={convertInput}
              onChange={(e) => setConvertInput(e.target.value)}
            />
            <div className="mt-3 flex justify-end">
              <button
                onClick={handleConvert}
                disabled={convertFiles.isPending || !convertInput.trim()}
                className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-40"
              >
                {convertFiles.isPending ? "Converting…" : "Convert & Index"}
              </button>
            </div>
          </SectionCard>
        </>
      )}

      <ToastContainer />
      <AskAiPanel pageContext={PAGE_CONTEXTS["knowledge"]} open={askAiOpen} onClose={() => setAskAiOpen(false)} />
    </main>
  );
}

/* ── Stat Box ── */

const StatBox = ({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: "emerald" | "red";
}) => {
  const valueColor =
    accent === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : accent === "red"
        ? "text-red-600 dark:text-red-400"
        : "text-foreground";

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 text-lg font-bold ${valueColor}`}>{value}</p>
    </div>
  );
};
