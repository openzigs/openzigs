# Contributing to OpenZigs

Thank you for your interest in contributing to OpenZigs! This document provides guidelines and steps for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Optional: graphify knowledge graph](#optional-graphify-knowledge-graph)
- [Branching Strategy](#branching-strategy)
- [Changelog](#changelog)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Commit Messages](#commit-messages)
- [Reporting Bugs](#reporting-bugs)
- [Feature Requests](#feature-requests)

## Code of Conduct

This project adheres to a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to the maintainers.

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally
3. Set up the development environment (see below)
4. Create a branch for your changes
5. Make your changes and test them
6. Submit a pull request

## Development Setup

### Prerequisites

- **Node.js** 22+
- **pnpm** 10+
- **Docker Desktop** (for container-based features)
- **Python 3.10+** (for AI sidecars)

### Installation

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/openzigs.git
cd openzigs

# Install dependencies
pnpm install

# Start development server
pnpm dev

# In a separate terminal, start the UI
cd ui && pnpm dev
```

### Environment Setup

Copy `.env.example` to `.env` and configure the required values:

```bash
cp .env.example .env
```

## Optional: graphify knowledge graph

[graphify](https://github.com/safishamsi/graphify) is an opt-in developer tool that builds a precomputed knowledge graph of the codebase. When the graph exists at `graphify-out/`, our Copilot subagents (orchestrator, code-issue, code-review, research-gather) consult it before doing wide grep / file-search sweeps. This typically saves **a large amount of premium-request tokens** when working with the AI on this repo.

**Install (one-time):**

| Platform | Command |
|----------|---------|
| Mac / Linux (recommended) | `uv tool install graphifyy` |
| Mac / Linux (alternative) | `pipx install graphifyy` |
| Windows | `pip install graphifyy` (then ensure `%APPDATA%\Python\Python3X\Scripts` is on `PATH`) |

Note the PyPI package name is `graphifyy` (double **y**); the CLI binary is `graphify`.

**Build the graph (one-time, then refresh on demand):**

```bash
graphify .
```

This produces:
- `graphify-out/graph.json` — the queryable graph (commit this; teammates benefit)
- `graphify-out/GRAPH_REPORT.md` — human-readable codebase overview (commit this)
- `graphify-out/graph.html` — interactive graph viewer (commit this)
- `graphify-out/cache/`, `manifest.json`, `cost.json` — per-developer state (gitignored)

**Auto-refresh on commit / branch switch (optional):**

```bash
graphify hook install
```

Installs `post-commit` and `post-checkout` git hooks that re-run `graphify .` so the graph never goes stale.

**VS Code Copilot Chat first-class support:**

```bash
graphify vscode install
```

This writes a snippet into `.github/copilot-instructions.md` (already done in this repo) so VS Code Copilot Chat consults the graph automatically every session.

**Query the graph manually** (useful when you're navigating unfamiliar code):

```bash
graphify query "task engine worker recursion" graphify-out/graph.json   # token-bounded subgraph for a topic
graphify path src/server.ts src/api/admin.ts                           # show dependency reach between two files
```

**What is excluded from the graph:** see [.graphifyignore](.graphifyignore) at the repo root — it skips `node_modules/`, `.next/`, `dist/`, `external/`, sidecar Python venvs, generated files, and ML model checkpoints.

**Privacy note:** code is parsed locally via tree-sitter (no API calls). Only documentation, papers, and images (none in this repo by default) would be sent to a model API. See the upstream [graphify README](https://github.com/safishamsi/graphify#privacy) for details.

## Branching Strategy

This project uses **GitHub Flow** — the standard for open-source projects:

- `main` is the **only permanent branch** and is always in a releasable state
- All work (features, fixes, docs) is done on **short-lived branches** off `main`
- Branches are merged back to `main` via a reviewed pull request and then deleted
- Versions are tagged directly on `main` commits (e.g., `v0.2.0`) — there are no separate `develop` or `release` branches

**Branch naming:**
```
feature/short-description      # new features
fix/issue-123-short-description # bug fixes
docs/update-readme              # documentation
chore/dependency-updates        # maintenance
```

> **Why not Gitflow?** Gitflow (with develop/release branches) is designed for scheduled enterprise releases. GitHub Flow is simpler and works better for continuous-delivery open-source projects where changes ship frequently.

## Changelog

Every PR with user-facing changes **must** add an entry to the `## [Unreleased]` section of [CHANGELOG.md](CHANGELOG.md) using the appropriate sub-heading:

- `### Added` — new features
- `### Changed` — changes to existing behavior
- `### Fixed` — bug fixes
- `### Removed` — removed features
- `### Security` — security fixes

**Do not bump the version number in `package.json`** on every PR. Versions are incremented only when a tagged release is cut (e.g., `git tag v0.2.0`), at which point the `[Unreleased]` section is promoted to a versioned entry.

## Pull Request Process

1. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** following our coding standards

3. **Run the quality gate** before committing:
   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test
   cd ui && npx next build  # if touching UI files
   ```

4. **Commit your changes** with a descriptive commit message

5. **Push to your fork** and create a pull request

6. **Respond to feedback** from maintainers

### PR Requirements

- All tests must pass
- No linting errors
- TypeScript type checking must pass
- UI changes require `next build` to succeed
- Include tests for new functionality
- Update documentation as needed

## Coding Standards

### TypeScript

- ESM TypeScript only (package `type: module`)
- Use explicit `.js` extensions in imports
- Follow existing code patterns and conventions
- Use Zod for runtime validation

### Code Style

- Use `pnpm lint` for code style enforcement
- Use `pnpm format` for automatic formatting
- Keep functions focused and reasonably sized
- Write self-documenting code with clear variable names

### File Organization

- Tests live next to source files (`*.test.ts`)
- Use barrel exports (`index.ts`) sparingly
- Follow the existing directory structure

## Testing

### Running Tests

```bash
# Run all tests
pnpm test

# Run specific test file
pnpm test src/path/to/file.test.ts

# Run UI tests
cd ui && pnpm test
```

### Writing Tests

- Use Vitest for backend tests
- Use React Testing Library for UI tests
- Mock time-dependent code with injectable `clock?: () => Date`
- Use in-memory SQLite for database tests

### Test Conventions

```typescript
// Time-dependent tests
const now = new Date("2026-02-09T12:00:00Z");

// SQLite in-memory tests
const db = new Database(":memory:");
```

## Commit Messages

Follow conventional commit format:

```
type(scope): description

[optional body]

[optional footer]
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

### Examples

```
feat(tasks): add parallel task execution support

fix(auth): resolve token refresh race condition

docs(readme): update installation instructions
```

## Reporting Bugs

When reporting bugs, please include:

1. **Description**: Clear description of the issue
2. **Steps to Reproduce**: Detailed steps to reproduce the behavior
3. **Expected Behavior**: What you expected to happen
4. **Actual Behavior**: What actually happened
5. **Environment**: OS, Node.js version, browser (if applicable)
6. **Logs**: Relevant error messages or logs

Use the GitHub issue tracker to report bugs.

## Feature Requests

Feature requests are welcome! Please:

1. Check existing issues to avoid duplicates
2. Describe the feature and its use case
3. Explain why this feature would be valuable
4. Consider implementation complexity

## Questions?

If you have questions about contributing, feel free to:

- Open a discussion on GitHub
- Check existing issues and discussions
- Review the documentation in `/docs`

Thank you for contributing to OpenZigs!
