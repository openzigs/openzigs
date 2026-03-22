/**
 * MemoryManager — GitHub repository-backed persistent memory for the OpenZigs agent.
 *
 * Stores structured memories as markdown files in a dedicated private GitHub
 * repository (default: `openzigs-memory`). Memories are injected into Copilot
 * SDK sessions as supplementary context to improve response quality over time.
 *
 * @module memory/memory-manager
 * @see https://github.com/openzigs/openzigs/issues/334
 */

import { EventEmitter } from "node:events";

// ── Types ──────────────────────────────────────────────────────────────

export type MemoryCategory =
  | "conventions"
  | "patterns"
  | "decisions"
  | "preferences"
  | "context";

export interface Memory {
  /** File path in the repo (e.g. `memories/conventions/esm-imports.md`) */
  id: string;
  category: MemoryCategory;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  sha: string;
}

export interface MemoryConfig {
  enabled: boolean;
  owner: string;
  repo: string;
  cacheTtlMs: number;
}

export interface MemoryRepoStatus {
  connected: boolean;
  owner: string;
  repo: string;
  memoryCount: number;
  lastSynced: string | null;
  error?: string;
}

export interface CreateMemoryInput {
  category: MemoryCategory;
  title: string;
  content: string;
}

export interface UpdateMemoryInput {
  title?: string;
  content?: string;
}

/** Minimal interface for the GitHub REST API calls we make. */
export interface GitHubApiClient {
  getAuthenticatedUser(): Promise<{ login: string }>;
  getRepo(owner: string, repo: string): Promise<{ full_name: string } | null>;
  createRepo(name: string, isPrivate: boolean, description: string): Promise<{ full_name: string }>;
  getContents(
    owner: string,
    repo: string,
    path: string,
  ): Promise<GitHubContent | GitHubContent[] | null>;
  createOrUpdateFile(
    owner: string,
    repo: string,
    path: string,
    message: string,
    content: string,
    sha?: string,
  ): Promise<{ content: { sha: string } }>;
  deleteFile(
    owner: string,
    repo: string,
    path: string,
    message: string,
    sha: string,
  ): Promise<void>;
}

export interface GitHubContent {
  name: string;
  path: string;
  sha: string;
  type: "file" | "dir";
  content?: string;
  encoding?: string;
}

// ── Default GitHub REST client ─────────────────────────────────────────

const GITHUB_API = "https://api.github.com";

export function createGitHubApiClient(token: string): GitHubApiClient {
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "openzigs-memory-manager",
    };
    if (token) {
      h.Authorization = `Bearer ${token}`;
    }
    return h;
  };

  const safeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const resp = await fetch(url, { ...init, headers: { ...headers(), ...init?.headers } });
    return resp;
  };

  return {
    async getAuthenticatedUser() {
      const resp = await safeFetch(`${GITHUB_API}/user`);
      if (!resp.ok) throw new Error(`GitHub API /user failed: ${resp.status}`);
      const body = await resp.json() as { login: string };
      return body;
    },

    async getRepo(owner: string, repo: string) {
      const resp = await safeFetch(`${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error(`GitHub API /repos failed: ${resp.status}`);
      return (await resp.json()) as { full_name: string };
    },

    async createRepo(name: string, isPrivate: boolean, description: string) {
      const resp = await safeFetch(`${GITHUB_API}/user/repos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, private: isPrivate, description, auto_init: true }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`GitHub API create repo failed (${resp.status}): ${text}`);
      }
      return (await resp.json()) as { full_name: string };
    },

    async getContents(owner: string, repo: string, p: string) {
      const resp = await safeFetch(
        `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${p}`,
      );
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error(`GitHub API getContents failed: ${resp.status}`);
      return (await resp.json()) as GitHubContent | GitHubContent[];
    },

    async createOrUpdateFile(owner, repo, p, message, content, sha?) {
      const body: Record<string, string> = {
        message,
        content: Buffer.from(content, "utf-8").toString("base64"),
      };
      if (sha) body.sha = sha;
      const resp = await safeFetch(
        `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${p}`,
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      );
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`GitHub API createOrUpdateFile failed (${resp.status}): ${text}`);
      }
      return (await resp.json()) as { content: { sha: string } };
    },

    async deleteFile(owner, repo, p, message, sha) {
      const resp = await safeFetch(
        `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${p}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, sha }),
        },
      );
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`GitHub API deleteFile failed (${resp.status}): ${text}`);
      }
    },
  };
}

// ── Memory categories ──────────────────────────────────────────────────

export const MEMORY_CATEGORIES: MemoryCategory[] = [
  "conventions",
  "patterns",
  "decisions",
  "preferences",
  "context",
];

const MEMORIES_ROOT = "memories";

// ── MemoryManager ──────────────────────────────────────────────────────

export class MemoryManager extends EventEmitter {
  private config: MemoryConfig;
  private github: GitHubApiClient;
  private cache: Memory[] | null = null;
  private cacheExpiry = 0;

  constructor(config: MemoryConfig, github: GitHubApiClient) {
    super();
    this.config = config;
    this.github = github;
  }

  // ── Config ───────────────────────────────────────────────────────────

  getConfig(): MemoryConfig {
    return { ...this.config };
  }

  updateConfig(patch: Partial<MemoryConfig>): void {
    this.config = { ...this.config, ...patch };
    this.invalidateCache();
    this.emit("config:changed", this.config);
  }

  // ── Repo Setup ───────────────────────────────────────────────────────

  /**
   * Create the memory repository on GitHub if it doesn't exist. Initialises
   * the `memories/` directory structure with a README in `memories/README.md`.
   */
  async setupRepo(): Promise<{ owner: string; repo: string; created: boolean }> {
    const owner = this.config.owner || (await this.github.getAuthenticatedUser()).login;
    const repoName = this.config.repo;

    const existing = await this.github.getRepo(owner, repoName);
    if (existing) {
      this.config.owner = owner;
      return { owner, repo: repoName, created: false };
    }

    await this.github.createRepo(
      repoName,
      true,
      "OpenZigs agent memory — persistent repository-scoped memory for improved AI responses",
    );
    this.config.owner = owner;

    // Initialise directory structure
    const readme = [
      "# OpenZigs Agent Memory",
      "",
      "This repository stores persistent memories for the OpenZigs AI agent.",
      "Memories are organised by category and injected into conversations to improve response quality.",
      "",
      "## Categories",
      "",
      "| Folder | Purpose |",
      "|--------|---------|",
      "| `conventions/` | Coding conventions, style rules, import patterns |",
      "| `patterns/` | Code patterns, architecture patterns, testing patterns |",
      "| `decisions/` | Architecture decisions, technology choices, trade-offs |",
      "| `preferences/` | User preferences, workflow preferences |",
      "| `context/` | Project context, domain knowledge, terminology |",
      "",
      "> Managed automatically by OpenZigs. Edit via the Admin → Memory panel.",
    ].join("\n");

    await this.github.createOrUpdateFile(
      owner, repoName, `${MEMORIES_ROOT}/README.md`, "chore: initialise memory repository", readme,
    );

    this.emit("repo:created", { owner, repo: repoName });
    return { owner, repo: repoName, created: true };
  }

  // ── Status ───────────────────────────────────────────────────────────

  async getStatus(): Promise<MemoryRepoStatus> {
    if (!this.config.enabled) {
      return {
        connected: false, owner: this.config.owner, repo: this.config.repo,
        memoryCount: 0, lastSynced: null, error: "Memory is disabled",
      };
    }

    try {
      const owner = this.config.owner || (await this.github.getAuthenticatedUser()).login;
      const exists = await this.github.getRepo(owner, this.config.repo);
      if (!exists) {
        return {
          connected: false, owner, repo: this.config.repo,
          memoryCount: 0, lastSynced: null, error: "Repository not found",
        };
      }

      const memories = await this.listMemories();
      return {
        connected: true, owner, repo: this.config.repo,
        memoryCount: memories.length, lastSynced: new Date().toISOString(),
      };
    } catch (err) {
      return {
        connected: false, owner: this.config.owner, repo: this.config.repo,
        memoryCount: 0, lastSynced: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────────────

  async listMemories(): Promise<Memory[]> {
    if (this.cache && Date.now() < this.cacheExpiry) return this.cache;

    const owner = this.config.owner;
    const repo = this.config.repo;
    const memories: Memory[] = [];

    for (const category of MEMORY_CATEGORIES) {
      const dirPath = `${MEMORIES_ROOT}/${category}`;
      const listing = await this.github.getContents(owner, repo, dirPath);
      if (!listing || !Array.isArray(listing)) continue;

      for (const item of listing) {
        if (item.type !== "file" || !item.name.endsWith(".md")) continue;

        const fileData = await this.github.getContents(owner, repo, item.path);
        if (!fileData || Array.isArray(fileData) || !fileData.content) continue;

        const decoded = Buffer.from(fileData.content, "base64").toString("utf-8");
        const { title, content, createdAt, updatedAt } = parseMemoryFile(decoded);

        memories.push({
          id: item.path,
          category: category as MemoryCategory,
          title,
          content,
          createdAt,
          updatedAt,
          sha: fileData.sha,
        });
      }
    }

    this.cache = memories;
    this.cacheExpiry = Date.now() + this.config.cacheTtlMs;
    return memories;
  }

  async getMemory(id: string): Promise<Memory | null> {
    const memories = await this.listMemories();
    return memories.find((m) => m.id === id) ?? null;
  }

  async createMemory(input: CreateMemoryInput): Promise<Memory> {
    const owner = this.config.owner;
    const repo = this.config.repo;
    const slug = slugify(input.title);
    const filePath = `${MEMORIES_ROOT}/${input.category}/${slug}.md`;
    const now = new Date().toISOString();
    const fileContent = formatMemoryFile(input.title, input.content, now, now);

    const result = await this.github.createOrUpdateFile(
      owner, repo, filePath,
      `memory: add ${input.category}/${slug}`,
      fileContent,
    );

    this.invalidateCache();

    const memory: Memory = {
      id: filePath,
      category: input.category,
      title: input.title,
      content: input.content,
      createdAt: now,
      updatedAt: now,
      sha: result.content.sha,
    };

    this.emit("memory:created", memory);
    return memory;
  }

  async updateMemory(id: string, input: UpdateMemoryInput): Promise<Memory> {
    const existing = await this.getMemory(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);

    const title = input.title ?? existing.title;
    const content = input.content ?? existing.content;
    const now = new Date().toISOString();
    const fileContent = formatMemoryFile(title, content, existing.createdAt, now);

    const result = await this.github.createOrUpdateFile(
      this.config.owner, this.config.repo, id,
      `memory: update ${id}`,
      fileContent,
      existing.sha,
    );

    this.invalidateCache();

    const updated: Memory = {
      ...existing,
      title,
      content,
      updatedAt: now,
      sha: result.content.sha,
    };
    this.emit("memory:updated", updated);
    return updated;
  }

  async deleteMemory(id: string): Promise<void> {
    const existing = await this.getMemory(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);

    await this.github.deleteFile(
      this.config.owner, this.config.repo, id,
      `memory: delete ${id}`,
      existing.sha,
    );

    this.invalidateCache();
    this.emit("memory:deleted", { id });
  }

  // ── Session Context ──────────────────────────────────────────────────

  /**
   * Build a markdown summary of all memories to inject into a Copilot session
   * as supplementary system context.
   */
  async buildSessionContext(): Promise<string | null> {
    if (!this.config.enabled) return null;

    try {
      const memories = await this.listMemories();
      if (memories.length === 0) return null;

      const grouped = new Map<MemoryCategory, Memory[]>();
      for (const m of memories) {
        const list = grouped.get(m.category) ?? [];
        list.push(m);
        grouped.set(m.category, list);
      }

      const sections: string[] = [
        "# Agent Memory — Persistent Knowledge",
        "",
        "The following are persistent memories saved from previous sessions.",
        "Use these to maintain consistency, apply known conventions, and personalise responses.",
        "",
        "**Important:** When you discover new facts about the user — their preferences,",
        "workflows, account names, scheduling habits, brand guidelines, technology choices,",
        "or project context — proactively use the `save-memory` tool to store them.",
        "This helps you be smarter in future sessions. Do not ask permission to save",
        "obvious preferences or factual information. Only save genuinely useful, specific facts.",
        "",
      ];

      for (const [category, items] of grouped) {
        sections.push(`## ${category.charAt(0).toUpperCase() + category.slice(1)}`);
        sections.push("");
        for (const item of items) {
          sections.push(`### ${item.title}`);
          sections.push(item.content);
          sections.push("");
        }
      }

      return sections.join("\n");
    } catch {
      return null;
    }
  }

  // ── Cache ────────────────────────────────────────────────────────────

  invalidateCache(): void {
    this.cache = null;
    this.cacheExpiry = 0;
  }
}

// ── File Format Helpers ────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export function formatMemoryFile(
  title: string,
  content: string,
  createdAt: string,
  updatedAt: string,
): string {
  return [
    "---",
    `title: "${title.replace(/"/g, '\\"')}"`,
    `createdAt: "${createdAt}"`,
    `updatedAt: "${updatedAt}"`,
    "---",
    content,
  ].join("\n");
}

export function parseMemoryFile(raw: string): {
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
} {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { title: "Untitled", content: raw.trim(), createdAt: "", updatedAt: "" };

  const frontmatter = match[1];
  const content = match[2].trim();

  const titleMatch = /title:\s*"([^"]*)"/.exec(frontmatter);
  const createdMatch = /createdAt:\s*"([^"]*)"/.exec(frontmatter);
  const updatedMatch = /updatedAt:\s*"([^"]*)"/.exec(frontmatter);

  return {
    title: titleMatch?.[1] ?? "Untitled",
    content,
    createdAt: createdMatch?.[1] ?? "",
    updatedAt: updatedMatch?.[1] ?? "",
  };
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
