import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// We need to import after mock setup
import { validateUrl, extractBlog } from "./blog-extractor.js";

describe("blog-extractor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── validateUrl ──────────────────────────────────────────────

  describe("validateUrl", () => {
    it("accepts valid https URLs", () => {
      const url = validateUrl("https://example.com/blog/post-1");
      expect(url.hostname).toBe("example.com");
      expect(url.protocol).toBe("https:");
    });

    it("accepts valid http URLs", () => {
      const url = validateUrl("http://example.com/page");
      expect(url.protocol).toBe("http:");
    });

    it("rejects invalid URL strings", () => {
      expect(() => validateUrl("not-a-url")).toThrow("Invalid URL");
    });

    it("rejects non-http protocols", () => {
      expect(() => validateUrl("ftp://example.com")).toThrow("Only http/https URLs are allowed");
      expect(() => validateUrl("file:///etc/passwd")).toThrow("Only http/https URLs are allowed");
    });

    it("rejects localhost", () => {
      expect(() => validateUrl("http://localhost:3000")).toThrow("Blocked host");
    });

    it("rejects 127.0.0.1", () => {
      expect(() => validateUrl("http://127.0.0.1/admin")).toThrow("Blocked host");
    });

    it("rejects 0.0.0.0", () => {
      expect(() => validateUrl("http://0.0.0.0")).toThrow("Blocked host");
    });

    it("rejects [::1]", () => {
      expect(() => validateUrl("http://[::1]")).toThrow("Blocked host");
    });

    it("rejects metadata.google.internal (SSRF)", () => {
      expect(() => validateUrl("http://metadata.google.internal")).toThrow("Blocked host");
    });

    it("rejects AWS metadata endpoint", () => {
      expect(() => validateUrl("http://169.254.169.254/latest")).toThrow("Blocked host");
    });

    it("rejects 10.x.x.x private IPs", () => {
      expect(() => validateUrl("http://10.0.0.1")).toThrow("Private/internal IP");
    });

    it("rejects 172.16-31.x.x private IPs", () => {
      expect(() => validateUrl("http://172.16.0.1")).toThrow("Private/internal IP");
      expect(() => validateUrl("http://172.31.255.255")).toThrow("Private/internal IP");
    });

    it("rejects 192.168.x.x private IPs", () => {
      expect(() => validateUrl("http://192.168.1.1")).toThrow("Private/internal IP");
    });

    it("rejects 169.254.x.x link-local IPs", () => {
      expect(() => validateUrl("http://169.254.1.1")).toThrow("Private/internal IP");
    });
  });

  // ── extractBlog ──────────────────────────────────────────────

  describe("extractBlog", () => {
    it("extracts text, images, and metadata from a simple blog page", async () => {
      const html = `<!DOCTYPE html>
<html>
<head>
  <title>Test Blog Post</title>
  <meta property="og:title" content="OG Title" />
  <meta property="og:description" content="OG Description" />
  <meta property="og:image" content="https://example.com/og.jpg" />
  <meta property="og:site_name" content="TestSite" />
  <meta name="author" content="Test Author" />
</head>
<body>
  <article>
    <p>This is the first paragraph of the blog post.</p>
    <img src="https://example.com/images/photo1.jpg" alt="A test photo" />
    <p>Second paragraph with more content here.</p>
  </article>
</body>
</html>`;

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: "OK",
        url: "https://example.com/blog/test",
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        text: vi.fn().mockResolvedValue(html),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

      const result = await extractBlog("https://example.com/blog/test");

      expect(result.metadata.title).toBe("OG Title");
      expect(result.metadata.description).toBe("OG Description");
      expect(result.metadata.siteName).toBe("TestSite");
      expect(result.metadata.author).toBe("Test Author");
      expect(result.text).toContain("first paragraph");
      expect(result.text).toContain("Second paragraph");
      expect(result.wordCount).toBeGreaterThan(0);
      expect(result.resolvedUrl).toBe("https://example.com/blog/test");
      // og:image should be prepended
      expect(result.images[0].url).toBe("https://example.com/og.jpg");
      // The inline image
      expect(result.images.some(i => i.url === "https://example.com/images/photo1.jpg")).toBe(true);
    });

    it("throws on HTTP error responses", async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: "Not Found",
        url: "https://example.com/missing",
        headers: new Headers({ "content-type": "text/html" }),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

      await expect(extractBlog("https://example.com/missing")).rejects.toThrow("HTTP 404");
    });

    it("throws on non-HTML content type", async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        statusText: "OK",
        url: "https://example.com/file.pdf",
        headers: new Headers({ "content-type": "application/pdf" }),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

      await expect(extractBlog("https://example.com/file.pdf")).rejects.toThrow("Unexpected content type");
    });

    it("falls back to <main> if no <article>", async () => {
      const html = `<html><head><title>Main Only</title></head><body><main><p>Main content here.</p></main></body></html>`;
      const mockResponse = {
        ok: true, status: 200, statusText: "OK",
        url: "https://example.com/main",
        headers: new Headers({ "content-type": "text/html" }),
        text: vi.fn().mockResolvedValue(html),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

      const result = await extractBlog("https://example.com/main");
      expect(result.text).toContain("Main content here");
    });

    it("falls back to <body> if no <article> or <main>", async () => {
      const html = `<html><head><title>Body Only</title></head><body><p>Body content.</p></body></html>`;
      const mockResponse = {
        ok: true, status: 200, statusText: "OK",
        url: "https://example.com/body",
        headers: new Headers({ "content-type": "text/html" }),
        text: vi.fn().mockResolvedValue(html),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

      const result = await extractBlog("https://example.com/body");
      expect(result.text).toContain("Body content");
    });

    it("strips script and style tags from content", async () => {
      const html = `<html><head><title>T</title></head><body><article><script>alert('xss')</script><style>.foo{}</style><p>Clean text.</p></article></body></html>`;
      const mockResponse = {
        ok: true, status: 200, statusText: "OK",
        url: "https://example.com/t",
        headers: new Headers({ "content-type": "text/html" }),
        text: vi.fn().mockResolvedValue(html),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

      const result = await extractBlog("https://example.com/t");
      expect(result.text).not.toContain("alert");
      expect(result.text).not.toContain(".foo");
      expect(result.text).toContain("Clean text");
    });

    it("deduplicates images by URL", async () => {
      const html = `<html><head><title>Dup</title></head><body><article>
        <img src="https://example.com/img.jpg" alt="First" />
        <img src="https://example.com/img.jpg" alt="Duplicate" />
      </article></body></html>`;
      const mockResponse = {
        ok: true, status: 200, statusText: "OK",
        url: "https://example.com/dup",
        headers: new Headers({ "content-type": "text/html" }),
        text: vi.fn().mockResolvedValue(html),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

      const result = await extractBlog("https://example.com/dup");
      const imgUrls = result.images.map(i => i.url);
      const unique = new Set(imgUrls);
      expect(unique.size).toBe(imgUrls.length);
    });

    it("skips tracking pixels and icons", async () => {
      const html = `<html><head><title>Skip</title></head><body><article>
        <img src="https://example.com/pixel.gif" alt="tracking" />
        <img src="https://example.com/favicon.ico" alt="icon" />
        <img src="https://example.com/real-photo.jpg" alt="Real photo" />
      </article></body></html>`;
      const mockResponse = {
        ok: true, status: 200, statusText: "OK",
        url: "https://example.com/skip",
        headers: new Headers({ "content-type": "text/html" }),
        text: vi.fn().mockResolvedValue(html),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

      const result = await extractBlog("https://example.com/skip");
      expect(result.images.length).toBe(1);
      expect(result.images[0].url).toContain("real-photo");
    });

    it("resolves relative image URLs", async () => {
      const html = `<html><head><title>Rel</title></head><body><article>
        <img src="/images/relative.jpg" alt="Relative" />
      </article></body></html>`;
      const mockResponse = {
        ok: true, status: 200, statusText: "OK",
        url: "https://example.com/blog/post",
        headers: new Headers({ "content-type": "text/html" }),
        text: vi.fn().mockResolvedValue(html),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

      const result = await extractBlog("https://example.com/blog/post");
      expect(result.images[0].url).toBe("https://example.com/images/relative.jpg");
    });

    it("decodes HTML entities in text", async () => {
      const html = `<html><head><title>Ent</title></head><body><article><p>Tom &amp; Jerry &lt;3 &quot;quotes&quot; &#39;apos&#39;</p></article></body></html>`;
      const mockResponse = {
        ok: true, status: 200, statusText: "OK",
        url: "https://example.com/ent",
        headers: new Headers({ "content-type": "text/html" }),
        text: vi.fn().mockResolvedValue(html),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

      const result = await extractBlog("https://example.com/ent");
      expect(result.text).toContain("Tom & Jerry");
      expect(result.text).toContain('<3');
    });

    it("extracts heading text from h1-h6 tags", async () => {
      const html = `<html><head><title>Headings</title></head><body><article><h2>Section Title</h2><p>Content here.</p></article></body></html>`;
      const mockResponse = {
        ok: true, status: 200, statusText: "OK",
        url: "https://example.com/headings",
        headers: new Headers({ "content-type": "text/html" }),
        text: vi.fn().mockResolvedValue(html),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

      const result = await extractBlog("https://example.com/headings");
      expect(result.text).toContain("Section Title");
    });

    it("uses title tag if og:title is not available", async () => {
      const html = `<html><head><title>Fallback Title</title></head><body><article><p>Text.</p></article></body></html>`;
      const mockResponse = {
        ok: true, status: 200, statusText: "OK",
        url: "https://example.com/fb",
        headers: new Headers({ "content-type": "text/html" }),
        text: vi.fn().mockResolvedValue(html),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

      const result = await extractBlog("https://example.com/fb");
      expect(result.metadata.title).toBe("Fallback Title");
    });

    it("rejects SSRF URLs in extractBlog", async () => {
      await expect(extractBlog("http://localhost:8080/admin")).rejects.toThrow("Blocked host");
      await expect(extractBlog("http://10.0.0.1/internal")).rejects.toThrow("Private/internal IP");
    });
  });
});
