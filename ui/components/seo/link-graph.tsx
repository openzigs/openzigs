"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { Link2 } from "lucide-react";

interface LinkAnalysis {
  totalLinks?: number;
  internalLinks?: number;
  externalLinks?: number;
  brokenLinks?: Array<{
    sourceUrl: string;
    targetUrl: string;
    anchorText: string;
    statusCode: number;
  }>;
  redirectChains?: unknown[];
  orphanPages?: unknown[];
  linkDepths?: Array<{ url: string; depth: number }>;
  linkDistribution?: Array<{
    url: string;
    incomingCount: number;
    outgoingCount: number;
  }>;
  links?: Array<{ source: string; target: string }>;
}

interface GraphNode extends SimulationNodeDatum {
  id: string;
  issueCount: number;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
}

function nodeColor(issueCount: number): string {
  if (issueCount === 0) return "#22c55e"; // green-500
  if (issueCount <= 2) return "#eab308"; // yellow-500
  return "#ef4444"; // red-500
}

export function LinkGraph({
  linkAnalysis,
}: {
  linkAnalysis: LinkAnalysis | null;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dimensions, setDimensions] = useState({ width: 600, height: 400 });

  const updateDimensions = useCallback(() => {
    if (svgRef.current?.parentElement) {
      const { clientWidth } = svgRef.current.parentElement;
      setDimensions({ width: Math.max(clientWidth, 300), height: 400 });
    }
  }, []);

  useEffect(() => {
    updateDimensions();
    window.addEventListener("resize", updateDimensions);
    // Also observe parent container — handles tab switches and sidebar toggles
    // that resize the container without firing window resize.
    let observer: ResizeObserver | undefined;
    if (
      typeof ResizeObserver !== "undefined" &&
      svgRef.current?.parentElement
    ) {
      observer = new ResizeObserver(() => updateDimensions());
      observer.observe(svgRef.current.parentElement);
    }
    return () => {
      window.removeEventListener("resize", updateDimensions);
      observer?.disconnect();
    };
  }, [updateDimensions]);

  useEffect(() => {
    if (!svgRef.current || !linkAnalysis) return;

    const svg = select(svgRef.current);
    svg.selectAll("*").remove();

    // Build graph data from link data
    const nodeMap = new Map<string, GraphNode>();
    const links: GraphLink[] = [];

    // Add nodes from link distribution
    for (const entry of linkAnalysis.linkDistribution ?? []) {
      if (!nodeMap.has(entry.url)) {
        nodeMap.set(entry.url, { id: entry.url, issueCount: 0 });
      }
    }

    // Add nodes and edges from broken links
    for (const bl of linkAnalysis.brokenLinks ?? []) {
      if (!nodeMap.has(bl.sourceUrl)) {
        nodeMap.set(bl.sourceUrl, { id: bl.sourceUrl, issueCount: 0 });
      }
      if (!nodeMap.has(bl.targetUrl)) {
        nodeMap.set(bl.targetUrl, { id: bl.targetUrl, issueCount: 1 });
      }
      const target = nodeMap.get(bl.targetUrl)!;
      target.issueCount += 1;
    }

    // Use real link pairs if available, otherwise fall back to broken links
    if (linkAnalysis.links && linkAnalysis.links.length > 0) {
      for (const l of linkAnalysis.links.slice(0, 200)) {
        if (!nodeMap.has(l.source)) {
          nodeMap.set(l.source, { id: l.source, issueCount: 0 });
        }
        if (!nodeMap.has(l.target)) {
          nodeMap.set(l.target, { id: l.target, issueCount: 0 });
        }
        links.push({ source: l.source, target: l.target });
      }
    } else {
      // Fallback: edges from broken links
      for (const bl of linkAnalysis.brokenLinks ?? []) {
        links.push({ source: bl.sourceUrl, target: bl.targetUrl });
      }
    }

    const nodes = [...nodeMap.values()];

    if (nodes.length === 0) return;

    const { width, height } = dimensions;

    // Container group for zoom/pan
    const g = svg.append("g");

    // Zoom behavior
    const zoomBehavior: ZoomBehavior<SVGSVGElement, unknown> = zoom<
      SVGSVGElement,
      unknown
    >()
      .scaleExtent([0.2, 4])
      .on("zoom", (event) => {
        g.attr("transform", event.transform);
      });

    svg.call(zoomBehavior);
    svg.call(zoomBehavior.transform, zoomIdentity);

    // Force simulation
    const simulation = forceSimulation<GraphNode>(nodes)
      .force(
        "link",
        forceLink<GraphNode, GraphLink>(links)
          .id((d) => d.id)
          .distance(80),
      )
      .force("charge", forceManyBody().strength(-200))
      .force("center", forceCenter(width / 2, height / 2))
      .force("collide", forceCollide(20));

    // Draw links
    const linkElements = g
      .selectAll<SVGLineElement, GraphLink>("line")
      .data(links)
      .join("line")
      .attr("stroke", "#6b7280")
      .attr("stroke-opacity", 0.4)
      .attr("stroke-width", 1);

    // Draw nodes
    const nodeElements = g
      .selectAll<SVGCircleElement, GraphNode>("circle")
      .data(nodes)
      .join("circle")
      .attr("r", 6)
      .attr("fill", (d) => nodeColor(d.issueCount))
      .attr("stroke", "#fff")
      .attr("stroke-width", 1.5);

    // Tooltips
    nodeElements.append("title").text((d) => {
      const shortUrl = d.id.replace(/^https?:\/\//, "");
      return `${shortUrl}\nIssues: ${d.issueCount}`;
    });

    simulation.on("tick", () => {
      linkElements
        .attr("x1", (d) => (d.source as GraphNode).x ?? 0)
        .attr("y1", (d) => (d.source as GraphNode).y ?? 0)
        .attr("x2", (d) => (d.target as GraphNode).x ?? 0)
        .attr("y2", (d) => (d.target as GraphNode).y ?? 0);

      nodeElements.attr("cx", (d) => d.x ?? 0).attr("cy", (d) => d.y ?? 0);
    });

    return () => {
      simulation.stop();
    };
  }, [linkAnalysis, dimensions]);

  if (
    !linkAnalysis ||
    ((linkAnalysis.links?.length ?? 0) === 0 &&
      (linkAnalysis.brokenLinks?.length ?? 0) === 0 &&
      (linkAnalysis.linkDistribution?.length ?? 0) === 0)
  ) {
    return (
      <div className="flex flex-col items-center justify-center h-40 rounded-lg border bg-muted/20">
        <Link2 className="h-8 w-8 text-muted-foreground/40 mb-2" />
        <p className="text-sm text-muted-foreground">
          No link data to visualize. Run an audit to build the link graph.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <svg
        ref={svgRef}
        width={dimensions.width}
        height={dimensions.height}
        className="bg-background"
      />
      <div className="flex items-center gap-4 px-3 py-2 border-t text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
          No issues
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-yellow-500" />
          1-2 issues
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
          3+ issues
        </span>
        <span className="ml-auto">Scroll to zoom, drag to pan</span>
      </div>
    </div>
  );
}
