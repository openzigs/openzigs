/**
 * Debug why fetchPinPageData returns null for valid pins.
 */
const pinId = "422281212543552";
const pinUrl = `https://www.pinterest.com/pin/${pinId}/`;

console.log("Fetching:", pinUrl);

try {
  const res = await fetch(pinUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  console.log("Status:", res.status);
  console.log("Content-Type:", res.headers.get("content-type"));
  console.log("Content-Length:", res.headers.get("content-length"));

  const html = await res.text();
  console.log("HTML length:", html.length);

  // Check for og:title
  const titleMatch = html.match(/<meta\s+(?:property|name)="og:title"[^>]*?content="([^"]+)"/i);
  console.log("og:title match:", titleMatch?.[1]?.slice(0, 80) ?? "NOT FOUND");

  // Check for pinterestapp:repins
  const repinsMatch = html.match(/<meta\s+(?:property|name)="pinterestapp:repins"[^>]*?content="([^"]+)"/i);
  console.log("repins match:", repinsMatch?.[1] ?? "NOT FOUND");

  // Check for pinterestapp:pinboard
  const boardMatch = html.match(/<meta\s+(?:property|name)="pinterestapp:pinboard"[^>]*?content="([^"]+)"/i);
  console.log("board match:", boardMatch?.[1] ?? "NOT FOUND");

  // Check for og:image
  const imgMatch = html.match(/<meta\s+(?:property|name)="(?:pinterestapp:pinimage|og:image)"[^>]*?content="([^"]+)"/i);
  console.log("image match:", imgMatch?.[1]?.slice(0, 60) ?? "NOT FOUND");

  // Try content="..." property="..." order  
  const reverseTitleMatch = html.match(/<meta\s+content="([^"]+)"[^>]*?(?:property|name)="og:title"/i);
  console.log("reverse og:title:", reverseTitleMatch?.[1]?.slice(0, 80) ?? "NOT FOUND");

  // Show first meta tags
  const metas = html.match(/<meta\s+[^>]+>/gi);
  console.log("\nFirst 5 meta tags:");
  for (const m of (metas ?? []).slice(0, 5)) {
    console.log(" ", m.slice(0, 120));
  }
  
  // Show og: meta tags specifically
  const ogMetas = (metas ?? []).filter(m => m.includes('og:') || m.includes('pinterestapp:'));
  console.log(`\nog: and pinterestapp: meta tags (${ogMetas.length}):`);
  for (const m of ogMetas) {
    console.log(" ", m.slice(0, 150));
  }
} catch (err) {
  console.error("Fetch error:", err);
}
