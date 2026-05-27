import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WizardCredentialStore } from "./wizard-credential-store.js";

describe("WizardCredentialStore", () => {
  let baseDir: string;
  const opts = () => ({
    baseDir,
    pbkdf2Iterations: 1000,
    fingerprint: "test-fingerprint",
  });

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "wcs-"));
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("init() creates the salt file with 0o600", async () => {
    const store = new WizardCredentialStore(opts());
    await store.init();
    const stat = await fs.stat(path.join(baseDir, ".wizard-key"));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.size).toBe(32);
  });

  it("init() is idempotent and reuses the same salt", async () => {
    const a = new WizardCredentialStore(opts());
    await a.init();
    const salt1 = await fs.readFile(path.join(baseDir, ".wizard-key"));
    const b = new WizardCredentialStore(opts());
    await b.init();
    const salt2 = await fs.readFile(path.join(baseDir, ".wizard-key"));
    expect(salt1.equals(salt2)).toBe(true);
  });

  it("set / get round-trips an OAuth token", async () => {
    const store = new WizardCredentialStore(opts());
    await store.init();
    const meta = await store.setCredential("meta", "access_token", "abc-123");
    expect(meta.platform).toBe("meta");
    expect(meta.hasValue).toBe(true);
    expect(await store.getCredential("meta", "access_token")).toBe("abc-123");
  });

  it("ciphertext file is 0o600 and contains no plaintext", async () => {
    const store = new WizardCredentialStore(opts());
    await store.init();
    await store.setCredential("linkedin", "access_token", "PLAIN_SECRET_VALUE");
    const file = path.join(baseDir, "wizard-credentials.enc");
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
    const contents = await fs.readFile(file, "utf-8");
    expect(contents).not.toContain("PLAIN_SECRET_VALUE");
  });

  it("listCredentials() returns metadata without values", async () => {
    const store = new WizardCredentialStore(opts());
    const secretA = "SECRET_AAA_111";
    const secretB = "SECRET_BBB_222";
    await store.setCredential("meta", "access_token", secretA);
    await store.setCredential("linkedin", "access_token", secretB);
    const list = await store.listCredentials();
    expect(list).toHaveLength(2);
    expect(list.every((c) => c.hasValue === true)).toBe(true);
    expect(JSON.stringify(list)).not.toContain(secretA);
    expect(JSON.stringify(list)).not.toContain(secretB);
  });

  it("listForPlatform() filters by platform", async () => {
    const store = new WizardCredentialStore(opts());
    await store.setCredential("meta", "access_token", "x");
    await store.setCredential("meta", "refresh_token", "y");
    await store.setCredential("linkedin", "access_token", "z");
    expect(await store.listForPlatform("meta")).toHaveLength(2);
    expect(await store.listForPlatform("linkedin")).toHaveLength(1);
  });

  it("deletePlatform() removes all entries for that platform", async () => {
    const store = new WizardCredentialStore(opts());
    await store.setCredential("meta", "access_token", "x");
    await store.setCredential("meta", "refresh_token", "y");
    await store.setCredential("linkedin", "access_token", "z");
    expect(await store.deletePlatform("meta")).toBe(2);
    expect(await store.listForPlatform("meta")).toHaveLength(0);
    expect(await store.listForPlatform("linkedin")).toHaveLength(1);
  });

  it("deleteCredential() removes only the specified type", async () => {
    const store = new WizardCredentialStore(opts());
    await store.setCredential("meta", "access_token", "x");
    await store.setCredential("meta", "refresh_token", "y");
    expect(await store.deleteCredential("meta", "access_token")).toBe(true);
    expect(await store.deleteCredential("meta", "access_token")).toBe(false);
    expect(await store.getCredential("meta", "refresh_token")).toBe("y");
  });

  it("setCredential rejects invalid platform identifiers", async () => {
    const store = new WizardCredentialStore(opts());
    await expect(store.setCredential("../etc", "t", "x")).rejects.toThrow(
      /invalid identifier/,
    );
    await expect(store.setCredential("meta", "../t", "x")).rejects.toThrow(
      /invalid identifier/,
    );
  });

  it("setCredential rejects empty values", async () => {
    const store = new WizardCredentialStore(opts());
    await expect(
      store.setCredential("meta", "access_token", ""),
    ).rejects.toThrow(/non-empty/);
  });

  it("data persists across store instances", async () => {
    const a = new WizardCredentialStore(opts());
    await a.setCredential("meta", "access_token", "persisted");
    const b = new WizardCredentialStore(opts());
    expect(await b.getCredential("meta", "access_token")).toBe("persisted");
  });

  it("a different fingerprint cannot decrypt prior data", async () => {
    const a = new WizardCredentialStore(opts());
    await a.setCredential("meta", "access_token", "secret");
    const b = new WizardCredentialStore({
      ...opts(),
      fingerprint: "WRONG",
    });
    expect(await b.getCredential("meta", "access_token")).toBeNull();
  });

  it("getCredential returns null for missing entries", async () => {
    const store = new WizardCredentialStore(opts());
    expect(await store.getCredential("meta", "access_token")).toBeNull();
  });

  it("setCredential updates an existing entry in place", async () => {
    const store = new WizardCredentialStore(opts());
    await store.setCredential("meta", "access_token", "first");
    await store.setCredential("meta", "access_token", "second");
    const list = await store.listForPlatform("meta");
    expect(list).toHaveLength(1);
    expect(await store.getCredential("meta", "access_token")).toBe("second");
  });
});
