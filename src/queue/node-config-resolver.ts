/**
 * Issue #1088 — Unified resolver for remote-worker node configuration.
 *
 * Reads the user's `~/.openzigs/config.json` at call time so that URL/token
 * edits made via the Admin UI take effect without a server restart.
 *
 * The five "remote-addressable" node types are exposed publicly; the two
 * extras (`audio`, `sad-talker`) exist only so that {@link resolveNodeConfig}
 * can replace every inline `networkNodeUrl` read inside `queue-master.ts`
 * (acceptance criterion of #1088).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type RemoteNodeType =
  | "image-gen"
  | "video-gen"
  | "music-gen"
  | "rvc"
  | "lip-sync";

export type ResolvableNodeType = RemoteNodeType | "audio" | "sad-talker";

export interface ResolvedNodeConfig {
  url: string;
  token?: string;
  /** Per-node opt-in for RFC1918 / private-range URLs (#1090 SSRF guard). */
  allowLan: boolean;
}

interface NodeNamespaceSpec {
  /** Top-level key in `~/.openzigs/config.json`. */
  configKey: string;
  /** Default URL to fall back to when no remote URL is configured. */
  localDefaultUrl: string;
}

const NODE_SPEC: Record<ResolvableNodeType, NodeNamespaceSpec> = {
  "image-gen": {
    configKey: "imageGen",
    localDefaultUrl: "http://localhost:5005",
  },
  "video-gen": {
    configKey: "videoGen",
    localDefaultUrl: "http://localhost:5007",
  },
  "music-gen": {
    configKey: "musicGen",
    localDefaultUrl: "http://localhost:5009",
  },
  rvc: {
    configKey: "musicStudio",
    localDefaultUrl: "http://localhost:5010",
  },
  "lip-sync": {
    configKey: "lipSync",
    localDefaultUrl: "http://localhost:5010",
  },
  audio: {
    configKey: "audioSidecar",
    localDefaultUrl: "http://localhost:5006",
  },
  "sad-talker": {
    configKey: "sadTalker",
    localDefaultUrl: "http://localhost:5011",
  },
};

export interface ResolverOverrides {
  /** Local default URL when no remote config is set. */
  localDefaultUrl?: string;
  /** Local default token when no remote config is set. */
  localDefaultToken?: string;
  /** Path to the user config file. Defaults to `~/.openzigs/config.json`. */
  configPath?: string;
}

function defaultConfigPath(): string {
  return path.join(os.homedir(), ".openzigs", "config.json");
}

/**
 * Read a single node namespace from the on-disk config file.
 * Returns `null` if the file is missing/unreadable so callers can fall back
 * to baked-in defaults.
 */
export async function readNodeNamespace(
  nodeType: ResolvableNodeType,
  configPath: string = defaultConfigPath(),
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const spec = NODE_SPEC[nodeType];
    const ns = cfg[spec.configKey];
    if (ns && typeof ns === "object") {
      return ns as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve `{ url, token, allowLan }` for a given node type.
 *
 * Resolution order:
 *  1. `cfg.<namespace>.networkNodeUrl` (when non-empty string)
 *  2. `overrides.localDefaultUrl`
 *  3. The hardcoded local-default URL for the node type
 */
export async function resolveNodeConfig(
  nodeType: ResolvableNodeType,
  overrides: ResolverOverrides = {},
): Promise<ResolvedNodeConfig> {
  const spec = NODE_SPEC[nodeType];
  const ns = await readNodeNamespace(
    nodeType,
    overrides.configPath ?? defaultConfigPath(),
  );

  const networkUrl =
    ns && typeof ns.networkNodeUrl === "string" ? ns.networkNodeUrl : "";
  const networkToken =
    ns && typeof ns.networkNodeToken === "string"
      ? ns.networkNodeToken
      : undefined;
  const allowLan = ns?.allowLan === true;

  if (networkUrl) {
    return {
      url: networkUrl,
      token: networkToken ?? overrides.localDefaultToken,
      allowLan,
    };
  }

  return {
    url: overrides.localDefaultUrl ?? spec.localDefaultUrl,
    token: overrides.localDefaultToken,
    allowLan,
  };
}

/** Exposed for tests / migrations. */
export function namespaceForNode(nodeType: ResolvableNodeType): string {
  return NODE_SPEC[nodeType].configKey;
}
