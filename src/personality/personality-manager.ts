import type Database from "better-sqlite3";

export type PersonalityConfig = {
  /** The system instruction / persona */
  systemInstruction: string;
  /** Text injected BEFORE the user's message */
  prePrompt: string;
  /** Text injected AFTER the user's message */
  postPrompt: string;
  /** Whether personality injection is enabled */
  enabled: boolean;
  /** ISO timestamp of last update */
  updatedAt: string;
};

export type PersonalityUpdate = {
  systemInstruction?: string;
  prePrompt?: string;
  postPrompt?: string;
  enabled?: boolean;
};

export const DEFAULT_PERSONALITY: PersonalityConfig = {
  systemInstruction: "You are OpenZigs, a helpful personal AI assistant.",
  prePrompt: "Output chat sessions in markdown format and use mermaid diagrams where applicable. When posting to social media, always convert Markdown formatting to platform-native text using Unicode characters. Never post raw Markdown syntax to social platforms.",
  postPrompt: "",
  enabled: true,
  updatedAt: new Date().toISOString(),
};

export type PersonalityManagerOptions = {
  db: Database.Database;
  clock?: () => Date;
};

type StoredPersonality = {
  id: number;
  system_instruction: string;
  pre_prompt: string;
  post_prompt: string;
  enabled: number;
  updated_at: string;
};

export class PersonalityManager {
  private db: Database.Database;
  private clock: () => Date;

  constructor({ db, clock }: PersonalityManagerOptions) {
    this.db = db;
    this.clock = clock ?? (() => new Date());
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personality (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        system_instruction TEXT NOT NULL,
        pre_prompt TEXT NOT NULL DEFAULT '',
        post_prompt TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Seed default row if empty
    const row = this.db.prepare("SELECT COUNT(*) as count FROM personality").get() as { count: number };
    if (row.count === 0) {
      this.db
        .prepare(
          `INSERT INTO personality (id, system_instruction, pre_prompt, post_prompt, enabled, updated_at)
           VALUES (1, ?, ?, ?, 1, ?)`
        )
        .run(
          DEFAULT_PERSONALITY.systemInstruction,
          DEFAULT_PERSONALITY.prePrompt,
          DEFAULT_PERSONALITY.postPrompt,
          this.clock().toISOString()
        );
    }
  }

  getConfig(): PersonalityConfig {
    const row = this.db.prepare("SELECT * FROM personality WHERE id = 1").get() as StoredPersonality | undefined;
    if (!row) {
      return { ...DEFAULT_PERSONALITY };
    }
    return {
      systemInstruction: row.system_instruction,
      prePrompt: row.pre_prompt,
      postPrompt: row.post_prompt,
      enabled: row.enabled === 1,
      updatedAt: row.updated_at,
    };
  }

  update(input: PersonalityUpdate): PersonalityConfig {
    const current = this.getConfig();
    const now = this.clock().toISOString();

    const systemInstruction = input.systemInstruction ?? current.systemInstruction;
    const prePrompt = input.prePrompt ?? current.prePrompt;
    const postPrompt = input.postPrompt ?? current.postPrompt;
    const enabled = input.enabled ?? current.enabled;

    this.db
      .prepare(
        `UPDATE personality
         SET system_instruction = ?, pre_prompt = ?, post_prompt = ?, enabled = ?, updated_at = ?
         WHERE id = 1`
      )
      .run(systemInstruction, prePrompt, postPrompt, enabled ? 1 : 0, now);

    return this.getConfig();
  }

  reset(): PersonalityConfig {
    const now = this.clock().toISOString();
    this.db
      .prepare(
        `UPDATE personality
         SET system_instruction = ?, pre_prompt = ?, post_prompt = ?, enabled = 1, updated_at = ?
         WHERE id = 1`
      )
      .run(
        DEFAULT_PERSONALITY.systemInstruction,
        DEFAULT_PERSONALITY.prePrompt,
        DEFAULT_PERSONALITY.postPrompt,
        now
      );
    return this.getConfig();
  }
}
