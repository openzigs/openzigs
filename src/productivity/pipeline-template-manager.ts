import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { PipelineStage } from "../tasks/types.js";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface TemplateVariable {
  key: string;
  label: string;
  description: string;
  required: boolean;
  default?: string;
}

export interface PipelineTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  tags: string[];
  suggestedSkill: string | null;
  template: string;
  stages: PipelineStage[];
  variables: TemplateVariable[];
  builtIn: boolean;
}

/* ------------------------------------------------------------------ */
/*  Manager                                                           */
/* ------------------------------------------------------------------ */

const USER_TEMPLATES_PATH = path.join(os.homedir(), ".openzigs", "pipeline-templates.json");

export class PipelineTemplateManager {
  private builtInTemplates: PipelineTemplate[] = [];
  private userTemplates: PipelineTemplate[] = [];

  constructor(private builtInPath: string) {}

  async load(): Promise<void> {
    // Load built-in templates
    try {
      const raw = await fs.readFile(this.builtInPath, "utf-8");
      const parsed = JSON.parse(raw) as Array<Omit<PipelineTemplate, "builtIn">>;
      this.builtInTemplates = parsed.map((t) => ({ ...t, builtIn: true }));
    } catch {
      this.builtInTemplates = [];
    }

    // Load user templates
    try {
      const raw = await fs.readFile(USER_TEMPLATES_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Array<Omit<PipelineTemplate, "builtIn">>;
      this.userTemplates = parsed.map((t) => ({ ...t, builtIn: false }));
    } catch {
      this.userTemplates = [];
    }
  }

  list(): PipelineTemplate[] {
    return [...this.builtInTemplates, ...this.userTemplates];
  }

  getById(id: string): PipelineTemplate | null {
    return this.list().find((t) => t.id === id) ?? null;
  }

  async create(data: Omit<PipelineTemplate, "id" | "builtIn">): Promise<PipelineTemplate> {
    const template: PipelineTemplate = { ...data, id: randomUUID(), builtIn: false };
    this.userTemplates.push(template);
    await this.saveUserTemplates();
    return template;
  }

  async update(id: string, data: Partial<Omit<PipelineTemplate, "id" | "builtIn">>): Promise<PipelineTemplate | null> {
    const idx = this.userTemplates.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    this.userTemplates[idx] = { ...this.userTemplates[idx], ...data };
    await this.saveUserTemplates();
    return this.userTemplates[idx];
  }

  async remove(id: string): Promise<boolean> {
    const idx = this.userTemplates.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    this.userTemplates.splice(idx, 1);
    await this.saveUserTemplates();
    return true;
  }

  private async saveUserTemplates(): Promise<void> {
    await fs.mkdir(path.dirname(USER_TEMPLATES_PATH), { recursive: true });
    const data = this.userTemplates.map(({ builtIn: _, ...rest }) => rest);
    await fs.writeFile(USER_TEMPLATES_PATH, JSON.stringify(data, null, 2), "utf-8");
  }
}
