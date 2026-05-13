import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveNodeConfig,
  readNodeNamespace,
  namespaceForNode,
  type ResolvableNodeType,
} from "./node-config-resolver.js";

describe("node-config-resolver", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ncr-"));
    configPath = path.join(tmpDir, "config.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeConfig(cfg: unknown): Promise<void> {
    await fs.writeFile(configPath, JSON.stringify(cfg));
  }

  describe("namespaceForNode", () => {
    it("maps every node type to a top-level config key", () => {
      const expected: Record<ResolvableNodeType, string> = {
        "image-gen": "imageGen",
        "video-gen": "videoGen",
        "music-gen": "musicGen",
        rvc: "musicStudio",
        "lip-sync": "lipSync",
        audio: "audioSidecar",
        "sad-talker": "sadTalker",
      };
      for (const [node, ns] of Object.entries(expected)) {
        expect(namespaceForNode(node as ResolvableNodeType)).toBe(ns);
      }
    });
  });

  describe("readNodeNamespace", () => {
    it("returns null when the config file does not exist", async () => {
      const ns = await readNodeNamespace(
        "image-gen",
        path.join(tmpDir, "missing.json"),
      );
      expect(ns).toBeNull();
    });

    it("returns null on malformed JSON", async () => {
      await fs.writeFile(configPath, "{ not json");
      const ns = await readNodeNamespace("image-gen", configPath);
      expect(ns).toBeNull();
    });

    it("returns null when namespace is missing", async () => {
      await writeConfig({ otherKey: { foo: 1 } });
      const ns = await readNodeNamespace("image-gen", configPath);
      expect(ns).toBeNull();
    });

    it("returns the namespace object when present", async () => {
      await writeConfig({ imageGen: { networkNodeUrl: "https://x" } });
      const ns = await readNodeNamespace("image-gen", configPath);
      expect(ns).toEqual({ networkNodeUrl: "https://x" });
    });
  });

  describe("resolveNodeConfig", () => {
    const cases: Array<{ node: ResolvableNodeType; cfgKey: string }> = [
      { node: "image-gen", cfgKey: "imageGen" },
      { node: "video-gen", cfgKey: "videoGen" },
      { node: "music-gen", cfgKey: "musicGen" },
      { node: "rvc", cfgKey: "musicStudio" },
      { node: "lip-sync", cfgKey: "lipSync" },
      { node: "audio", cfgKey: "audioSidecar" },
      { node: "sad-talker", cfgKey: "sadTalker" },
    ];

    for (const { node, cfgKey } of cases) {
      it(`returns network URL+token for ${node}`, async () => {
        await writeConfig({
          [cfgKey]: {
            networkNodeUrl: `https://${node}.example.com`,
            networkNodeToken: `tok-${node}`,
          },
        });
        const r = await resolveNodeConfig(node, { configPath });
        expect(r).toEqual({
          url: `https://${node}.example.com`,
          token: `tok-${node}`,
          allowLan: false,
        });
      });

      it(`falls back to local default URL for ${node} when unset`, async () => {
        await writeConfig({});
        const r = await resolveNodeConfig(node, { configPath });
        expect(r.url).toMatch(/^http:\/\/localhost:\d+$/);
        expect(r.token).toBeUndefined();
        expect(r.allowLan).toBe(false);
      });
    }

    it("returns network URL with no token when token absent", async () => {
      await writeConfig({
        musicGen: { networkNodeUrl: "https://music.example.com" },
      });
      const r = await resolveNodeConfig("music-gen", { configPath });
      expect(r).toEqual({
        url: "https://music.example.com",
        token: undefined,
        allowLan: false,
      });
    });

    it("propagates allowLan: true from config", async () => {
      await writeConfig({
        imageGen: {
          networkNodeUrl: "http://192.168.68.60:5005",
          allowLan: true,
        },
      });
      const r = await resolveNodeConfig("image-gen", { configPath });
      expect(r.allowLan).toBe(true);
    });

    it("uses overrides.localDefaultUrl when no network URL configured", async () => {
      await writeConfig({});
      const r = await resolveNodeConfig("image-gen", {
        configPath,
        localDefaultUrl: "http://override:9000",
      });
      expect(r.url).toBe("http://override:9000");
    });

    it("uses overrides.localDefaultToken when network token absent", async () => {
      await writeConfig({
        imageGen: { networkNodeUrl: "https://x.example.com" },
      });
      const r = await resolveNodeConfig("image-gen", {
        configPath,
        localDefaultToken: "default-tok",
      });
      expect(r.token).toBe("default-tok");
    });

    it("ignores empty networkNodeUrl strings", async () => {
      await writeConfig({ imageGen: { networkNodeUrl: "" } });
      const r = await resolveNodeConfig("image-gen", { configPath });
      expect(r.url).toMatch(/^http:\/\/localhost:5005$/);
    });

    it("treats non-boolean allowLan as false", async () => {
      await writeConfig({
        imageGen: { networkNodeUrl: "https://x", allowLan: "yes" },
      });
      const r = await resolveNodeConfig("image-gen", { configPath });
      expect(r.allowLan).toBe(false);
    });
  });
});
