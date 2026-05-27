/**
 * WizardCredentialStore — AES-256-GCM encrypted credential store for the
 * onboarding wizard.
 *
 * Design:
 * - No master password (the wizard runs before any UX could collect one).
 * - Key derived via PBKDF2 from a randomly generated 32-byte salt persisted at
 *   `~/.openzigs/.wizard-key` with 0o600 permissions, combined with the
 *   machine fingerprint (hostname + arch + platform).
 * - Ciphertext persisted to `~/.openzigs/wizard-credentials.enc` (0o600).
 * - Plaintext NEVER leaves this module except via `getCredential()`, which
 *   callers should treat as sensitive (no logging, no echoing).
 *
 * Issue #1162 — encrypted storage for OAuth tokens.
 *
 * Security notes:
 * - Encryption-at-rest only. An attacker with local file access AND the
 *   `.wizard-key` salt can decrypt. For full key separation use
 *   `SecretVaultService` (master password) instead. The wizard trades this for
 *   zero-friction onboarding; the epic AC requires "no plaintext credentials"
 *   and this implementation satisfies that.
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const AES_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_LEN = 32;
const PBKDF2_DIGEST = "sha512";

export interface CredentialMetadata {
  platform: string;
  type: string;
  hasValue: true;
  updatedAt: string;
}

interface StoredEntry {
  platform: string;
  type: string;
  ivHex: string;
  tagHex: string;
  dataHex: string;
  updatedAt: string;
}

interface StoreFile {
  version: 1;
  entries: StoredEntry[];
}

const SECURE_FILE_MODE = 0o600;
const SECURE_DIR_MODE = 0o700;

export interface WizardCredentialStoreOptions {
  baseDir?: string;
  /** Override iterations in tests for speed. */
  pbkdf2Iterations?: number;
  /** Override machine fingerprint in tests. */
  fingerprint?: string;
  clock?: () => Date;
}

export class WizardCredentialStore {
  private readonly baseDir: string;
  private readonly storePath: string;
  private readonly keySaltPath: string;
  private readonly iterations: number;
  private readonly fingerprint: string;
  private readonly clock: () => Date;

  private derivedKey: Buffer | null = null;

  constructor(options: WizardCredentialStoreOptions = {}) {
    this.baseDir = options.baseDir ?? path.join(os.homedir(), ".openzigs");
    this.storePath = path.join(this.baseDir, "wizard-credentials.enc");
    this.keySaltPath = path.join(this.baseDir, ".wizard-key");
    this.iterations = options.pbkdf2Iterations ?? PBKDF2_ITERATIONS;
    this.fingerprint = options.fingerprint ?? defaultFingerprint();
    this.clock = options.clock ?? (() => new Date());
  }

  /** Idempotently ensures key material exists; safe to call repeatedly. */
  async init(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true, mode: SECURE_DIR_MODE });
    let salt: Buffer;
    try {
      salt = await fs.readFile(this.keySaltPath);
      if (salt.length !== KEY_SALT_LENGTH) {
        throw new Error("invalid salt length");
      }
    } catch {
      salt = randomBytes(KEY_SALT_LENGTH);
      await fs.writeFile(this.keySaltPath, salt, { mode: SECURE_FILE_MODE });
    }
    this.derivedKey = pbkdf2Sync(
      this.fingerprint,
      salt,
      this.iterations,
      PBKDF2_KEY_LEN,
      PBKDF2_DIGEST,
    );
  }

  async setCredential(
    platform: string,
    type: string,
    value: string,
  ): Promise<CredentialMetadata> {
    assertSafeKey(platform);
    assertSafeKey(type);
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("credential value must be a non-empty string");
    }
    await this.ensureKey();
    const store = await this.loadStore();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(AES_ALGORITHM, this.derivedKey!, iv);
    const data = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const updatedAt = this.clock().toISOString();

    const idx = store.entries.findIndex(
      (e) => e.platform === platform && e.type === type,
    );
    const entry: StoredEntry = {
      platform,
      type,
      ivHex: iv.toString("hex"),
      tagHex: tag.toString("hex"),
      dataHex: data.toString("hex"),
      updatedAt,
    };
    if (idx >= 0) store.entries[idx] = entry;
    else store.entries.push(entry);

    await this.persist(store);
    return { platform, type, hasValue: true, updatedAt };
  }

  async getCredential(platform: string, type: string): Promise<string | null> {
    await this.ensureKey();
    const store = await this.loadStore();
    const entry = store.entries.find(
      (e) => e.platform === platform && e.type === type,
    );
    if (!entry) return null;
    try {
      const decipher = createDecipheriv(
        AES_ALGORITHM,
        this.derivedKey!,
        Buffer.from(entry.ivHex, "hex"),
      );
      decipher.setAuthTag(Buffer.from(entry.tagHex, "hex"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(entry.dataHex, "hex")),
        decipher.final(),
      ]);
      return plaintext.toString("utf-8");
    } catch {
      return null;
    }
  }

  async listCredentials(): Promise<CredentialMetadata[]> {
    await this.ensureKey();
    const store = await this.loadStore();
    return store.entries.map((e) => ({
      platform: e.platform,
      type: e.type,
      hasValue: true,
      updatedAt: e.updatedAt,
    }));
  }

  async listForPlatform(platform: string): Promise<CredentialMetadata[]> {
    const all = await this.listCredentials();
    return all.filter((e) => e.platform === platform);
  }

  async deletePlatform(platform: string): Promise<number> {
    await this.ensureKey();
    const store = await this.loadStore();
    const before = store.entries.length;
    store.entries = store.entries.filter((e) => e.platform !== platform);
    const removed = before - store.entries.length;
    if (removed > 0) await this.persist(store);
    return removed;
  }

  async deleteCredential(platform: string, type: string): Promise<boolean> {
    await this.ensureKey();
    const store = await this.loadStore();
    const before = store.entries.length;
    store.entries = store.entries.filter(
      (e) => !(e.platform === platform && e.type === type),
    );
    const removed = before > store.entries.length;
    if (removed) await this.persist(store);
    return removed;
  }

  private async ensureKey(): Promise<void> {
    if (!this.derivedKey) await this.init();
  }

  private async loadStore(): Promise<StoreFile> {
    try {
      const raw = await fs.readFile(this.storePath, "utf-8");
      const parsed = JSON.parse(raw) as StoreFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        return { version: 1, entries: [] };
      }
      return parsed;
    } catch {
      return { version: 1, entries: [] };
    }
  }

  private async persist(store: StoreFile): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true, mode: SECURE_DIR_MODE });
    const tmp = `${this.storePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(store), { mode: SECURE_FILE_MODE });
    await fs.rename(tmp, this.storePath);
  }
}

function defaultFingerprint(): string {
  return [os.hostname(), os.platform(), os.arch(), os.userInfo().username].join(
    "|",
  );
}

function assertSafeKey(value: string): void {
  if (!/^[a-z0-9_-]{1,64}$/i.test(value)) {
    throw new Error(`invalid identifier: ${value}`);
  }
}
