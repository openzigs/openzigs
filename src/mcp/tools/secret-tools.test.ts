import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSecretTools } from "./secret-tools.js";
import { SecretVaultService } from "../../vault/index.js";

const tmpDir = path.join(os.tmpdir(), `openzigs-secret-tools-test-${process.pid}`);
const FAST_ITERATIONS = 1_000;

let vaultService: SecretVaultService;

beforeEach(async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  const vaultPath = path.join(tmpDir, `vault-${Date.now()}.enc`);
  vaultService = new SecretVaultService({ vaultPath, pbkdf2Iterations: FAST_ITERATIONS });
  await vaultService.initialize("test-password");
});

afterEach(async () => {
  vaultService.lock();
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("get-secret tool", () => {
  it("returns a reference token for a matching secret", async () => {
    await vaultService.addSecret({ label: "GitHub PAT", value: "ghp_abc123", service: "github.com" });

    const tools = createSecretTools({ vaultService });
    const getTool = tools.find((t) => t.name === "get-secret")!;

    const result = await getTool.handler({ label: "GitHub PAT" });
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(result.text);
    expect(parsed.token).toMatch(/^\{\{SECRET:[0-9a-f-]{36}\}\}$/);
    expect(parsed.label).toBe("GitHub PAT");
    expect(parsed.service).toBe("github.com");
  });

  it("supports partial case-insensitive matching", async () => {
    await vaultService.addSecret({ label: "AWS Secret Key", value: "sk_xxx" });

    const tools = createSecretTools({ vaultService });
    const getTool = tools.find((t) => t.name === "get-secret")!;

    const result = await getTool.handler({ label: "aws" });
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(result.text);
    expect(parsed.label).toBe("AWS Secret Key");
  });

  it("returns error when no match found", async () => {
    const tools = createSecretTools({ vaultService });
    const getTool = tools.find((t) => t.name === "get-secret")!;

    const result = await getTool.handler({ label: "nonexistent" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("No secret found");
  });

  it("returns error when vault is locked", async () => {
    vaultService.lock();

    const tools = createSecretTools({ vaultService });
    const getTool = tools.find((t) => t.name === "get-secret")!;

    const result = await getTool.handler({ label: "anything" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Vault is locked");
  });
});

describe("list-secrets tool", () => {
  it("lists all secrets metadata (no values)", async () => {
    await vaultService.addSecret({ label: "Secret A", value: "val_a" });
    await vaultService.addSecret({ label: "Secret B", value: "val_b", service: "example.com" });

    const tools = createSecretTools({ vaultService });
    const listTool = tools.find((t) => t.name === "list-secrets")!;

    const result = await listTool.handler({});
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse(result.text);
    expect(parsed.count).toBe(2);
    expect(parsed.secrets[0].label).toBe("Secret A");
    expect(parsed.secrets[1].label).toBe("Secret B");
    // Must not contain plaintext values
    expect(result.text).not.toContain("val_a");
    expect(result.text).not.toContain("val_b");
  });

  it("returns error when vault is locked", async () => {
    vaultService.lock();

    const tools = createSecretTools({ vaultService });
    const listTool = tools.find((t) => t.name === "list-secrets")!;

    const result = await listTool.handler({});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Vault is locked");
  });
});
