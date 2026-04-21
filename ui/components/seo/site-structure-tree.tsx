"use client";

import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  FileText,
} from "lucide-react";

export interface SiteStructurePage {
  url: string;
  status?: number;
  /** Number of issues on this page. */
  issueCount?: number;
  /** Severity bucket. */
  severity?: "ok" | "warning" | "error";
  /** Optional title for display. */
  title?: string;
}

export interface SiteStructureNode {
  /** Path segment ("" for root). */
  segment: string;
  /** Full path joined from root. */
  path: string;
  page?: SiteStructurePage;
  children: SiteStructureNode[];
}

/**
 * Parse an array of crawled URLs into a hierarchical tree based on URL paths.
 * Root node represents the origin; subsequent levels = path segments.
 *
 * Issue #847.
 */
export function buildSiteTree(pages: SiteStructurePage[]): SiteStructureNode {
  const root: SiteStructureNode = { segment: "/", path: "/", children: [] };
  for (const page of pages) {
    let parsed: URL;
    try {
      parsed = new URL(page.url);
    } catch {
      continue;
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    let current = root;
    let acc = "";
    if (segments.length === 0) {
      // Root page itself.
      root.page = page;
      continue;
    }
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      acc += `/${seg}`;
      let child = current.children.find((c) => c.segment === seg);
      if (!child) {
        child = { segment: seg, path: acc, children: [] };
        current.children.push(child);
      }
      if (i === segments.length - 1) child.page = page;
      current = child;
    }
  }
  // Sort children alphabetically.
  const sortRecursive = (n: SiteStructureNode) => {
    n.children.sort((a, b) => a.segment.localeCompare(b.segment));
    n.children.forEach(sortRecursive);
  };
  sortRecursive(root);
  return root;
}

interface NodeRowProps {
  node: SiteStructureNode;
  depth: number;
  defaultExpanded: boolean;
}

function StatusIcon({
  severity,
}: {
  severity?: SiteStructurePage["severity"];
}) {
  if (severity === "error")
    return (
      <AlertCircle
        className="h-3 w-3 text-red-500"
        aria-label="Errors present"
      />
    );
  if (severity === "warning")
    return (
      <AlertTriangle
        className="h-3 w-3 text-amber-500"
        aria-label="Warnings present"
      />
    );
  if (severity === "ok")
    return (
      <CheckCircle2
        className="h-3 w-3 text-emerald-500"
        aria-label="No issues"
      />
    );
  return <FileText className="h-3 w-3 text-muted-foreground" aria-hidden />;
}

function NodeRow({ node, depth, defaultExpanded }: NodeRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasChildren = node.children.length > 0;
  const indent = depth * 12;
  return (
    <div data-testid={`tree-node-${node.path}`}>
      <div
        className="flex items-center gap-1 py-0.5 text-[11px] hover:bg-muted/40"
        style={{ paddingLeft: indent }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-label={expanded ? "Collapse" : "Expand"}
            aria-expanded={expanded}
            className="rounded p-0.5 hover:bg-muted"
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ) : (
          <span className="w-4" />
        )}
        <StatusIcon severity={node.page?.severity} />
        <span className="truncate font-mono text-[11px]">{node.segment}</span>
        {node.page?.issueCount != null && node.page.issueCount > 0 && (
          <span
            className="ml-auto rounded bg-red-500/15 px-1.5 py-0.5 text-[9px] font-medium text-red-500"
            aria-label={`${node.page.issueCount} issues`}
          >
            {node.page.issueCount}
          </span>
        )}
        {node.page?.status && (
          <span className="text-[9px] text-muted-foreground">
            {node.page.status}
          </span>
        )}
      </div>
      {expanded &&
        node.children.map((child) => (
          <NodeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            defaultExpanded={defaultExpanded}
          />
        ))}
    </div>
  );
}

export interface SiteStructureTreeProps {
  pages: SiteStructurePage[];
  /** Whether nodes are expanded by default. */
  defaultExpanded?: boolean;
}

export function SiteStructureTree({
  pages,
  defaultExpanded = true,
}: SiteStructureTreeProps) {
  const tree = useMemo(() => buildSiteTree(pages), [pages]);
  if (pages.length === 0) {
    return (
      <p
        className="rounded-lg border border-dashed border-border p-3 text-center text-[11px] text-muted-foreground"
        data-testid="site-tree-empty"
      >
        No pages crawled yet.
      </p>
    );
  }
  return (
    <div
      role="tree"
      aria-label="Site structure"
      className="rounded-lg border border-border p-2"
      data-testid="site-structure-tree"
    >
      <NodeRow node={tree} depth={0} defaultExpanded={defaultExpanded} />
    </div>
  );
}
