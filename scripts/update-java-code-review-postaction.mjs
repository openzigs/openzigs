// Update the java-code-review-daily prompt to use a single stage with postAction
// instead of a 2-stage pipeline with LLM-based issue creation (which hallucinates).

const PROMPT_ID = "2b7e4a42-38c0-4bc5-83e1-7a2729aa8baf";
const BASE_URL = "http://localhost:3001/api/admin";

// Single stage: LLM reviews code, then postAction creates GitHub issues deterministically
const stages = [
  {
    name: "clone-review",
    prompt: `You are an automated Java code review pipeline.

IMPORTANT: Do NOT use the task tool. Perform ALL steps yourself directly.

## Step 1: Clone or Pull Repository
Use shell-execute to update the repo:
- If /Users/matthewcronin/Development/DictionarySample does NOT exist, run command "git" with args ["clone", "https://github.com/mgcronin/DictionarySample", "/Users/matthewcronin/Development/DictionarySample"]
- If it already exists, run command "git" with args ["-C", "/Users/matthewcronin/Development/DictionarySample", "pull"]

## Step 2: Discover and Read Java Files
Use shell-execute to find all Java files. Run command "find" with args ["/Users/matthewcronin/Development/DictionarySample", "-name", "*.java", "-not", "-path", "*/.git/*"].
Then use read-file to read EVERY Java file found.

## Step 3: Perform Code Review
For each Java file, perform a thorough review checking for:
- SOLID principle violations
- Null safety / potential NullPointerExceptions
- Missing or insufficient error handling
- Inefficient algorithms (O(n^2) or worse)
- Thread safety and concurrency problems
- Hardcoded values that should be configurable
- Missing input validation
- Poor naming conventions
- Missing or misleading Javadoc
- Security vulnerabilities (SQL injection, XSS, insecure deserialization)
- Unused imports and dead code

Severity rubric (be consistent):
- Critical: crashes/data loss or clear security exploit
- High: user-facing breakage, unsafe defaults, or config/secrets issues
- Medium: correctness/robustness issues that likely bite later
- Low: style/docs/naming/tests

Your final output MUST be a structured review report listing ALL findings in EXACTLY this format:

### Findings

1. **[SEVERITY]** File: path/to/File.java Line: N
   Description: ...
   Recommendation: ...

Include a summary at the end with total files reviewed and count by severity.`,
    tools: ["shell-execute", "read-file"],
    autoApproveTools: ["shell-execute", "read-file"],
    timeoutSeconds: 1200,
    postAction: {
      type: "create-github-issues",
      config: {
        owner: "mgcronin",
        repo: "DictionarySample",
        labels: ["code-review", "automated"],
        minSeverity: "medium",
        maxIssues: 8,
      },
    },
  },
];

async function main() {
  const resp = await fetch(`${BASE_URL}/prompts/${PROMPT_ID}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stages }),
  });

  if (!resp.ok) {
    console.error("Failed:", resp.status, await resp.text());
    process.exit(1);
  }

  const data = await resp.json();
  console.log("Updated prompt with postAction:", JSON.stringify(data, null, 2).slice(0, 300));
}

main().catch(console.error);
