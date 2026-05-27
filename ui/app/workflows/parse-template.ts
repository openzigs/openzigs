// Workflow template parser & validator (no external dependency).
// Validates the .openzigs-template.json round-trip shape used by
// the workflow builder's import/export.

export type ParsedTemplate = {
  name: string;
  description?: string;
  stages?: unknown[];
  graphLayout: {
    nodes: unknown[];
    edges: unknown[];
    viewport?: unknown;
  };
};

export type ParseResult =
  | { ok: true; template: ParsedTemplate }
  | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseGraphLayout(
  raw: unknown,
): { nodes: unknown[]; edges: unknown[]; viewport?: unknown } | string {
  let layout: unknown = raw;
  if (typeof raw === "string") {
    try {
      layout = JSON.parse(raw);
    } catch {
      return "graphLayout is a string but not valid JSON";
    }
  }
  if (!isObject(layout)) return "graphLayout must be an object";
  if (!Array.isArray(layout.nodes)) return "graphLayout.nodes must be an array";
  if (!Array.isArray(layout.edges)) return "graphLayout.edges must be an array";
  return {
    nodes: layout.nodes,
    edges: layout.edges,
    viewport: layout.viewport,
  };
}

export function parseWorkflowTemplate(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
  if (!isObject(data))
    return { ok: false, error: "Template must be a JSON object" };
  if (typeof data.name !== "string" || data.name.trim() === "") {
    return { ok: false, error: "Template is missing required field: name" };
  }
  if (data.graphLayout === undefined || data.graphLayout === null) {
    return {
      ok: false,
      error: "Template is missing required field: graphLayout",
    };
  }
  const layout = parseGraphLayout(data.graphLayout);
  if (typeof layout === "string") return { ok: false, error: layout };

  if (data.stages !== undefined && !Array.isArray(data.stages)) {
    return { ok: false, error: "stages must be an array when provided" };
  }
  if (data.description !== undefined && typeof data.description !== "string") {
    return { ok: false, error: "description must be a string when provided" };
  }

  return {
    ok: true,
    template: {
      name: data.name,
      description: data.description as string | undefined,
      stages: data.stages as unknown[] | undefined,
      graphLayout: layout,
    },
  };
}
