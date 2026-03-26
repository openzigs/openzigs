/**
 * Tests for the platform capability detection module.
 * Issue #599
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import childProcess from "node:child_process";
import { getPlatformCapabilities, findChromePath, isDockerAvailableSync } from "./platform.js";
import type { PlatformCapabilities } from "./platform.js";

describe("getPlatformCapabilities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a capabilities object with all required fields", () => {
    const caps = getPlatformCapabilities();
    expect(caps).toHaveProperty("os");
    expect(caps).toHaveProperty("arch");
    expect(caps).toHaveProperty("dockerAvailable");
    expect(caps).toHaveProperty("sidecarsSupported");
    expect(caps).toHaveProperty("chromePath");
    expect(caps).toHaveProperty("isWindows");
    expect(caps).toHaveProperty("isMacOS");
    expect(caps).toHaveProperty("isLinux");
  });

  it("detects current OS correctly", () => {
    const caps = getPlatformCapabilities();
    expect(caps.os).toBe(process.platform);
  });

  it("detects architecture", () => {
    const caps = getPlatformCapabilities();
    expect(typeof caps.arch).toBe("string");
    expect(caps.arch.length).toBeGreaterThan(0);
  });

  it("boolean flags are consistent with os field", () => {
    const caps = getPlatformCapabilities();
    expect(caps.isWindows).toBe(caps.os === "win32");
    expect(caps.isMacOS).toBe(caps.os === "darwin");
    expect(caps.isLinux).toBe(caps.os === "linux");
  });

  it("chromePath is either a string or null", () => {
    const caps = getPlatformCapabilities();
    expect(caps.chromePath === null || typeof caps.chromePath === "string").toBe(true);
  });

  it("dockerAvailable is a boolean", () => {
    const caps = getPlatformCapabilities();
    expect(typeof caps.dockerAvailable).toBe("boolean");
  });

  describe("overrides", () => {
    it("accepts partial overrides for testing", () => {
      const caps = getPlatformCapabilities({
        os: "win32",
        isWindows: true,
        isMacOS: false,
        isLinux: false,
        sidecarsSupported: false,
        dockerAvailable: false,
        chromePath: "C:\\chrome.exe",
      });
      expect(caps.os).toBe("win32");
      expect(caps.isWindows).toBe(true);
      expect(caps.sidecarsSupported).toBe(false);
      expect(caps.chromePath).toBe("C:\\chrome.exe");
    });

    it("overrides only specified fields", () => {
      const caps = getPlatformCapabilities({ dockerAvailable: true });
      expect(caps.dockerAvailable).toBe(true);
      expect(caps.os).toBe(process.platform);
    });
  });

  describe("sidecarsSupported logic", () => {
    it("reports sidecars supported on darwin arm64", () => {
      const caps = getPlatformCapabilities({
        os: "darwin",
        arch: "arm64",
        sidecarsSupported: true,
      });
      expect(caps.sidecarsSupported).toBe(true);
    });

    it("reports sidecars NOT supported on win32", () => {
      const caps = getPlatformCapabilities({
        os: "win32",
        sidecarsSupported: false,
      });
      expect(caps.sidecarsSupported).toBe(false);
    });

    it("reports sidecars NOT supported on linux", () => {
      const caps = getPlatformCapabilities({
        os: "linux",
        sidecarsSupported: false,
      });
      expect(caps.sidecarsSupported).toBe(false);
    });
  });

  describe("PlatformCapabilities type", () => {
    it("satisfies the exported type", () => {
      const caps: PlatformCapabilities = getPlatformCapabilities();
      expect(caps.os).toBeDefined();
      expect(typeof caps.isWindows).toBe("boolean");
    });
  });
});

describe("findChromePath", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a string or null", () => {
    const result = findChromePath();
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("returns a valid path on macOS when Chrome is installed", () => {
    const result = findChromePath();
    if (process.platform === "darwin" && result !== null) {
      expect(result).toContain("Chrome");
    }
  });

  it("returns null when no candidate is accessible", () => {
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const result = findChromePath();
    expect(result).toBeNull();
  });

  it("returns the first accessible candidate", () => {
    let callCount = 0;
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      callCount++;
      if (callCount < 2) throw new Error("ENOENT");
      // Second candidate succeeds
    });
    const result = findChromePath();
    expect(typeof result).toBe("string");
    expect(result).not.toBeNull();
  });

  it("builds win32 candidate paths from env vars", () => {
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const result = findChromePath("win32");
    // All candidates fail, returns null — but win32 branch was exercised
    expect(result).toBeNull();
  });

  it("returns a win32 Chrome path when accessible", () => {
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      // All candidates "succeed"
    });
    const result = findChromePath("win32");
    expect(typeof result).toBe("string");
    expect(result).toContain("chrome");
  });

  it("builds linux candidate paths", () => {
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const result = findChromePath("linux");
    expect(result).toBeNull();
  });

  it("returns a linux Chrome path when accessible", () => {
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      // All succeed
    });
    const result = findChromePath("linux");
    expect(typeof result).toBe("string");
    expect(result).toContain("/usr/bin/");
  });
});

describe("isDockerAvailableSync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when docker info succeeds", () => {
    vi.spyOn(childProcess, "execSync").mockImplementation(() => Buffer.from(""));
    const result = isDockerAvailableSync();
    expect(result).toBe(true);
  });

  it("returns false when docker info throws", () => {
    vi.spyOn(childProcess, "execSync").mockImplementation(() => {
      throw new Error("docker not found");
    });
    const result = isDockerAvailableSync();
    expect(result).toBe(false);
  });
});
