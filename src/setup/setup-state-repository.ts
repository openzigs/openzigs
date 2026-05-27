/**
 * SetupStateRepository — SQLite-backed persistence for the onboarding wizard.
 *
 * Single-row table (`id = 1`) holds the user's current step, the list of
 * completed steps, and an opaque JSON payload of step-level form data so the
 * wizard can be resumed across reloads and device switches.
 *
 * Issue #1126 — Wizard: state persistence + resume.
 */

import Database from "better-sqlite3";

export type WizardStepId =
  | "welcome"
  | "prereqs"
  | "sidecars"
  | "social"
  | "byok"
  | "recipes"
  | "complete";

export interface WizardState {
  currentStep: WizardStepId;
  completedSteps: WizardStepId[];
  data: Record<string, unknown>;
  updatedAt: string;
}

export const DEFAULT_WIZARD_STATE: WizardState = {
  currentStep: "welcome",
  completedSteps: [],
  data: {},
  updatedAt: new Date(0).toISOString(),
};

export class SetupStateRepository {
  private db: Database.Database;
  private clock: () => Date;

  constructor(db: Database.Database, clock?: () => Date) {
    this.db = db;
    this.clock = clock ?? (() => new Date());
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wizard_state (
        id              INTEGER PRIMARY KEY CHECK(id = 1),
        current_step    TEXT NOT NULL,
        completed_steps TEXT NOT NULL DEFAULT '[]',
        data            TEXT NOT NULL DEFAULT '{}',
        updated_at      TEXT NOT NULL
      );
    `);
  }

  get(): WizardState {
    const row = this.db
      .prepare(
        "SELECT current_step, completed_steps, data, updated_at FROM wizard_state WHERE id = 1",
      )
      .get() as
      | {
          current_step: string;
          completed_steps: string;
          data: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return { ...DEFAULT_WIZARD_STATE };

    return {
      currentStep: row.current_step as WizardStepId,
      completedSteps: JSON.parse(row.completed_steps) as WizardStepId[],
      data: JSON.parse(row.data) as Record<string, unknown>,
      updatedAt: row.updated_at,
    };
  }

  save(updates: Partial<Omit<WizardState, "updatedAt">>): WizardState {
    const current = this.get();
    const next: WizardState = {
      currentStep: updates.currentStep ?? current.currentStep,
      completedSteps: updates.completedSteps ?? current.completedSteps,
      data: updates.data ? { ...current.data, ...updates.data } : current.data,
      updatedAt: this.clock().toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO wizard_state (id, current_step, completed_steps, data, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           current_step = excluded.current_step,
           completed_steps = excluded.completed_steps,
           data = excluded.data,
           updated_at = excluded.updated_at`,
      )
      .run(
        next.currentStep,
        JSON.stringify(next.completedSteps),
        JSON.stringify(next.data),
        next.updatedAt,
      );

    return next;
  }

  reset(): void {
    this.db.prepare("DELETE FROM wizard_state WHERE id = 1").run();
  }
}
