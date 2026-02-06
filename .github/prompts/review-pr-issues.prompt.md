#context7 #github

**Act as a Senior Automated Code Reviewer.**

I need you to process the review comments for Pull Request #{{PR_NUMBER}}.
Please follow this strict step-by-step workflow:

**Phase 1: Analysis**
1.  **Fetch Comments:** Use the #github tool to retrieve the latest review comments and file changes for PR #{{PR_NUMBER}}.
2.  **Evaluate:** For each unresolved comment:
    * Analyze the code context referenced in the comment.
    * Compare the code against the best practices and API patterns defined in #context7.
    * Determine if the comment is technically valid. (If a comment is subjective or incorrect based on #context7, skip it and note why).

**Phase 2: Execution (For valid comments only)**
1.  **Apply Fixes:** Update the local files to address the issues. Ensure your fixes align with the library usage in #context7.
2.  **Commit & Push:**
    * Create a single commit with the message: "fix: address review comments from PR #{{PR_NUMBER}}"
    * Push the changes to the current branch.
3.  **Resolve:**
    * Use the @github tool to reply to the specific comment threads saying "Fixed in [commit_hash]."
    * Mark the conversation/thread as resolved if the tool allows.

**Constraints:**
* Do not hallucinate changes; only fix exactly what was requested in the comments.
* If you cannot resolve a comment (e.g., it requires clarification), output a question for me instead of changing code.