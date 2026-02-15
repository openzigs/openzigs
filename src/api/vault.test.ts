import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createVaultRouter } from "./vault.js";
import { SecretVaultService } from "../vault/index.js";

const tmpDir = path.join(os.tmpdir(), `openzigs-vault-api-test-${process.pid}`);
const FAST_ITERATIONS = 1_000;

let vaultService: SecretVaultService;
let app: express.Express;

beforeEach(async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  const vaultPath = path.join(tmpDir, `vault-${Date.now()}.enc`);
  vaultService = new SecretVaultService({ vaultPath, pbkdf2Iterations: FAST_ITERATIONS });
  app = express();
  app.use(express.json());
  const router = createVaultRouter({ vaultService });
  app.use("/vault", router);
});

afterEach(async () => {
  vaultService.lock();
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("Vault API", () => {
  it("GET /vault/status returns exists=false for new vault", async () => {
    const res = await request(app).get("/vault/status").expect(200);
    expect(res.body.exists).toBe(false);
    expect(res.body.unlocked).toBe(false);
  });

  it("POST /vault/initialize creates a new vault", async () => {
    const res = await request(app)
      .post("/vault/initialize")
      .send({ masterPassword: "strongpassword" })
      .expect(200);
    expect(res.body.ok).toBe(true);

    const status = await request(app).get("/vault/status").expect(200);
    expect(status.body.exists).toBe(true);
    expect(status.body.unlocked).toBe(true);
  });

  it("POST /vault/initialize rejects short passwords", async () => {
    const res = await request(app)
      .post("/vault/initialize")
      .send({ masterPassword: "short" })
      .expect(400);
    expect(res.body.error).toContain("at least 8 characters");
  });

  it("POST /vault/unlock + lock cycle", async () => {
    await vaultService.initialize("testpass1234");

    vaultService.lock();
    expect(vaultService.isUnlocked()).toBe(false);

    await request(app)
      .post("/vault/unlock")
      .send({ masterPassword: "testpass1234" })
      .expect(200);

    expect(vaultService.isUnlocked()).toBe(true);

    await request(app).post("/vault/lock").expect(200);
    expect(vaultService.isUnlocked()).toBe(false);
  });

  it("POST /vault/unlock rejects wrong password", async () => {
    await vaultService.initialize("correctpass");
    vaultService.lock();

    const res = await request(app)
      .post("/vault/unlock")
      .send({ masterPassword: "wrongpass" })
      .expect(401);
    expect(res.body.error).toContain("Invalid master password");
  });

  it("CRUD secrets lifecycle", async () => {
    await vaultService.initialize("mypassword");

    // Create
    const createRes = await request(app)
      .post("/vault/secrets")
      .send({ label: "Test Key", value: "s3cr3t", service: "example.com" })
      .expect(201);
    expect(createRes.body.secret.label).toBe("Test Key");
    const secretId = createRes.body.secret.id;

    // List
    const listRes = await request(app).get("/vault/secrets").expect(200);
    expect(listRes.body.secrets).toHaveLength(1);
    expect(listRes.body.secrets[0].label).toBe("Test Key");
    // Value must NOT be in list response
    expect(JSON.stringify(listRes.body)).not.toContain("s3cr3t");

    // Update
    const updateRes = await request(app)
      .patch(`/vault/secrets/${secretId}`)
      .send({ label: "Updated Key" })
      .expect(200);
    expect(updateRes.body.secret.label).toBe("Updated Key");

    // Delete
    await request(app).delete(`/vault/secrets/${secretId}`).expect(200);

    const finalList = await request(app).get("/vault/secrets").expect(200);
    expect(finalList.body.secrets).toHaveLength(0);
  });

  it("GET /vault/secrets returns 403 when vault is locked", async () => {
    const res = await request(app).get("/vault/secrets").expect(403);
    expect(res.body.error).toContain("Vault is locked");
  });
});
