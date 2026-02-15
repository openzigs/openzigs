import { describe, it, expect } from "vitest";
import { STEALTH_SCRIPTS, COMBINED_STEALTH_SCRIPT } from "./stealth.js";

describe("browser stealth", () => {
  it("provides 17 stealth scripts", () => {
    expect(STEALTH_SCRIPTS.length).toBe(17);
  });

  it("combined script is a non-empty IIFE with concealed sourceURL", () => {
    expect(COMBINED_STEALTH_SCRIPT).toContain("(function()");
    expect(COMBINED_STEALTH_SCRIPT.length).toBeGreaterThan(100);
    // sourceURL must point to a generic extension path, not an empty/CDP path
    expect(COMBINED_STEALTH_SCRIPT).toContain("//# sourceURL=chrome-extension://");
  });

  it("combined script includes navigator.webdriver override", () => {
    expect(COMBINED_STEALTH_SCRIPT).toContain("navigator");
    expect(COMBINED_STEALTH_SCRIPT).toContain("webdriver");
  });

  it("combined script includes chrome.runtime shim", () => {
    expect(COMBINED_STEALTH_SCRIPT).toContain("chrome.runtime");
  });

  it("combined script includes chrome.app shim", () => {
    expect(COMBINED_STEALTH_SCRIPT).toContain("chrome.app");
  });

  it("combined script includes chrome.csi and chrome.loadTimes", () => {
    expect(COMBINED_STEALTH_SCRIPT).toContain("chrome.csi");
    expect(COMBINED_STEALTH_SCRIPT).toContain("chrome.loadTimes");
  });

  it("combined script patches WebGL1 and WebGL2 parameters", () => {
    expect(COMBINED_STEALTH_SCRIPT).toContain("WebGLRenderingContext");
    expect(COMBINED_STEALTH_SCRIPT).toContain("WebGL2RenderingContext");
  });

  it("combined script injects canvas fingerprint noise", () => {
    expect(COMBINED_STEALTH_SCRIPT).toContain("getImageData");
    expect(COMBINED_STEALTH_SCRIPT).toContain("toDataURL");
  });

  it("combined script injects AudioContext fingerprint noise", () => {
    expect(COMBINED_STEALTH_SCRIPT).toContain("AudioBuffer");
    expect(COMBINED_STEALTH_SCRIPT).toContain("getChannelData");
  });

  it("combined script spoofs navigator.connection", () => {
    expect(COMBINED_STEALTH_SCRIPT).toContain("navigator.connection");
    expect(COMBINED_STEALTH_SCRIPT).toContain("4g");
  });

  it("combined script cleans up stack traces", () => {
    expect(COMBINED_STEALTH_SCRIPT).toContain("prepareStackTrace");
  });

  it("combined script removes ChromeDriver markers", () => {
    expect(COMBINED_STEALTH_SCRIPT).toContain("domAutomationController");
    expect(COMBINED_STEALTH_SCRIPT).toContain("__webdriver_evaluate");
  });
});
