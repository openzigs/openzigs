#context7 #github

**Act as a Senior Automated Code Reviewer.**

I need you to process the review comments for Pull Request #{{PR_NUMBER}}.
Please follow this strict step-by-step workflow:

**Tooling Strategy:**
1.  **Primary:** Use the #github tool for reading data (fetching comments, diffs).
2.  **Secondary (Crucial):** If the #github tool cannot perform a specific action (like replying to a specific thread ID or marking a thread as "resolved"), you **MUST** use the terminal to execute `gh` CLI commands or `gh api` calls to achieve the result. Do not ask for permission; assume you have full `gh` CLI access.

**Phase 1: Analysis**
1.  **Fetch Comments:** Retrieve the latest review comments for PR #{{PR_NUMBER}}.
2.  **Evaluate:** For each unresolved comment:
    * Analyze the code context.
    * Compare against best practices in #context7.
    * Determine technical validity.

**Phase 2: Execution (For valid comments only)**
1.  **Apply Fixes:** Update local files to address the issues.
2.  **Commit & Push:**
    * Create a commit: "fix: address review comments from PR #{{PR_NUMBER}}"
    * Push to the current branch.
3.  **Resolve (Advanced):**
    * **Reply:** Use the terminal to reply to the specific comment ID.
      * *Hint:* `gh api POST /repos/:owner/:repo/pulls/comments/{comment_id}/replies -f body='Fixed in [commit_hash]'`
    * **Resolve:** If possible via API, mark the thread resolved.
      * *Hint:* Use `gh api graphql` with the `resolveReviewThread` mutation if you can identify the node ID.
    * **Fallback:** If identifying the thread ID is too complex, use `gh pr review {{PR_NUMBER}} --comment -b "All requested changes fixed in [commit_hash]"` to leave a summary review.

**Constraints:**
* Do not hallucinate changes; only fix exactly what was requested.
* If a comment requires human clarification, output a question for me instead of changing code.