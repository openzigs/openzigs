/**
 * SecretVaultService — AES-256-GCM encrypted local secret store.
 *
 * Design constraints:
 * - Master password derived key via PBKDF2 (100 000 iterations, SHA-512).
 * - Vault file at ~/.openzigs/vault.enc with 0o600 permissions.
 * - Master password cached in memory; cleared on shutdown.
 * - Plaintext NEVER leaves this module except via explicit `resolveToken()`.
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomUUID,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { logger } from "../logging/logger.js";
import type {
  SecretEntry,
  SecretEntryWithValue,
  EncryptedVaultFile,
} from "./vault-types.js";

// ── Constants ──

const VAULT_DIR = path.join(os.homedir(), ".openzigs");
const VAULT_FILE = path.join(VAULT_DIR, "vault.enc");
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_LEN = 32; // 256 bits
const PBKDF2_DIGEST = "sha512";
const AES_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const SALT_LENGTH = 32;

export type SecretVaultServiceOptions = {
  /** Override the vault file path (useful for testing). */
  vaultPath?: string;
  /** Override PBKDF2 iterations (lower for fast tests). */
  pbkdf2Iterations?: number;
};

export class SecretVaultService {
  private vaultPath: string;
  private pbkdf2Iterations: number;

  /** Cached PBKDF2-derived key — only lives in memory while vault is unlocked. */
  private derivedKey: Buffer | null = null;

  /** Decrypted secrets kept in memory for fast access after unlock. */
  private secrets: SecretEntryWithValue[] = [];

  /** Salt used for the current derived key (persisted in vault file). */
  private currentSalt: Buffer | null = null;

  /** Whether the vault has been unlocked this session. */
  private unlocked = false;

  constructor(options: SecretVaultServiceOptions = {}) {
    this.vaultPath = options.vaultPath ?? VAULT_FILE;
    this.pbkdf2Iterations = options.pbkdf2Iterations ?? PBKDF2_ITERATIONS;
  }

  // ── Public API ──

  /** Returns true if the vault file exists on disk. */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.vaultPath);
      return true;
    } catch {
      return false;
    }
  }

  /** Returns true if the vault is currently unlocked (master password cached). */
  isUnlocked(): boolean {
    return this.unlocked;
  }

  /**
   * Initialise a brand-new vault with the given master password.
   * Throws if a vault file already exists.
   */
  async initialize(masterPassword: string): Promise<void> {
    if (await this.exists()) {
      throw new Error("Vault already exists. Use unlock() instead.");
    }
    this.currentSalt = randomBytes(SALT_LENGTH);
    this.derivedKey = this.deriveKey(masterPassword, this.currentSalt);
    this.secrets = [];
    this.unlocked = true;
    await this.persist();
    logger.info("Secret vault initialised");
  }

  /**
   * Unlock an existing vault with the master password.
   * Throws if the password is wrong or the file is corrupt.
   */
  async unlock(masterPassword: string): Promise<void> {
    const raw = await fs.readFile(this.vaultPath, "utf-8");
    const vault = JSON.parse(raw) as EncryptedVaultFile;

    if (vault.version !== 1) {
      throw new Error(`Unsupported vault version: ${vault.version}`);
    }

    const salt = Buffer.from(vault.salt, "hex");
    const iv = Buffer.from(vault.iv, "hex");
    const tag = Buffer.from(vault.tag, "hex");
    const ciphertext = Buffer.from(vault.data, "hex");

    const key = this.deriveKey(masterPassword, salt);

    const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    let plaintext: string;
    try {
      plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf-8");
    } catch {
      throw new Error("Invalid master password or corrupt vault");
    }

    this.secrets = JSON.parse(plaintext) as SecretEntryWithValue[];
    this.derivedKey = key;
    this.currentSalt = salt;
    this.unlocked = true;
    logger.info(`Secret vault unlocked (${this.secrets.length} secrets)`);
  }

  /** Lock the vault — wipe the derived key and plaintext from memory. */
  lock(): void {
    if (this.derivedKey) {
      this.derivedKey.fill(0);
    }
    this.derivedKey = null;
    this.currentSalt = null;
    this.secrets = [];
    this.unlocked = false;
    logger.info("Secret vault locked");
  }

  /**
   * Change the master password.
   * Re-encrypts all secrets with a new salt + key pair.
   */
  async changeMasterPassword(
    currentPassword: string,
    newPassword: string
  ): Promise<void> {
    // Re-unlock to verify the current password is correct
    await this.unlock(currentPassword);

    // Derive a new key with a fresh salt
    this.currentSalt = randomBytes(SALT_LENGTH);
    this.derivedKey = this.deriveKey(newPassword, this.currentSalt);
    await this.persist();
    logger.info("Vault master password changed");
  }

  /** Add a new secret and return its entry (without the value). */
  async addSecret(params: {
    label: string;
    value: string;
    service?: string;
    username?: string;
  }): Promise<SecretEntry> {
    this.ensureUnlocked();

    const now = new Date().toISOString();
    const entry: SecretEntryWithValue = {
      id: randomUUID(),
      label: params.label,
      service: params.service,
      username: params.username,
      value: params.value,
      createdAt: now,
      updatedAt: now,
    };

    this.secrets.push(entry);
    await this.persist();
    logger.info(`Secret added: ${entry.label} (${entry.id})`);
    return this.stripValue(entry);
  }

  /** Update an existing secret's metadata and/or value. */
  async updateSecret(
    id: string,
    updates: Partial<Pick<SecretEntryWithValue, "label" | "value" | "service" | "username">>
  ): Promise<SecretEntry> {
    this.ensureUnlocked();

    const entry = this.secrets.find((s) => s.id === id);
    if (!entry) {
      throw new Error(`Secret not found: ${id}`);
    }

    if (updates.label !== undefined) entry.label = updates.label;
    if (updates.value !== undefined) entry.value = updates.value;
    if (updates.service !== undefined) entry.service = updates.service;
    if (updates.username !== undefined) entry.username = updates.username;
    entry.updatedAt = new Date().toISOString();

    await this.persist();
    logger.info(`Secret updated: ${entry.label} (${entry.id})`);
    return this.stripValue(entry);
  }

  /** Delete a secret by ID. */
  async deleteSecret(id: string): Promise<void> {
    this.ensureUnlocked();

    const index = this.secrets.findIndex((s) => s.id === id);
    if (index === -1) {
      throw new Error(`Secret not found: ${id}`);
    }

    const label = this.secrets[index].label;
    this.secrets.splice(index, 1);
    await this.persist();
    logger.info(`Secret deleted: ${label} (${id})`);
  }

  /** List all secrets (metadata only — values stripped). */
  listSecrets(): SecretEntry[] {
    this.ensureUnlocked();
    return this.secrets.map((s) => this.stripValue(s));
  }

  /** Get a single secret's metadata by ID (no value). */
  getSecret(id: string): SecretEntry | undefined {
    this.ensureUnlocked();
    const entry = this.secrets.find((s) => s.id === id);
    return entry ? this.stripValue(entry) : undefined;
  }

  /**
   * Resolve a secret reference token to its plaintext value.
   * This is the ONLY method that returns plaintext — call it inside
   * the browser-navigate handler right before dispatching key events.
   */
  resolveToken(id: string): string | undefined {
    this.ensureUnlocked();
    const entry = this.secrets.find((s) => s.id === id);
    return entry?.value;
  }

  // ── Private helpers ──

  private ensureUnlocked(): void {
    if (!this.unlocked || !this.derivedKey) {
      throw new Error("Vault is locked. Call unlock() first.");
    }
  }

  private deriveKey(password: string, salt: Buffer): Buffer {
    return pbkdf2Sync(
      password,
      salt,
      this.pbkdf2Iterations,
      PBKDF2_KEY_LEN,
      PBKDF2_DIGEST
    );
  }

  private encrypt(plaintext: string): { iv: Buffer; tag: Buffer; data: Buffer } {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(AES_ALGORITHM, this.derivedKey!, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf-8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return { iv, tag, data: encrypted };
  }

  private async persist(): Promise<void> {
    if (!this.derivedKey || !this.currentSalt) {
      throw new Error("Cannot persist — vault is not unlocked");
    }

    const plaintext = JSON.stringify(this.secrets);
    const { iv, tag, data } = this.encrypt(plaintext);

    const vault: EncryptedVaultFile = {
      version: 1,
      salt: this.currentSalt.toString("hex"),
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      data: data.toString("hex"),
    };

    await fs.mkdir(path.dirname(this.vaultPath), { recursive: true, mode: 0o700 });
    // Write to temp file first, then rename for atomicity
    const tmpPath = `${this.vaultPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(vault, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fs.rename(tmpPath, this.vaultPath);
    await fs.chmod(this.vaultPath, 0o600);
  }

  private stripValue(entry: SecretEntryWithValue): SecretEntry {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { value: _v, ...meta } = entry;
    return meta;
  }
}
