"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchJson } from "@/lib/api";
import {
  Clock,
  Globe,
  Download,
  ChevronLeft,
  ChevronRight,
  FileJson,
  Loader2,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────

interface ExtractionRow {
  id: number;
  url: string;
  prompt: string;
  schemaJson: string | null;
  extractedAt: string;
  domain: string;
  preview?: string;
  scrapedMarkdown?: string;
}

interface ExtractionListResponse {
  rows: ExtractionRow[];
  total: number;
  limit: number;
  offset: number;
}

// ── Component ────────────────────────────────────────────────────────────

export function ExtractionHistory() {
  const [rows, setRows] = useState<ExtractionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ExtractionRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const limit = 20;

  const fetchExtractions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<ExtractionListResponse>(
        `/api/admin/extractions?limit=${limit}&offset=${offset}`,
      );
      setRows(data.rows);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load extractions");
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    fetchExtractions();
  }, [fetchExtractions]);

  const loadDetail = useCallback(async (id: number) => {
    setSelectedId(id);
    setDetailLoading(true);
    try {
      const data = await fetchJson<ExtractionRow>(`/api/admin/extractions/${id}`);
      setDetail(data);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const exportJson = useCallback(() => {
    if (!detail) return;
    const blob = new Blob([JSON.stringify(detail, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `extraction-${detail.id}-${detail.domain}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [detail]);

  const exportCsv = useCallback(() => {
    if (!rows.length) return;
    const headers = ["ID", "URL", "Prompt", "Domain", "Extracted At"];
    const csvRows = rows.map((r) =>
      [r.id, r.url, `"${r.prompt.replace(/"/g, '""')}"`, r.domain, r.extractedAt].join(","),
    );
    const csv = [headers.join(","), ...csvRows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "extractions.csv";
    a.click();
    URL.revokeObjectURL(url);
  }, [rows]);

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  if (selectedId && detail) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setSelectedId(null); setDetail(null); }}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" /> Back to list
          </button>
        </div>

        <div className="rounded-lg border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-lg font-semibold">Extraction #{detail.id}</h3>
            <button
              onClick={exportJson}
              className="flex items-center gap-1 rounded-md bg-primary/10 px-3 py-1.5 text-sm text-primary hover:bg-primary/20"
            >
              <Download className="h-3.5 w-3.5" /> Export JSON
            </button>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">URL:</span>{" "}
              <a href={detail.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                {detail.url}
              </a>
            </div>
            <div>
              <span className="text-muted-foreground">Domain:</span> {detail.domain}
            </div>
            <div>
              <span className="text-muted-foreground">Prompt:</span> {detail.prompt}
            </div>
            <div>
              <span className="text-muted-foreground">Date:</span> {new Date(detail.extractedAt).toLocaleString()}
            </div>
          </div>

          {detail.schemaJson && (
            <div className="mb-4">
              <h4 className="mb-1 text-sm font-medium text-muted-foreground">Schema</h4>
              <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(JSON.parse(detail.schemaJson), null, 2)}
              </pre>
            </div>
          )}

          {detail.scrapedMarkdown && (
            <div>
              <h4 className="mb-1 text-sm font-medium text-muted-foreground">Scraped Content</h4>
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
                {detail.scrapedMarkdown}
              </pre>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <FileJson className="h-4 w-4" />
          Extraction History ({total})
        </h3>
        {rows.length > 0 && (
          <button
            onClick={exportCsv}
            className="flex items-center gap-1 rounded-md bg-primary/10 px-3 py-1.5 text-sm text-primary hover:bg-primary/20"
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No extractions yet. Use the Extract action to scrape and extract data from websites.
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">URL</th>
                  <th className="px-3 py-2 text-left font-medium">Schema</th>
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Preview</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => loadDetail(row.id)}
                    className="cursor-pointer border-b transition-colors hover:bg-muted/30"
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <Globe className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                        <span className="max-w-[200px] truncate">{row.url}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {row.schemaJson ? "Custom" : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {new Date(row.extractedAt).toLocaleDateString()}
                      </div>
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2 text-muted-foreground">
                      {row.preview?.slice(0, 80) ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                Page {currentPage} of {totalPages}
              </span>
              <div className="flex gap-2">
                <button
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                  className="rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-50"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  disabled={offset + limit >= total}
                  onClick={() => setOffset(offset + limit)}
                  className="rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-50"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {detailLoading && (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
