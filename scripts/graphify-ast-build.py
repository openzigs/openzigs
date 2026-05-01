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

import faulthandler
import json
import sys
import traceback
from pathlib import Path

faulthandler.enable()

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "graphify-out"

# We deliberately skip ``graphify.detect.detect()`` because:
#   1. It walks the entire tree without honoring ``.graphifyignore``.
#   2. On CI it has been observed to OOM-kill the process before any of our
#      logging/timeouts fire (no traceback, no faulthandler output — SIGKILL).
#   3. Its only consumer is ``report.generate()``, which uses it for the
#      header summary. A minimal stub is sufficient to keep the report and
#      the actual graph building intact.
DETECT_STUB = {"languages": {}, "file_count": 0, "word_count": 0}


def log(msg: str) -> None:
    print(f"[graphify] {msg}", flush=True)


def main() -> int:
    log(f"repo root: {REPO_ROOT}")
    log(f"python: {sys.version}")

    try:
        from graphify import analyze, build, cluster, extract, report
        log("imports ok")
    except Exception:
        traceback.print_exc()
        return 2

    OUT_DIR.mkdir(exist_ok=True)
    (OUT_DIR / "cache").mkdir(exist_ok=True)

    try:
        # 1. Skip detect (see DETECT_STUB note above).
        log("step 1/7: detect (skipped, using stub)")
        detect_result = DETECT_STUB

        # 2. AST extraction (no LLM).
        log("step 2/7: collect_files")
        files = extract.collect_files(REPO_ROOT)
        log(f"collected {len(files)} files")
        log("step 2b/7: extract")
        extracted = extract.extract(files)
        log("extract ok")

        # 3. Build graph.
        log("step 3/7: build")
        graph = build.build_from_json(extracted)
        log(f"graph: {graph.number_of_nodes()} nodes / {graph.number_of_edges()} edges")

        # 4. Cluster (returns dict[int, list[str]]).
        log("step 4/7: cluster")
        communities = cluster.cluster(graph)
        cohesion = {cid: 0.0 for cid in communities}
        labels = {cid: f"Community {cid}" for cid in communities}
        log(f"{len(communities)} communities")

        # 5. Analyze.
        log("step 5/7: analyze")
        god_nodes = analyze.god_nodes(graph)
        surprises = analyze.surprising_connections(graph, communities)

        # 6. Persist graph.json.
        log("step 6/7: serialize graph.json")
        from networkx.readwrite import json_graph
        data = json_graph.node_link_data(graph)
        if "edges" in data and "links" not in data:
            data["links"] = data.pop("edges")
        graph_path = OUT_DIR / "graph.json"
        graph_path.write_text(json.dumps(data), encoding="utf-8")
        log(f"wrote {graph_path} ({graph_path.stat().st_size:,} bytes)")

        # 7. Report.
        log("step 7/7: report")
        md = report.generate(
            graph,
            communities,
            cohesion,
            labels,
            god_nodes,
            surprises,
            detect_result,
            {"input_tokens": 0, "output_tokens": 0, "total_cost_usd": 0.0},
            str(REPO_ROOT),
        )
        report_path = OUT_DIR / "GRAPH_REPORT.md"
        report_path.write_text(md, encoding="utf-8")
        log(f"wrote {report_path} ({report_path.stat().st_size:,} bytes)")
        log("done")
        return 0
    except Exception:
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
