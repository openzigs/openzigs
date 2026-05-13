import { describe, expect, it } from "vitest";
import {
  validateNodeUrl,
  isLikelyLanUrl,
  isLoopback,
  isLinkLocal,
  isPrivate,
  SsrfBlockedError,
  LanNotAllowedError,
} from "./url-validator.js";

function fakeResolver(map: Record<string, string[]>) {
  return async (host: string) => {
    const ips = map[host];
    if (!ips) throw new Error("ENOTFOUND");
    return ips.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
  };
}

describe("url-validator: classification predicates", () => {
  it("classifies IPv4 loopback", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.255.0.1")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(true);
    expect(isLoopback("8.8.8.8")).toBe(false);
  });

  it("classifies IPv6 loopback (incl. IPv4-mapped)", () => {
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("::ffff:8.8.8.8")).toBe(false);
  });

  it("classifies link-local IPv4", () => {
    expect(isLinkLocal("169.254.169.254")).toBe(true);
    expect(isLinkLocal("169.254.0.1")).toBe(true);
    expect(isLinkLocal("169.255.0.1")).toBe(false);
  });

  it("classifies link-local IPv6 (fe80::/10)", () => {
    expect(isLinkLocal("fe80::1")).toBe(true);
    expect(isLinkLocal("febf::1")).toBe(true);
    expect(isLinkLocal("fec0::1")).toBe(false);
  });

  it("classifies RFC1918 private ranges", () => {
    expect(isPrivate("10.0.0.1")).toBe(true);
    expect(isPrivate("10.255.255.254")).toBe(true);
    expect(isPrivate("172.16.0.1")).toBe(true);
    expect(isPrivate("172.31.255.254")).toBe(true);
    expect(isPrivate("172.32.0.1")).toBe(false);
    expect(isPrivate("172.15.0.1")).toBe(false);
    expect(isPrivate("192.168.68.60")).toBe(true);
    expect(isPrivate("8.8.8.8")).toBe(false);
  });

  it("classifies IPv6 unique-local (fc00::/7)", () => {
    expect(isPrivate("fc00::1")).toBe(true);
    expect(isPrivate("fd00::1")).toBe(true);
    expect(isPrivate("fe00::1")).toBe(false);
  });
});

describe("url-validator: isLikelyLanUrl", () => {
  it("matches RFC1918 literals", () => {
    expect(isLikelyLanUrl("http://192.168.68.60:5005")).toBe(true);
    expect(isLikelyLanUrl("http://10.0.0.1")).toBe(true);
    expect(isLikelyLanUrl("http://172.16.0.1:8080")).toBe(true);
  });

  it("matches loopback literals", () => {
    expect(isLikelyLanUrl("http://127.0.0.1")).toBe(true);
    expect(isLikelyLanUrl("http://localhost:3000")).toBe(true);
  });

  it("returns false for public hostnames", () => {
    expect(isLikelyLanUrl("https://fluxq.example.com")).toBe(false);
  });

  it("returns false for empty / malformed", () => {
    expect(isLikelyLanUrl("")).toBe(false);
    expect(isLikelyLanUrl("not a url")).toBe(false);
  });
});

describe("url-validator: validateNodeUrl", () => {
  it("rejects empty URL", async () => {
    await expect(validateNodeUrl("")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects malformed URL", async () => {
    await expect(validateNodeUrl("not-a-url")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("rejects non-http(s) protocols", async () => {
    await expect(validateNodeUrl("file:///etc/passwd")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    await expect(
      validateNodeUrl("ftp://example.com/foo"),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(validateNodeUrl("javascript:alert(1)")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("rejects blocked hostnames (cloud metadata / localhost alias)", async () => {
    for (const host of ["localhost", "metadata", "metadata.google.internal"]) {
      await expect(
        validateNodeUrl(`http://${host}/foo`, { allowLan: true }),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
    }
  });

  it("rejects loopback IP literal even with allowLan", async () => {
    await expect(
      validateNodeUrl("http://127.0.0.1:6379", { allowLan: true }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects AWS metadata IP literal even with allowLan", async () => {
    await expect(
      validateNodeUrl("http://169.254.169.254/latest/meta-data/", {
        allowLan: true,
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects RFC1918 IP literal when allowLan=false", async () => {
    await expect(
      validateNodeUrl("http://192.168.68.60:5005", { allowLan: false }),
    ).rejects.toBeInstanceOf(LanNotAllowedError);
  });

  it("permits RFC1918 IP literal when allowLan=true", async () => {
    const r = await validateNodeUrl("http://192.168.68.60:5005", {
      allowLan: true,
    });
    expect(r.url.hostname).toBe("192.168.68.60");
  });

  it("permits public hostname (DNS resolves to public IP)", async () => {
    const r = await validateNodeUrl("https://fluxq.example.com", {
      resolver: fakeResolver({ "fluxq.example.com": ["104.21.10.5"] }),
    });
    expect(r.url.hostname).toBe("fluxq.example.com");
    expect(r.resolved[0].classification).toBe("public");
  });

  it("blocks hostname that resolves to loopback (DNS rebinding)", async () => {
    await expect(
      validateNodeUrl("http://evil.example.com", {
        allowLan: true,
        resolver: fakeResolver({ "evil.example.com": ["127.0.0.1"] }),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks hostname that resolves to AWS metadata IP", async () => {
    await expect(
      validateNodeUrl("http://attacker.example.com", {
        allowLan: true,
        resolver: fakeResolver({
          "attacker.example.com": ["169.254.169.254"],
        }),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks hostname when ANY resolved IP is private (split-horizon DNS)", async () => {
    await expect(
      validateNodeUrl("http://mixed.example.com", {
        allowLan: false,
        resolver: fakeResolver({
          "mixed.example.com": ["104.21.10.5", "10.0.0.1"],
        }),
      }),
    ).rejects.toBeInstanceOf(LanNotAllowedError);
  });

  it("blocks hostname with no DNS records", async () => {
    await expect(
      validateNodeUrl("http://nx.example.com", {
        resolver: async () => [],
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("wraps DNS errors as SsrfBlockedError", async () => {
    await expect(
      validateNodeUrl("http://nx.example.com", {
        resolver: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
