"use client";

import { useState } from "react";
import { fetchJson } from "@/lib/api";
import { Download, FileJson, FileText, FileSpreadsheet } from "lucide-react";

type Format = "csv" | "json" | "pdf";

export function ExportDialog({ snapshotId }: { snapshotId: number | null }) {
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleExport = async (format: Format) => {
    if (!snapshotId) return;
    setExporting(true);
    setResult(null);
    try {
      const res = await fetchJson<{ path: string }>(
        `/api/seo/export/${snapshotId}`,
        {
          method: "POST",
          body: JSON.stringify({ format }),
        },
      );
      setResult(res.path);
    } catch {
      setResult("Export failed");
    } finally {
      setExporting(false);
    }
  };

  const disabled = !snapshotId || exporting;

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold">Export Audit Report</h4>
      {!snapshotId && (
        <p className="text-xs text-muted-foreground">
          Select an audit above to enable export.
        </p>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => handleExport("csv")}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent/10 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <FileSpreadsheet className="h-3.5 w-3.5" /> CSV
        </button>
        <button
          onClick={() => handleExport("json")}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent/10 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <FileJson className="h-3.5 w-3.5" /> JSON
        </button>
        <button
          onClick={() => handleExport("pdf")}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent/10 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <FileText className="h-3.5 w-3.5" /> PDF
        </button>
      </div>
      {result && (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Download className="h-3 w-3" /> {result}
        </p>
      )}
    </div>
  );
}
