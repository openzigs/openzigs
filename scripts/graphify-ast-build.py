#!/usr/bin/env python
"""AST-only graphify build for openzigs.

This script produces ``graphify-out/graph.json`` and ``graphify-out/GRAPH_REPORT.md``
without any LLM calls — it is safe and free to run in CI on every pull request.

Why a script and not ``graphify .``?
  ``graphifyy`` >= 0.5 is primarily a *skill installer* for AI assistants; the
  end-to-end build is invoked by the AI host (e.g. ``/graphify`` in Copilot
  Chat). For headless CI we drive the same pipeline directly via the Python API.

Usage (locally or in CI):
    uv tool run --from graphifyy python scripts/graphify-ast-build.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "graphify-out"


def main() -> int:
    # Imported lazily so a missing graphifyy install produces a helpful error.
    from graphify import analyze, build, cluster, detect, extract, report

    OUT_DIR.mkdir(exist_ok=True)
    (OUT_DIR / "cache").mkdir(exist_ok=True)

    print(f"[graphify] repo root: {REPO_ROOT}")

    # 1. Detect corpus.
    detect_result = detect.detect(REPO_ROOT)
    print(f"[graphify] detect: {detect_result}")

    # 2. AST extraction (no LLM).
    files = extract.collect_files(REPO_ROOT)
    extracted = extract.extract(files)
    print(f"[graphify] extracted {len(files)} files")

    # 3. Build graph.
    graph = build.build_from_json(extracted)
    print(f"[graphify] graph: {graph.number_of_nodes()} nodes / {graph.number_of_edges()} edges")

    # 4. Cluster.
    communities, cohesion, labels, member_counts = cluster.cluster(graph)
    print(f"[graphify] {len(communities)} communities")

    # 5. Analyze.
    god_nodes = analyze.god_nodes(graph)
    surprises = analyze.surprising_connections(graph, communities)

    # 6. Persist graph.json. Patch NetworkX 3 ``edges`` → ``links`` for graphify
    #    CLI compatibility (upstream still expects the legacy key).
    from networkx.readwrite import json_graph
    data = json_graph.node_link_data(graph)
    if "edges" in data and "links" not in data:
        data["links"] = data.pop("edges")
    graph_path = OUT_DIR / "graph.json"
    graph_path.write_text(json.dumps(data), encoding="utf-8")
    print(f"[graphify] wrote {graph_path} ({graph_path.stat().st_size:,} bytes)")

    # 7. Generate human-readable report.
    md = report.generate(
        graph,
        communities,
        cohesion,
        labels,
        god_nodes,
        surprises,
        detect_result,
        token_cost=0.0,
        root=REPO_ROOT,
    )
    report_path = OUT_DIR / "GRAPH_REPORT.md"
    report_path.write_text(md, encoding="utf-8")
    print(f"[graphify] wrote {report_path} ({report_path.stat().st_size:,} bytes)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
