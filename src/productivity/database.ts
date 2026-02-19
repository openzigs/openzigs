import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { TaskRepository } from "../tasks/task-repository.js";
import { PresentationRepository } from "../presenter/presentation-repository.js";

export type DatabaseOptions = {
  dbPath?: string;
};

const defaultDbPath = () => path.join(os.homedir(), ".openzigs", "openzigs.db");

let sharedDb: Database.Database | null = null;

export const getDatabase = (options: DatabaseOptions = {}): Database.Database => {
  if (sharedDb) {
    return sharedDb;
  }

  const dbPath = options.dbPath ?? defaultDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  initSchema(db);

  // Run task-engine migration (agent_tasks table)
  const taskRepo = new TaskRepository(db);
  taskRepo.migrate();

  // Run presenter migration (presentations + quiz_cache tables)
  const presentationRepo = new PresentationRepository(db);
  presentationRepo.migrate();

  sharedDb = db;
  return db;
};

export const closeDatabase = () => {
  if (sharedDb) {
    sharedDb.close();
    sharedDb = null;
  }
};

const initSchema = (db: Database.Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      template TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      action_type TEXT NOT NULL DEFAULT 'prompt',
      action_payload TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      model TEXT,
      reasoning_effort TEXT,
      allowed_tools TEXT,
      auto_approve_tools TEXT,
      last_run_at TEXT,
      next_run_at TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voice_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      ref_audio_path TEXT NOT NULL DEFAULT '',
      ref_text TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'en',
      top_p REAL NOT NULL DEFAULT 0.8,
      temperature REAL NOT NULL DEFAULT 1.0,
      text_split_method TEXT NOT NULL DEFAULT 'cut5',
      speed_factor REAL NOT NULL DEFAULT 1.0,
      repetition_penalty REAL NOT NULL DEFAULT 1.35,
      top_k INTEGER NOT NULL DEFAULT 15,
      sample_steps INTEGER NOT NULL DEFAULT 32,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const voiceProfileColumns = db
    .prepare("PRAGMA table_info(voice_profiles)")
    .all() as Array<{ name: string }>;

  const hasSampleSteps = voiceProfileColumns.some((col) => col.name === "sample_steps");
  if (!hasSampleSteps) {
    db.exec("ALTER TABLE voice_profiles ADD COLUMN sample_steps INTEGER NOT NULL DEFAULT 32");
  }
};

/** Create a fresh in-memory database for testing. */
export const createTestDatabase = (): Database.Database => {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initSchema(db);

  const taskRepo = new TaskRepository(db);
  taskRepo.migrate();

  const presentationRepo = new PresentationRepository(db);
  presentationRepo.migrate();

  return db;
};
