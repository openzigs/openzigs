/**
 * Loads the bundled starter-recipe `.openzigs-template.json` files from
 * `config/starter-recipes/` and exposes them via metadata + raw JSON for
 * importing into the prompt library.
 *
 * Issue #1140 — Starter recipe library: one-click import of curated templates.
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface StarterRecipeMetadata {
  id: string;
  name: string;
  description: string;
  tags: string[];
  stageCount: number;
}

export interface RecipeLoaderOptions {
  /** Directory containing `*.json` recipe files. Defaults to repo's config dir. */
  recipesDir?: string;
}

export class StarterRecipeLoader {
  private readonly recipesDir: string;

  constructor(options: RecipeLoaderOptions = {}) {
    this.recipesDir =
      options.recipesDir ??
      path.join(process.cwd(), "config", "starter-recipes");
  }

  async list(): Promise<StarterRecipeMetadata[]> {
    const files = await this.readJsonFiles();
    return files.map(({ id, json }) => ({
      id,
      name: stringField(json, "prompt.name") ?? id,
      description: stringField(json, "prompt.description") ?? "",
      tags: (getDeep(json, "prompt.tags") as string[]) ?? [],
      stageCount: ((getDeep(json, "prompt.stages") as unknown[]) ?? []).length,
    }));
  }

  async get(id: string): Promise<Record<string, unknown> | null> {
    if (!/^[a-z0-9-]{1,80}$/.test(id)) {
      throw new Error(`invalid recipe id: ${id}`);
    }
    const file = path.join(this.recipesDir, `${id}.json`);
    try {
      const raw = await fs.readFile(file, "utf-8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async readJsonFiles(): Promise<
    { id: string; json: Record<string, unknown> }[]
  > {
    let entries: string[];
    try {
      entries = await fs.readdir(this.recipesDir);
    } catch {
      return [];
    }
    const results: { id: string; json: Record<string, unknown> }[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -5);
      if (!/^[a-z0-9-]{1,80}$/.test(id)) continue;
      try {
        const raw = await fs.readFile(
          path.join(this.recipesDir, entry),
          "utf-8",
        );
        results.push({ id, json: JSON.parse(raw) as Record<string, unknown> });
      } catch {
        // Skip malformed files rather than blowing up the wizard.
      }
    }
    return results;
  }
}

function getDeep(obj: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc != null && typeof acc === "object"
          ? (acc as Record<string, unknown>)[key]
          : undefined,
      obj,
    );
}

function stringField(
  obj: Record<string, unknown>,
  path: string,
): string | undefined {
  const v = getDeep(obj, path);
  return typeof v === "string" ? v : undefined;
}
