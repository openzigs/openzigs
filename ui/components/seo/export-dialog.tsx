"use client";

import { useState } from "react";
import { fetchJson } from "@/lib/api";
import {
  Download,
  FileJson,
  FileText,
  FileSpreadsheet,
  Sheet,
  Palette,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

type Format = "csv" | "json" | "pdf" | "sheets";

interface Branding {
  companyName?: string;
  logoUrl?: string;
  primaryColor?: string;
}

export function ExportDialog({ snapshotId }: { snapshotId: number | null }) {
  const [exporting, setExporting] = useState<Format | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Sheets-specific
  const [sheetsToken, setSheetsToken] = useState("");

  // PDF branding (collapsible)
  const [showBranding, setShowBranding] = useState(false);
  const [branding, setBranding] = useState<Branding>({
    companyName: "",
    logoUrl: "",
    primaryColor: "#e60023",
  });

  const handleExport = async (format: Format) => {
    if (!snapshotId) return;
    setExporting(format);
    setResult(null);
    setError(null);
    try {
      const body: Record<string, unknown> = { format };
      if (format === "pdf") {
        // Only send branding fields the user actually filled in.
        const cleaned: Branding = {};
        if (branding.companyName?.trim())
          cleaned.companyName = branding.companyName.trim();
        if (branding.logoUrl?.trim()) cleaned.logoUrl = branding.logoUrl.trim();
        if (branding.primaryColor?.trim())
          cleaned.primaryColor = branding.primaryColor.trim();
        if (Object.keys(cleaned).length > 0) body.branding = cleaned;
      }
      if (format === "sheets") {
        if (!sheetsToken.trim()) {
          setError("Google Sheets export requires an OAuth2 access token.");
          setExporting(null);
          return;
        }
        body.sheetsAccessToken = sheetsToken.trim();
      }
      const res = await fetchJson<{ path: string; format?: Format }>(
        `/api/seo/export/${snapshotId}`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      setResult(res.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(null);
    }
  };

  const disabled = !snapshotId || exporting !== null;

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold">Export Audit Report</h4>
      {!snapshotId && (
        <p className="text-xs text-muted-foreground">
          Select an audit above to enable export.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
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
          data-testid="export-pdf"
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent/10 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <FileText className="h-3.5 w-3.5" /> PDF
        </button>
        <button
          onClick={() => handleExport("sheets")}
          disabled={disabled}
          data-testid="export-sheets"
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent/10 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Sheet className="h-3.5 w-3.5" /> Google Sheets
        </button>
      </div>

      {/* Sheets OAuth token input */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-muted-foreground">
          Google Sheets OAuth2 access token
          <span className="ml-1 font-normal italic">
            (required for Sheets export)
          </span>
        </label>
        <input
          type="password"
          value={sheetsToken}
          onChange={(e) => setSheetsToken(e.target.value)}
          placeholder="ya29.…"
          autoComplete="off"
          data-testid="sheets-token-input"
          className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
        />
      </div>

      {/* PDF branding (collapsible) */}
      <div className="rounded-md border border-border">
        <button
          type="button"
          onClick={() => setShowBranding((s) => !s)}
          aria-expanded={showBranding}
          data-testid="branding-toggle"
          className="flex w-full items-center justify-between px-3 py-1.5 text-xs font-medium hover:bg-muted/40"
        >
          <span className="flex items-center gap-1.5">
            <Palette className="h-3.5 w-3.5" /> PDF branding (optional)
          </span>
          {showBranding ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </button>
        {showBranding && (
          <div
            className="space-y-2 border-t border-border p-3"
            data-testid="branding-fields"
          >
            <label className="block">
              <span className="text-[11px] text-muted-foreground">
                Company name
              </span>
              <input
                type="text"
                value={branding.companyName ?? ""}
                onChange={(e) =>
                  setBranding((b) => ({ ...b, companyName: e.target.value }))
                }
                placeholder="Acme Corp"
                maxLength={120}
                className="mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-muted-foreground">
                Logo URL
                <span className="ml-1 italic">
                  (https:// or data:image/…;base64,…)
                </span>
              </span>
              <input
                type="url"
                value={branding.logoUrl ?? ""}
                onChange={(e) =>
                  setBranding((b) => ({ ...b, logoUrl: e.target.value }))
                }
                placeholder="https://example.com/logo.png"
                className="mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-muted-foreground">
                Primary color
              </span>
              <div className="mt-0.5 flex items-center gap-2">
                <input
                  type="color"
                  value={branding.primaryColor ?? "#e60023"}
                  onChange={(e) =>
                    setBranding((b) => ({
                      ...b,
                      primaryColor: e.target.value,
                    }))
                  }
                  className="h-7 w-10 cursor-pointer rounded border border-border bg-background"
                />
                <input
                  type="text"
                  value={branding.primaryColor ?? ""}
                  onChange={(e) =>
                    setBranding((b) => ({
                      ...b,
                      primaryColor: e.target.value,
                    }))
                  }
                  placeholder="#e60023"
                  pattern="^#[0-9A-Fa-f]{6}$"
                  className="flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
                />
              </div>
            </label>
            <p className="text-[10px] text-muted-foreground">
              Branding only applies to PDF exports. Inputs are sanitized
              server-side (HTML-escape on company name, https/data URL
              allow-list on logo, hex regex on color).
            </p>
          </div>
        )}
      </div>

      {result && (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Download className="h-3 w-3" /> {result}
        </p>
      )}
      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
