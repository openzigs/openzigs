---
name: repo-scaffold
description: "Scaffolds a new project repository with the optimal tech stack. Detects or asks for project type (web app, API server, CLI, library), researches best-fit technologies using web and Context7, creates local + remote repos, and applies industry-standard scaffolding with CI/CD, linting, testing, and docs structure."
argument-hint: "[project-name] — name for the new project repository"
---

# Repository Scaffold

## Purpose

This skill guides the **Code Planner** agent through creating a new project from scratch: selecting the right tech stack, scaffolding the repo with best practices, and pushing to GitHub. It handles the full lifecycle from "I have an idea" to "I have a repo ready for development."

## When to Use

- The user wants to start a new project and doesn't have a repo yet
- The user describes an application and needs a repo created
- The user asks to "scaffold", "bootstrap", "create a new project", or "set up a repo"
- The Code Planner agent detects no local or remote git repo

## Required MCP Tools

| Tool | Purpose |
|------|---------|
| `mcp_github_create_repository` | Create remote GitHub repo |
| `mcp_github_push_files` | Push initial scaffolding to remote |
| `mcp_github_get_me` | Get current GitHub user for repo ownership |
| `mcp_context7_resolve-library-id` | Resolve library IDs for documentation lookup |
| `mcp_context7_query-docs` | Fetch up-to-date scaffolding and config docs |
| `mcp_tavily_tavily_search` | Web search for best practices, starter templates, and framework docs (preferred) |
| `fetch_webpage` | Fetch a specific URL when Tavily is unavailable or URL is already known |

## Workflow

### Step 0: Detect or Acquire Repo

#### 0a. Did the user name a specific repo in their prompt?

Look for any of:
- A full URL: `https://github.com/owner/repo`
- An `owner/repo` short form: `myorg/my-project`
- A plain repo name that can be inferred from context

If a repo was named, go to **Step 0b** to ensure it's on disk and up-to-date.  
If no repo was named, proceed to **Step 0c**.

#### 0b. Clone or Pull the Named Repo

Resolve the owner and repo name from the user's input. Use `github.com` as the default host.

Build the clone path: `{workspace_dir}/{REPO}` (or the user's preferred directory).

**If the directory does not exist** — clone it:
```bash
git clone https://github.com/{OWNER}/{REPO}.git
```

**If the directory already exists** — pull latest from the default branch:
```bash
cd {REPO}
git fetch origin
git checkout main 2>/dev/null || git checkout master
git pull --ff-only origin $(git rev-parse --abbrev-ref HEAD)
```

After clone/pull, set the working repo path and
proceed directly to the **epic-planner** skill — no scaffolding is needed for existing repos.

> If clone fails (auth, not found, typo), report the error immediately and ask the user to
> confirm the repo name/URL and that they have access. Do not proceed until the repo is available locally.

#### 0c. No Repo Named — Detect What's Local

1. Check if the current workspace has a `.git` directory
2. Check if there's a `package.json`, `build.gradle`, `Cargo.toml`, `go.mod`, `pyproject.toml`, or similar
3. If a repo exists locally, check for a remote: `git remote -v`
4. If a remote exists, check if it exists on GitHub using `mcp_github_get_me` + search

**If repo exists**: Skip to the epic-planner skill — scaffolding is not needed.

**If no repo exists**: Proceed with the interview.

### Step 1: Project Interview

Ask the user the following questions. Present sensible defaults based on context.

#### 1a. Project Type (Required)
> **What type of project are you building?**
> - 🌐 **Web Application** (frontend + optional backend)
> - 🔌 **API Server** (REST/GraphQL backend service)
> - 🖥️ **CLI Tool** (command-line application)
> - 📦 **Library/Package** (reusable module)
> - 🔧 **Full-Stack Application** (monorepo with frontend + backend)
> - 📱 **Mobile Application** (React Native, Flutter, etc.)
> - 🤖 **MCP Server** (Model Context Protocol server)
> - ❓ **Other** (describe it)

#### 1b. Project Description (Required)
> **Describe what this project does in 1-3 sentences.**

#### 1c. Project Name (Required)
> **What should the repository be called?** (kebab-case recommended)

#### 1d. Visibility
> **Public or private repository?** (default: private)

#### 1e. Additional Context
> **Any specific requirements?** (auth needs, database, real-time features, integrations, etc.)

### Step 2: Technology Research & Recommendation

Based on the project type and description, research the best tech stack.

#### Frontend Projects (Web App, Full-Stack frontend)

**Default recommendation**: React + Tailwind CSS + Radix UI

Research using Context7 and Tavily:
```
mcp_context7_resolve-library-id → "Next.js" or "Vite React"
mcp_context7_query-docs → scaffolding commands and configuration
mcp_tavily_tavily_search → latest best practices for the chosen framework (fall back to fetch_webpage if unavailable)
```

**Decision tree**:
- Needs SSR, SEO, or file-based routing → **Next.js** (App Router)
- Pure SPA, no SSR needed → **Vite + React**
- Content-heavy site → **Astro** (with React islands)
- Simple static site → **Vite + React** or **Astro**

**Always include**:
- Tailwind CSS v4 for styling
- Radix UI primitives for accessible components
- TypeScript (strict mode)
- ESLint + Prettier
- Vitest for unit tests
- Playwright for e2e tests (if UI)

#### Backend Projects (API Server, Full-Stack backend)

Research the best fit based on the project requirements:

| Consideration | Recommended Stack | When |
|---------------|------------------|------|
| Simple REST API, rapid development | **Node.js + Express/Fastify + TypeScript** | Most web APIs, CRUD apps, real-time features |
| Complex business logic, enterprise | **Java + Spring Boot** | Heavy ORM needs, complex transactions, enterprise integration |
| Data science, ML, scripting | **Python + FastAPI** | ML pipelines, data processing, science computing |
| High performance, concurrency | **Go + Chi/Gin** | Microservices, high-throughput, low-latency |
| Systems programming, WASM | **Rust + Axum/Actix** | Performance-critical, memory-safe systems |

For each candidate, use Context7 to check:
```
mcp_context7_resolve-library-id → resolve the framework
mcp_context7_query-docs → "project setup scaffolding getting started"
```

Present the recommendation with reasoning:

```markdown
## Tech Stack Recommendation

### Frontend
- **Framework**: Next.js 15 (App Router)
- **Styling**: Tailwind CSS v4
- **Components**: Radix UI primitives
- **Language**: TypeScript 5.7+ (strict)

### Backend
- **Runtime**: Node.js 22 LTS
- **Framework**: Fastify 5
- **Language**: TypeScript 5.7+ (strict)
- **ORM**: Drizzle ORM

### Reasoning
[Why this stack fits the described project]

### Alternatives Considered
[Brief mention of what was considered and why it wasn't chosen]
```

Wait for user confirmation before proceeding.

#### MCP Server Projects

**Default recommendation**: Node.js + TypeScript + `@modelcontextprotocol/sdk`

Research:
```
mcp_context7_resolve-library-id → "@modelcontextprotocol/sdk"
mcp_context7_query-docs → "create MCP server tools resources"
```

### Step 3: Create Repository

#### 3a. Create Remote Repository
```
mcp_github_get_me → get username
mcp_github_create_repository → create repo with:
  - name: project-name
  - description: from interview
  - private: based on interview
  - auto_init: false (we'll push our own scaffolding)
```

#### 3b. Initialize Local Repository
```bash
mkdir <project-name> && cd <project-name>
git init
git remote add origin https://github.com/<owner>/<project-name>.git
```

### Step 4: Scaffold Project

Apply the appropriate scaffold based on the chosen tech stack.

#### Next.js + Tailwind + Radix UI
```bash
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm
npm install @radix-ui/themes @radix-ui/react-icons
npm install -D vitest @testing-library/react @testing-library/jest-dom @playwright/test
npx playwright install chromium
```

#### Vite + React + Tailwind + Radix UI
```bash
npm create vite@latest . -- --template react-ts
npm install @radix-ui/themes @radix-ui/react-icons tailwindcss @tailwindcss/vite
npm install -D vitest @testing-library/react @testing-library/jest-dom @playwright/test
npx playwright install chromium
```

#### Node.js + Fastify + TypeScript
```bash
npm init -y
npm install fastify @fastify/cors @fastify/helmet
npm install -D typescript @types/node tsx vitest eslint prettier
npx tsc --init --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --outDir dist
```

#### Python + FastAPI
```bash
python -m venv .venv
source .venv/bin/activate
pip install fastapi uvicorn[standard] pydantic
pip install -D pytest pytest-asyncio httpx ruff mypy
```

#### Go + Chi
```bash
go mod init github.com/<owner>/<project-name>
go get github.com/go-chi/chi/v5
go get github.com/go-chi/cors
```

#### Rust + Axum
```bash
cargo init .
cargo add axum tokio --features tokio/full
cargo add serde --features derive
cargo add tower-http --features cors
```

### Step 5: Create Standard Files

Every project gets these files regardless of stack:

#### `.github/ISSUE_TEMPLATE/1-epic.yml`
Create from the epic template (see epic-planner skill).

#### `.github/ISSUE_TEMPLATE/2-feature.yml`
Create from the feature template.

#### `.github/ISSUE_TEMPLATE/3-bug.yml`
Create from the bug template.

#### `.github/PULL_REQUEST_TEMPLATE.md`
Standard PR template with checklist.

#### `docs/ARCHITECTURE.md`
Initial architecture document (living document — maintained by Code Issue agent).

#### `docs/USER_GUIDE.md`
Initial user guide (living document — maintained by Code Issue agent).

#### `.github/copilot-instructions.md`
Project-specific Copilot instructions covering everything an agent needs to work efficiently in this repo without excessive exploration. Generate it with high intent — this file is used by Copilot Chat, Copilot code review, and the Copilot coding agent on every request.

Generate content covering all of the following sections (keep total file under 2 pages / ~150 lines):

```markdown
# {Project Name} — Copilot Instructions

## Project Summary
{1-2 sentence description of what the app does and who it's for}

## Tech Stack
| Layer | Technology | Version |
|-------|-----------|---------|
| ...   | ...       | ...     |

## Build & Run Commands
<!-- Always run these before building — list exact commands in order -->
- Install: `{install command}`
- Build: `{build command}`
- Test: `{test command}`
- Test with coverage: `{coverage command}`
- Lint: `{lint command}`
- Run dev server: `{dev command}`

## Project Layout
{Key directories and their purpose — 6-10 lines max}
- `src/` — ...
- `tests/` — ...
- `.github/` — CI, agents, skills, instructions, prompts

## Architecture Overview
{2-4 sentences on how the system is structured — layers, services, data flow}

## Coding Conventions
- Language: {TypeScript/Python/Go/etc.} with {strict/standard} mode
- Style: {ESLint/Prettier/Black/gofmt config locations}
- Naming: {brief naming conventions}
- Testing: {framework, co-located vs. separate test directory, coverage threshold}
- Error handling: {pattern used in the project}

## CI / Validation Pipeline
{List GitHub Actions jobs or other CI steps and what they check}

## Known Gotchas
{Optional — document any non-obvious setup steps, timing issues, or workarounds}

## Trust These Instructions
Rely on this file rather than exploring the codebase from scratch. Only search if this file is incomplete or appears out of date.
```

> **Note**: This file is a **living document** — the Code Issue agent updates it whenever architectural changes occur (new modules, changed commands, new conventions). See `.github/instructions/` for path-specific rules.

#### `README.md`
Project README with:
- Project description
- Tech stack
- Getting started instructions
- Development workflow
- Project structure

#### Standard config files
- `.gitignore` (appropriate for the stack)
- `.editorconfig`
- CI/CD workflow (`.github/workflows/ci.yml`)
- Linting and formatting configs

### Step 6: Initial Commit & Push

```bash
git add -A
git commit -m "chore: initial project scaffold

Tech stack: [summary]
Created by Code Planner agent"

git push -u origin main
```

### Step 7: Handoff

Present to the user:
- **Repository URL**: link to the new GitHub repo
- **Tech stack summary**: what was installed and why
- **Next steps**: "Ready to plan your epics and issues. Describe what you want to build."

Then transition to the **epic-planner** skill.

## Error Recovery

| Scenario | Action |
|----------|--------|
| GitHub repo creation fails | Check auth, suggest manual creation, retry |
| Scaffold command fails | Fall back to manual file creation |
| Context7 unavailable | Use web research and known best practices |
| User rejects recommendation | Re-interview with more specific questions |
| Package install fails | Check Node/Python/Go/Rust version, suggest fixes |

## Tips

- Always confirm the tech stack with the user before scaffolding
- Use `--use-npm` for Node.js projects to avoid lockfile confusion
- Create the remote repo before local init to avoid push conflicts
- Include a comprehensive `.gitignore` from the start
- The `docs/` folder is created here but maintained by the Code Issue agent
