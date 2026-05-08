import { describe, it, expect } from "vitest";
import {
  DEFAULT_CLOUD_THRESHOLD_TOKENS,
  RouterPrivacyError,
  estimateInputTokens,
  routeRequest,
} from "./smart-router.js";

describe("estimateInputTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateInputTokens("")).toBe(0);
  });
  it("estimates ~length/4 tokens", () => {
    expect(estimateInputTokens("abcd")).toBe(1);
    expect(estimateInputTokens("a".repeat(40))).toBe(10);
  });
  it("rounds up partial tokens", () => {
    expect(estimateInputTokens("abc")).toBe(1);
  });
});

describe("routeRequest — privacy mode (hard kill switch)", () => {
  it("global privacy + local available → local", () => {
    const d = routeRequest({
      inputTokens: 100,
      localProviderConfigured: true,
      privacyMode: "global",
    });
    expect(d.provider).toBe("local");
    expect(d.reason).toBe("privacy_mode_local");
  });

  it("session privacy + local available → local", () => {
    const d = routeRequest({
      inputTokens: 100_000,
      localProviderConfigured: true,
      privacyMode: "session",
    });
    expect(d.provider).toBe("local");
    expect(d.reason).toBe("privacy_mode_local");
  });

  it("global privacy + NO local provider → throws RouterPrivacyError", () => {
    expect(() =>
      routeRequest({
        inputTokens: 100,
        localProviderConfigured: false,
        privacyMode: "global",
      }),
    ).toThrow(RouterPrivacyError);
  });

  it("session privacy + NO local provider → throws RouterPrivacyError", () => {
    expect(() =>
      routeRequest({
        inputTokens: 100,
        localProviderConfigured: false,
        privacyMode: "session",
      }),
    ).toThrow(RouterPrivacyError);
  });

  it("privacy_mode_local ignores any threshold (large prompts still go local)", () => {
    const d = routeRequest({
      inputTokens: 1_000_000,
      localProviderConfigured: true,
      privacyMode: "global",
      cloudThresholdTokens: 100,
    });
    expect(d.provider).toBe("local");
    expect(d.estimatedTokens).toBe(1_000_000);
  });
});

describe("routeRequest — router disabled", () => {
  it("disabled router always returns cloud", () => {
    const d = routeRequest({
      inputTokens: 1,
      localProviderConfigured: true,
      privacyMode: "off",
      enabled: false,
    });
    expect(d.provider).toBe("cloud");
    expect(d.reason).toBe("router_disabled");
  });

  it("disabled router yields cloud even when local available", () => {
    const d = routeRequest({
      inputTokens: 100,
      localProviderConfigured: true,
      privacyMode: "off",
      enabled: false,
    });
    expect(d.provider).toBe("cloud");
  });
});

describe("routeRequest — local provider missing", () => {
  it("no local provider + privacy off → cloud", () => {
    const d = routeRequest({
      inputTokens: 100,
      localProviderConfigured: false,
      privacyMode: "off",
    });
    expect(d.provider).toBe("cloud");
    expect(d.reason).toBe("no_local_provider");
  });
});

describe("routeRequest — threshold logic", () => {
  it("below threshold + local available → local", () => {
    const d = routeRequest({
      inputTokens: 100,
      localProviderConfigured: true,
      privacyMode: "off",
      cloudThresholdTokens: 4096,
    });
    expect(d.provider).toBe("local");
    expect(d.reason).toBe("below_threshold_local");
  });

  it("at exactly the threshold → local (boundary inclusive)", () => {
    const d = routeRequest({
      inputTokens: 4096,
      localProviderConfigured: true,
      privacyMode: "off",
      cloudThresholdTokens: 4096,
    });
    expect(d.provider).toBe("local");
  });

  it("above threshold → cloud", () => {
    const d = routeRequest({
      inputTokens: 4097,
      localProviderConfigured: true,
      privacyMode: "off",
      cloudThresholdTokens: 4096,
    });
    expect(d.provider).toBe("cloud");
    expect(d.reason).toBe("above_threshold_cloud");
  });

  it("uses default threshold of 4096 when not provided", () => {
    expect(DEFAULT_CLOUD_THRESHOLD_TOKENS).toBe(4096);
    const d = routeRequest({
      inputTokens: 4096,
      localProviderConfigured: true,
      privacyMode: "off",
    });
    expect(d.thresholdTokens).toBe(4096);
    expect(d.provider).toBe("local");
  });

  it("estimates from prompt when inputTokens omitted", () => {
    const d = routeRequest({
      prompt: "a".repeat(10),
      localProviderConfigured: true,
      privacyMode: "off",
    });
    expect(d.estimatedTokens).toBe(3); // ceil(10/4)
    expect(d.provider).toBe("local");
  });

  it("normalises NaN inputTokens to estimate-from-prompt", () => {
    const d = routeRequest({
      prompt: "ab",
      inputTokens: Number.NaN,
      localProviderConfigured: true,
      privacyMode: "off",
    });
    expect(d.estimatedTokens).toBe(1);
  });

  it("normalises negative inputTokens to 0", () => {
    const d = routeRequest({
      inputTokens: -50,
      localProviderConfigured: true,
      privacyMode: "off",
    });
    expect(d.estimatedTokens).toBe(0);
    expect(d.provider).toBe("local");
  });

  it("uses custom threshold when provided", () => {
    const d = routeRequest({
      inputTokens: 500,
      localProviderConfigured: true,
      privacyMode: "off",
      cloudThresholdTokens: 256,
    });
    expect(d.provider).toBe("cloud");
    expect(d.thresholdTokens).toBe(256);
  });

  it("decision payload echoes privacyMode for audit", () => {
    const d = routeRequest({
      inputTokens: 1,
      localProviderConfigured: true,
      privacyMode: "off",
    });
    expect(d.privacyMode).toBe("off");
  });
});

describe("RouterPrivacyError", () => {
  it("has stable error code for callers to switch on", () => {
    const e = new RouterPrivacyError();
    expect(e.code).toBe("ROUTER_PRIVACY_NO_LOCAL_PROVIDER");
    expect(e.name).toBe("RouterPrivacyError");
  });
});
