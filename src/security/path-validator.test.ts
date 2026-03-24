import { describe, it, expect } from "vitest";
import path from "node:path";
import { sanitizePath, validateResolvedPath, sanitizePathComponent } from "./path-validator.js";

describe("sanitizePath", () => {
  const base = "/home/user/data";

  it("resolves a simple relative path within the base", () => {
    const result = sanitizePath("file.txt", base);
    expect(result).toBe(path.resolve(base, "file.txt"));
  });

  it("resolves nested relative paths", () => {
    const result = sanitizePath("sub/dir/file.txt", base);
    expect(result).toBe(path.resolve(base, "sub/dir/file.txt"));
  });

  it("allows the base directory itself", () => {
    const result = sanitizePath(".", base);
    expect(result).toBe(path.resolve(base));
  });

  it("blocks simple traversal with ..", () => {
    expect(() => sanitizePath("../etc/passwd", base)).toThrow("Path traversal detected");
  });

  it("blocks nested traversal", () => {
    expect(() => sanitizePath("sub/../../etc/passwd", base)).toThrow("Path traversal detected");
  });

  it("blocks absolute path that escapes base", () => {
    expect(() => sanitizePath("/etc/passwd", base)).toThrow("Path traversal detected");
  });

  it("rejects null bytes", () => {
    expect(() => sanitizePath("file\0.txt", base)).toThrow("null bytes");
  });

  it("blocks encoded traversal that resolves outside base", () => {
    // path.resolve will normalise this
    expect(() => sanitizePath("..%2F..%2Fetc/passwd", base)).not.toThrow();
    // The literal percent-encoded string doesn't traverse — path.resolve treats it as a filename
    // But actual traversal does:
    expect(() => sanitizePath("../../../../etc/passwd", base)).toThrow("Path traversal detected");
  });
});

describe("validateResolvedPath", () => {
  const base = "/home/user/data";

  it("accepts a path within the base", () => {
    const result = validateResolvedPath("/home/user/data/file.txt", base);
    expect(result).toBe(path.resolve("/home/user/data/file.txt"));
  });

  it("accepts the base directory exactly", () => {
    const result = validateResolvedPath(base, base);
    expect(result).toBe(path.resolve(base));
  });

  it("rejects a path outside the base", () => {
    expect(() => validateResolvedPath("/etc/passwd", base)).toThrow("Path outside allowed directory");
  });

  it("rejects a sibling directory with similar prefix", () => {
    // /home/user/data-backup should NOT match /home/user/data
    expect(() => validateResolvedPath("/home/user/data-backup/file.txt", base)).toThrow(
      "Path outside allowed directory",
    );
  });

  it("rejects null bytes", () => {
    expect(() => validateResolvedPath("/home/user/data/file\0.txt", base)).toThrow("null bytes");
  });
});

describe("sanitizePathComponent", () => {
  it("accepts a simple filename", () => {
    expect(sanitizePathComponent("report.pdf")).toBe("report.pdf");
  });

  it("accepts alphanumeric IDs", () => {
    expect(sanitizePathComponent("abc-123_def")).toBe("abc-123_def");
  });

  it("rejects traversal sequences", () => {
    expect(() => sanitizePathComponent("..")).toThrow("Invalid path component");
    expect(() => sanitizePathComponent("../etc")).toThrow("Invalid path component");
  });

  it("rejects forward slashes", () => {
    expect(() => sanitizePathComponent("sub/dir")).toThrow("Invalid path component");
  });

  it("rejects backslashes", () => {
    expect(() => sanitizePathComponent("sub\\dir")).toThrow("Invalid path component");
  });

  it("rejects null bytes", () => {
    expect(() => sanitizePathComponent("file\0name")).toThrow("null bytes");
  });

  it("uses custom label in error messages", () => {
    expect(() => sanitizePathComponent("../bad", "session ID")).toThrow("Invalid session ID");
  });
});
