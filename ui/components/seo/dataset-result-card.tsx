"use client";

import { useEffect, useState } from "react";
import { Check, Copy, FileText, FolderOpen } from "lucide-react";
import { useSocket } from "@/lib/socket-context";

/**
 * DatasetResultCard
 *
 * Subscribes to the `chat:stream` socket while a dataset run is active and,
 * once the run completes, scans the buffered output for the manifest path and
 * output directory the dataset tools advertise (e.g. `**Manifest**: <path>`,
 * `**Output directory**: <path>`). Renders a small card with copy buttons so
 * users can recover the artifacts without scrolling the chat panel.
 *
 * Bug #13 fix.
 */
interface Props {
  active: boolean;
  /** Increments whenever a new run is started, used to reset the buffer. */
  runKey: number;
}

interface ParsedResult {
  manifest?: string;
  outputDir?: string;
  files: string[];
}

const MANIFEST_RE = /\*\*Manifest\*\*:\s*([^\n\r`]+)/i;
const OUTPUT_DIR_RE = /\*\*Output(?:\s+directory)?\*\*:\s*([^\n\r`]+)/i;
const FILE_LIST_RE = /\*\*Files?\*\*:\s*([^\n\r]+)/i;

function parseOutput(text: string): ParsedResult | null {
  const manifest = MANIFEST_RE.exec(text)?.[1]?.trim();
  const outputDir = OUTPUT_DIR_RE.exec(text)?.[1]?.trim();
  const fileList = FILE_LIST_RE.exec(text)?.[1]?.trim();
  if (!manifest && !outputDir) return null;
  const files = fileList
    ? fileList
        .split(/[,\s]+/)
        .map((f) => f.trim())
        .filter(Boolean)
    : [];
  return { manifest, outputDir, files };
}

export function DatasetResultCard({ active, runKey }: Props) {
  const { socket } = useSocket();
  const [buffer, setBuffer] = useState("");
  const [result, setResult] = useState<ParsedResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Reset buffer + result whenever a new run starts
  useEffect(() => {
    setBuffer("");
    setResult(null);
  }, [runKey]);

  // Capture stream content while active
  useEffect(() => {
    if (!socket || !active) return;
    const onStream = (data: { chunk?: string }) => {
      if (typeof data?.chunk === "string") {
        setBuffer((prev) => prev + data.chunk);
      }
    };
    socket.on("chat:stream", onStream);
    return () => {
      socket.off("chat:stream", onStream);
    };
  }, [socket, active]);

  // Re-parse the buffer on every change so partial results show up early.
  useEffect(() => {
    if (!buffer) return;
    const parsed = parseOutput(buffer);
    if (parsed) setResult(parsed);
  }, [buffer]);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setTimeout(() => setCopied((c) => (c === value ? null : c)), 1500);
    } catch {
      // best-effort
    }
  };

  if (!result) return null;

  const Item = ({
    icon,
    label,
    value,
  }: {
    icon: React.ReactNode;
    label: string;
    value: string;
  }) => (
    <div className="flex items-start gap-2 rounded-md border bg-muted/20 p-2">
      <div className="mt-0.5 text-muted-foreground">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="break-all font-mono text-xs">{value}</p>
      </div>
      <button
        type="button"
        onClick={() => copy(value)}
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        title="Copy path"
      >
        {copied === value ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );

  return (
    <div className="mt-4 space-y-2 rounded-lg border bg-card p-4">
      <h3 className="text-sm font-semibold">Dataset Output</h3>
      <p className="text-xs text-muted-foreground">
        Paths emitted by the dataset run. Use these to locate the generated
        files on disk.
      </p>
      <div className="space-y-2">
        {result.outputDir && (
          <Item
            icon={<FolderOpen className="h-4 w-4" />}
            label="Output Directory"
            value={result.outputDir}
          />
        )}
        {result.manifest && (
          <Item
            icon={<FileText className="h-4 w-4" />}
            label="Manifest"
            value={result.manifest}
          />
        )}
        {result.files.length > 0 && (
          <div className="rounded-md border bg-muted/20 p-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Files ({result.files.length})
            </p>
            <ul className="mt-1 space-y-0.5">
              {result.files.map((f) => (
                <li key={f} className="break-all font-mono text-xs">
                  {f}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
