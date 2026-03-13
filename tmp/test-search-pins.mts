/**
 * Test pinterest-search-pins tool with seed pins discovered from Chrome DevTools.
 */
import { createPinterestSeoTools } from "../src/mcp/tools/pinterest-seo-tools.js";

const tools = createPinterestSeoTools();
const searchPinsTool = tools.find((t) => t.name === "pinterest-search-pins");

if (!searchPinsTool) {
  console.error("pinterest-search-pins tool not found!");
  console.log("Available tools:", tools.map((t) => t.name).join(", "));
  process.exit(1);
}

console.log(`Found ${tools.length} Pinterest tools:`);
for (const t of tools) console.log(`  - ${t.name}`);

console.log("\n=== Testing pinterest-search-pins ===\n");
console.log("Using 3 seed pins discovered by Chrome DevTools from Pinterest search 'spring nails 2026'");

const result = await searchPinsTool.handler({
  query: "spring nails 2026",
  pin_urls: [
    "https://www.pinterest.com/pin/422281212543552/",
    "https://www.pinterest.com/pin/12877548933020939/",
    "https://www.pinterest.com/pin/281543726694967/",
  ],
  count: 8,
  region: "US",
  include_board_discovery: true,
});

console.log("\n=== Result ===\n");
const text = typeof result === "string" ? result : result.text;
// Show first 3000 chars
console.log(text.slice(0, 3000));
if (text.length > 3000) console.log(`\n... (${text.length - 3000} more chars)`);
