/**
 * Post-Action Registry — a plugin system for deterministic post-stage actions.
 *
 * Each post-action type is registered with:
 *   - A unique `type` string identifier (e.g., "create-github-issues").
 *   - A human-readable label, description, and category.
 *   - A JSON Schema describing the config fields, used by the UI to render dynamic forms.
 *   - A handler function that executes the action given stageOutput + config.
 *
 * The registry is queried via `GET /api/admin/post-actions` so the UI can
 * dynamically build the post-action dropdown and config forms without hardcoding.
 */

import type { PipelinePostAction } from "./types.js";

/* ------------------------------------------------------------------ */
/*  JSON Schema field descriptors (subset sufficient for config forms) */
/* ------------------------------------------------------------------ */

/** A single field in a config schema. */
export type ConfigFieldSchema = {
  type: "string" | "number" | "boolean" | "array";
  /** Human-readable label for the field. */
  title: string;
  /** Help text / tooltip. */
  description?: string;
  /** Default value. */
  default?: unknown;
  /** For string fields: constrain to a set of allowed values. */
  enum?: string[];
  /** For string fields: human-readable labels matching the enum values. */
  enumLabels?: string[];
  /** For array fields: schema of each item. */
  items?: { type: "string" };
  /** For number fields: minimum value. */
  minimum?: number;
  /** For number fields: maximum value. */
  maximum?: number;
  /** Placeholder text for the input. */
  placeholder?: string;
};

/** JSON-Schema-like config descriptor. */
export type ConfigSchema = {
  type: "object";
  properties: Record<string, ConfigFieldSchema>;
  required: string[];
};

/* ------------------------------------------------------------------ */
/*  Post-action definition                                            */
/* ------------------------------------------------------------------ */

/** Handler function signature for post-actions. */
export type PostActionHandler = (
  stageOutput: string,
  config: Record<string, unknown>,
) => Promise<string>;

/** Full definition of a registered post-action type. */
export interface PostActionDefinition {
  /** Unique action type string (e.g., "create-github-issues"). Used in pipeline JSON. */
  type: string;
  /** Human-readable label shown in the dropdown. */
  label: string;
  /** Short description of what this action does. */
  description: string;
  /** Grouping category (e.g., "Integrations", "Notifications", "Analysis"). */
  category: string;
  /** Icon identifier (emoji or lucide icon name). */
  icon?: string;
  /** JSON Schema for the config object — drives dynamic form rendering. */
  configSchema: ConfigSchema;
  /** The handler that executes this action. */
  handler: PostActionHandler;
}

/** Serialisable shape returned by the API (no handler). */
export type PostActionTypeInfo = Omit<PostActionDefinition, "handler">;

/* ------------------------------------------------------------------ */
/*  Registry singleton                                                */
/* ------------------------------------------------------------------ */

class PostActionRegistryImpl {
  private actions = new Map<string, PostActionDefinition>();

  /** Register a new post-action type. Throws if the type is already registered. */
  register(definition: PostActionDefinition): void {
    if (this.actions.has(definition.type)) {
      throw new Error(`Post-action type "${definition.type}" is already registered.`);
    }
    this.actions.set(definition.type, definition);
  }

  /** Unregister a post-action type. Returns true if it existed. */
  unregister(type: string): boolean {
    return this.actions.delete(type);
  }

  /** Get a specific action definition by type. */
  get(type: string): PostActionDefinition | undefined {
    return this.actions.get(type);
  }

  /** List all registered post-action types (without handlers — safe for API serialisation). */
  list(): PostActionTypeInfo[] {
    return Array.from(this.actions.values()).map(({ handler: _h, ...info }) => info);
  }

  /** Execute a post-action. Delegates to the registered handler. */
  async execute(action: PipelinePostAction, stageOutput: string): Promise<string> {
    const definition = this.actions.get(action.type);
    if (!definition) {
      return JSON.stringify({ error: `Unknown post-action type: ${action.type}` });
    }
    return definition.handler(stageOutput, action.config ?? {});
  }

  /** Check whether a type is registered. */
  has(type: string): boolean {
    return this.actions.has(type);
  }

  /** Number of registered action types. */
  get size(): number {
    return this.actions.size;
  }

  /** Clear all registrations (useful for testing). */
  clear(): void {
    this.actions.clear();
  }
}

/** Global singleton registry. */
export const postActionRegistry = new PostActionRegistryImpl();
