/**
 * Custom Post-Action persistence and template handlers.
 *
 * Users can create post-action types via the UI using:
 *   1. **Templates** — pre-built handler types (webhook, script) where users
 *      supply a configuration (URL, command, etc.).
 *   2. **Advanced builder** — users define custom config fields and a shell
 *      script body that receives stage output via stdin and config via env vars.
 *
 * Definitions are persisted as JSON and hot-registered with the PostActionRegistry
 * so they appear alongside built-in actions in every stage's dropdown.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { postActionRegistry } from "./post-action-registry.js";
import type {
  PostActionDefinition,
  ConfigSchema,
  ConfigFieldSchema,
  PostActionHandler,
} from "./post-action-registry.js";
import { logger } from "../logging/logger.js";
import { isAllowedWebhookUrl } from "../security/url-validation.js";

/* ------------------------------------------------------------------ */
/*  Persisted types                                                   */
/* ------------------------------------------------------------------ */

/** A single config field definition authored by the user in the advanced builder. */
export interface CustomFieldDefinition {
  key: string;
  type: "string" | "number" | "boolean" | "array";
  title: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  /** For string enum fields. */
  enum?: string[];
  enumLabels?: string[];
  placeholder?: string;
  minimum?: number;
  maximum?: number;
}

/** Template types users can choose from. */
export type TemplateType = "webhook" | "script";

/** Serialisable definition stored on disk. */
export interface CustomPostActionDefinition {
  /** Unique slug (e.g., "custom-slack-notify"). */
  type: string;
  /** Human-readable label shown in dropdowns. */
  label: string;
  /** Description of what this action does. */
  description: string;
  /** Grouping category. */
  category: string;
  /** Lucide icon name or emoji. */
  icon?: string;

  /**
   * Which template powers this action.
   *   - "webhook" — generic HTTP sender; uses `templateConfig.url`, etc.
   *   - "script"  — shell command; uses `templateConfig.command`, etc.
   *   - undefined  — advanced builder (user-defined fields + script body).
   */
  templateType?: TemplateType;

  /**
   * Template-specific configuration (for webhook/script templates).
   * Not used for advanced builder actions.
   */
  templateConfig?: Record<string, unknown>;

  /**
   * For advanced builder: user-defined config fields and a script body.
   */
  customFields?: CustomFieldDefinition[];
  scriptBody?: string;
  scriptTimeout?: number;

  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/*  Storage                                                           */
/* ------------------------------------------------------------------ */

const DATA_DIR = path.join(os.homedir(), ".openzigs");
const DATA_FILE = path.join(DATA_DIR, "custom-post-actions.json");

export async function loadCustomPostActions(): Promise<CustomPostActionDefinition[]> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    const data = JSON.parse(raw) as unknown;
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function saveCustomPostActions(defs: CustomPostActionDefinition[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(DATA_FILE, JSON.stringify(defs, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/* ------------------------------------------------------------------ */
/*  Template handlers                                                 */
/* ------------------------------------------------------------------ */

/** Build a webhook handler from template config. */
function createWebhookHandler(templateConfig: Record<string, unknown>): PostActionHandler {
  return async (stageOutput, runtimeConfig) => {
    // Merge template defaults with per-invocation runtime config
    const url =
      (runtimeConfig.url as string) ??
      (templateConfig.url as string) ??
      "";
    const method =
      (runtimeConfig.method as string) ??
      (templateConfig.method as string) ??
      "POST";
    const includeOutput =
      (runtimeConfig.includeOutput as boolean) ??
      (templateConfig.includeOutput as boolean) ??
      true;
    const extraHeaders =
      (runtimeConfig.headers as Record<string, string>) ??
      (templateConfig.headers as Record<string, string>) ??
      {};

    if (!url) {
      return JSON.stringify({ error: "Webhook URL is required" });
    }

    if (!isAllowedWebhookUrl(url)) {
      return JSON.stringify({ error: "Webhook URL blocked: private/internal addresses are not allowed" });
    }

    const payload: Record<string, unknown> = {
      event: "pipeline_stage_completed",
      timestamp: new Date().toISOString(),
      source: "openzigs",
      ...((runtimeConfig.extraPayload as Record<string, unknown>) ?? {}),
    };
    if (includeOutput) {
      payload.stageOutput = stageOutput.slice(0, 10_000);
    }

    try {
      const resp = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "OpenZigs/0.1",
          ...extraHeaders,
        },
        body: JSON.stringify(payload),
      });
      return JSON.stringify({
        status: resp.status,
        ok: resp.ok,
        ...(resp.ok ? {} : { body: (await resp.text()).slice(0, 500) }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: msg });
    }
  };
}

/** Build a shell script handler. */
function createScriptHandler(
  scriptBody: string,
  timeout = 30_000,
): PostActionHandler {
  return async (stageOutput, config) => {
    return new Promise<string>((resolve) => {
      // Only expose safe environment variables — never leak API keys, tokens,
      // or secrets from process.env to user-provided scripts.
      const env: Record<string, string> = {
        PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME ?? "",
        LANG: process.env.LANG ?? "en_US.UTF-8",
        TERM: "dumb",
      };

      // Pass config values as OPENZIGS_CONFIG_* environment variables
      for (const [key, val] of Object.entries(config)) {
        const envKey = `OPENZIGS_CONFIG_${key.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
        env[envKey] = String(val);
      }

      const child = execFile(
        "/bin/sh",
        ["-c", scriptBody],
        {
          timeout,
          maxBuffer: 1024 * 1024,
          env,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve(
              JSON.stringify({
                error: error.message,
                exitCode: error.code,
                stderr: stderr?.slice(0, 2000),
                stdout: stdout?.slice(0, 2000),
              }),
            );
            return;
          }
          resolve(stdout || JSON.stringify({ ok: true, stderr: stderr?.slice(0, 500) }));
        },
      );

      // Pipe stage output to stdin
      if (child.stdin) {
        child.stdin.write(stageOutput);
        child.stdin.end();
      }
    });
  };
}

/* ------------------------------------------------------------------ */
/*  Schema builder                                                    */
/* ------------------------------------------------------------------ */

/** Build a ConfigSchema for a webhook template action. */
function webhookConfigSchema(templateConfig: Record<string, unknown>): ConfigSchema {
  const hasDefaultUrl = !!(templateConfig.url as string);
  const props: Record<string, ConfigFieldSchema> = {
    url: {
      type: "string",
      title: "Webhook URL",
      description: "The HTTP(S) endpoint to send results to.",
      placeholder: (templateConfig.url as string) || "https://hooks.slack.com/...",
      ...(hasDefaultUrl ? { default: templateConfig.url } : {}),
    },
    method: {
      type: "string",
      title: "HTTP Method",
      enum: ["POST", "PUT"],
      enumLabels: ["POST", "PUT"],
      default: (templateConfig.method as string) || "POST",
    },
    includeOutput: {
      type: "boolean",
      title: "Include Stage Output",
      description: "Include full stage output in the payload (capped at 10 KB).",
      default: (templateConfig.includeOutput as boolean) ?? true,
    },
  };

  return {
    type: "object",
    properties: props,
    required: hasDefaultUrl ? [] : ["url"],
  };
}

/** Build a ConfigSchema for a script template action. */
function scriptConfigSchema(): ConfigSchema {
  // Script actions don't expose user-editable config fields at the stage level
  // — the script body itself is the configuration.
  return {
    type: "object",
    properties: {},
    required: [],
  };
}

/** Build a ConfigSchema from user-defined custom fields (advanced builder). */
function customFieldsToSchema(fields: CustomFieldDefinition[]): ConfigSchema {
  const properties: Record<string, ConfigFieldSchema> = {};
  const required: string[] = [];

  for (const field of fields) {
    const schema: ConfigFieldSchema = {
      type: field.type,
      title: field.title,
      description: field.description,
      default: field.default,
      placeholder: field.placeholder,
      minimum: field.minimum,
      maximum: field.maximum,
    };

    if (field.enum) {
      schema.enum = field.enum;
      schema.enumLabels = field.enumLabels;
    }

    if (field.type === "array") {
      schema.items = { type: "string" };
    }

    properties[field.key] = schema;

    if (field.required) {
      required.push(field.key);
    }
  }

  return { type: "object", properties, required };
}

/* ------------------------------------------------------------------ */
/*  Convert persisted def → runtime PostActionDefinition               */
/* ------------------------------------------------------------------ */

function toRuntimeDefinition(def: CustomPostActionDefinition): PostActionDefinition {
  let handler: PostActionHandler;
  let configSchema: ConfigSchema;

  if (def.templateType === "webhook") {
    handler = createWebhookHandler(def.templateConfig ?? {});
    configSchema = webhookConfigSchema(def.templateConfig ?? {});
  } else if (def.templateType === "script") {
    handler = createScriptHandler(def.scriptBody ?? "echo 'no script'", def.scriptTimeout);
    configSchema = scriptConfigSchema();
  } else {
    // Advanced builder — custom fields + script body
    handler = createScriptHandler(
      def.scriptBody ?? "echo 'no script'",
      def.scriptTimeout ?? 30_000,
    );
    configSchema = customFieldsToSchema(def.customFields ?? []);
  }

  return {
    type: def.type,
    label: def.label,
    description: def.description,
    category: def.category,
    icon: def.icon,
    configSchema,
    handler,
  };
}

/* ------------------------------------------------------------------ */
/*  CRUD operations (used by admin API)                               */
/* ------------------------------------------------------------------ */

export class CustomPostActionManager {
  private definitions: CustomPostActionDefinition[] = [];

  /** Load from disk and register all custom actions with the registry. */
  async initialize(): Promise<void> {
    this.definitions = await loadCustomPostActions();
    for (const def of this.definitions) {
      this.registerSafe(def);
    }
    if (this.definitions.length > 0) {
      logger.info(`Loaded ${this.definitions.length} custom post-action type(s)`);
    }
  }

  /** Register a definition, skipping if already registered (e.g., by built-ins). */
  private registerSafe(def: CustomPostActionDefinition): void {
    if (postActionRegistry.has(def.type)) {
      logger.warn(`Custom post-action type "${def.type}" conflicts with an existing type — skipped`);
      return;
    }
    try {
      postActionRegistry.register(toRuntimeDefinition(def));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to register custom post-action "${def.type}": ${msg}`);
    }
  }

  /** List all custom definitions (without handlers). */
  list(): CustomPostActionDefinition[] {
    return [...this.definitions];
  }

  /** Get a single custom definition by type. */
  getByType(type: string): CustomPostActionDefinition | undefined {
    return this.definitions.find((d) => d.type === type);
  }

  /** Create a new custom post-action type. */
  async create(input: Omit<CustomPostActionDefinition, "createdAt" | "updatedAt">): Promise<CustomPostActionDefinition> {
    if (postActionRegistry.has(input.type)) {
      throw new Error(`Post-action type "${input.type}" already exists.`);
    }
    if (this.definitions.some((d) => d.type === input.type)) {
      throw new Error(`Custom post-action type "${input.type}" already exists.`);
    }

    const now = new Date().toISOString();
    const def: CustomPostActionDefinition = {
      ...input,
      createdAt: now,
      updatedAt: now,
    };

    // Register with the runtime registry
    postActionRegistry.register(toRuntimeDefinition(def));

    this.definitions.push(def);
    await saveCustomPostActions(this.definitions);

    logger.info(`Custom post-action created: "${def.type}"`);
    return def;
  }

  /** Update an existing custom post-action type. */
  async update(
    type: string,
    input: Partial<Omit<CustomPostActionDefinition, "type" | "createdAt" | "updatedAt">>,
  ): Promise<CustomPostActionDefinition> {
    const idx = this.definitions.findIndex((d) => d.type === type);
    if (idx === -1) {
      throw new Error(`Custom post-action type "${type}" not found.`);
    }

    const existing = this.definitions[idx]!;
    const updated: CustomPostActionDefinition = {
      ...existing,
      ...input,
      type, // immutable
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    // Re-register: unregister old, register new
    postActionRegistry.unregister(type);
    postActionRegistry.register(toRuntimeDefinition(updated));

    this.definitions[idx] = updated;
    await saveCustomPostActions(this.definitions);

    logger.info(`Custom post-action updated: "${type}"`);
    return updated;
  }

  /** Delete a custom post-action type. */
  async delete(type: string): Promise<boolean> {
    const idx = this.definitions.findIndex((d) => d.type === type);
    if (idx === -1) {
      return false;
    }

    postActionRegistry.unregister(type);
    this.definitions.splice(idx, 1);
    await saveCustomPostActions(this.definitions);

    logger.info(`Custom post-action deleted: "${type}"`);
    return true;
  }

  /** Number of custom definitions. */
  get size(): number {
    return this.definitions.length;
  }
}
