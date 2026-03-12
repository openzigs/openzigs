import { createPinterestSeoTools } from "../src/mcp/tools/pinterest-seo-tools.js";

const tools = createPinterestSeoTools();
const seoTool = tools.find((t) => t.name === "pinterest-seo-analyze");
if (!seoTool) {
  console.error("pinterest-seo-analyze tool not found!");
  process.exit(1);
}

const urls = [
  "https://www.pinterest.com/pin/422281212543552/",
  "https://www.pinterest.com/pin/12877548933020939/",
  "https://www.pinterest.com/pin/281543726694967/",
  "https://www.pinterest.com/pin/1106478202218332610/",
  "https://www.pinterest.com/pin/987654321/",
  "https://www.pinterest.com/pin/123456789/",
];

for (const url of urls) {
  console.log(`\n=== Analyzing: ${url} ===\n`);
  try {
    // Call analyze_url action
    const res = await seoTool.handler({ action: "analyze_url", url, include_annotations: true, include_competitors: false });
    const text = typeof res === "string" ? res : res.text;
    if (!text) {
      console.log(`No output returned for ${url}`);
      continue;
    }
    // Print full report (trim long output for console)
    console.log(text.slice(0, 3000));
    if (text.length > 3000) console.log(`\n... (${text.length - 3000} more chars)\n`);
  } catch (err) {
    console.error(`Error analyzing ${url}:`, err instanceof Error ? err.message : String(err));
  }
}
