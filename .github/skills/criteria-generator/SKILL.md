---
name: criteria-generator
description: "Converts ingested requirements into structured Given/When/Then acceptance criteria using RAG-powered LLM generation. Auto-tags criteria, assigns confidence scores, and maintains traceability links."
argument-hint: "[app ID or functional area] — generate acceptance criteria for an app or specific area"
---

# Criteria Generator

## Purpose

This skill drives the acceptance criteria generation phase of the Test Orchestrator workflow. It retrieves requirement chunks from the knowledge base, builds constrained LLM prompts, parses structured criteria output, and saves the results with full traceability back to source requirements.

## When to Use

- After requirements have been ingested into the knowledge base (Phase 1 complete)
- The user asks to "generate criteria", "create acceptance criteria", or "convert requirements to test criteria"
- During Phase 2 of the Test Orchestrator workflow
- When new requirements are added and existing criteria need to be expanded

## Agent

Execute with the **Test Orchestrator** agent (`test-orchestrator.agent.md`), which has access to Talos MCP tools and LLM capabilities.

## Required MCP Tools

| Tool | Purpose |
|------|---------|
| `talos_generate_criteria` | AI-powered bulk criteria generation from knowledge base |
| `talos_create_criteria` | Save individual criteria to the repository |
| `talos_list_criteria` | List existing criteria to avoid duplicates |
| `talos_get_traceability` | Verify traceability after generation |

## Workflow

### Step 1: Retrieve Requirement Chunks from Knowledge Base

1. **Scope the retrieval** — Determine which requirements to process:
   - By `docType`: filter to `requirement`, `user_story`, `prd`, `api_spec`
   - By `tags`: filter to specific functional areas if generating incrementally
   - By `persona`: filter to specific user roles if generating role-specific criteria

2. **Retrieve chunks** — Use the knowledge base's hybrid search to pull relevant requirement chunks. For each chunk, capture:
   - Chunk ID and content
   - Source document metadata (`docId`, `sourceVersion`, `docType`)
   - Auto-generated tags from the `AutoTagger`
   - Confidence score from ingestion

3. **Group by functional area** — Organize chunks into logical groups:
   - Authentication & Authorization
   - Core workflows (by feature)
   - Data management (CRUD operations)
   - Integration points (API contracts)
   - Non-functional requirements (by NFR type)

4. **Check for existing criteria** — Call `talos_list_criteria` to see what already exists. Skip requirements that already have linked criteria unless the user explicitly requests regeneration.

### Step 2: Build Constrained LLM Prompts

For each requirement chunk (or group of related chunks), construct a prompt with strict constraints:

#### System Prompt
```
You are a Senior QA Engineer with 10+ years of experience writing acceptance criteria for complex web applications. Your criteria are precise, testable, and unambiguous.

Rules:
- Use ONLY the provided requirement context. Do not invent requirements.
- State unknowns explicitly — if the requirement is ambiguous, flag it.
- Every scenario must be independently testable.
- Use concrete values in examples, not placeholders like "valid data".
- Include negative scenarios (error paths) for every happy path.
- Tag criteria with controlled vocabulary terms.
```

#### User Prompt
```
Generate acceptance criteria for the following requirement:

**Requirement**: {chunk.content}
**Source**: {chunk.docId} (v{chunk.sourceVersion})
**Document Type**: {chunk.docType}
**Tags**: {chunk.tags.join(', ')}
**Application Context**: {app.description}

Output a JSON object with this structure:
{
  "scenarios": [
    {
      "title": "Short descriptive title",
      "given": "Initial state / precondition",
      "when": "Action performed by the user or system",
      "then": "Expected observable outcome",
      "priority": "P0 | P1 | P2 | P3",
      "testType": "e2e | smoke | regression | accessibility | api"
    }
  ],
  "preconditions": ["Global preconditions that apply to all scenarios"],
  "dataRequirements": ["Specific test data needed"],
  "nfrTags": ["performance", "accessibility", "security"],
  "confidence": 0.85,
  "unknowns": ["Any ambiguities or missing information"]
}
```

#### Few-Shot Examples

Include these examples to anchor the LLM's output format:

**Example 1 — Login Flow**
```json
{
  "scenarios": [
    {
      "title": "Successful login with valid credentials",
      "given": "The user is on the login page and has a registered account",
      "when": "The user enters 'alice@example.com' and 'Str0ng!Pass' and clicks 'Sign In'",
      "then": "The user is redirected to the dashboard and sees a welcome message with their display name",
      "priority": "P0",
      "testType": "e2e"
    },
    {
      "title": "Login rejected with incorrect password",
      "given": "The user is on the login page and has a registered account",
      "when": "The user enters 'alice@example.com' and 'wrong-password' and clicks 'Sign In'",
      "then": "An error message 'Invalid email or password' is displayed and the user remains on the login page",
      "priority": "P0",
      "testType": "e2e"
    },
    {
      "title": "Login form prevents submission with empty fields",
      "given": "The user is on the login page",
      "when": "The user clicks 'Sign In' without entering any credentials",
      "then": "Validation messages appear for both email and password fields and no API request is made",
      "priority": "P1",
      "testType": "e2e"
    }
  ],
  "preconditions": ["Application is deployed and accessible", "Test user accounts exist in the database"],
  "dataRequirements": ["Valid user: alice@example.com / Str0ng!Pass", "No account exists for unknown@example.com"],
  "nfrTags": ["security"],
  "confidence": 0.95,
  "unknowns": []
}
```

**Example 2 — Data Export**
```json
{
  "scenarios": [
    {
      "title": "Export test results as CSV",
      "given": "The user is on the results page with at least 5 completed test runs",
      "when": "The user clicks 'Export' and selects 'CSV' format",
      "then": "A CSV file is downloaded containing all visible test run rows with columns: name, status, duration, date",
      "priority": "P1",
      "testType": "e2e"
    },
    {
      "title": "Export disabled when no results exist",
      "given": "The user is on the results page with zero completed test runs",
      "when": "The user views the export button",
      "then": "The 'Export' button is disabled with a tooltip 'No results to export'",
      "priority": "P2",
      "testType": "e2e"
    }
  ],
  "preconditions": ["User is authenticated with at least 'viewer' role"],
  "dataRequirements": ["Test runs with varying statuses: passed, failed, skipped"],
  "nfrTags": [],
  "confidence": 0.80,
  "unknowns": ["Maximum export size limit not specified in requirements"]
}
```

### Step 3: Parse and Validate LLM Response

1. **Parse JSON** — Extract the structured response. If the LLM returns malformed JSON:
   - Attempt to fix common issues (trailing commas, unescaped quotes)
   - If unfixable, re-prompt with explicit JSON formatting instructions
   - After 2 retries, flag the requirement as needing manual criteria

2. **Validate structure** — Ensure every scenario has:
   - Non-empty `title`, `given`, `when`, `then` fields
   - Valid `priority` value (P0–P3)
   - Valid `testType` value
   - `confidence` between 0.0 and 1.0

3. **Validate content quality**:
   - `given` describes a concrete, achievable state (not vague like "user is ready")
   - `when` describes a single, atomic action (not a multi-step process)
   - `then` describes an observable, verifiable outcome (not "system works correctly")
   - Negative scenarios exist for at least 50% of happy-path scenarios

### Step 4: Auto-Tag Criteria

Apply tags from the controlled vocabulary:

#### Persona Tags
- `admin`, `standard-user`, `read-only`, `anonymous`, `api-client`

#### NFR Tags
- `performance`, `accessibility`, `security`, `reliability`, `scalability`, `usability`

#### Environment Tags
- `chromium`, `firefox`, `webkit`, `mobile`, `desktop`, `ci`

#### Functional Area Tags
- `auth`, `dashboard`, `settings`, `data-management`, `reporting`, `export`, `search`, `navigation`, `notifications`

**Tagging rules**:
- Extract persona from the `given` clause (e.g., "admin user is logged in" → `admin`)
- Extract NFR tags from `nfrTags` array in the LLM response
- Infer functional area from the requirement's source tags and content keywords
- Always include at least one persona tag and one functional area tag

### Step 5: Assign Confidence Scores

Calculate a final confidence score for each criterion based on:

| Factor | Weight | Scoring |
|--------|--------|---------|
| LLM self-reported confidence | 0.3 | Direct from response |
| Requirement clarity | 0.3 | High if requirement is specific, low if vague |
| Scenario completeness | 0.2 | Higher if negative paths included |
| Tag coverage | 0.1 | Higher if persona + area + NFR tags all present |
| Source document reliability | 0.1 | Higher for formal specs, lower for informal notes |

**Final confidence** = weighted sum, clamped to [0.0, 1.0].

**Confidence thresholds**:
- **≥ 0.8**: Auto-approve — criterion is ready for test generation
- **0.6 – 0.79**: Flag for review — present to user with suggested edits
- **< 0.6**: Manual required — requirement too vague for reliable criteria

### Step 6: Save Criteria to Repository

For each validated criterion, call `talos_create_criteria` with:

```json
{
  "appId": "{app-id}",
  "title": "{scenario.title}",
  "given": "{scenario.given}",
  "when": "{scenario.when}",
  "then": "{scenario.then}",
  "priority": "{scenario.priority}",
  "testType": "{scenario.testType}",
  "tags": ["{persona}", "{area}", "{nfr}"],
  "confidence": 0.85,
  "sourceChunkId": "{chunk.id}",
  "status": "approved"  // or "draft" if confidence < 0.8
}
```

### Step 7: Update Traceability Links

1. **Verify links** — Call `talos_get_traceability` to confirm:
   - Every saved criterion links back to its source requirement chunk
   - No orphan criteria exist (criteria with no source requirement)

2. **Report gaps** — Identify:
   - Requirements that still have no criteria (unmapped)
   - Criteria with broken traceability links
   - Functional areas with disproportionately low criteria count

### Step 8: Output Summary

Produce the generation summary:

```markdown
## Criteria Generation Summary

### Overview
- Requirements processed: {count}
- Criteria generated: {count}
- Average confidence: {score}
- Auto-approved (≥0.8): {count}
- Flagged for review (0.6–0.79): {count}
- Manual required (<0.6): {count}

### By Functional Area
| Area | Requirements | Criteria | Avg Confidence |
|------|-------------|----------|----------------|
| Authentication | 5 | 12 | 0.91 |
| Dashboard | 3 | 8 | 0.78 |
| ... | ... | ... | ... |

### Coverage Impact
- Before: {old_coverage}% requirements with criteria
- After: {new_coverage}% requirements with criteria
- Delta: +{delta}%

### Action Items
- [ ] Review {N} flagged criteria (confidence 0.6–0.79)
- [ ] Manually write criteria for {M} vague requirements
- [ ] {Any other items}
```

## Notes

- This skill generates **criteria**, not tests. Test generation is a separate phase.
- Re-run this skill when new requirements are ingested to generate incremental criteria.
- The few-shot examples anchor the LLM's output format — adjust them if the application domain differs significantly from web applications.
- Confidence scores are heuristic. When in doubt, flag for human review rather than auto-approving.
