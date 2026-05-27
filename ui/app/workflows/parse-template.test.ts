import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflowTemplate } from "./parse-template";

const TEMPLATES_DIR = join(process.cwd(), "..", "config", "workflow-templates");

describe("parseWorkflowTemplate", () => {
  it("rejects invalid JSON", () => {
    const r = parseWorkflowTemplate("not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Invalid JSON/);
  });

  it("rejects non-object payloads", () => {
    const r = parseWorkflowTemplate("[]");
    expect(r.ok).toBe(false);
  });

  it("rejects missing name", () => {
    const r = parseWorkflowTemplate(
      JSON.stringify({ graphLayout: { nodes: [], edges: [] } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/name/);
  });

  it("rejects missing graphLayout", () => {
    const r = parseWorkflowTemplate(JSON.stringify({ name: "x" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/graphLayout/);
  });

  it("rejects graphLayout with non-array nodes", () => {
    const r = parseWorkflowTemplate(
      JSON.stringify({ name: "x", graphLayout: { nodes: {}, edges: [] } }),
    );
    expect(r.ok).toBe(false);
  });

  it("accepts graphLayout as a JSON-encoded string (legacy export shape)", () => {
    const r = parseWorkflowTemplate(
      JSON.stringify({
        name: "x",
        graphLayout: JSON.stringify({ nodes: [], edges: [] }),
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.template.graphLayout.nodes).toEqual([]);
      expect(r.template.graphLayout.edges).toEqual([]);
    }
  });

  it("rejects non-array stages", () => {
    const r = parseWorkflowTemplate(
      JSON.stringify({
        name: "x",
        graphLayout: { nodes: [], edges: [] },
        stages: "nope",
      }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("starter template round-trip", () => {
  const files = readdirSync(TEMPLATES_DIR).filter((f) =>
    f.endsWith(".openzigs-template.json"),
  );

  it("ships at least 5 starter templates", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files)("%s parses cleanly", (file) => {
    const text = readFileSync(join(TEMPLATES_DIR, file), "utf-8");
    const r = parseWorkflowTemplate(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.template.name).toBeTruthy();
      expect(Array.isArray(r.template.graphLayout.nodes)).toBe(true);
      expect(Array.isArray(r.template.graphLayout.edges)).toBe(true);
      expect(r.template.graphLayout.nodes.length).toBeGreaterThan(0);
    }
  });
});
