import { describe, expect, it } from "vitest";
import { migrateAllowLan, NODE_NAMESPACES } from "./migrations.js";

describe("migrateAllowLan", () => {
  it("returns empty migration list for null/undefined config", () => {
    expect(migrateAllowLan(null).migratedNamespaces).toEqual([]);
    expect(migrateAllowLan(undefined).migratedNamespaces).toEqual([]);
  });

  it("auto-enables allowLan for RFC1918 URLs across all namespaces", () => {
    const cfg: Record<string, unknown> = {};
    for (const ns of NODE_NAMESPACES) {
      cfg[ns] = { networkNodeUrl: "http://192.168.68.60:5005" };
    }
    const r = migrateAllowLan(cfg);
    expect(r.migratedNamespaces.sort()).toEqual([...NODE_NAMESPACES].sort());
    for (const ns of NODE_NAMESPACES) {
      expect((r.userConfig[ns] as Record<string, unknown>).allowLan).toBe(true);
    }
  });

  it("auto-enables allowLan for loopback URLs", () => {
    const r = migrateAllowLan({
      imageGen: { networkNodeUrl: "http://127.0.0.1:5005" },
    });
    expect(r.migratedNamespaces).toContain("imageGen");
  });

  it("does not touch public URLs", () => {
    const r = migrateAllowLan({
      imageGen: { networkNodeUrl: "https://fluxq.example.com" },
    });
    expect(r.migratedNamespaces).toEqual([]);
    expect("allowLan" in (r.userConfig.imageGen as object)).toBe(false);
  });

  it("does not overwrite explicit allowLan: false", () => {
    const r = migrateAllowLan({
      imageGen: {
        networkNodeUrl: "http://192.168.68.60:5005",
        allowLan: false,
      },
    });
    expect(r.migratedNamespaces).toEqual([]);
    expect((r.userConfig.imageGen as Record<string, unknown>).allowLan).toBe(
      false,
    );
  });

  it("does not overwrite explicit allowLan: true", () => {
    const r = migrateAllowLan({
      imageGen: {
        networkNodeUrl: "http://192.168.68.60:5005",
        allowLan: true,
      },
    });
    expect(r.migratedNamespaces).toEqual([]);
  });

  it("ignores namespaces without networkNodeUrl", () => {
    const r = migrateAllowLan({ imageGen: { mode: "local" } });
    expect(r.migratedNamespaces).toEqual([]);
  });

  it("ignores empty networkNodeUrl", () => {
    const r = migrateAllowLan({ imageGen: { networkNodeUrl: "" } });
    expect(r.migratedNamespaces).toEqual([]);
  });

  it("ignores non-object namespace values", () => {
    const r = migrateAllowLan({ imageGen: "not an object" });
    expect(r.migratedNamespaces).toEqual([]);
  });

  it("returns a new object — does not mutate input", () => {
    const input = {
      imageGen: { networkNodeUrl: "http://192.168.68.60:5005" },
    };
    const r = migrateAllowLan(input);
    expect(r.userConfig).not.toBe(input);
    expect("allowLan" in input.imageGen).toBe(false);
  });
});
