import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { StarterRecipeLoader } from "./starter-recipe-loader.js";

describe("StarterRecipeLoader", () => {
  let dir: string;

  const validRecipe = (name: string, stages = 2) => ({
    $schema: "openzigs-template-v1",
    version: 1,
    exportedAt: "2026-08-01T00:00:00.000Z",
    exportedFrom: "test",
    prompt: {
      name,
      description: `desc-${name}`,
      template: "Body",
      tags: ["starter", "test"],
      stages: Array.from({ length: stages }, (_, i) => ({
        name: `stage-${i}`,
        prompt: "do it",
      })),
    },
    placeholders: [],
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "recipes-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns [] when directory does not exist", async () => {
    const loader = new StarterRecipeLoader({
      recipesDir: path.join(dir, "missing"),
    });
    expect(await loader.list()).toEqual([]);
  });

  it("lists valid recipes with metadata", async () => {
    await fs.writeFile(
      path.join(dir, "hello.json"),
      JSON.stringify(validRecipe("Hello", 3)),
    );
    const loader = new StarterRecipeLoader({ recipesDir: dir });
    const list = await loader.list();
    expect(list).toEqual([
      {
        id: "hello",
        name: "Hello",
        description: "desc-Hello",
        tags: ["starter", "test"],
        stageCount: 3,
      },
    ]);
  });

  it("skips malformed JSON files", async () => {
    await fs.writeFile(
      path.join(dir, "good.json"),
      JSON.stringify(validRecipe("G")),
    );
    await fs.writeFile(path.join(dir, "bad.json"), "{ not json");
    const loader = new StarterRecipeLoader({ recipesDir: dir });
    const list = await loader.list();
    expect(list.map((r) => r.id)).toEqual(["good"]);
  });

  it("ignores non-json files and bad id names", async () => {
    await fs.writeFile(
      path.join(dir, "ok.json"),
      JSON.stringify(validRecipe("O")),
    );
    await fs.writeFile(path.join(dir, "README.md"), "hi");
    await fs.writeFile(
      path.join(dir, "BAD!.json"),
      JSON.stringify(validRecipe("X")),
    );
    const loader = new StarterRecipeLoader({ recipesDir: dir });
    const list = await loader.list();
    expect(list.map((r) => r.id)).toEqual(["ok"]);
  });

  it("get() returns the parsed JSON for a known id", async () => {
    await fs.writeFile(
      path.join(dir, "x.json"),
      JSON.stringify(validRecipe("X")),
    );
    const loader = new StarterRecipeLoader({ recipesDir: dir });
    const recipe = await loader.get("x");
    expect(recipe).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((recipe as any).prompt.name).toBe("X");
  });

  it("get() returns null for missing files", async () => {
    const loader = new StarterRecipeLoader({ recipesDir: dir });
    expect(await loader.get("missing")).toBeNull();
  });

  it("get() throws on invalid id (no path traversal)", async () => {
    const loader = new StarterRecipeLoader({ recipesDir: dir });
    await expect(loader.get("../etc")).rejects.toThrow(/invalid/);
    await expect(loader.get("UPPER")).rejects.toThrow(/invalid/);
    await expect(loader.get("")).rejects.toThrow(/invalid/);
  });

  it("falls back to id when prompt.name is missing", async () => {
    const broken = { prompt: { description: "d", tags: [], stages: [] } };
    await fs.writeFile(path.join(dir, "noname.json"), JSON.stringify(broken));
    const loader = new StarterRecipeLoader({ recipesDir: dir });
    const list = await loader.list();
    expect(list[0]!.name).toBe("noname");
    expect(list[0]!.stageCount).toBe(0);
  });
});

describe("bundled starter recipes", () => {
  it("all three bundled recipes load and validate", async () => {
    const loader = new StarterRecipeLoader({
      recipesDir: path.join(process.cwd(), "config", "starter-recipes"),
    });
    const list = await loader.list();
    const ids = list.map((r) => r.id).sort();
    expect(ids).toEqual([
      "director-first-video",
      "seo-keyword-research",
      "social-week",
    ]);
    for (const id of ids) {
      const recipe = await loader.get(id);
      expect(recipe).not.toBeNull();
    }
  });
});
