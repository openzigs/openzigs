import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SecretVaultService } from "./secret-vault-service.js";
import { SECRET_TOKEN_PATTERN, buildSecretToken } from "./vault-types.js";

const tmpVaultDir = path.join(os.tmpdir(), `openzigs-vault-test-${process.pid}`);

const createTmpVaultPath = () =>
  path.join(tmpVaultDir, `vault-${Date.now()}-${Math.random().toString(36).slice(2)}.enc`);

beforeEach(async () => {
  await fs.mkdir(tmpVaultDir, { recursive: true });
});

afterEach(async () => {
  try {
    await fs.rm(tmpVaultDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

const FAST_ITERATIONS = 1_000; // speedy for tests, still exercises the code path

describe("SecretVaultService", () => {
  it("initialises a new vault and unlocks it", async () => {
    const vaultPath = createTmpVaultPath();
    const svc = new SecretVaultService({ vaultPath, pbkdf2Iterations: FAST_ITERATIONS });

    expect(await svc.exists()).toBe(false);
    expect(svc.isUnlocked()).toBe(false);

    await svc.initialize("hunter2");

    expect(await svc.exists()).toBe(true);
    expect(svc.isUnlocked()).toBe(true);
    expect(svc.listSecrets()).toEqual([]);
  });

  it("refuses to initialise when vault already exists", async () => {
    const vaultPath = createTmpVaultPath();
    const svc = new SecretVaultService({ vaultPath, pbkdf2Iterations: FAST_ITERATIONS });
    await svc.initialize("password");

    await expect(svc.initialize("password")).rejects.toThrow("Vault already exists");
  });

  it("adds, lists, and deletes secrets", async () => {
    const vaultPath = createTmpVaultPath();
    const svc = new SecretVaultService({ vaultPath, pbkdf2Iterations: FAST_ITERATIONS });
    await svc.initialize("pass123");

    const entry = await svc.addSecret({
      label: "GitHub PAT",
      value: "ghp_supersecret",
      service: "github.com",
      username: "octocat",
    });

    expect(entry.label).toBe("GitHub PAT");
    expect(entry.service).toBe("github.com");
    expect(entry.username).toBe("octocat");
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    // Value should NOT be in the returned metadata
    expect((entry as Record<string, unknown>).value).toBeUndefined();

    const list = svc.listSecrets();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("GitHub PAT");

    await svc.deleteSecret(entry.id);
    expect(svc.listSecrets()).toHaveLength(0);
  });

  it("resolves a token to plaintext", async () => {
    const vaultPath = createTmpVaultPath();
    const svc = new SecretVaultService({ vaultPath, pbkdf2Iterations: FAST_ITERATIONS });
    await svc.initialize("pass");

    const entry = await svc.addSecret({ label: "test", value: "s3cr3t" });
    const resolved = svc.resolveToken(entry.id);
    expect(resolved).toBe("s3cr3t");
  });

  it("returns undefined for unknown token ID", async () => {
    const vaultPath = createTmpVaultPath();
    const svc = new SecretVaultService({ vaultPath, pbkdf2Iterations: FAST_ITERATIONS });
    await svc.initialize("pass");

    expect(svc.resolveToken("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });

  it("updates a secret", async () => {
    const vaultPath = createTmpVaultPath();
    const svc = new SecretVaultService({ vaultPath, pbkdf2Iterations: FAST_ITERATIONS });
    await svc.initialize("pass");

    const entry = await svc.addSecret({ label: "old", value: "v1" });
    const updated = await svc.updateSecret(entry.id, { label: "new", value: "v2" });

    expect(updated.label).toBe("new");
    expect(svc.resolveToken(entry.id)).toBe("v2");
  });

  it("persists secrets across unlock cycles", async () => {
    const vaultPath = createTmpVaultPath();
    const svc1 = new SecretVaultService({ vaultPath, pbkdf2Iterations: FAST_ITERATIONS });
    await svc1.initialize("master");
    await svc1.addSecret({ label: "persistent", value: "abc123" });
    svc1.lock();

    // Re-open with a fresh instance
    const svc2 = new SecretVaultService({ vaultPath, pbkdf2Iterations: FAST_ITERATIONS });
    await svc2.unlock("master");
    const list = svc2.listSecrets();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("persistent");
    expect(svc2.resolveToken(list[0].id)).toBe("abc123");
  });

  it("rejects wrong master password", async () => {
    const vaultPath = createTmpVaultPath();
    const svc = new SecretVaultService({ vaultPath, pbkdf2Iterations: FAST_ITERATIONS });
    await svc.initialize("correct");
    svc.lock();

    await expect(svc.unlock("wrong")).rejects.toThrow("Invalid master password");
  });

  it("lock() wipes in-memory state", async () => {
    const vaultPath = createTmpVaultPath();
    const svc = new SecretVaultService({ vaultPath, pbkdf2Iterations: FAST_ITERATIONS });
    await svc.initialize("pass");
    await svc.addSecret({ label: "a", value: "b" });
    expect(svc.isUnlocked()).toBe(true);

    svc.lock();

    expect(svc.isUnlocked()).toBe(false);
    expect(() => svc.listSecrets()).toThrow("Vault is locked");
    expect(() => svc.resolveToken("anything")).toThrow("Vault is locked");
  });

  it("changeMasterPassword re-encrypts with a new key", async () => {
    const vaultPath = createTmpVaultPath();
    const svc = new SecretVaultService({ vaultPath, pbkdf2Iterations: FAST_ITERATIONS });
    await svc.initialize("oldpass");
    await svc.addSecret({ label: "keepme", value: "safe" });

    await svc.changeMasterPassword("oldpass", "newpass");
    svc.lock();

    // Old password should fail
    await expect(svc.unlock("oldpass")).rejects.toThrow("Invalid master password");

    // New password should work
    await svc.unlock("newpass");
    expect(svc.listSecrets()).toHaveLength(1);
    expect(svc.resolveToken(svc.listSecrets()[0].id)).toBe("safe");
  });

  it("throws when operating on locked vault", async () => {
    const svc = new SecretVaultService({ vaultPath: createTmpVaultPath(), pbkdf2Iterations: FAST_ITERATIONS });
    // Never unlocked
    await expect(svc.addSecret({ label: "x", value: "y" })).rejects.toThrow("Vault is locked");
  });

  it("vault file has 0600 permissions", async () => {
    const vaultPath = createTmpVaultPath();
    const svc = new SecretVaultService({ vaultPath, pbkdf2Iterations: FAST_ITERATIONS });
    await svc.initialize("pass");

    const stat = await fs.stat(vaultPath);
    // 0o600 = owner read+write only (octal 33188 on most systems)
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe("vault-types helpers", () => {
  it("SECRET_TOKEN_PATTERN matches reference tokens", () => {
    const text = "Login with {{SECRET:a1b2c3d4-e5f6-7890-abcd-ef1234567890}} please";
    const matches = [...text.matchAll(SECRET_TOKEN_PATTERN)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("buildSecretToken produces correct format", () => {
    const token = buildSecretToken("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(token).toBe("{{SECRET:a1b2c3d4-e5f6-7890-abcd-ef1234567890}}");
  });

  it("SECRET_TOKEN_PATTERN matches multiple tokens", () => {
    const text = "user={{SECRET:11111111-1111-1111-1111-111111111111}}&pass={{SECRET:22222222-2222-2222-2222-222222222222}}";
    // Reset lastIndex for global regex
    SECRET_TOKEN_PATTERN.lastIndex = 0;
    const matches = [...text.matchAll(SECRET_TOKEN_PATTERN)];
    expect(matches).toHaveLength(2);
  });
});
