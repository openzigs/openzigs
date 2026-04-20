import { describe, it, expect } from "vitest";
import { extractLighthouseOptimizations } from "./core-web-vitals.js";

describe("extractLighthouseOptimizations (#875)", () => {
  it("extracts opportunities with savings", () => {
    const audits = {
      "render-blocking-resources": {
        id: "render-blocking-resources",
        title: "Eliminate render-blocking resources",
        description: "Resources are blocking the first paint.",
        score: 0.3,
        details: {
          type: "opportunity",
          overallSavingsMs: 1500,
        },
      },
      "unused-css-rules": {
        id: "unused-css-rules",
        title: "Reduce unused CSS",
        description: "Reduce unused rules from stylesheets.",
        score: 0.5,
        details: {
          type: "opportunity",
          overallSavingsMs: 300,
          overallSavingsBytes: 50000,
        },
      },
    };
    const results = extractLighthouseOptimizations(audits);
    expect(results).toHaveLength(2);
    expect(results[0].auditId).toBe("render-blocking-resources");
    expect(results[0].savingsMs).toBe(1500);
    expect(results[0].category).toBe("opportunity");
    expect(results[1].auditId).toBe("unused-css-rules");
    expect(results[1].savingsBytes).toBe(50000);
  });

  it("excludes audits with perfect score and no savings", () => {
    const audits = {
      "render-blocking-resources": {
        id: "render-blocking-resources",
        title: "Eliminate render-blocking resources",
        score: 1,
      },
      "dom-size": {
        id: "dom-size",
        title: "Avoid an excessive DOM size",
        score: 1,
      },
    };
    const results = extractLighthouseOptimizations(audits);
    expect(results).toHaveLength(0);
  });

  it("includes diagnostics without savings but with poor score", () => {
    const audits = {
      "dom-size": {
        id: "dom-size",
        title: "Avoid an excessive DOM size",
        description: "Browser performance may be impacted.",
        score: 0.4,
      },
    };
    const results = extractLighthouseOptimizations(audits);
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe("diagnostic");
    expect(results[0].savingsMs).toBeNull();
  });

  it("strips markdown links from descriptions", () => {
    const audits = {
      "uses-text-compression": {
        id: "uses-text-compression",
        title: "Enable text compression",
        description:
          "Text-based resources should be served with compression. [Learn more](https://example.com).",
        score: 0.2,
        details: { type: "opportunity", overallSavingsMs: 200 },
      },
    };
    const results = extractLighthouseOptimizations(audits);
    expect(results[0].description).not.toContain("[Learn more]");
    expect(results[0].description).toContain("compression");
  });

  it("sorts opportunities before diagnostics, then by savings descending", () => {
    const audits = {
      "dom-size": {
        id: "dom-size",
        title: "DOM Size",
        score: 0.3,
      },
      "unused-javascript": {
        id: "unused-javascript",
        title: "Remove unused JavaScript",
        score: 0.5,
        details: { type: "opportunity", overallSavingsMs: 100 },
      },
      "render-blocking-resources": {
        id: "render-blocking-resources",
        title: "Eliminate render-blocking resources",
        score: 0.2,
        details: { type: "opportunity", overallSavingsMs: 500 },
      },
    };
    const results = extractLighthouseOptimizations(audits);
    expect(results[0].auditId).toBe("render-blocking-resources"); // opportunity, 500ms
    expect(results[1].auditId).toBe("unused-javascript"); // opportunity, 100ms
    expect(results[2].auditId).toBe("dom-size"); // diagnostic
  });

  it("ignores unrecognized audit IDs", () => {
    const audits = {
      "custom-audit": {
        id: "custom-audit",
        title: "Custom Audit",
        score: 0,
      },
    };
    const results = extractLighthouseOptimizations(audits);
    expect(results).toHaveLength(0);
  });

  it("handles empty audits", () => {
    const results = extractLighthouseOptimizations({});
    expect(results).toHaveLength(0);
  });
});
