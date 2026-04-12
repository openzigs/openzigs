import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { spawn } from "node:child_process";
import { marked } from "marked";

// ── Chrome binary discovery ─────────────────────────────────────────────

const CHROME_PATHS_FOR_PDF: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
};

export function findChromeBinaryForPdf(): string | undefined {
  const paths = CHROME_PATHS_FOR_PDF[os.platform()] ?? [];
  return paths.find((p) => fs.existsSync(p));
}

// ── HTML wrapper ────────────────────────────────────────────────────────

export function wrapMarkdownAsHtml(markdownContent: string): string {
  // Convert mermaid code blocks into <pre class="mermaid"> elements so
  // the mermaid.js library (loaded below) renders them as inline SVGs.
  const processedMarkdown = markdownContent.replace(
    /```mermaid\n([\s\S]*?)```/g,
    (_match, content: string) =>
      `<pre class="mermaid">\n${content.trim()}\n</pre>`,
  );
  const body = marked(processedMarkdown) as string;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; font-size: 13px; line-height: 1.5; color: #1a1a1a; max-width: 900px; margin: 0 auto; padding: 24px 32px; }
  h1 { font-size: 22px; color: #e60023; border-bottom: 2px solid #e60023; padding-bottom: 8px; margin-bottom: 16px; }
  h2 { font-size: 16px; color: #333; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-top: 24px; }
  h3 { font-size: 14px; color: #444; margin-top: 16px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 12px; }
  th { background: #f0f0f0; border: 1px solid #ccc; padding: 6px 10px; text-align: left; font-weight: 600; }
  td { border: 1px solid #ddd; padding: 5px 10px; vertical-align: top; }
  tr:nth-child(even) td { background: #fafafa; }
  ul, ol { padding-left: 20px; margin: 8px 0; }
  li { margin: 3px 0; }
  code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 11px; }
  pre { background: #f4f4f4; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 11px; }
  blockquote { border-left: 3px solid #e60023; margin: 8px 0; padding: 4px 12px; color: #555; background: #fff5f5; }
  details { display: none; }
  strong { font-weight: 600; }
  em { color: #555; }
  hr { border: none; border-top: 1px solid #eee; margin: 20px 0; }
  @media print { body { padding: 0; } }
  .mermaid { text-align: center; margin: 16px 0; }
  .mermaid svg { max-width: 100%; height: auto; }
</style>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>mermaid.initialize({ startOnLoad: true, theme: "default" });</script>
</head>
<body>
${body}
</body>
</html>`;
}

// ── PDF generation ──────────────────────────────────────────────────────

/**
 * Saves a markdown report as PDF using Chrome headless print.
 * @param basename  – Filename stem (no extension).
 * @param markdownContent – Full markdown string.
 * @param outputDir – Directory to write the PDF into (will be created if missing).
 * @returns The PDF file path on success, or null if Chrome is not found.
 */
export async function saveReportPdf(
  basename: string,
  markdownContent: string,
  outputDir: string,
): Promise<string | null> {
  const chrome = findChromeBinaryForPdf();
  if (!chrome) return null;

  fs.mkdirSync(outputDir, { recursive: true });
  const pdfPath = path.join(outputDir, `${basename}.pdf`);

  try {
    // Serve via a local HTTP server so Chrome can fetch the mermaid CDN script.
    const htmlContent = wrapMarkdownAsHtml(markdownContent);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlContent);
    });
    const serverPort = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(
          chrome,
          [
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            `--print-to-pdf=${pdfPath}`,
            "--print-to-pdf-no-header",
            `--virtual-time-budget=10000`,
            `http://127.0.0.1:${serverPort}`,
          ],
          { stdio: "ignore" },
        );
        proc.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`Chrome exited ${code}`)),
        );
        proc.on("error", reject);
        setTimeout(() => {
          proc.kill();
          reject(new Error("Chrome PDF timeout"));
        }, 30000);
      });
    } finally {
      server.close();
    }
    return fs.existsSync(pdfPath) ? pdfPath : null;
  } catch {
    return null;
  }
}
