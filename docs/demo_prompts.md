## <u>How to prompt to create an Epic and Issues</u>

<u>Act as a Principal Product Architect. We are defining the \*\*"UX 2.0: Advanced Workflow Builder"\*\* initiative.</u>

<u>\*\*The Goal:\*\*</u>

<u>1.  \*\*Visual Builder:\*\* Create a DAG-based UI for building complex pipelines.</u>

<u>2.  \*\*Global Autonomy:\*\* Add Global Tool Approval toggles to the Admin UI. \*\*Crucially\*\*, this must allow users to force approval even for "Always On" tools (like \`read-file\`) that are currently hardcoded to skip checks.</u>

<u>3.  \*\*Automatic Decomposition:\*\* Investigate "Magic Wand" auto-planning.</u>

<u>I need you to use #context7 for library and api support  then analyze the codebase and then use #github to create the Epic and 6 Feature Issues.</u>

<u>### Phase 1: Investigation (Use #context7)</u>

<u>1.  \*\*Analyze Fan-Out Logic:\*\*</u>

<u>    \* Inspect \`src/mcp/tools/agent-tools.ts\` (\`orchestrate\_agents\`).</u>

<u>    \* \*Question:\* How can we replicate the \`Promise.all\` logic in \`executePipeline\`?</u>

<u>2.  \*\*Analyze Pipeline Schema:\*\*</u>

<u>    \* Inspect \`src/lib/types.ts\`.</u>

<u>    \* \*Proposed Schema:\* \`type PipelineStage \= { type: 'prompt' ... } | { type: 'parallel'; stages: PipelineStage\[] ... }\`</u>

<u>3.  \*\*Analyze Approval & Always-On Logic:\*\*</u>

<u>    \* Inspect \`src/copilot/hooks.ts\` and \`src/mcp/constants.ts\`.</u>

<u>    \* \*Critical Check:\* Currently, \`ALWAYS\_ON\_TOOLS\` (like \`read-file\`) likely bypass the approval queue entirely. We need to refactor this so the "Global Approval" setting takes precedence over the "Always On" whitelist.</u>

<u>### Phase 2: Create Project Artifacts (Use #github)</u>

<u>\*\*1. Epic:\*\*</u>

<u>\* \*\*Title:\*\* "UX 2.0: Advanced Workflow Builder (DAG & Auto-Planning)"</u>

<u>\* \*\*Body:\*\* Implement a DAG-based Workflow Builder and a robust Global Approval system that gives users final say over \*every\* tool, including defaults.</u>

<u>\*\*2. Issue A: "Feat: Visual Pipeline Editor (Canvas UI)"\*\*</u>

<u>\* \*\*Body:\*\*</u>

<u>    \* Create \`ui/components/pipeline/pipeline-editor.tsx\`.</u>

<u>    \* \*\*UI Pattern:\*\* Tree/Node-based layout.</u>

<u>    \* \*\*Stage Types:\*\* "Prompt Node" and "Parallel Group Node".</u>

<u>    \* \*\*Features:\*\* Model Selector, Tool Multi-Select, Auto-Approve Multi-Select.</u>

<u>\*\*3. Issue B: "Feat: Workflow Wizard with 'Magic Wand'"\*\*</u>

<u>\* \*\*Body:\*\*</u>

<u>    \* \*\*Step 1:\*\* Define Goal.</u>

<u>    \* \*\*Step 2:\*\* \*\*"Auto-Plan" Button:\*\* Calls backend to generate \`PipelineDefinition\`.</u>

<u>    \* \*\*Step 3:\*\* Editor (Issue A) pre-filled with plan.</u>

<u>    \* \*\*Step 4:\*\* Dry Run & Save.</u>

<u>\*\*4. Issue C: "Backend: Recursive Execution & Validation"\*\*</u>

<u>\* \*\*Body:\*\*</u>

<u>    \* Update \`src/tasks/task-worker.ts\` -> \`executePipeline\`.</u>

<u>    \* Handle \`type: 'parallel'\` nodes using \`Promise.all\`.</u>

<u>    \* Wait for all parallel branches to finish before proceeding.</u>

<u>\*\*5. Issue D: "Refactor: Scheduler & Tool Integration"\*\*</u>

<u>\* \*\*Body:\*\*</u>

<u>    \* Update \`ui/app/scheduler/page.tsx\` to support nested pipelines.</u>

<u>    \* Ensure "Global Job Override" applies recursively to sub-tasks.</u>

<u>\*\*6. Issue E: "Feat: Global Approval Toggles & Always-On Override"\*\*</u>

<u>\* \*\*Body:\*\*</u>

<u>    \* \*\*Frontend:\*\* Add "Require Approval" lock icon to \*all\* Admin Tool Cards (even "Low Risk" ones).</u>

<u>    \* \*\*Backend:\*\*</u>

<u>        \* Update \`config/tools.json\` persistence.</u>

<u>        \* \*\*Refactor Hook Logic:\*\* In \`src/copilot/hooks.ts\`, move the \`GlobalApprovalRequired\` check \*before\* the \`isAlwaysOn\` or \`RiskLevel\=Low\` checks.</u>

<u>        \* \*\*New Priority:\*\* \`if (tool.globalApprovalRequired) return 'ask';\` -> \`if (job.autoApprove.includes(tool)) return 'allow';\` -> \`if (risk \=\= Low) return 'allow';\`.</u>

<u>    \* \*\*Goal:\*\* A user must be able to force \`read-file\` to require approval globally if they want strict security.</u>

<u>\*\*7. Issue F: "Investigation: The 'Auto-Pipeline' Planner Agent"\*\*</u>

<u>\* \*\*Body:\*\*</u>

<u>    \* Create a specialized agent (using \`o4-mini\`) to accept a goal and return a valid \`PipelineDefinition\` JSON.</u>

<u>    \* Deliverable: System Prompt and Zod Schema.</u>

## <u>Prompt to code an Epic</u>

/code-issue Code epic 163 and all sub issues. Code all until finished without asking to continue. Use #context7 for api and library assistance. Ensure all tests and lint is proper before creating PR. Update #file:USER\_GUIDE.md  and #file:ARCHITECTURE.md&#x20;

## <u>Review PR and resolve issues</u>

<u>/review-pr-issues 170</u>

## <u>Demo</u>

```

Compare the pricing of AWS, GCP, and Azure for a 3-node medium sized Kubernetes cluster.
Use orchestrate-agents to research all three in parallel, save to file in ./tmp/report.md notify me when finished. 
```



use browser-navigate to [https://www.nyiso.com.](https://www.nyiso.com.) Explore the site.  Find me information on the leadership team. Once you have the information perform a web-search on the individuals and provide your thoughts.