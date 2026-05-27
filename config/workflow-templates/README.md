# Starter Workflow Templates

These `.openzigs-template.json` files ship with OpenZigs and can be imported
into the Workflow Builder at `/workflows` via the **Import** button.

Each file matches the schema validated by
`ui/app/workflows/parse-template.ts`:

```jsonc
{
  "name": "string (required)",
  "description": "string (optional)",
  "stages": [ /* basic prompt stages, optional */ ],
  "graphLayout": {
    "nodes": [ /* @xyflow/react nodes */ ],
    "edges": [ /* @xyflow/react edges */ ],
    "viewport": { "x": 0, "y": 0, "zoom": 1 }
  }
}
```

## Templates

| File | Use case |
| --- | --- |
| `director-storyboard.openzigs-template.json` | Generate a Director storyboard from a single prompt. |
| `social-cross-post.openzigs-template.json` | Compose one message and adapt it for Twitter, LinkedIn, Reddit in parallel. |
| `seo-audit.openzigs-template.json` | Audit a target URL: extract keywords, analyse competitors, draft action items. |
| `content-repurposing.openzigs-template.json` | Turn a long-form article into thread + short video script + email. |
| `lead-nurture.openzigs-template.json` | Draft a 3-step nurture sequence for a captured lead. |

## Adding a new template

1. Build the workflow in `/workflows`.
2. Click **Export** — that produces a valid `.openzigs-template.json`.
3. Drop it in this folder and add an entry to the table above.
