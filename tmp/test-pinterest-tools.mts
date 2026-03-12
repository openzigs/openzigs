import { createPinterestSeoTools } from "../src/mcp/tools/pinterest-seo-tools.js";

const tools = createPinterestSeoTools();

// Test 1: pinterest-list-boards
console.log("\n=== Test 1: pinterest-list-boards ===");
const listBoards = tools.find((t) => t.name === "pinterest-list-boards")!;
const boardResult = await listBoards.handler({});
console.log("isError:", boardResult.isError);
console.log(boardResult.text.substring(0, 600));

// Test 2: pinterest-pin-insights (with just a query, no pin IDs)
console.log("\n=== Test 2: pinterest-pin-insights (trends + keywords) ===");
const pinInsights = tools.find((t) => t.name === "pinterest-pin-insights")!;
const insightsResult = await pinInsights.handler({
  query: "AI coding assistant",
  region: "US",
  include_keyword_metrics: true,
  include_trend_data: true,
  include_pin_analysis: false,
});
console.log("isError:", insightsResult.isError);
console.log(insightsResult.text.substring(0, 1500));

// Test 3: pinterest-pin-insights (with pin analysis)
console.log("\n=== Test 3: pinterest-pin-insights (pin analysis) ===");
const analysisResult = await pinInsights.handler({
  query: "AI tools",
  region: "US",
  include_keyword_metrics: false,
  include_trend_data: false,
  include_pin_analysis: true,
  pin_ids: ["1106478202219379014"],
});
console.log("isError:", analysisResult.isError);
console.log(analysisResult.text.substring(0, 2000));

console.log("\n=== All tests complete ===");
