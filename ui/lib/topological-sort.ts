/**
 * Kahn's algorithm topological sort.
 *
 * Shared utility used by the Workflow Builder UI.
 * The backend equivalent lives in `src/productivity/graph-serializer.ts`.
 */
export type TopoSortResult = {
  sorted: string[];
  hasCycle: boolean;
};

export function topologicalSort(
  nodeIds: string[],
  edges: ReadonlyArray<{ source: string; target: string }>,
): TopoSortResult {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }

  for (const edge of edges) {
    if (adj.has(edge.source) && inDegree.has(edge.target)) {
      adj.get(edge.source)!.push(edge.target);
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const neighbor of adj.get(current) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  return { sorted, hasCycle: sorted.length !== nodeIds.length };
}
