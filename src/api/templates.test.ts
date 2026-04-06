import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { PostTemplateRepository } from "../creative/post-template-repository.js";
import { createTemplatesRouter } from "./templates.js";

function setup() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Create brand_kits table referenced by post_templates FK
  db.exec(`
    CREATE TABLE IF NOT EXISTS brand_kits (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
  const repo = new PostTemplateRepository(db);
  repo.migrate();
  const app = express();
  app.use(express.json());
  app.use("/templates", createTemplatesRouter({ postTemplateRepo: repo }));
  return { db, repo, app };
}

describe("POST /templates", () => {
  let app: express.Express;

  beforeEach(() => {
    ({ app } = setup());
  });

  it("creates a template and returns 201", async () => {
    const res = await request(app)
      .post("/templates")
      .send({
        name: "Tweet promo",
        platform: "twitter",
        content_template: "Check out {{product}}! #launch",
        tags: ["promo"],
      });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Tweet promo");
    expect(res.body.platform).toBe("twitter");
    expect(res.body.contentTemplate).toBe("Check out {{product}}! #launch");
    expect(res.body.tags).toEqual(["promo"]);
    expect(res.body.id).toBeDefined();
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/templates")
      .send({ platform: "twitter" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("name is required");
  });

  it("returns 400 when platform is missing", async () => {
    const res = await request(app).post("/templates").send({ name: "Test" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("platform is required");
  });
});

describe("GET /templates", () => {
  let app: express.Express;
  let repo: PostTemplateRepository;

  beforeEach(() => {
    ({ app, repo } = setup());
    repo.create({
      name: "T1",
      platform: "twitter",
      layout: "default",
      contentTemplate: "Hello {{name}}",
    });
    repo.create({
      name: "T2",
      platform: "instagram",
      layout: "default",
      contentTemplate: "IG {{topic}}",
    });
  });

  it("lists all templates", async () => {
    const res = await request(app).get("/templates");
    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(2);
  });

  it("filters by platform", async () => {
    const res = await request(app).get("/templates?platform=twitter");
    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(1);
    expect(res.body.templates[0].platform).toBe("twitter");
  });
});

describe("GET /templates/:id", () => {
  let app: express.Express;
  let repo: PostTemplateRepository;

  beforeEach(() => {
    ({ app, repo } = setup());
  });

  it("returns template by id", async () => {
    const t = repo.create({
      name: "T1",
      platform: "twitter",
      layout: "default",
      contentTemplate: "Hello",
    });
    const res = await request(app).get(`/templates/${t.id}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("T1");
  });

  it("returns 404 for unknown id", async () => {
    const res = await request(app).get("/templates/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("PUT /templates/:id", () => {
  let app: express.Express;
  let repo: PostTemplateRepository;

  beforeEach(() => {
    ({ app, repo } = setup());
  });

  it("updates a template", async () => {
    const t = repo.create({
      name: "Old",
      platform: "twitter",
      layout: "default",
      contentTemplate: "old",
    });
    const res = await request(app)
      .put(`/templates/${t.id}`)
      .send({ name: "New", content_template: "updated {{x}}" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("New");
    expect(res.body.contentTemplate).toBe("updated {{x}}");
  });

  it("returns 404 for unknown id", async () => {
    const res = await request(app)
      .put("/templates/nonexistent")
      .send({ name: "X" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /templates/:id", () => {
  let app: express.Express;
  let repo: PostTemplateRepository;

  beforeEach(() => {
    ({ app, repo } = setup());
  });

  it("deletes a template", async () => {
    const t = repo.create({
      name: "Temp",
      platform: "twitter",
      layout: "default",
      contentTemplate: "",
    });
    const res = await request(app).delete(`/templates/${t.id}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(repo.getById(t.id)).toBeNull();
  });

  it("returns 404 for unknown id", async () => {
    const res = await request(app).delete("/templates/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("POST /templates/:id/apply", () => {
  let app: express.Express;
  let repo: PostTemplateRepository;

  beforeEach(() => {
    ({ app, repo } = setup());
  });

  it("applies template with variables", async () => {
    const t = repo.create({
      name: "Promo",
      platform: "twitter",
      layout: "default",
      contentTemplate: "Buy {{product}} now! {{cta}}",
    });
    const res = await request(app)
      .post(`/templates/${t.id}/apply`)
      .send({ variables: { product: "Widget", cta: "Shop today" } });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("Buy Widget now! Shop today");
    expect(res.body.platform).toBe("twitter");
  });

  it("returns 404 for unknown template", async () => {
    const res = await request(app)
      .post("/templates/nonexistent/apply")
      .send({ variables: {} });
    expect(res.status).toBe(404);
  });

  it("handles missing variables body gracefully", async () => {
    const t = repo.create({
      name: "Simple",
      platform: "twitter",
      layout: "default",
      contentTemplate: "Hello world",
    });
    const res = await request(app).post(`/templates/${t.id}/apply`).send({});
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("Hello world");
  });
});
