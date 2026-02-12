const PROMPT_ID = "2b7e4a42-38c0-4bc5-83e1-7a2729aa8baf";
const BASE = "http://localhost:3001";

const stage2Prompt = `You are stage 2 of the java-code-review-daily pipeline.
The stage 1 review report is provided as context.

HARD RULES:
- Do NOT use the task tool.
- You MUST create issues using tool calls.
- Do NOT claim an issue was created unless the tool returned success with an issue URL/number.
- If ANY github-create-issue call fails: STOP and output the exact error text.

Repository: mgcronin/DictionarySample
Labels to apply: ["code-review", "automated"]

## Step 1: Select findings
- Create issues for MEDIUM, HIGH, CRITICAL findings only (skip LOW).
- Max 8 issues per run.

## Step 2: Create issues (REQUIRED tool calls)
For each selected finding:
1) (Optional) github-search-issues to avoid duplicates.
2) github-create-issue with owner, repo, title, body, labels.
3) Record returned issue number + URL.

## Step 3: Verify (REQUIRED tool call)
Call github-list-issues with:
- owner: "mgcronin"
- repo: "DictionarySample"
- state: "open"
- labels: "code-review,automated"

## Final output
Return ONLY valid JSON:
{
  "findings": {"critical": 0, "high": 0, "medium": 0, "low": 0},
  "issuesAttempted": 0,
  "issuesCreated": 0,
  "createdIssues": [{"number": 123, "url": "https://...", "title": "..."}],
  "verifyListCount": 0,
  "issuesLink": "https://github.com/mgcronin/DictionarySample/issues"
}

If issuesCreated is 0, createdIssues must be an empty array.`;

async function main() {
  const listRes = await fetch(`${BASE}/api/admin/prompts`);
  if (!listRes.ok) {
    throw new Error(`GET /api/admin/prompts failed: ${listRes.status} ${await listRes.text()}`);
  }
  const { prompts } = await listRes.json();
  const prompt = prompts.find((p) => p.id === PROMPT_ID);
  if (!prompt) {
    throw new Error(`Prompt not found: ${PROMPT_ID}`);
  }

  const stages = Array.isArray(prompt.stages) ? prompt.stages : [];
  const updatedStages = stages.map((s) => {
    if (s.name !== "report-issues") return s;
    return {
      ...s,
      prompt: stage2Prompt,
      tools: ["github-search-issues", "github-create-issue", "github-list-issues"],
      autoApproveTools: ["github-search-issues", "github-create-issue", "github-list-issues"],
      timeoutSeconds: s.timeoutSeconds ?? 300,
    };
  });

  const payload = {
    name: prompt.name,
    template: prompt.template,
    description: prompt.description,
    tags: prompt.tags,
    preferredTools: prompt.preferredTools,
    stages: updatedStages,
  };

  const putRes = await fetch(`${BASE}/api/admin/prompts/${PROMPT_ID}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!putRes.ok) {
    throw new Error(`PUT /api/admin/prompts/${PROMPT_ID} failed: ${putRes.status} ${await putRes.text()}`);
  }
  const updated = await putRes.json();
  const s2 = updated.stages?.find((s) => s.name === "report-issues");
  console.log(JSON.stringify({ ok: true, updatedAt: updated.updatedAt, tools: s2?.tools }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
