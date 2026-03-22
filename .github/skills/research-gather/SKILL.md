---
name: research-gather
description: "Gathers research material from multiple sources: local files (DOCX/PDF/XLSX/PPTX), web pages, and library documentation via Context7. Converts everything to Markdown for analysis. Use before epic planning to build a rich requirements base."
argument-hint: "[topic or path] — describe what to research or provide a local directory path"
---

# Research Gather

## Purpose

This skill collects and converts research material from multiple sources into Markdown for use by the **Code Planner** and **Epic Planner** workflows. It bridges the gap between raw requirements data (local files, web content, library docs) and structured GitHub issues.

## When to Use

- Before epic planning, to gather requirements and context
- The user has local documents (Word, PDF, Excel, PowerPoint) to analyze
- The user provides web URLs with reference material, specs, or designs
- The user says "research", "gather requirements", "pull in docs", or "analyze documents"

## Required MCP Tools

| Tool | Purpose |
|------|---------|
| `mcp_tavily_tavily_search` | Web search — search queries against the live web (preferred for discovery) |
| `mcp_tavily_tavily_extract` | Extract structured content from specific URLs |
| `fetch_webpage` | Fetch a specific URL when Tavily is unavailable |
| `mcp_context7_resolve-library-id` | Resolve library IDs |
| `mcp_context7_query-docs` | Fetch framework/library documentation |

## Workflow

### Step 1: Ask the User About Sources

Present this menu:

> **Where should I gather research material from?** (Choose all that apply)
>
> 1. � **Local directory** — Read documents from a folder on disk (DOCX, PDF, XLSX, PPTX → Markdown)
> 2. 🌐 **Web URLs** — Fetch content from web pages you provide
> 3. 📚 **Library docs** — Look up framework/library documentation via Context7
>
> *Provide paths, URLs, or search terms for each source you'd like to use.*

### Step 2: Local Documents (if selected)

#### 2a. Get the Path
Ask the user for the directory or file path:
> *"What is the path to your local documents?"*

#### 2b. Read and Analyze
- Read the documents in the specified directory
- Extract requirements, business rules, data models, and specifications
- Note the source file for each finding

### Step 3: Web Research (if selected)

#### 3a. Get URLs
Ask the user for URLs, or infer from the project context:
> *"What URLs should I fetch? (documentation, design specs, API references, etc.)"*

#### 3b. Fetch and Parse
```
mcp_tavily_tavily_search → for open-ended queries where you need to discover the right sources
mcp_tavily_tavily_extract → to extract structured content from a specific URL
fetch_webpage → fallback when Tavily is unavailable
```

#### 3c. Extract Insights
- Summarize relevant content
- Extract patterns, best practices, and technical requirements
- Note URLs for citation in epic bodies

### Step 4: Library Documentation (if selected)

#### 4a. Identify Libraries
From the project tech stack and user description, identify key libraries to research.

#### 4b. Resolve and Query
```
mcp_context7_resolve-library-id → for each library
mcp_context7_query-docs → for specific patterns, setup, and best practices
```

### Step 5: Compile Research Summary

Produce a structured research summary that the epic-planner skill can consume:

```markdown
## Research Summary

### Sources Consulted
| Source | Type | Key Findings |
|--------|------|-------------|
| {document/URL name} | Local/Web/Docs | {1-line summary} |

### Requirements Extracted
#### Functional Requirements
1. {FR-001}: {description} *(Source: {document})*
2. {FR-002}: {description} *(Source: {document})*

#### Non-Functional Requirements
1. {NFR-001}: {description} *(Source: {document})*

#### Business Rules
1. {BR-001}: {description} *(Source: {document})*

### Data Model Insights
{Any schema, entity relationships, or data structures identified}

### Integration Points
{External systems, APIs, or services identified}

### User Roles & Permissions
{User types and their access levels}

### Open Questions
1. {Question needing user clarification}
2. {Ambiguity found in documents}

### Constraints & Assumptions
- {Constraint or assumption identified during research}
```

Present the summary to the user and ask:
> *"Here's what I found. Are there any corrections, additions, or questions you'd like me to address before I start planning the epics?"*

### Step 6: Handoff to Epic Planner

Pass the research summary to the epic-planner skill as context for issue creation.

## Error Recovery

| Scenario | Action |
|----------|--------|
| Local path doesn't exist | Ask user to verify the path |
| File conversion fails | Log error, skip file, continue with others |
| Web fetch fails | Note URL as inaccessible, continue with other sources |
| Context7 unavailable | Skip library docs, use Tavily or web research as fallback |

## Tips

- For large document sets, prioritize the most recent and most relevant
- Cross-reference findings across multiple sources for accuracy
- Flag contradictions between documents for user resolution
- Keep the research summary concise — detail goes into the individual epic/issue bodies
