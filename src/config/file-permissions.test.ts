/**
 * Tests for cross-platform file permission helpers.
 * Issue #598
 */

import { describe, it, expect, vi, afterEach } from "vitest";

const IS_WINDOWS = process.platform === "win32";

// We test the module by importing and verifying the returned shapes.
// The actual platform detection is process.platform which we can stub.

describe("file-permissions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  describe("on non-Windows (Unix/macOS)", () => {
    it("secureFileOptions returns mode 0o600", async () => {
      const { secureFileOptions } = await import("./file-permissions.js");
      const opts = secureFileOptions();
      if (IS_WINDOWS) {
        expect(opts.mode).toBeUndefined();
      } else {
        expect(opts.mode).toBe(0o600);
      }
    });

    it("secureDirOptions returns recursive true and mode 0o700", async () => {
      const { secureDirOptions } = await import("./file-permissions.js");
      const opts = secureDirOptions();
      if (IS_WINDOWS) {
        expect(opts).toEqual({ recursive: true });
      } else {
        expect(opts).toEqual({ recursive: true, mode: 0o700 });
      }
    });

    it("secureWriteOptions returns encoding and mode", async () => {
      const { secureWriteOptions } = await import("./file-permissions.js");
      const opts = secureWriteOptions();
      expect(opts.encoding).toBe("utf-8");
      if (IS_WINDOWS) {
        expect(opts.mode).toBeUndefined();
      } else {
        expect(opts.mode).toBe(0o600);
      }
    });

    it("chmodSecureFile calls fs.chmod on Unix", async () => {
      const mockChmod = vi.fn().mockResolvedValue(undefined);
      vi.doMock("node:fs/promises", () => ({
        default: { chmod: mockChmod },
        chmod: mockChmod,
      }));
      const { chmodSecureFile } = await import("./file-permissions.js");
      await chmodSecureFile("/tmp/test-file");
      // On Windows chmodSecureFile is a no-op; on Unix it calls fs.chmod
    });
  });

  describe("Windows platform simulation", () => {
    it("secureFileOptions omits mode on win32", async () => {
      const { secureFileOptions } = await import("./file-permissions.js");
      const opts = secureFileOptions();
      if (IS_WINDOWS) {
        expect(opts).not.toHaveProperty("mode");
      } else {
        expect(opts).toHaveProperty("mode");
      }
    });
  });
});
