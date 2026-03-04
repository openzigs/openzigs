# User Guide

## Prerequisites

Before you begin, ensure the following are installed and available:

| Requirement | Version | Purpose |
|---|---|---|
| **Node.js** | 22+ | Runtime for the agent server. |
| **pnpm** | 10+ | Package manager. |
| **Docker Desktop** | Latest | Runs the agent, Cloudflare Tunnel sidecar, and MCP server sidecars in containers. Required for the full stack. |
| **Docker Compose** | v2+ | Orchestrates multi-container deployments (bundled with Docker Desktop). |
| **GitHub Copilot Subscription** | Individual or Business | Required for SDK access. The agent authenticates via OAuth device flow using `@github/copilot-sdk`. |
| **Chrome** | Any recent version | Required only if you use the `browser-read` or `browser-navigate` tools. |

**Knowledge converter prerequisites (Local Knowledge Base):**

| Requirement | Purpose |
|---|---|
| **ffmpeg** | Required for media converter (`.mp4`, `.mp3`, etc.) to extract 16kHz WAV audio before transcription. |
| **ImageMagick** + **Ghostscript** | Required for scanned PDF OCR fallback (render PDF pages to images). |
| **Whisper model files** (`whisper-node`) | Required for the Node-side fallback media converter (when not using the local audio sidecar). Install with `pnpm exec whisper-node download`. |

**Optional API keys:**

| Key | Purpose |
|---|---|
| `BRAVE_API_KEY` | Enables the `web-search` tool (Brave Search API). |
| `TELEGRAM_BOT_TOKEN` | Connects the Telegram messaging channel. |
| `DISCORD_BOT_TOKEN` | Connects the Discord messaging channel. |
| `GITHUB_CLIENT_ID` | OAuth app client ID for the device-flow authentication. |
| `TUNNEL_TOKEN` | Cloudflare Tunnel token for the Docker sidecar (production). |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to Google Cloud service account JSON key file. Required for voice TTS. |
| `SOCIAL_WEBHOOK_VERIFY_TOKEN` | Verify token for Social Brain webhook subscriptions (Instagram, TikTok, etc.). |
| `INSTAGRAM_ACCESS_TOKEN` | Instagram User Access Token for post context lookup (captions, media type in comment automation). |

**Native MCP Server prerequisites (optional — only needed if using social, document, or personal assistant tools):**

| Requirement | Purpose |
|---|---|
| **Python 3.10+** | Social media MCP servers (Instagram, Facebook, Twitter, YouTube, LinkedIn, Reddit) and MarkItDown are Python-based. Each has its own virtualenv under `external/`. |
| **Java 17+ / JBang** | Required for the JDBC Database MCP server. [Install JBang](https://www.jbang.dev/download/). |
| **Platform API credentials** | Each social platform requires API credentials set as environment variables. See respective `README.md` in `external/`. |
| **Google Cloud OAuth credentials** | Required for Gmail MCP server. Create an OAuth app in Google Cloud Console. |
| **GitHub Personal Access Token** | Required for GitHub MCP server. Create at github.com/settings/tokens. |

---

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/mgcronin/openzigs.git
cd openzigs
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Configure Environment

Create a `.env` file at the repository root. Use the following template and fill in the values relevant to your setup:

```dotenv
# ── Required ──
GITHUB_CLIENT_ID=your-github-oauth-client-id

# ── Optional: Brave Search ──
BRAVE_API_KEY=your-brave-api-key

# ── Optional: Messaging Channels ──
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
DISCORD_BOT_TOKEN=your-discord-bot-token

# ── Optional: Chrome DevTools ──
CHROME_DEBUG_HOST=localhost
CHROME_DEBUG_PORT=9222

# ── Optional: Cloudflare Tunnel (Docker sidecar) ──
TUNNEL_TOKEN=your-cloudflare-tunnel-token

# ── Optional: Voice Interface (Google Cloud TTS) ──
GOOGLE_APPLICATION_CREDENTIALS=/path/to/your/service-account-key.json

# ── Optional: Social Platform MCP Servers ──
# Instagram (Meta Graph API)
# INSTAGRAM_ACCESS_TOKEN=your-instagram-user-access-token
# INSTAGRAM_BUSINESS_ACCOUNT_ID=your-instagram-business-account-id
# FACEBOOK_APP_ID=your-meta-app-id
# FACEBOOK_APP_SECRET=your-meta-app-secret
# Facebook Pages (same Meta app)
# FACEBOOK_PAGE_TOKEN=your-facebook-page-access-token
# Twitter / X (API v2)
# TWITTER_BEARER_TOKEN=your-twitter-bearer-token
# TWITTER_API_KEY=your-twitter-api-key
# TWITTER_API_SECRET=your-twitter-api-key-secret
# YouTube (Data API v3 — API key for reads, OAuth token for write operations like replying to comments)
# YOUTUBE_API_KEY=your-youtube-api-key
# YOUTUBE_OAUTH_TOKEN=your-youtube-oauth-token
# LinkedIn (API v2)
# LINKEDIN_ACCESS_TOKEN=your-linkedin-access-token
# Reddit (OAuth2)
# REDDIT_CLIENT_ID=your-reddit-client-id
# REDDIT_CLIENT_SECRET=your-reddit-client-secret
# REDDIT_USERNAME=your-reddit-username
# REDDIT_PASSWORD=your-reddit-password

# ── Optional: Personal Assistant MCP Servers ──
# GMAIL_OAUTH_PATH=~/.gmail-mcp/gcp-oauth.keys.json
# GITHUB_PERSONAL_ACCESS_TOKEN=ghp_your_token_here
# JDBC_URL=jdbc:postgresql://localhost:5432/mydb
# DB_PASSWORD=your-db-password

# ── Optional: Social Brain ──
# SOCIAL_WEBHOOK_VERIFY_TOKEN=your-random-verify-token

# ── Media Queue (Distributed GPU Nodes) ──
# Set to the primary Mac's LAN IP so remote worker nodes can POST callbacks back to it.
# Auto-detected from os.networkInterfaces() at startup if unset.
# QUEUE_CALLBACK_URL=http://192.168.1.50:3000/api/queue/complete

# ── Server ──
PORT=3000
```

### 4. Start the Server

**Development mode (with auto-reload):**

```bash
# Terminal 1: Start the backend
pnpm dev

# Terminal 2: Start the Next.js UI
cd ui && pnpm dev
```

**Production build:**

```bash
pnpm build
pnpm start

# Build and serve the UI separately
cd ui && pnpm build && pnpm start
```

**Docker (recommended for production):**

```bash
docker compose up -d
```

The backend API starts at **http://localhost:3000** and the Next.js UI at **http://localhost:3001** by default. Access the UI at `http://localhost:3001`.

---

## First-Time Authentication

On first launch, the agent must authenticate with GitHub Copilot:

1. Run the interactive setup wizard:

   ```bash
   pnpm setup
   ```

2. The CLI prints a device code and a URL:

   ```
   Visit: https://github.com/login/device
   Enter code: ABCD-1234
   ```

3. Open the URL in your browser, enter the code, and authorize the application.

4. Once authorized, the token is saved to `~/.openzigs/auth.json` with restricted file permissions (`0600`).

You only need to do this once. The token persists across restarts.

---

## Using the Web UI

The OpenZigs UI is a **Next.js** application with a navigation bar providing access to five pages:

| Page | URL | Purpose |
|---|---|---|
| **Dashboard** | `/` | System snapshot, pending approvals, audit log |
| **Chat** | `/chat` | AI chat with streaming, model selection, approval overlays |
| **Workbench** | `/workbench` | Rich Markdown editor with file browser for drafting and editing documents |
| **Admin** | `/admin` | Channel config, sidecar management, tool toggles, env status |
| **Library** | `/library` | Saved prompt templates with `{{variable}}` interpolation |
| **Scheduler** | `/scheduler` | Cron-based job scheduling with prompt linking and model overrides |
| **Tasks** | `/tasks` | Monitor background agent tasks, sub-agents, and scheduled work |
| **Social Brain** | `/social` | Unified social inbox, CRM, automation rules, and AI-powered auto-replies |
| **Post-Actions** | `/admin/post-actions` | Create and manage custom post-action types for pipeline stages |
| **Webhooks** | `/admin/webhooks` | Create and manage inbound webhooks for external integrations |
| **Gallery** | `/gallery` | Asset gallery for generated images, videos, and audio; inline creation studio for txt2img, img2img, txt2video, img2video, txt2music |
| **Music Studio** | `/music-studio` | AI Voice2Voice pipeline — stem separation, voice conversion, and mixdown with DAW waveform visualization |
| **Director** | `/director` | AI video production wizard, blog-to-YouTube, and timeline studio |
| **Director Studio** | `/director/studio/[id]` | Full timeline editor with player preview, scene inspector, and drag-and-drop reordering |

### Chat

1. Navigate to **http://localhost:3001/chat**.

![Chat overview — model selector, reasoning effort, and message input](images/chat-overview.png)

2. The chat interface includes:
   - A **model selector** dropdown in the header.
   - A **reasoning effort selector** (dot-based radio buttons) — visible only when a reasoning-capable model is selected (e.g., `o1`, `o3`, `o4-mini`).
   - A **provider badge** — shows when a non-Copilot BYOK provider is active.
   - A **context fuel gauge** — compact progress bar showing real-time context window usage (green → yellow → orange → red). Pulses during context compaction. Hover for exact token count.
   - A **connection indicator** (green = connected).
   - A **session context bar** below the header showing session ID, context gauge, turn count, session age, and compaction status.
   - A **message input** area at the bottom with **IntelliSense autocomplete**, **file attachment button**, and **drag-and-drop file zone**.

3. Type a message and press **Enter** (or click **Send**).

![Chat with xHigh reasoning effort selected](images/chat-reasoning-xhigh.png)

4. The assistant responds in real time via streaming — text appears word-by-word as the model generates it.

![Live chat response with tool calls and Markdown table rendering](images/chat-conversation-response.png)

5. During execution, the agent may display an **interactive clarification prompt** — either a set of radio-button choices or a free-text input — to gather additional information before continuing.

### Smart Input (IntelliSense Autocomplete)

The chat input features trigger-based autocomplete for fast access to tools, saved prompts, and models. Type a trigger character to open the autocomplete popover:

| Trigger | Category | What it shows |
|---------|----------|---------------|
| `/` | Prompts | Saved prompt templates from the Library |
| `#` | Tools | All enabled MCP tools by name |
| `@` | Models | Available Copilot models |

**Keyboard shortcuts:**

| Key | Action |
|-----|--------|
| `/`, `#`, `@` | Open autocomplete (after whitespace or at start of input) |
| ↑ / ↓ | Navigate the autocomplete list |
| Enter | Select the highlighted item |
| Escape | Dismiss the popover |
| Arrow Up (at start of input, no popover) | Scroll through command history |
| Arrow Down (in history mode) | Navigate forward in history |
| Shift + Enter | Insert a new line |

![IntelliSense autocomplete showing saved prompts (/ trigger)](images/chat-intellisense-prompts.png)

![IntelliSense autocomplete showing available tools (# trigger)](images/chat-intellisense-tools.png)

![IntelliSense autocomplete showing models (@ trigger)](images/chat-intellisense-models.png)

When you select an item from the autocomplete, its name is inserted into the input field. For example, typing `#web-` and selecting `web-search` inserts `web-search` at the cursor position.

### Approval Prompts

If the agent calls a high-risk tool (e.g., writing a file or running a shell command), an approval overlay appears:

- **Tool name** and **explanation** are shown.
- Click **Approve** to allow the action, or **Deny** to block it.
- The first approval (from any connected channel) wins.

### Dashboard

![Dashboard — system snapshot, pending approvals, and audit log](images/dashboard.png)

The dashboard at `/` provides:

- **Snapshot stats** — total enabled tools, pending approvals, active sessions.
- **Pending approvals** — approve or deny high-risk tool calls inline.
- **Audit log** — filterable log of tool calls, auth events, and system changes with CSV export.

### Admin

![Admin page — channels, personality, model configuration, and tools](images/admin-overview.png)

The admin page at `/admin` consolidates all configuration:

- **Channels** — Configure Telegram and Discord tokens, toggle channels on/off, select default model.
- **AI Personality** — Configure the system instruction and optional pre/post prompts, or disable injection globally. Set the **mode** to `append` (merge your personality with SDK defaults) or `replace` (fully override the system prompt with your personality text). A warning banner is displayed when replace mode is selected, and the prompt preview reflects the selected mode. When a brand voice is active, an indicator is shown at the top of the personality panel.
- **Brand Voice** — Analyze your writing samples to extract a reproducible style rulebook. Paste one or more writing samples (separated by `---`), give it a name, and click "Analyze & Save". The AI extracts your tone, sentence structure, vocabulary level, formatting quirks, and banned words into a rulebook. You can create multiple brand voices, expand any voice to view or edit its rulebook inline, and activate one at a time. The active brand voice is automatically injected into video storyboards, social brain replies, and blog-to-video pipelines.

![Brand Voice panel — analyze samples, view rulebook, activate/deactivate](images/admin-brand-voice.png)
![Model Configuration — reasoning effort and BYOK provider settings](images/admin-model-config.png)

- **Model Configuration** — Set the default reasoning effort (Low / Medium / High / xHigh) for reasoning models. Enable **BYOK (Bring Your Own Key)** to configure a custom provider (OpenAI, Azure, Anthropic, Ollama, or Custom) with base URL, API key (masked by default), and optional Azure API version. Test the connection before saving, or clear the provider to revert to GitHub Copilot.
- **Task Engine** — Adjust the maximum concurrent background agents (1–10) at runtime, view live queue stats (running, queued, concurrency limit). Configure the **tool limit per request** (1–128) to control how many tools are sent to the LLM in each call — see [Tool Limit Configuration](#tool-limit-configuration) below.
![Custom Agents — agent cards with tool badges and infer indicators](images/admin-custom-agents.png)

- **Custom Agents** — Create, edit, and delete custom agent archetypes. Each agent has a name (identifier), display name, description, system prompt, tool allowlist (multi-select grouped by category), and auto-invoke toggle. Agents are displayed as cards with tool badges and infer indicators.

![New Agent form — name, description, system prompt, tool selection, and auto-invoke toggle](images/admin-new-agent-form.png)
- **MCP Servers** — View and manage all 12 native MCP servers (social platforms, document tools, personal assistant, developer tools). See live running status for each server, toggle individual tools on/off, and define server connections (Local stdio, HTTP, SSE). Local servers are configured with a command, arguments, working directory, and masked environment variables. HTTP/SSE servers are configured with a URL and optional headers. Each server has a configurable timeout.
- **Tools** — Toggle any tool on/off, view risk level badges (🟢 low, 🟡 medium, 🔴 high), grouped by category. Each tool also has a **🔓/🔒 global approval lock** toggle — see [Global Tool Approval Lock](#global-tool-approval-lock).

![Admin tools with global approval lock toggles — 🔓 unlocked, 🔒 locked](images/admin-tools-global-lock.png)

- **Environment** — Status grid showing which environment variables are configured vs. missing.

### Library (Saved Prompts)

![Library — saved prompt templates with variable highlighting](images/library-prompts.png)

The library at `/library` provides a visual interface for managing saved prompt templates:

- **Create** new prompts with name, content, and tags.
- **Edit** existing prompts inline.
- **Search** prompts by name, content, or tags.
- **Variable preview** — `{{variable}}` placeholders are highlighted and listed.
- **Preferred Tools** — Restrict which tools a prompt can use via a ToolMultiSelect dropdown grouped by category. When set, only the selected tools (plus always-on tools) are available during execution.
- **Pipeline Stages** — Attach a multi-stage pipeline to any prompt. When the prompt is executed by the scheduler, stages run sequentially (or in parallel groups) with per-stage prompts, tool restrictions, model overrides, timeouts, auto-approve tools, and optional post-actions (e.g., "create GitHub issues from findings").
- **Use as System Prompt** — Apply any saved prompt as the active system instruction in the AI Personality panel.
- **Export** — Download any prompt as a portable `.openzigs-template.json` file for sharing across instances.
- **Import** — Upload a `.openzigs-template.json` file via the Import Wizard to add a shared template to your library.
- **Delete** with confirmation.

#### Pipeline Stages on Prompts

Any saved prompt can optionally carry pipeline stages, turning it from a simple template into a full multi-stage workflow. This is configured directly in the Library editor — no need to create a separate scheduler job.

**How to add stages:**

1. Open the Library at **http://localhost:3001/library**.
2. Click **+ New Prompt** (or **Edit** on an existing prompt).
3. Scroll to the **Pipeline Stages** section (collapsed by default).
4. Click to expand. If the prompt already has stages, the section auto-expands with a stage count badge.
5. Choose a creation mode:
   - **🧙 Workflow Wizard** — Describe your goal in plain English; AI auto-generates the stages.
   - **🔧 Manual Editor** — Build the pipeline yourself using the visual React Flow editor.
6. Each stage supports:
   - **Name** — Display label for the stage.
   - **Prompt** — Instructions for the LLM at this stage. Supports `{{variable}}` interpolation.
   - **Tools** — Multi-select for tools available to this stage (grouped by category).
   - **Auto-Approve Tools** — Tool selector (multi-select) specifying which tools bypass approval gating for this stage. Select specific tools from the stage's tool list, or leave empty to require approval for all.
   - **Timeout** — Max execution time in seconds (default: 300).
   - **Post-Action** — Deterministic action after stage completion. Action types are loaded dynamically from the Post-Action Registry (see below).
7. Click **Save Prompt** to persist the stages.

#### Post-Action Registry (Plugin System)

Post-actions are deterministic actions that run after a pipeline stage completes (e.g., create GitHub issues, send a webhook). Instead of hardcoding action types in the UI, openzigs uses a **Post-Action Registry** — a plugin system where each action type is registered with a JSON Schema describing its configuration, enabling the UI to render dynamic config forms for any action.

**Built-in post-action types:**

| Type | Category | Description |
|------|----------|-------------|
| `create-github-issues` | Integrations | Parse stage output for findings and create GitHub issues. Config: `owner`, `repo`, `labels`, `minSeverity`, `maxIssues`. |
| `send-webhook` | Notifications | POST/PUT the stage output to a webhook URL. Config: `url`, `method`, `includeOutput`. |

**How it works:**

1. At server startup, `registerBuiltinPostActions()` registers all built-in action types with the global `postActionRegistry`.
2. The UI fetches available types via `GET /api/admin/post-actions`, which returns each type's label, description, category, icon, and `configSchema`.
3. The pipeline editor renders a dynamic form based on the `configSchema` — field types (string, number, boolean, array), labels, defaults, enums, and constraints are all driven by the schema.
4. When a stage executes, the engine calls `postActionRegistry.execute(action, stageOutput)`, which delegates to the registered handler.

**REST API — List registered post-actions:**

```bash
curl http://localhost:3000/api/admin/post-actions
# Returns: { "actions": [{ "type": "create-github-issues", "label": "...", "configSchema": {...} }, ...] }
```

**Creating custom post-actions (UI):**

Navigate to **http://localhost:3001/admin/post-actions** to create custom post-action types without writing code. See [Custom Post-Actions (Settings Page)](#custom-post-actions-settings-page) below for full details.

**Registering a custom post-action (code):**

```typescript
import { postActionRegistry } from "./tasks/post-action-registry.js";

postActionRegistry.register({
  type: "slack-notify",
  label: "Slack Notification",
  description: "Send stage results to a Slack channel via incoming webhook.",
  category: "Notifications",
  icon: "slack",
  configSchema: {
    type: "object",
    properties: {
      webhookUrl: { type: "string", title: "Webhook URL", placeholder: "https://hooks.slack.com/..." },
      channel: { type: "string", title: "Channel", default: "#general" },
      mentionOnFailure: { type: "boolean", title: "Mention @here on failure", default: false },
    },
    required: ["webhookUrl"],
  },
  handler: async (stageOutput, config) => {
    // Your implementation here
    return JSON.stringify({ ok: true, channel: config.channel });
  },
});
```

**Stage and tool count badges** appear on saved prompt cards in the list, giving you a quick visual indicator of which prompts are simple templates vs. full pipelines.

**MCP tools:** The `save-prompt` and `update-prompt` MCP tools also support `stages` and `preferredTools` parameters, allowing the AI to create pipeline-enabled prompts programmatically.

**REST API:**

```bash
# Create a prompt with pipeline stages
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "code-review-pipeline",
    "content": "Review code for {{project}}",
    "stages": [
      {
        "name": "clone-and-read",
        "prompt": "Read the source files for {{project}}",
        "tools": ["read-file", "list-directory"]
      },
      {
        "name": "review",
        "prompt": "Review the code for bugs, security issues, and style",
        "tools": ["read-file", "web-search"],
        "autoApproveTools": ["read-file"],
        "postAction": {
          "type": "create-github-issues",
          "config": { "owner": "acme", "repo": "app", "minSeverity": "medium" }
        }
      }
    ],
    "preferredTools": ["read-file", "list-directory", "web-search"]
  }' \
  http://localhost:3000/api/prompts

# Update stages (set to null to remove)
curl -X PUT -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"stages": null}' \
  http://localhost:3000/api/prompts/<id>
```

#### Custom Post-Actions (Settings Page)

The Post-Actions settings page at `/admin/post-actions` provides a UI for creating custom post-action types without writing code. Custom actions appear automatically in the pipeline stage editor's post-action dropdown alongside built-in types.

**How to create a custom post-action:**

1. Navigate to **http://localhost:3001/admin/post-actions**.
2. Click **+ New Post-Action**.
3. Fill in the required fields:
   - **Type** — Unique slug identifier (e.g., `custom-slack-notify`).
   - **Label** — Human-readable label shown in dropdowns.
   - **Description** — What the action does.
   - **Category** — Grouping category (default: "Custom").
4. Choose a creation mode:
   - **Template** — Use a pre-built template:
     - **Webhook** — Generic HTTP sender. Configure default URL, HTTP method, and whether to include stage output.
     - **Script** — Shell command. Stage output is piped to stdin; config values are passed as `OPENZIGS_CONFIG_*` environment variables.
   - **Advanced** — Define custom config fields (string, number, boolean, array) and a script body. The fields appear as a dynamic form in the stage editor.
5. Click **Create** to save. The action is immediately available in all pipeline editors.

**Managing custom post-actions:**

- **Edit** — Click the **Edit** button on any custom action card to modify its configuration.
- **Delete** — Click **Delete** and confirm to remove a custom action.
- **Built-in actions** — Shown as read-only cards; these cannot be edited or deleted.

**REST API — Custom post-action CRUD:**

```bash
# List custom post-action definitions
curl http://localhost:3000/api/admin/post-actions/custom

# Create a custom webhook post-action
curl -X POST -H "Content-Type: application/json" \
  -d '{
    "type": "slack-webhook",
    "label": "Slack Webhook",
    "description": "Send stage output to a Slack channel",
    "templateType": "webhook",
    "templateConfig": {
      "url": "https://hooks.slack.com/services/...",
      "method": "POST",
      "includeOutput": true
    }
  }' \
  http://localhost:3000/api/admin/post-actions/custom

# Update a custom post-action
curl -X PUT -H "Content-Type: application/json" \
  -d '{"label": "Slack Webhook (Updated)"}' \
  http://localhost:3000/api/admin/post-actions/custom/slack-webhook

# Delete a custom post-action
curl -X DELETE http://localhost:3000/api/admin/post-actions/custom/slack-webhook
```

**Persistence:** Custom post-action definitions are stored in `~/.openzigs/custom-post-actions.json` and survive server restarts. On startup, all custom actions are automatically re-registered with the global post-action registry.

#### Exporting & Importing Templates

![Library page with Export and Import buttons](images/library-export-import.png)

The Library supports exporting and importing prompt templates as portable `.openzigs-template.json` files. This makes it easy to share workflows between OpenZigs instances or distribute curated templates to a team.

##### Exporting a Template

1. Open the Library at **http://localhost:3001/library**.
2. Find the prompt you want to export.
3. Click the **⬇ Export** button on the prompt card.
4. A `.openzigs-template.json` file is downloaded to your browser.

The exported file contains the full prompt definition — name, description, template content, tags, preferred tools, and pipeline stages. Environment-specific values in post-action configurations (e.g., GitHub repo owner/name, webhook URLs) are automatically **tokenized** into `{{placeholder}}` markers so the template is safe to share without leaking credentials.

##### Importing a Template

1. Open the Library at **http://localhost:3001/library**.
2. Click the **Import** button in the header (next to "+ New Prompt").
3. The **Import Wizard** opens with three steps:

   ![Import Wizard — drag & drop upload step](images/library-import-wizard.png)

   **Step 1 — Upload:**
   - Drag and drop a `.openzigs-template.json` file onto the drop zone, or click **Browse** to select a file.
   - The wizard validates the file format and shows any errors.

   **Step 2 — Preview & Configure:**
   - Review the prompt name, description, stage count, and tags.
   - If the template contains placeholders (tokenized environment values), fill in the required values for your instance (e.g., your GitHub org/repo, your webhook URL).
   - Click **Import Template** to proceed.

   **Step 3 — Success:**
   - A confirmation screen shows the imported prompt name.
   - Click **Close** to dismiss the wizard and see the new prompt in your library.

If a prompt with the same name already exists, the imported template is automatically renamed with an "(imported)" suffix.

##### REST API — Template Export & Import

```bash
# Export a prompt as a template file
curl -H "Authorization: Bearer <token>" \
  http://localhost:3000/api/admin/prompts/1/export \
  -o my-template.openzigs-template.json

# Analyze a template before importing (pre-validation)
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d @my-template.openzigs-template.json \
  http://localhost:3000/api/admin/templates/analyze

# Import a template with placeholder values
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "template": { ... },
    "placeholders": {
      "stage_0_config.owner": "my-org",
      "stage_0_config.repo": "my-repo"
    }
  }' \
  http://localhost:3000/api/admin/templates/import
```

### Scheduler

![Scheduler — cron-based job management with existing jobs](images/scheduler-page.png)

The scheduler at `/scheduler` manages cron-based automated jobs:

- **Create** jobs with name, cron expression, and action (prompt, shell command, pipeline, or custom).
- **Prompt linking** — link a job to a saved prompt from the Library.
- **Model selection** — optionally choose a model override per prompt or pipeline job.
- **AI Scheduler Assistant** — describe the schedule in plain English and auto-fill fields (uses `gpt-5-mini`).
- **Cron preview** — visual breakdown of minute, hour, day, month, weekday fields.
- **Enable/disable** individual jobs with toggle switches.
- **Run Now** — trigger any job immediately with the ▶ Run button, bypassing the cron schedule.
- **Auto-Approve Tools** — for prompt/shell/custom jobs, specify tool names that bypass approval gating. For **pipeline jobs**, auto-approve tools are **automatically derived** from the union of all stage-level tool restrictions — any tool a stage uses is auto-approved during scheduled runs.

![New Job form — Pipeline action type with model selector and wizard/manual chooser](images/scheduler-pipeline-new-job.png)
- **Live execution events** via Socket.IO — see when jobs fire in real time.

#### Multi-Model Agent Chaining

When using the `orchestrate-agents` tool (available to prompt-type jobs), you can assign **different models to each sub-agent** in the orchestration. For example, use `gpt-4o-mini` for cheap read-only analysis and `gpt-4.1` for complex code generation — all within a single scheduled job.

Each agent in the `orchestrate-agents` array accepts an optional `model` field and `auto_approve_tools` array, giving you fine-grained control over cost, capability, and autonomy per sub-agent.

#### Per-Run Approval Overrides

Approval overrides let specific tools run without human confirmation during scheduled or agent-spawned tasks. This is critical for **autonomous workflows** where no human is present to approve.

**How it works:**
1. Set `autoApproveTools` on a scheduled job or pass `auto_approve_tools` when spawning/orchestrating agents.
2. When the task executes and invokes a listed tool, the hooks layer skips the approval queue and immediately allows execution.
3. An audit log entry (`tool_auto_approved`) is recorded for every auto-approved invocation.
4. Tools **not** in the auto-approve list still follow normal approval gating.

#### Pipeline Jobs (Visual Workflow Builder)

The scheduler supports **pipeline** as a job action type. A pipeline job executes a multi-stage agent workflow where each stage runs sequentially (or in parallel groups) with its own prompt, tool restrictions, and optional model override.

![Pipeline editor with multiple stages and a parallel group](images/pipeline-editor-multi-stage.png)

**Creating a pipeline job:**

1. In the New Job form, select **Pipeline** as the action type.
2. A **Wizard/Manual chooser** appears:
   - **🧙 Workflow Wizard** — Describe your goal in plain English and let AI auto-plan the pipeline stages.
   - **🔧 Manual Editor** — Build the pipeline yourself using the visual drag-and-drop editor.

![Wizard/Manual chooser for pipeline creation](images/pipeline-wizard-chooser.png)

3. In the **Manual Editor**, the Visual Pipeline Editor canvas (powered by React Flow) provides:
   - **+ Stage** button — Adds a prompt stage (single LLM agent step).
   - **+ Parallel** button — Adds a parallel group (multiple stages running concurrently).
   - **MiniMap** (bottom-left) — Overview of the full pipeline graph.
   - **Controls** (bottom-right) — Zoom, fit view, toggle interactivity.
4. Click any node to open the **Stage Editor** sidebar:
   - **Name** — Display label for the stage.
   - **Prompt** — The instruction sent to the LLM. Supports a prompt selector (press `/` to search saved prompts).
   - **Tools** — Multi-select dropdown with tools grouped by category (Browser, Developer, Documents, Filesystem, Productivity, Search, Shell). The dropdown renders as a portal overlay for full visibility.
   - **Timeout** — Maximum execution time in seconds (default: 300).
5. Connect nodes by dragging from output handles (bottom) to input handles (top).
6. Click **Save** when done. The pipeline must have at least 2 stages to create the job.

![Tool multi-select dropdown with full portal rendering](images/pipeline-tool-dropdown.png)

**Model selection:** Pipeline jobs now include a **Model** selector below the editor, allowing you to choose an LLM model override for the entire pipeline (e.g., `claude-sonnet-4`, `gpt-5`). This applies to all stages unless individual stages specify a model.

**Auto-derived auto-approve:** When stages have specific tool restrictions, the pipeline job's auto-approve list is **automatically derived** from the union of all stage tools. For example, if stage-1 uses `browser-navigate, list-directory, shell-execute`, those 3 tools are automatically auto-approved for the pipeline job's scheduled runs.

![Auto-approve tools derived from pipeline stage configuration](images/pipeline-auto-approve-derived.png)

**Recursive pipelines:** Parallel groups can contain nested stages or further parallel groups, up to 4 levels deep. This allows complex fan-out/fan-in patterns.

**Pipeline Planner (Auto-Plan):** The **Workflow Wizard** provides an AI-assisted pipeline creation flow:

![Workflow Wizard step 1 — describe your goal](images/workflow-wizard-step1.png)

1. Select **🧙 Workflow Wizard** from the chooser.
2. Describe your goal in plain English (e.g., "Research competitors, analyze their pricing, and draft a comparison report").
3. Click **Auto-Plan Pipeline** — the system calls the Pipeline Planner Agent (`POST /api/admin/pipeline/plan`) which generates a structured pipeline definition.
4. Review the AI's rationale and the generated pipeline in the visual editor.
5. Make adjustments if needed, then confirm to create the pipeline.
6. You can also click **Skip to Manual Editor** at any time to switch to manual mode.

#### Global Tool Approval Lock

![Admin tools — approval toggles with 🔓/🔒 lock buttons and risk level badges](images/admin-tools-approval-toggles.png)

Administrators can set a **global approval lock** on any tool from the Admin → Tools panel. When a tool is locked:

- A 🔒 icon appears on the tool card. Click it to toggle the lock.
- **Locked tools always require human approval**, even if they appear in a task's `autoApproveTools` list or the interactive auto-approve context.
- This provides an admin-level safety mechanism for dangerous tools (e.g., `shell-execute`, `write-file`) that cannot be bypassed by any automation.

To toggle a lock via the API:

```bash
# Lock a tool
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"required": true}' \
  http://localhost:3000/api/admin/tools/shell-execute/global-approval

# Unlock a tool
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"required": false}' \
  http://localhost:3000/api/admin/tools/shell-execute/global-approval
```

### Workbench (Project Editor)

The Workbench at `/workbench` is a rich Markdown editor for drafting documents, notes, and content — powered by [MDXEditor](https://mdxeditor.dev/).

**Layout:**

| Area | Description |
|------|-------------|
| **File sidebar** (left) | Recursive file tree browser. Click folders to expand, click files to open. |
| **Editor** (center) | WYSIWYG Markdown editor with formatting toolbar. |
| **Status bar** (bottom) | Active file path and save state ("Modified" / "Saved"). |

**Toolbar actions:**

| Button | Action |
|--------|--------|
| Undo / Redo | Step through edit history |
| **B** *I* U | Bold, italic, underline toggles |
| `</>` | Inline code toggle |
| Block type | Switch between paragraph, headings (H1–H6), and quote |
| Lists | Ordered and unordered list toggles |
| Link | Insert or edit a hyperlink |
| Image | Insert an image by URL |
| Table | Insert a Markdown table |
| Horizontal rule | Insert a thematic break (`---`) |

**Code blocks:** The editor supports syntax-highlighted code blocks via CodeMirror for JavaScript, TypeScript, TSX, JSX, CSS, HTML, JSON, Python, Bash, SQL, and plain text.

**File management:**

- **Open a file:** Click any file in the sidebar to load its content into the editor.
- **New file:** Click the **+** button in the sidebar header. The editor resets to a blank document.
- **Save:** Click the **Save** button in the toolbar or press **Cmd+S** (macOS) / **Ctrl+S** (Windows/Linux). If no file is open, you'll be prompted for a file path.
- **Import document:** Click the **Import** button in the toolbar to open the Import Document dialog. Browse the file tree, select a document (Word, PDF, PowerPoint, Excel, HTML, images, or audio), and click **Import**. The file is converted to Markdown via the MarkItDown MCP tool and loaded into the editor as a new unsaved document.
- **Refresh:** Click the **↻** button in the sidebar header to reload the file tree.
- **Collapse sidebar:** Click the **›** button to collapse the sidebar to a narrow icon strip.

**Importing documents:**

The Import Document feature converts non-Markdown files into editable Markdown directly in the Workbench. It uses the LLM + the `convert-to-markdown` MCP tool (powered by [Microsoft MarkItDown](https://github.com/microsoft/markitdown)) to transform documents on the fly.

| Supported format | Extensions |
|------------------|------------|
| **Office documents** | `.docx`, `.pptx`, `.xlsx` |
| **PDF** | `.pdf` |
| **Web/text** | `.html`, `.htm`, `.rtf`, `.csv`, `.tsv`, `.epub` |
| **Images** (OCR) | `.jpg`, `.jpeg`, `.png`, `.gif`, `.bmp`, `.tiff`, `.webp` |
| **Audio** (transcription) | `.mp3`, `.wav`, `.m4a`, `.ogg` |

After import, the converted Markdown is loaded into the editor with a suggested file path (the original filename with a `.md` extension). The document is marked as unsaved — press **Cmd+S** to save it.

> **Prerequisite:** The MarkItDown MCP server must be available. Ensure Python 3.10+ and `uvx` are installed.

**Keyboard shortcuts:**

| Key | Action |
|-----|--------|
| Cmd/Ctrl + S | Save the current file |
| Standard Markdown shortcuts | Bold (`**`), italic (`*`), code (`` ` ``), headings (`#`), lists (`-`) via Markdown shortcut plugin |

**Unsaved changes:** An amber dot appears next to the file name when you have unsaved edits. The status bar also shows "Modified" until you save.

**File path sandbox:** The Workbench uses the same `allowedDirs` sandbox as the MCP filesystem tools. You can only browse and edit files within the allowed directories (by default: the project root, home directory, and temp directories).

**Environment variable:** Set `NEXT_PUBLIC_WORKBENCH_ROOT` to change the default root directory for the file sidebar (defaults to `.`, the project root).

### Tasks (Background Agents)

![Tasks page — queue stats, task list with status badges and results](images/tasks-page.png)

The Tasks page at `/tasks` provides real-time monitoring of background agent tasks:

- **Queue stats** — live counters showing queued and running task counts.
- **Task list** — all tasks with status badges (queued, running, completed, failed, cancelled), trigger type (chat, cron, agent), model, and depth.
- **Status filter** — filter by task status.
- **Cancel** — cancel queued or running tasks.
- **Results / errors** — view task output or error details inline.
- **Child tasks** — expand a task to see its spawned sub-tasks (recursive chaining).
- **Real-time updates** — Socket.IO pushes update the list when tasks complete or fail.
- **Token cost badges** — each task card displays a color-coded badge showing total token consumption.
- **Visual workflow graph** — click **◇ View graph** on any task to see a full interactive DAG (directed acyclic graph) of the task tree.

#### Token Cost Badges

![Tasks page with token cost badges — green (1.6K), orange (58.1K), and orange (107.5K) badges on task cards](images/tasks-token-badges.png)

Each task card shows a **Token Cost Badge** next to the status badge, indicating how many tokens the task consumed. The badge is color-coded by total token count:

| Token Count | Color | Meaning |
|---|---|---|
| < 10,000 | 🟢 Green | Lightweight task — minimal token usage. |
| 10,000–50,000 | 🟡 Yellow | Moderate usage. |
| 50,000–200,000 | 🟠 Orange | Heavy usage — complex task with many tool calls. |
| > 200,000 | 🔴 Red | Very expensive task — consider optimizing. |

Hover over the badge to see a tooltip with the input/output token breakdown. Token usage is only available for completed or failed tasks; queued and running tasks show no badge until they finish.

**Token usage API:**

```bash
# Get token usage for a specific task
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/tasks/<id>/usage

# Get aggregate token summary for recent tasks
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/tasks/usage/summary?hours=24
```

### Visual Workflow Graph

![Task workflow graph — interactive DAG visualization of task tree](images/tasks-graph-view.png)

The task graph provides an interactive visualisation of a task and all its descendants, powered by React Flow and dagre layout.

**How to use:**

1. Navigate to the **Tasks** page at `/tasks`.
2. Find a task that has spawned sub-agents (any task created via `spawn-agent` or `orchestrate-agents`).
3. Click **◇ View graph** to expand the DAG below that task card.
4. The graph renders all tasks as nodes, connected by edges showing parent-child relationships.

**Node features:**

| Element | Description |
|---------|-------------|
| Status dot | Color-coded (🟡 queued, 🔵 running, 🟢 completed, 🔴 failed, ⚪ cancelled). Running nodes pulse. |
| Trigger icon | 💬 chat, ⏰ cron, 🤖 agent |
| Goal text | The task's goal, truncated to 2 lines |
| Model | The model used for execution (shown at bottom) |
| Duration | Time from creation to completion |
| Result/Error | One-line preview of output or error |

**Graph controls:**

| Control | Action |
|---------|--------|
| Mouse drag | Pan the graph |
| Scroll wheel | Zoom in/out |
| Bottom-right controls | Zoom buttons, fit view |
| Bottom-left minimap | Overview of full graph, draggable viewport |

**Animated edges:** Edges to running tasks are animated with a dashed stroke to indicate active execution.

The graph auto-refreshes every 10 seconds to reflect status changes.

**How background tasks are created:**

1. **spawn-agent tool** — During a conversation, the AI can call the `spawn-agent` MCP tool to delegate long-running work to a background sub-agent.
2. **Scheduled jobs** — Prompt-type scheduled jobs are automatically submitted as background tasks via the TaskEngine.
3. **Chat messages** — Every routed chat message is also tracked as an immediate-mode task for observability.

**Recursive chaining:** Sub-agents can themselves call `spawn-agent` to create nested sub-tasks, up to a configurable depth limit (default: 5 levels). Each level tracks its parent and depth.

**REST API:**

```bash
# List all tasks  
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/tasks

# Get queue stats
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/tasks/stats

# Get a specific task
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/tasks/<id>

# Get children of a task
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/tasks/<id>/children

# Cancel a task
curl -X POST -H "Authorization: Bearer <token>" http://localhost:3000/api/tasks/<id>/cancel
```

---

## Advanced: Agent Chaining Patterns

The **Recursive Agent Chaining** system lets you orchestrate multi-step, long-running workflows by composing background sub-agents. Under the hood, the agent uses the `spawn-agent` MCP tool to create independent `AgentTask` entries in the SQLite queue. Each task executes asynchronously via the `TaskWorker`, persists its result to the database, and notifies you when it completes — even if you close the browser.

This section covers three real-world patterns that demonstrate how to unlock chaining in practice.

### 1. The "Fire and Forget" Pattern (Chat → Background)

**When to use:** You want a thorough answer to a complex question, but you don't want to sit and watch the chat stream for several minutes.

**Example prompt (in Chat):**

```
Research the history of the weirdest V8 engines ever made. This will take a while,
so please run it in the background and notify me when done.
```

**What happens:**

| Step | Component | Action |
|------|-----------|--------|
| 1 | **MessageRouter** | Receives your message and streams it to the LLM as an immediate-mode task. |
| 2 | **LLM** | Recognizes the "background" intent and calls the `spawn-agent` tool instead of answering inline. |
| 3 | **`spawn-agent` tool** | Creates a new `AgentTask` with `trigger: "agent"`, `mode: "background"`, and `notifyOnComplete: true`. The task is inserted into the SQLite `agent_tasks` queue. |
| 4 | **Chat** | Returns immediately: *"Background task started: Research the history of the weirdest V8 engines ever made. You'll be notified when it completes."* |
| 5 | **TaskWorker** | Polls the queue, dequeues the task, and executes it via `CopilotWrapper.chat()` with a structured prompt built from the task's `goal` and `context`. |
| 6 | **NotificationDispatcher** | On completion, pushes a `task:notification` Socket.IO event to the UI, sends a message to the originating channel (Web Chat, Telegram, or Discord), and appends the result to the session JSONL. |

**Tracking:** Navigate to **http://localhost:3001/tasks** to see real-time status. The task appears with a 🤖 agent trigger icon, a `running` badge, and updates to `completed` (with the full result) or `failed` (with the error) when done.

**Key detail:** The task persists in SQLite. If you close your browser, shut your laptop, or even restart the server, the result is waiting for you when you come back. The notification is delivered the next time you connect.

---

### 2. The "Morning Briefing" Pattern (Cron → Parallel Agents)

**When to use:** You have a scheduled job that needs to gather information from multiple independent sources in parallel, then synthesize the results.

**Setup:** Create a scheduled job via the Scheduler UI at `/scheduler` (or the `schedule-job` tool):

| Field | Value |
|-------|-------|
| **Name** | `morning-briefing` |
| **Cron** | `0 6 * * *` (6:00 AM daily) |
| **Action** | Prompt |
| **Prompt** | *(see below)* |

**Job prompt:**

```
You are the Chief of Staff. Your job is to prepare a morning briefing.

Spawn three separate background agents to research the following topics in parallel:
1. "Summarize the top 5 AI and machine learning news stories from the last 24 hours."
2. "Get the current prices of Bitcoin, Ethereum, and Solana. Include 24h change percentages."
3. "What is the weather forecast for New York City today? Include temperature, precipitation, and wind."

Once all three agents complete, compile their reports into a single concise briefing document.
```

**What happens:**

```
6:00 AM — Scheduler fires
  └─ TaskEngine.submit(trigger: "cron", mode: "background")
       └─ TaskWorker dequeues → LLM executes the prompt
            ├─ spawn-agent → "AI News"       (Depth 1, child task #1)
            ├─ spawn-agent → "Crypto Prices"  (Depth 1, child task #2)
            └─ spawn-agent → "Local Weather"  (Depth 1, child task #3)
```

| Task | Trigger | Depth | Status |
|------|---------|-------|--------|
| `morning-briefing` (root) | ⏰ cron | 0 | Running — waiting for children |
| `AI News` | 🤖 agent | 1 | Queued → Running → Completed |
| `Crypto Prices` | 🤖 agent | 1 | Queued → Running → Completed |
| `Local Weather` | 🤖 agent | 1 | Queued → Running → Completed |

The three child tasks execute independently and in parallel (up to `maxConcurrent: 2` at a time). Each child's result is returned to the root agent's LLM context via the `spawn-agent` tool response. The root agent then compiles the results into a final briefing.

**Viewing in the Tasks UI:** The root task shows a **▶ Expand** button. Clicking it reveals the three child tasks with their individual statuses, results, and timing. Each child is linked to the parent via `parentTaskId`.

**Notification:** When the root task completes, the `NotificationDispatcher` sends the compiled briefing to the configured notification channel.

---

### 3. The "Manager-Worker" Pattern (Recursive Depth)

**When to use:** You have a multi-phase task where each phase depends on the output of the previous one — a pipeline of specialists.

**Example prompt (in Chat):**

```
Build a Python script that scrapes product pricing from example.com.
Break this into phases: first write a spec, then write the code based on the spec.
Run each phase as a separate background agent.
```

**What happens — a three-level task tree:**

```
Root Agent (Depth 0) — "Build a Python pricing scraper"
  │
  ├─ spawn-agent → Spec Writer (Depth 1)
  │    goal: "Write a technical specification for a Python script that scrapes
  │           product pricing from example.com. Include: target URLs, data fields
  │           to extract, output format (CSV), error handling strategy, and
  │           rate-limiting approach."
  │    context: "This spec will be handed to a coding agent to implement."
  │
  │    ┌─ Spec Writer completes with the spec document
  │    │
  │    └─ spawn-agent → Coder (Depth 2)
  │         goal: "Implement the following specification as a Python script."
  │         context: [the full spec from Depth 1]
  │
  │         └─ Coder completes with the Python script
  │
  └─ Root agent receives the final script → task marked completed
```

**Task tree in the UI:**

| Task | Depth | Parent | Status |
|------|-------|--------|--------|
| Build a Python pricing scraper | 0 | — | Completed |
| ↳ Write technical specification | 1 | *(root)* | Completed |
| &nbsp;&nbsp;&nbsp;&nbsp;↳ Implement the specification | 2 | *(spec writer)* | Completed |

**How depth tracking works:**

1. When the root agent calls `spawn-agent`, the tool handler reads the current task's `depth` (0) and creates the child at `depth + 1` (1).
2. When the Spec Writer agent calls `spawn-agent`, the child is created at `depth + 1` (2).
3. The `TaskRepository` enforces `TASK_LIMITS.maxDepth` (default: **5**). If an agent at depth 5 attempts to spawn a child, the tool returns an error: *"Maximum task depth exceeded."*
4. Additional safeguards: each parent can have at most **10 children** (`maxChildren`), and each session is limited to **20 spawns per minute** (`maxRatePerMinute`).

**Visualizing the tree:** On the `/tasks` page, click the root task's **▶ Expand** button to see its children. Click a child to expand further. Each level shows the task's goal, status badge, model, result preview, and timing.

---

### Chaining Reference

#### `spawn-agent` Tool Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `goal` | string | Yes | — | The instruction for the sub-agent. Be specific and self-contained. |
| `context` | string | No | `""` | Additional data passed to the sub-agent's prompt (e.g., output from a previous step). |
| `notify_user` | boolean | No | `true` | Send a notification to the originating channel when the task completes or fails. |
| `model` | string | No | *(server default)* | Model override for the sub-agent (e.g., `gpt-4.1`, `claude-sonnet-4`). |

#### `orchestrate-agents` Tool Parameters

The `orchestrate-agents` tool provides a **fan-out / fan-in** pattern: it dispatches multiple sub-agents in parallel, waits for all to finish (or timeout), and optionally aggregates their results via a Copilot call.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agents` | array | Yes | — | Array of 1–10 agent definitions, each with `goal` (string, required) and optional `context` (string). |
| `aggregation_prompt` | string | No | — | If provided, a final Copilot call synthesizes the agent outputs into a single deliverable. |
| `timeout_seconds` | number | No | `300` | Maximum time to wait for all agents (30–600 seconds). |

**When to use `orchestrate-agents` vs `spawn-agent`:**

| Scenario | Tool | Why |
|----------|------|-----|
| Fire-and-forget background work | `spawn-agent` | You don't need the result inline — the notification arrives later. |
| Parallel research with combined report | `orchestrate-agents` | You need all results before producing a deliverable. |
| Sequential pipeline (spec → code) | `spawn-agent` (chained) | Each step depends on the previous one. |
| Multi-source comparison | `orchestrate-agents` | Fan-out to N sources, aggregate into a comparison table. |

**Example prompt:**

```
Compare the pricing of AWS, GCP, and Azure for a 3-node Kubernetes cluster.
Use orchestrate-agents to research all three in parallel, then combine the
findings into a comparison table.
```

**What happens:**

```
Root Agent (Chat)
  └─ orchestrate-agents(
       agents: [
         { goal: "Research AWS EKS pricing for 3-node cluster" },
         { goal: "Research GCP GKE pricing for 3-node cluster" },
         { goal: "Research Azure AKS pricing for 3-node cluster" },
       ],
       aggregation_prompt: "Create a comparison table of pricing across providers"
     )
       ├─ Agent 1: AWS research (background task)
       ├─ Agent 2: GCP research (background task)
       └─ Agent 3: Azure research (background task)
       
       [All 3 complete → Copilot aggregation call → comparison table returned to chat]
```

#### Safeguard Limits

| Limit | Default | Description |
|-------|---------|-------------|
| Max recursion depth | **5** | Maximum nesting levels (root = 0, first child = 1, etc.). |
| Max children per parent | **10** | Maximum sub-tasks a single agent can spawn. |
| Max spawns per minute | **20** | Rate limit per session to prevent runaway loops. |

#### Task Lifecycle

```
queued → running → completed
                 → failed
         → cancelled (user-initiated via API or UI)
```

Tasks that are `queued` or `running` can be cancelled from the Tasks UI or via the REST API:

```bash
curl -X POST -H "Authorization: Bearer <token>" \
  http://localhost:3000/api/tasks/<task-id>/cancel
```

#### Persistence Guarantees

- All tasks are persisted in the SQLite `agent_tasks` table with WAL mode.
- Task results survive server restarts, browser closures, and network disconnections.
- Notifications are delivered via Socket.IO on reconnect and/or pushed to the originating messaging channel (Telegram, Discord).
- Session JSONL logs include task completion events for full audit traceability.

---

## Session Lifecycle & Infinite Context

OpenZigs uses the GitHub Copilot SDK's **native session management** for multi-turn conversations. This means the SDK maintains conversation context automatically — no manual history reconstruction.

### How It Works

1. **Long-Lived Sessions** — When you chat, OpenZigs creates an SDK session tied to your conversation ID and caches it. Subsequent messages reuse the same session, so the AI remembers what you said.
2. **Session Resumption** — If the server restarts, OpenZigs attempts to resume your session via the SDK's `resumeSession()` API. If that fails (e.g., the session expired), a new session is created automatically.
3. **Infinite Sessions** — Enabled by default. When the conversation grows long, the SDK automatically compacts older context in the background, preventing context window exhaustion without losing the thread of the conversation.
4. **Session Cleanup** — When you click "New Chat" in the web UI, the cached SDK session is destroyed, freeing resources and starting fresh.

### Configuration

In `config/default.json`:

```json
{
  "session": {
    "historyWindow": 20,
    "maxToolsPerRequest": 30,
    "dynamicToolLoading": false,
    "infiniteSessions": {
      "enabled": true,
      "backgroundCompactionThreshold": 0.80,
      "bufferExhaustionThreshold": 0.95
    }
  }
}
```

| Setting | Default | Description |
|---|---|---|
| `infiniteSessions.enabled` | `true` | Enable automatic context compaction for long conversations. |
| `infiniteSessions.backgroundCompactionThreshold` | `0.80` | Start compacting in the background when context usage reaches 80%. |
| `infiniteSessions.bufferExhaustionThreshold` | `0.95` | Force compaction when context usage reaches 95% (prevents hard failures). |
| `historyWindow` | `20` | Number of events retained in the JSONL audit log for admin views. Does **not** affect the LLM context (the SDK manages that natively). |

### Background Tasks

Background tasks (sub-agents, scheduled jobs) use **ephemeral sessions** — each task gets its own short-lived session that is not cached or reused. This is by design: background tasks are independent, self-contained operations.

---

## Copilot SDK Session History & Analytics

The Admin panel's **Sessions** tab provides full visibility into both OpenZigs platform sessions and the underlying Copilot SDK sessions. This surfaces session metadata, conversation replay, resume capabilities, and lifecycle analytics.

### Admin Sessions Panel

The Sessions admin panel has three tabs:

| Tab | Description |
|---|---|
| **App Sessions** | OpenZigs-managed sessions (JSONL-backed). Shows channel, user, last active time, conversation history. Supports delete and restore-to-chat. |
| **Copilot SDK Sessions** | Sessions maintained by the Copilot SDK (`client.listSessions()`). Shows session ID, repo/branch context, summary, remote/local badge. Supports resume, message replay, and delete. |
| **Analytics** | Real-time counters for sessions created, resumed, destroyed, and context compactions. Shows a timeline of lifecycle events. Counters can be reset. |

### Copilot SDK Sessions

Each SDK session displays:
- **Session ID** — unique identifier (truncated in UI, full on hover)
- **Context** — repository, branch, working directory, and git root (if available)
- **Summary** — SDK-generated session summary (when available)
- **Remote/Local badge** — whether the session is running remotely
- **Timestamps** — creation time and last modified time

**Actions per session:**
- **Resume** — resumes the session and returns a conversation ID for continued chat
- **Replay** — expand to view the full event stream (user messages, assistant responses, tool executions, session lifecycle events)
- **Delete** — permanently deletes the SDK session
- **Search** — filter sessions by ID, summary, repository, or branch

### Session Analytics

Analytics tracks four counters since the last reset:
- **Sessions Created** — new SDK sessions created via `createSession()`
- **Sessions Resumed** — existing sessions restored via `resumeSession()`
- **Sessions Destroyed** — sessions explicitly destroyed
- **Compaction Count** — number of automatic context compactions triggered by infinite sessions

The lifecycle events timeline shows recent SDK lifecycle events (`session.created`, `session.deleted`, `session.updated`, `session.foreground`, `session.background`) with timestamps.

### API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/admin/copilot-sessions` | List all SDK sessions. Optional query filters: `repository`, `branch`, `cwd`, `gitRoot`. |
| `DELETE` | `/api/admin/copilot-sessions/:sessionId` | Delete an SDK session. |
| `POST` | `/api/admin/copilot-sessions/:sessionId/resume` | Resume a session, returns `{ conversationId, metadata }`. |
| `GET` | `/api/admin/copilot-sessions/:sessionId/messages` | Get all events for a session (conversation replay). |
| `GET` | `/api/admin/copilot-sessions/analytics` | Get session analytics counters and lifecycle events. |
| `POST` | `/api/admin/copilot-sessions/analytics/reset` | Reset analytics counters. |

---

## Tool Limit Configuration

OpenZigs registers 90+ MCP tools, but sending all of them to the LLM in every request wastes context window tokens and can degrade response quality. The **tool limit** controls how many tools are included per LLM call.

### Why It Matters

Each tool schema consumes **~100-300 tokens** in the model's context window. With 91 tools, that's **9,000-27,000 tokens** used before any conversation happens. This can cause:

- **Reduced conversation capacity** — fewer tokens available for chat history and responses.
- **Hallucinated tool calls** — weaker models may "invent" tool calls with incorrect parameters when overwhelmed with schemas.
- **Slower responses** — more input tokens = longer processing time.

The Copilot SDK itself has **no hard tool limit**, but the underlying models do (e.g., OpenAI supports up to 128 functions per request).

### Always-On Tools

**7 critical tools** are always included regardless of the cap:

`read-file`, `list-directory`, `web-search`, `browser-navigate`, `shell-execute`, `spawn-agent`, `orchestrate-agents`

These tools are essential for core agent functionality and will never be silently dropped.

### Admin UI

Navigate to **http://localhost:3001/admin** and find the **Tool Limit per Request** slider in the Task Engine panel:

- **Range:** 1–128 tools
- **Default:** 30
- **±5 buttons** for quick adjustment
- **Current stats** displayed: total registered tools, always-on count
- **Immediate effect** — changes apply to the next LLM request without restarting the server

The setting is persisted to `~/.openzigs/config.json` under `session.maxToolsPerRequest`.

### REST API

```bash
# Read current session config
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/admin/session/config
# Response: { "maxToolsPerRequest": 30, "totalTools": 91, "alwaysOnCount": 7 }

# Update the tool limit
curl -X PUT -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"maxToolsPerRequest": 50}' \
  http://localhost:3000/api/admin/session/config
```

### Recommendations

| Scenario | Suggested Limit | Why |
|---|---|---|
| Default / general use | **30** | Balances capability vs. context budget. |
| Lightweight chat only | **15-20** | Faster responses, more room for conversation history. |
| Full-featured (all sidecars active) | **50-80** | Ensures sidecar tools are included. |
| Maximum coverage | **128** | All tools included — monitor for quality degradation. |

---

## Per-Entity Tool Scoping

Beyond the global tool limit, OpenZigs supports **per-entity tool scoping** — restricting which tools are available for a specific scheduled job, saved prompt, or chat message. This lets you lock down a job to only the tools it needs, or give a prompt access to a curated toolset.

### How It Works

Each entity (job, prompt, or message) can declare an allowlist of tool names. When the entity executes, only those tools (plus the 7 always-on tools) are sent to the LLM. If no allowlist is set, the full enabled toolset is used as before.

**Resolution algorithm:**

1. Start with the entity's tool allowlist (e.g., `["web-search", "read-file"]`).
2. Merge in the 7 always-on tools (`read-file`, `list-directory`, `web-search`, `browser-navigate`, `shell-execute`, `spawn-agent`, `orchestrate-agents`).
3. Filter to only tools currently enabled in the `ToolRegistry`.
4. Pass the resulting set to the LLM — no other tools are visible.

### Scheduled Jobs (`allowedTools`)

Restrict a cron job to a specific set of tools:

```bash
# Create a job scoped to web-search and read-file only
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "news-digest",
    "cron": "0 7 * * *",
    "action": "prompt",
    "promptText": "Find the top 5 AI news stories from today",
    "allowedTools": ["web-search", "read-file"]
  }' \
  http://localhost:3000/api/jobs

# Update a job to change its allowed tools
curl -X PUT -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"allowedTools": ["web-search", "browser-navigate", "read-file"]}' \
  http://localhost:3000/api/jobs/1

# Clear tool scoping (use all enabled tools)
curl -X PUT -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"allowedTools": null}' \
  http://localhost:3000/api/jobs/1
```

When a scoped job executes, only the listed tools plus always-on tools are sent to the LLM. This is useful for security-sensitive jobs (e.g., a reporting job that should never call `shell-execute`) or for reducing token consumption on simple jobs.

### Saved Prompts (`preferredTools`)

Attach a preferred toolset to a saved prompt template:

```bash
# Create a prompt with preferred tools
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "code-review",
    "content": "Review the code in {{file}} for security issues",
    "preferredTools": ["read-file", "list-directory", "shell-execute"]
  }' \
  http://localhost:3000/api/prompts

# Update preferred tools
curl -X PUT -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"preferredTools": ["read-file", "web-search"]}' \
  http://localhost:3000/api/prompts/1

# Clear preferred tools
curl -X PUT -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"preferredTools": null}' \
  http://localhost:3000/api/prompts/1
```

The `resolveWithTools()` method returns both the interpolated prompt text and its preferred tools, making it easy for callers to scope tool access when executing a prompt.

### Web Chat Messages (`tools`)

The web chat Socket.IO interface accepts an optional `tools` array per message:

```javascript
// Client-side: send a message with tool scoping
socket.emit('chat:message', {
  content: 'Search for the latest TypeScript release notes',
  model: 'gpt-4.1',
  tools: ['web-search', 'browser-navigate']
});
```

When `tools` is provided, only those tools (plus always-on tools) are available for that specific message. This is useful for building UI controls that let users restrict tool access per-message — for example, a "search only" mode or a "code only" mode.

### Scoping Summary

| Entity | Field | API | Effect |
|--------|-------|-----|--------|
| Scheduled Job | `allowedTools` | `POST/PUT /api/jobs` | Restricts tools when the job fires |
| Saved Prompt | `preferredTools` | `POST/PUT /api/prompts` | Attaches tool preferences to the prompt |
| Chat Message | `tools` | Socket.IO `chat:message` | Restricts tools for that single message |

All three scopes follow the same resolution: **entity allowlist ∪ always-on tools ∩ enabled tools**.

> **Tip:** For a deeper analysis of tool selection strategies, token costs, and future plans, see [docs/rfc-tool-selection-strategy.md](rfc-tool-selection-strategy.md).

---

## Interactive Clarifications

During a conversation, the AI agent may need additional information from you before continuing — for example, to choose between multiple options or confirm a detail. When this happens, a **clarification prompt** appears inline in the chat.

### How It Works

1. The agent encounters an ambiguous situation during tool execution.
2. A styled prompt card appears in the chat with a question — either a set of **radio-button choices** or a **free-text input** (or both).
3. Select a choice or type your answer, then click **Submit** (or press **Enter** in the text field).
4. The prompt transitions to an "Answered" state showing your response, and the agent continues execution.

### Timeout

If you don't respond within **60 seconds**, the prompt shows a "Timed out" state and the agent auto-skips the clarification, continuing with a best-effort default. A countdown bar above the Submit button shows remaining time. This prevents conversations from hanging indefinitely.

### Background Tasks

Background tasks (sub-agents, scheduled jobs) **never** prompt for clarifications. They automatically skip all input requests so they can run unattended. If a background task encounters an ambiguous situation, it proceeds with the default behavior instead of blocking.

### Messaging Channels

Interactive clarifications are currently supported only in the **Web Chat** UI. Telegram and Discord channels auto-skip clarification prompts. Support for these channels is planned for a future release.

---

## Model Selection

The Chat page includes a model selector in the header bar.

1. Click the dropdown to see available models (fetched from the Copilot SDK).
2. Select a model. Your choice is:
   - **Applied immediately** to the next message you send.
   - **Persisted** to `config/user.json` so it survives page refreshes.

You can also set the default model from the **Admin** page under the Channels panel.

Available models depend on your Copilot subscription. Common options include:

| Model | Description |
|---|---|
| `gpt-4.1` | Default. Strong general-purpose reasoning. |
| `claude-sonnet-4` | Anthropic's Claude, available through Copilot. |

---

## File Attachments

When using the Web Chat, you can attach files and directories to your messages for the AI to reference during its response. Attachments are passed to the Copilot SDK alongside the prompt and provide the model with file contents or directory structure context.

### Supported Attachment Types

| Type | Description |
|---|---|
| `file` | A single file — the SDK reads its content and makes it available to the model. |
| `directory` | A directory path — the SDK provides the directory's structure as context. |
| `selection` | A code selection — a highlighted range within a file (with optional `startLine` / `endLine`). |

### Socket.IO Interface

Include a `files` array in the `chat:message` event:

```javascript
socket.emit('chat:message', {
  content: 'Review this code for bugs',
  files: [
    { type: 'file', path: '/home/user/project/src/app.ts', displayName: 'app.ts' },
    { type: 'directory', path: '/home/user/project/src' },
    { type: 'selection', path: '/home/user/project/src/utils.ts', startLine: 10, endLine: 25 }
  ]
});
```

### Working Directory

A **working directory** sets the base path for all tool operations (file reads, shell commands, etc.) during a conversation. You can set it per-message or as a server-wide default.

**Per-message** (Socket.IO):

```javascript
socket.emit('chat:message', {
  content: 'List all TypeScript files',
  workingDirectory: '/home/user/my-project'
});
```

**Server-wide default** (config):

```json
{
  "copilot": {
    "defaultWorkingDirectory": "/home/user/projects/main"
  }
}
```

Per-message values override the server default.

---

## Reasoning Effort

Reasoning effort controls how deeply the model reasons through a problem before responding. Higher effort produces more thorough answers at the cost of latency and token usage. This setting is passed to the Copilot SDK's `reasoningEffort` parameter.

| Level | Behavior |
|---|---|
| `low` | Quick responses, minimal reasoning. Good for simple lookups. |
| `medium` | Balanced (default). Suitable for most tasks. |
| `high` | Extended reasoning. Better for complex code generation, debugging, and planning. |
| `xhigh` | Maximum reasoning. Best for difficult multi-step problems, architecture design, and thorough analysis. |

### Configuration

**Admin API:**

```bash
# Get current model config
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/admin/models/config

# Set reasoning effort
curl -X PUT -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"reasoningEffort": "high"}' \
  http://localhost:3000/api/admin/models/config
```

**Config file** (`config/default.json` or `~/.openzigs/config.json`):

```json
{
  "copilot": {
    "defaultReasoningEffort": "high"
  }
}
```

Changes take effect on the next LLM request without restarting the server.

---

## Context Fuel Gauge

![Context Fuel Gauge — progress bar showing real-time context window usage in the chat header](images/chat-context-fuel-gauge.png)

The chat header includes a **Context Fuel Gauge** — a compact progress bar that shows real-time context window usage as the conversation progresses. It sits between the model selector and the connection indicator.

### Color States

| Context Usage | Color | Meaning |
|---|---|---|
| 0–50% | 🟢 Green | Plenty of context remaining. |
| 50–75% | 🟡 Yellow | Context filling up — consider starting a new chat soon. |
| 75–90% | 🟠 Orange | Context window nearly full. |
| 90–100% | 🔴 Red | Context critical — compaction imminent or in progress. |

### Features

- **Percentage display** — Shows the fill ratio as a percentage (e.g., "42%").
- **Token count tooltip** — Hover over the gauge to see the exact token count (e.g., "53,760 tokens").
- **Compaction indicator** — The gauge pulses with an amber glow when the SDK is actively compacting context in the background.
- **Auto-reset** — The gauge resets to 0% when you click "New Chat" to clear the session.

### How It Works

The gauge subscribes to real-time `context:usage` Socket.IO events emitted by the server whenever the Copilot SDK reports token consumption. The fill ratio is calculated as:

$$\text{fillRatio} = \frac{\text{inputTokens}}{\text{contextWindow}}$$

The context window size is determined by the currently selected model (e.g., 128K for GPT-4o, 200K for Claude Sonnet 4, 1M for GPT-4.1).

---

## Session Context Bar

The Chat page displays a **session context bar** below the header, providing real-time visibility into the current session's state.

### Indicators

| Indicator | Description |
|---|---|
| **Session ID** | Truncated session ID with a copy-to-clipboard button. Click to copy the full ID. |
| **Context Gauge** | Colored progress bar showing context window usage (0–100%). Colors transition from green → amber → orange → red as usage increases. Pulses when above 80%. |
| **Turn Count** | Number of conversation turns in the current session. |
| **Session Age** | Relative time since session creation (e.g., "5m ago", "2h ago"). |
| **Compaction Spinner** | Appears when background context compaction is in progress. Disappears when compaction completes. |

### Context Thresholds

| Usage | Color | Meaning |
|---|---|---|
| 0–60% | 🟢 Green | Normal — plenty of context remaining. |
| 60–80% | 🟡 Amber | Context filling up. |
| 80–95% | 🟠 Orange | Compaction will start soon (pulsing animation). |
| 95–100% | 🔴 Red | Context nearly full — may block requests. |

### Socket Events

The context bar updates via the following real-time Socket.IO events:

| Event | Direction | Payload |
|---|---|---|
| `session:status` | Server → Client | `{ sessionId, contextUsage, turnCount, createdAt, isResumed, compactionActive, infiniteSessionsEnabled }` |
| `compaction:start` | Server → Client | *(empty)* — triggers a toast notification and spinner |
| `compaction:complete` | Server → Client | *(empty)* — triggers a toast notification and hides spinner |

---

## BYOK Provider (Bring Your Own Key)

OpenZigs supports connecting to alternative LLM providers via the Copilot SDK's **provider** configuration. This allows you to use your own API keys with OpenAI-compatible endpoints, Azure OpenAI, Anthropic, or Ollama.

### Supported Provider Types

| Provider | Description |
|---|---|
| `openai` | OpenAI API or any OpenAI-compatible endpoint (e.g., Together AI, Fireworks, local vLLM). |
| `azure` | Azure OpenAI Service with optional API version. |
| `anthropic` | Anthropic Claude API (direct access, not through Copilot). |
| `ollama` | Local Ollama instance for running open-weight models. |

### Configuration

**Admin API:**

```bash
# Set an OpenAI-compatible provider
curl -X PUT -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": {
      "type": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-..."
    }
  }' \
  http://localhost:3000/api/admin/models/config

# Set Ollama (local)
curl -X PUT -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": {
      "type": "ollama",
      "baseUrl": "http://localhost:11434"
    }
  }' \
  http://localhost:3000/api/admin/models/config

# Clear provider (revert to GitHub Copilot)
curl -X PUT -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"provider": null}' \
  http://localhost:3000/api/admin/models/config
```

**Config file** (`config/default.json` or `~/.openzigs/config.json`):

```json
{
  "copilot": {
    "provider": {
      "type": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-your-key"
    }
  }
}
```

### Provider Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | Yes | Provider type: `openai`, `azure`, `anthropic`, `ollama`. |
| `baseUrl` | string | Yes | API base URL. |
| `apiKey` | string | No | API key (used for `openai`, `azure`, `anthropic`). |
| `bearerToken` | string | No | Alternative to `apiKey` — passed as Bearer token. |
| `wireApi` | string | No | OpenAI only: `"openai"` or `"anthropic"` wire format. |
| `azure.apiVersion` | string | No | Azure only: API version string (e.g., `"2024-02-15-preview"`). |

> **Note:** Changing the provider clears all cached SDK sessions. The next message will create a fresh session with the new provider.

---

## Custom Agents (Hierarchical Sub-Agents)

OpenZigs supports native hierarchical agents via the Copilot SDK's `customAgents` API. Custom agents are specialized sub-agents that the primary model can delegate to for domain-specific tasks. Each agent has its own system prompt, tool access, and identity.

### Default Agent Archetypes

OpenZigs ships with five built-in agent archetypes defined in `config/agents.json`:

| Name | Display Name | Description |
|------|-------------|-------------|
| `researcher` | Research Agent | Deep web research and analysis with full tool access |
| `coder` | Code Agent | Code generation and file operations (read-file, write-file, list-directory, shell-execute) |
| `writer` | Writing Agent | Content writing and editing (read-file, write-file, list-directory, web-search) |
| `analyst` | Data Analyst | Data analysis and visualization with full tool access |
| `reviewer` | Code Reviewer | Code review and quality assurance (read-file, list-directory, shell-execute) |

### Configuration

Add custom agents in your user config (`~/.openzigs/config.json`) or `config/default.json` under `copilot.customAgents`:

```json
{
  "copilot": {
    "customAgents": [
      {
        "name": "security-auditor",
        "displayName": "Security Auditor",
        "description": "Specialized in security analysis and vulnerability assessment",
        "prompt": "You are an expert security auditor. Analyze code for vulnerabilities, review dependencies, and suggest hardening measures.",
        "tools": ["read-file", "list-directory", "shell-execute", "web-search"],
        "infer": false
      }
    ]
  }
}
```

User-configured agents override default archetypes when they share the same `name`. Agents not overridden are kept from`config/agents.json`.

### Agent Definition Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique agent identifier (used for delegation). |
| `displayName` | string | Yes | Human-readable label shown in responses. |
| `description` | string | No | Brief description of the agent's specialty. |
| `prompt` | string | Yes | System prompt defining the agent's behavior. |
| `tools` | string[] \| null | No | Tool allowlist for this agent (`null` = all tools). |
| `infer` | boolean | No | Whether the SDK infers when to delegate to this agent. |
| `mcpServers` | object | No | Per-agent MCP server connections (see Native MCP Servers below). |

### Admin API

```bash
# List all custom agents
curl http://localhost:3000/api/admin/agents

# Add a new agent
curl -X POST http://localhost:3000/api/admin/agents \
  -H "Content-Type: application/json" \
  -d '{"name":"qa","displayName":"QA Agent","prompt":"You test software."}'

# Replace all agents
curl -X PUT http://localhost:3000/api/admin/agents \
  -H "Content-Type: application/json" \
  -d '{"agents":[...]}'

# Remove an agent
curl -X DELETE http://localhost:3000/api/admin/agents/qa
```

### Per-Chat Override

Custom agents can also be specified per-chat call via the `customAgents` option. Per-call agents merge with defaults — agents with the same `name` are overridden, new agents are appended.

---

## Native MCP Servers

OpenZigs supports native MCP (Model Context Protocol) server connections via the Copilot SDK's built-in `mcpServers` API. This is the recommended way to connect external MCP servers — it replaces the legacy subprocess-based `LocalMcpServerManager`.

### Configuration

Add native MCP servers in `~/.openzigs/config.json` or `config/default.json` under `copilot.nativeMcpServers`:

```json
{
  "copilot": {
    "nativeMcpServers": {
      "my-database": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-postgres"],
        "env": { "DATABASE_URL": "postgresql://localhost:5432/mydb" }
      },
      "remote-tools": {
        "type": "http",
        "url": "https://mcp.example.com/tools",
        "headers": { "Authorization": "Bearer ${MCP_API_KEY}" }
      }
    }
  }
}
```

### Server Types

| Type | Transport | Required Fields | Description |
|------|-----------|----------------|-------------|
| `stdio` | Subprocess | `command` | Spawns a local process communicating via stdin/stdout |
| `local` | Subprocess | `command` | Alias for `stdio` |
| `http` | HTTP | `url` | Connects to an HTTP-based MCP server |
| `sse` | Server-Sent Events | `url` | Connects to an SSE-based MCP server |

### Server Definition Fields

| Field | Type | Applies To | Description |
|-------|------|-----------|-------------|
| `type` | string | All | Server type: `"stdio"`, `"local"`, `"http"`, or `"sse"` |
| `command` | string | stdio/local | Command to spawn (e.g., `"npx"`, `"uvx"`, `"python3"`) |
| `args` | string[] | stdio/local | Command arguments |
| `env` | object | stdio/local | Environment variables for the subprocess |
| `cwd` | string | stdio/local | Working directory for the subprocess |
| `url` | string | http/sse | Server URL |
| `headers` | object | http/sse | HTTP headers (e.g., auth tokens) |
| `tools` | string[] | All | Tool allowlist (only expose these tools from the server) |
| `timeout` | number | All | Connection timeout in milliseconds |

### Admin API

```bash
# List configured native MCP servers
curl http://localhost:3000/api/admin/native-mcp-servers

# Replace all native MCP servers
curl -X PUT http://localhost:3000/api/admin/native-mcp-servers \
  -H "Content-Type: application/json" \
  -d '{"servers":{"my-server":{"type":"stdio","command":"npx","args":["-y","my-mcp-server"]}}}'

# Test a native MCP server config without saving
curl -X POST http://localhost:3000/api/admin/native-mcp-servers/test \
  -H "Content-Type: application/json" \
  -d '{"serverName":"my-server","server":{"type":"stdio","command":"npx","args":["-y","my-mcp-server"]}}'
```

### MCP Connection Wizard (Admin UI)

Native MCP servers are now managed through a step-by-step wizard in **Admin → Native MCP Servers**:

1. **Step 1:** Choose server type (`Stdio`, `HTTP`, or `SSE`) and enter server name.
2. **Step 2:** Fill type-specific fields (command/args/env/cwd or url/headers) and timeout.
3. **Step 3:** Run **Test Connection** to validate connectivity and preview discovered tools.

![Native MCP wizard — step-by-step server setup and connection test](images/admin-native-mcp-wizard.png)
You can save without testing via **Skip Test**, but testing is recommended because successful tests populate discovered tool metadata shown in the Tools panel.

### System Busy Guard (Safe-Swap)

To avoid interrupting active workloads, MCP server config updates are blocked while tasks are running:

- Backend guard: `PUT/POST/DELETE /api/admin/native-mcp-servers*` returns `409` when `running + queued > 0`.
- UI guard: Add/Edit/Remove controls are disabled and an amber lock banner appears with running/queued counts.

When unlocked, config changes proceed normally.

### Auto-Discovered MCP Tools

After a successful connection test, discovered MCP tools appear in **Admin → Tools** under categories formatted as:

- `USER MCP: <SERVER-NAME>`

These entries are shown with a plug icon and can be toggled via `mcp:<server>:<tool>` identifiers. If a server is disconnected, the category shows a disconnected marker and the Native MCP card offers a **Reconnect** action.

> **Note:** Native MCP servers are managed by the Copilot SDK at the session level. Changing server configuration clears cached SDK sessions, so OpenZigs applies a busy guard to prevent swaps during active task execution. The `LocalMcpServerManager` path remains available for legacy local servers, but native MCP is the preferred path for new integrations.

---

## Enabling and Disabling Tools

Tools can be managed via the **Admin** page at `/admin` or via the REST API. Each tool can be toggled independently.

### Admin UI

Navigate to **http://localhost:3001/admin** and scroll to the **Tools** section. Tools are grouped by category (`filesystem`, `search`, `browser`, `shell`, `productivity`, `social`, `documents`, `personal`, `data`, `developer`). Each tool shows its risk level badge and a toggle switch.

For native MCP server tools, expand a server card and use the per-tool toggles to enable or disable individual tools within that server.

### REST API

#### List All Tools

```bash
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/tools | jq
```

Returns tools grouped by category (`filesystem`, `search`, `browser`, `shell`, `productivity`, `social`, `documents`), each showing `name`, `riskLevel`, and `enabled` status.

### Toggle a Tool

```bash
# Disable shell-execute
curl -X POST \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}' \
  http://localhost:3000/api/tools/shell-execute/toggle

# Enable it again
curl -X POST \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}' \
  http://localhost:3000/api/tools/shell-execute/toggle
```

Toggle state is persisted to `config/tools.json`. Disabled tools are **not** passed to the Copilot SDK; the model cannot call them.

---

## Connecting Telegram

For the full, step-by-step Telegram setup (including Cloudflare Tunnel and access control), see [docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md).

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather) and copy the token.

2. Set the token in your `.env`:

   ```dotenv
   TELEGRAM_BOT_TOKEN=123456:ABCdefGHIjklMNOpqrSTUvwxYZ
   ```

3. Enable the Telegram channel in `config/default.json`:

   ```json
   {
     "channels": {
       "telegram": {
         "enabled": true,
         "token": "${TELEGRAM_BOT_TOKEN}"
       }
     }
   }
   ```

4. **If you need webhooks** (e.g., for production or non-polling mode), enable the Cloudflare Tunnel:

   ```json
   {
     "tunnel": {
       "enabled": true,
       "mode": "quick"
     }
   }
   ```

   The agent prints the public URL on startup. Set the `webhookUrl` in your config to this URL + `/telegram/webhook`.

5. Restart the server. Send a message to your bot in Telegram — the agent responds.

### Access Control

Restrict which Telegram users can interact with the agent:

```json
{
  "channels": {
    "telegram": {
      "allowedUsers": ["123456789", "987654321"]
    }
  }
}
```

When `allowedUsers` is non-empty, only those Telegram user IDs may send messages. Everyone else receives "Unauthorized."

---

## Connecting Discord

1. Create a Discord application at the [Discord Developer Portal](https://discord.com/developers/applications).
2. Add a bot and copy the token.

3. Set the token in your `.env`:

   ```dotenv
   DISCORD_BOT_TOKEN=your-discord-bot-token
   ```

4. Enable the Discord channel in `config/default.json`:

   ```json
   {
     "channels": {
       "discord": {
         "enabled": true,
         "token": "${DISCORD_BOT_TOKEN}",
         "allowedGuilds": ["your-guild-id"]
       }
     }
   }
   ```

5. Invite the bot to your server using the OAuth2 URL from the Developer Portal.

6. Restart the server. DM the bot or mention it in a channel — the agent responds.

---

## Chrome DevTools Setup

The `browser-read` tool connects to a running Chrome instance via the Chrome DevTools Protocol. This is required if you want the agent to read web page content.

1. Launch Chrome with remote debugging:

   ```bash
   # macOS
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
     --remote-debugging-port=9222

   # Linux
   google-chrome --remote-debugging-port=9222

   # Windows
   start chrome --remote-debugging-port=9222
   ```

2. Set the environment variables (default values shown):

   ```dotenv
   CHROME_DEBUG_HOST=localhost
   CHROME_DEBUG_PORT=9222
   ```

3. If running the agent in Docker, Chrome runs on the host machine and the agent reaches it via `host.docker.internal:9222`.

---

## Enabling Voice Features

OpenZigs includes an optional voice interface with two capabilities:

- **"Hey Zigs" wake word**: Hands-free voice input via the browser's Web Speech API with fuzzy matching.
- **Text-to-Speech (TTS)**: AI responses read aloud using Google Cloud Text-to-Speech with file system caching.

### Prerequisites

| Requirement | Purpose |
|---|---|
| **Google Cloud Project** | Required for TTS. Free tier includes 1M characters/month for Standard voices, 1M bytes for Neural2/Journey voices. |
| **Chrome / Edge / Brave** | The wake word feature requires a browser with Web Speech API support. |

### Step 1: Set Up Google Cloud TTS

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or use an existing one).
3. Enable the **Cloud Text-to-Speech API**:
   ```
   Navigation menu → APIs & Services → Library → Search "Text-to-Speech" → Enable
   ```
4. Create a service account:
   ```
   Navigation menu → IAM & Admin → Service Accounts → Create Service Account
   ```
   - Name: `openzigs-tts`
   - Role: None required (TTS API doesn't need IAM roles)
5. Create a JSON key:
   - Click the service account → Keys → Add Key → Create new key → JSON
   - Save the downloaded file to a secure location (e.g., `~/.openzigs/gcp-tts-key.json`)
6. Set the environment variable:
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.openzigs/gcp-tts-key.json"
   ```
   Or add to your `.env` file:
   ```dotenv
   GOOGLE_APPLICATION_CREDENTIALS=/Users/you/.openzigs/gcp-tts-key.json
   ```
  You can also set this path from **Admin → Environment → Voice TTS credentials** in the web UI.

### Step 2: Enable Voice in Configuration

In `config/default.json` or `~/.openzigs/config.json`:

```json
{
  "voice": {
    "enabled": true,
    "provider": "google",
    "voiceName": "en-US-Standard-C",
    "speakingRate": 1.0,
    "pitch": 0.0,
    "cacheDir": "~/.openzigs/voice-cache",
    "maxCacheSizeMb": 500,
    "maxTextLength": 5000
  }
}
```

### Step 3: Restart the Server

```bash
pnpm dev
```

On startup, you should see:
```
Voice service initialized (provider: google, voice: en-US-Standard-C)
```

### Using Voice in the Chat

Once enabled, two new buttons appear in the chat header:

![Voice controls in the chat header](images/voice-controls-chat.png)

| Button | Icon | Action |
|---|---|---|
| **Mic toggle** | 🎤 / 🎤✕ | Start/stop wake word listening |
| **Speaker toggle** | 🔊 / 🔇 | Enable/disable TTS for AI responses |

**Wake word flow:**

1. Click the **mic button** to enter STANDBY mode (blue pulsing indicator).
2. Say **"Hey Zigs"** followed by your question (e.g., "Hey Zigs, what's the weather?").
3. The indicator turns green (ACTIVE) while capturing your query.
4. After 5 seconds of silence, the captured query is submitted as a chat message.
5. The system returns to STANDBY, listening for the next wake word.

**TTS flow:**

1. Click the **speaker button** to enable TTS output.
2. When the AI responds, the last assistant message is read aloud via Google Cloud TTS.
3. Say "Hey Zigs" during playback to interrupt the audio.

**Cost control (free tier):**

- To stay in the largest free tier, use a **Standard** voice (recommended: `en-US-Standard-C`).
- You can change this in **Admin → Environment → Voice TTS voice**.

### Voice Configuration Reference

| Key | Type | Default | Description |
|---|---|---|---|
| `voice.enabled` | boolean | `false` | Enable/disable voice features globally. |
| `voice.provider` | string | `"google"` | TTS provider (currently only Google Cloud). |
| `voice.voiceName` | string | `"en-US-Standard-C"` | Google Cloud voice name. Use Standard voices for free-tier-preferred usage. |
| `voice.speakingRate` | number | `1.0` | Speech rate (0.25–4.0). |
| `voice.pitch` | number | `0.0` | Pitch adjustment (-20 to 20 semitones). |
| `voice.cacheDir` | string | `"~/.openzigs/voice-cache"` | Directory for cached audio files. |
| `voice.maxCacheSizeMb` | number | `500` | Maximum cache size in MB (LRU eviction). |
| `voice.maxTextLength` | number | `5000` | Maximum characters per TTS request. |

### Available Voices

| Voice ID | Type | Pricing Tier | Description |
|---|---|---|---|
| `en-US-Standard-A` | Standard | Free-tier preferred | Male, generic American |
| `en-US-Standard-B` | Standard | Free-tier preferred | Male, slightly deeper |
| `en-US-Standard-C` | Standard | Free-tier preferred | Female, clear assistant style |
| `en-US-Standard-D` | Standard | Free-tier preferred | Male, news anchor style |
| `en-US-Standard-E` | Standard | Free-tier preferred | Female, slightly higher pitch |
| `en-US-Neural2-A` | Neural2 | Paid tier | Male, natural |
| `en-US-Neural2-C` | Neural2 | Paid tier | Female, natural |
| `en-US-Neural2-J` | Neural2 | Paid tier | Male, deeper voice |
| `en-US-Journey-D` | Journey | Paid tier | Male, conversational |
| `en-US-Journey-F` | Journey | Paid tier | Female, conversational |

### Voice REST API

```bash
# Synthesize text to speech (returns MP3 audio stream)
curl -X POST -H "Content-Type: application/json" \
  -d '{"text": "Hello from OpenZigs"}' \
  http://localhost:3000/api/voice/speak -o hello.mp3

# Get voice configuration and available voices
curl http://localhost:3000/api/voice/config

# Get cache statistics
curl http://localhost:3000/api/voice/cache

# Clear the TTS cache
curl -X DELETE http://localhost:3000/api/voice/cache
```

### Browser Compatibility (Wake Word)

| Browser | Web Speech API | Notes |
|---|---|---|
| Chrome 90+ | ✅ Supported | Full support, recommended |
| Edge 90+ | ✅ Supported | Uses Chromium engine |
| Brave | ✅ Supported | Uses Chromium engine |
| Firefox | ❌ Not supported | Web Speech API not available |
| Safari | ⚠️ Partial | Recognition available but may require permission |

### Troubleshooting Voice

| Symptom | Likely Cause | Fix |
|---|---|---|
| Voice buttons not visible | `voice.enabled` is `false` or browser doesn't support Web Speech API | Set `voice.enabled: true` in config. Use Chrome. |
| TTS returns 503 | `GOOGLE_APPLICATION_CREDENTIALS` not set | Set the env var pointing to your service account JSON key. |
| TTS returns 429 | Google Cloud quota exceeded | Check your project's quota dashboard. Free tier allows 1M chars/month. |
| Mic not working | Browser blocked microphone access | Click the lock icon in the address bar → allow microphone. |
| Wake word not detected | Background noise or unclear speech | Speak clearly and say "Hey Zigs" distinctly. Try lowering `fuzzyThreshold`. |
| Audio not playing | Browser autoplay policy | Click the speaker toggle to explicitly enable TTS (user gesture required). |

### Pricing

Google Cloud TTS pricing (as of 2025):

| Voice Type | Free Tier | Paid Tier |
|---|---|---|
| Standard | 4M characters/month | $4/1M characters |
| WaveNet | 1M characters/month | $16/1M characters |
| Neural2 | 1M bytes/month | $16/1M bytes |
| Journey | 1M bytes/month | $16/1M bytes |

The cache system significantly reduces API calls — repeated queries hit the local cache instead of calling Google.

### Local Voice Provider (Audio Sidecar)

As an alternative to Google Cloud TTS, OpenZigs supports a **local audio sidecar** that runs speech synthesis (TTS) and speech-to-text (STT) entirely on your machine using Apple Silicon (MPS) or CUDA acceleration — no cloud API keys, no per-character costs.

#### Prerequisites

| Requirement | Purpose |
|---|---|
| **Python 3.12+** | Runs the audio sidecar server. |
| **Apple Silicon Mac** (or CUDA GPU) | MLX models require Metal Performance Shaders or CUDA. |
| **ffmpeg** | Required for audio format conversion during transcription. |

#### Setup

1. Start the audio sidecar:
   ```bash
   cd sidecars/audio
   pip install -r requirements.txt
   python server.py --port 5006
   ```

   Or via Docker Compose:
   ```bash
   docker compose up -d audio-sidecar
   ```

2. Configure the voice provider in `~/.openzigs/config.json`:
   ```json
   {
     "voice": {
       "enabled": true,
       "provider": "local",
       "sidecarUrl": "http://localhost:5006"
     }
   }
   ```

3. Restart the server. You should see:
   ```
   Voice service initialized (provider: local, sidecar: http://localhost:5006)
   ```

#### Local Model Downloads & Git

- `pip install -r requirements.txt` installs Python packages only — it does **not** download ML weight files.
- Model weights are fetched automatically on first use:
  - First `POST /tts` downloads Kokoro (`mlx-community/Kokoro-82M-bf16`)
  - First `POST /transcribe` downloads Whisper (`distil-large-v3`)
- OpenZigs ignores these artifacts in git. They are runtime-generated and should not be committed.

**Default local cache locations (repo-local):**

- `sidecars/audio/mlx_models/` (Whisper MLX model files)
- `sidecars/audio/.cache/huggingface/` (Hugging Face cache)

You can prefetch models after startup by calling `/tts` and `/transcribe` once, then check `GET /health` to confirm both models are loaded.

#### Available Local Voices

The sidecar provides 19 Kokoro voice presets across 4 languages:

| Language | Voices |
|---|---|
| **American English** | Heart (F), Bella (F), Nicole (F), Sarah (F), Sky (F), Adam (M), Michael (M) |
| **British English** | Emma (F), Isabella (F), George (M), Lewis (M) |
| **Japanese** | Alpha (F), Beta (M), Gamma (F) |
| **Chinese** | Xiaobei (F), Xiaoniu (F), Yunjian (M), Yunxi (M), Yunyang (M) |

Preview voices from **Admin → Voice & Audio** in the web UI.

#### Push-to-Talk Voice Input

With the audio sidecar running, a **microphone button** (🎤) appears in the chat input area, next to the file attachment button. This provides push-to-talk voice transcription:

1. **Click** the mic button to start recording (or hold to record, release to stop).
2. Speak your message.
3. **Click again** (or release) to stop recording.
4. The audio is transcribed via the local sidecar and inserted into the text input.
5. Press Enter to send (or edit the transcribed text first).

This uses the browser's `MediaRecorder` API and sends audio to the sidecar's `/transcribe` endpoint — no Google Cloud or browser Speech API required.

#### Admin Voice Panel

The **Admin → Voice & Audio** panel shows:

- **Provider status**: Local or Google Cloud, with health indicator.
- **Sidecar health**: Online/offline status with URL display.
- **Loaded models**: TTS (Kokoro, ~330MB) and STT (Whisper, ~1.5GB) with independent load/unload controls.
- **Voice browser**: All 19 local voices with preview playback.

#### Memory Usage

| Model | Approximate VRAM |
|---|---|
| Kokoro TTS (Kokoro-82M-bf16) | ~330 MB |
| Whisper STT (distil-large-v3) | ~1.5 GB |
| Both loaded | ~1.8 GB |

Models load lazily on first use and auto-unload after 5 minutes of inactivity (configurable via `AUDIO_IDLE_TIMEOUT` environment variable).

#### Ingesting Audio/Video into the Knowledge Base

When the audio sidecar is running, audio and video files dropped into the knowledge directory are automatically transcribed and indexed:

1. Place `.mp4`, `.mp3`, `.wav`, or other media files in your knowledge directory (default: `~/.openzigs/knowledge/`).
2. The knowledge ingestion service detects the file and routes it to the sidecar media converter.
3. The audio track is extracted via ffmpeg and sent to the sidecar for transcription.
4. The transcript (with timestamps) is chunked, embedded, and stored in the vector database.
5. You can now search spoken content via natural language queries.

**Media-aware search**: Queries containing media keywords ("video", "recording", "podcast") automatically boost results from media transcripts. Timestamp citations (e.g., `[meeting.mp4 @ 2:30 → 3:15]`) are included in search results.

---

## Docker Usage

### Full Stack (Recommended)

```bash
docker compose up -d
```

This starts the complete stack:

| Service | Description | Port |
|---|---|---|
| `agent` | OpenZigs agent server | 3000 |
| `tunnel` | Cloudflare Tunnel sidecar | — (proxies to `agent:3000`) |
| `audio-sidecar` | Local TTS + STT (MLX) | 5006 |

All MCP tool servers now run as **native subprocesses** via `LocalMcpServerManager` (12 servers: word, markitdown, gmail, database, github, calendar, instagram, facebook, twitter, youtube, linkedin, reddit). They are managed automatically by the agent — no Docker containers needed.

### Starting Individual Services

If you only need a subset of services:

```bash
# Agent + tunnel only
docker compose up -d agent tunnel

# Agent only (no tunnel, no audio sidecar)
docker compose up -d agent
```

> **Note:** If an MCP sidecar is not running, the corresponding tools will return connection errors when invoked. The agent does not currently health-check sidecars on startup.

### View Logs

```bash
docker compose logs -f           # All services
docker compose logs -f agent     # Agent only
docker compose logs -f tunnel    # Tunnel only
```

### Stop

```bash
docker compose down
```

### Development with Docker

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

This mounts the source directory for live-reload inside the container.

### Persistence

- **Session data and auth tokens** are stored in `~/.openzigs/` on the host (mounted as a Docker volume).
- **Pinterest OAuth tokens** are persisted in the `pinterest-tokens` Docker volume.
- **SQLite database** (prompts, jobs) is stored inside the agent container at the configured path. Data survives container restarts via the `~/.openzigs/` mount.

---

## Cloudflare Tunnel

The Cloudflare Tunnel provides a public HTTPS URL to reach your local agent. This is required for Telegram webhooks and Discord OAuth redirects.

### Docker Sidecar (Recommended)

In the recommended deployment, `cloudflared` runs as a separate container defined in `docker-compose.yml`. The agent does **not** manage the tunnel process — Docker Compose does.

1. Create a Cloudflare Tunnel in the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/) and copy the tunnel token.

2. Set the token in your `.env`:

   ```dotenv
   TUNNEL_TOKEN=your-cloudflare-tunnel-token
   ```

3. Ensure the agent's internal tunnel is **disabled** (this is the default):

   ```json
   {
     "tunnel": {
       "enabled": false
     }
   }
   ```

4. Start the stack:

   ```bash
   docker compose up -d
   ```

The `tunnel` service proxies public HTTPS traffic to `http://agent:3000` inside the Docker network. Set your Telegram `webhookUrl` to your Cloudflare hostname (e.g., `https://agent.example.com/telegram/webhook`).

### Embedded Quick Mode (Development)

For local development without Docker, the agent can spawn `cloudflared` as a child process:

```json
{
  "tunnel": {
    "enabled": true,
    "mode": "quick"
  }
}
```

Generates a temporary `https://xxx.trycloudflare.com` URL. No Cloudflare account required.

### Embedded Named Mode (Production without Docker)

```json
{
  "tunnel": {
    "enabled": true,
    "mode": "named",
    "namedTunnel": {
      "credentialsFile": "~/.cloudflared/credentials.json",
      "hostname": "agent.example.com"
    }
  }
}
```

Requires a Cloudflare account with a configured tunnel and DNS record.

---

## Productivity Tools

OpenZigs includes an embedded productivity engine backed by SQLite for saved prompts and cron-based job scheduling.

### Saved Prompts

Save reusable prompt templates with `{{variable}}` interpolation:

```
You: Save a prompt called "daily-standup" with content "Summarize the key updates from {{channel}} for {{date}}"
Agent: ✅ Saved prompt "daily-standup" (id: 1)

You: Run the prompt "daily-standup" with channel=telegram and date=today
Agent: [executes the resolved prompt]
```

**Available tools:** `save-prompt`, `get-prompt`, `list-prompts`, `update-prompt`, `delete-prompt`, `run-prompt`.

**REST API:**

```bash
# List all prompts
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/prompts

# Create a prompt
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "greeting", "content": "Hello {{name}}!"}' \
  http://localhost:3000/api/prompts
```

### Scheduled Jobs

Schedule automated cron jobs that the agent executes on a recurring basis:

```
You: Schedule a job called "morning-summary" to run at 8am every day with the action "Summarize yesterday's activity"
Agent: ✅ Scheduled job "morning-summary" (cron: 0 8 * * *)
```

**Available tools:** `schedule-job`, `list-jobs`, `get-job`, `update-job`, `delete-job`, `toggle-job`.

**REST API:**

```bash
# List all jobs
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/jobs

# Toggle a job on/off
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}' \
  http://localhost:3000/api/jobs/1/toggle
```

---

## Social Media Tools

Social media tools are powered by **native MCP servers** — Python subprocess servers managed by `LocalMcpServerManager`. Each platform has its own server in `external/` with full API coverage for posting, reading, analytics, DMs, and comment replies.

### Supported Platforms

| Platform | MCP Server | Publish Tool | Content Types | Key Tools |
|---|---|---|---|---|
| **Instagram** | `ig-mcp` | `instagram-publish-media` | Image, video (Reels), with caption | 11 tools: profile, posts, insights, DMs, comments |
| **Facebook** | `fb-mcp` | `facebook-publish-post` | Text, link, photo | 10 tools: page info, posts, Messenger, insights, comments |
| **Twitter/X** | `twitter-mcp` | `twitter-post-tweet` | Text (280 chars), replies | 8 tools: tweets, search, DMs, user lookup |
| **LinkedIn** | `linkedin-mcp` | `linkedin-create-post` | Text (PUBLIC or CONNECTIONS) | 8 tools: profile, posts, company, messages, comments |
| **Reddit** | `reddit-mcp` | `reddit-submit-post` | Text or link post to a subreddit | 8 tools: subreddits, posts, comments, search, inbox |
| **YouTube** | `youtube-mcp` | `youtube-upload-video` | Video file upload (resumable) with metadata | 8 tools: channel, videos, comments, search, analytics, **upload** |

> **Note — YouTube Upload Quota:** Each `youtube-upload-video` call consumes **1,600 quota units** (default daily quota: 10,000 units), limiting uploads to **~6 per day**. The upload uses the YouTube Data API v3 resumable upload protocol — provide a path to a local video file and the tool handles chunked transfer automatically. Uploads default to **private** privacy. Set `privacy_status` to `"public"` or `"unlisted"` as needed. Requires an OAuth2 token with the `youtube.upload` scope — see [YouTube OAuth Setup](#youtube-oauth-setup) in the Social Brain Guide.

### Posting Content

You can publish content to any supported platform by asking the agent in chat:

```
You: Post "Just shipped a new feature! 🚀" to LinkedIn
Agent: [calls linkedin-create-post] ✅ Posted to LinkedIn

You: Publish an Instagram post with caption "Summer vibes ☀️" using this image: https://example.com/photo.jpg
Agent: [calls instagram-publish-media] ✅ Published to Instagram

You: Tweet "Check out our latest blog post: https://example.com/blog"
Agent: [calls twitter-post-tweet] ✅ Tweeted

You: Submit a post to r/programming titled "My new open-source project" with a link
Agent: [calls reddit-submit-post] ✅ Submitted to r/programming

You: Post "Excited to announce our Series A! 🎉" to Facebook
Agent: [calls facebook-publish-post] ✅ Posted to Facebook Page

You: Upload /path/to/video.mp4 to YouTube titled "Product Demo" with tags ["demo", "product"]
Agent: [calls youtube-upload-video] ✅ Uploaded to YouTube (video ID: abc123, status: private)
```

The agent automatically selects the correct platform-specific tool and handles parameter mapping. For a comprehensive list of all tools per platform, see the [Social Brain Guide](SOCIAL_BRAIN_GUIDE.md#platform-specific-tools).

### Configuration

Each MCP server requires platform-specific API credentials set as environment variables in your `.env` file (see [Environment Variables](#3-configure-environment)). Servers start automatically when credentials are present. Manage server status and restart servers from the Admin UI under **MCP Servers**.

---

## Document Intelligence Tools

Document tools provide PDF reading, Word document generation, and Google Calendar integration.

### PDF Reading (Built-in)

The `read-pdf` tool runs locally inside the agent (no sidecar needed):

```
You: Read the PDF at /data/report.pdf and summarize it
Agent: [calls read-pdf] Here's a summary of the document: ...
```

### Word Document Creation (MCP Sidecar)

The `create-word-doc` tool proxies to the Word MCP sidecar:

```
You: Create a Word document with a project proposal
Agent: [calls create-word-doc via word-mcp-server] ✅ Document created
```

### Google Calendar (MCP Sidecar)

```
You: What meetings do I have this week?
Agent: [calls calendar-list] Here are your upcoming events: ...

You: Create a meeting called "Sprint Planning" next Monday at 10am
Agent: [calls calendar-create] ✅ Event created
```

---

## Personal Assistant Tools

Personal assistant tools connect OpenZigs to your email, databases, GitHub, and document processing pipelines.

### MarkItDown (Document Converter)

Converts PDF, DOCX, PPTX, XLSX, HTML, images, and audio files into Markdown for LLM consumption.

**Source:** [microsoft/markitdown](https://github.com/microsoft/markitdown)

```
You: Convert /data/report.pdf to markdown
Agent: [calls convert-to-markdown] Here’s the markdown content: ...

You: Summarize the PowerPoint at /data/deck.pptx
Agent: [calls convert-to-markdown, then summarizes] Key points: ...
```

**Setup:**

1. Build the Docker image:
   ```bash
   docker build -t markitdown-mcp:latest -f sidecars/markitdown/Dockerfile .
   ```

2. Enable in `config/default.json`:
   ```json
   { "mcpServers": { "sidecars": { "markitdown": { "enabled": true } } } }
   ```

3. Mount your data directory via Docker volumes so the server can access files.

### Gmail

Read, search, and send emails via Gmail.

**Source:** [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server)

```
You: Search my email for messages from john@example.com about invoices
Agent: [calls gmail-search] Found 3 emails: ...

You: Draft a reply to the latest one saying "Thanks, I’ll review this today"
Agent: [calls gmail-draft] ✅ Draft created

You: Send it
Agent: ⚠️ This action requires approval (gmail-send is high-risk)
[Approval overlay appears] Approve / Deny
```

**Setup:**

1. Create a Google Cloud project and enable the Gmail API.
2. Create OAuth 2.0 credentials and download `gcp-oauth.keys.json`.
3. Place credentials:
   ```bash
   mkdir -p ~/.gmail-mcp
   mv gcp-oauth.keys.json ~/.gmail-mcp/
   ```
4. Run initial auth:
   ```bash
   npx @gongrzhe/server-gmail-autoauth-mcp auth
   ```
5. Enable in config:
   ```json
   { "mcpServers": { "sidecars": { "gmail": { "enabled": true } } } }
   ```

> **Security:** `gmail-send` is classified as 🔴 high risk and requires human approval before execution.

### Database (JDBC)

Query any JDBC-compatible database (PostgreSQL, MySQL, SQLite, H2).

**Source:** [quarkiverse/quarkus-mcp-servers](https://github.com/quarkiverse/quarkus-mcp-servers/tree/main/jdbc)

```
You: List all tables in my database
Agent: [calls db-list-tables] Tables: users, orders, products, ...

You: Describe the orders table
Agent: [calls db-describe] Columns: id (int), user_id (int), total (decimal), created_at (timestamp)

You: How many orders were placed last month?
Agent: ⚠️ This action requires approval (db-query is high-risk)
[Approval overlay] SELECT COUNT(*) FROM orders WHERE created_at >= '2026-01-01'
Approve / Deny
```

**Setup:**

1. Install JBang: https://www.jbang.dev/download/
2. Set environment variables:
   ```dotenv
   JDBC_URL=jdbc:postgresql://localhost:5432/mydb
   DB_PASSWORD=your-password
   ```
3. Enable in config:
   ```json
   { "mcpServers": { "sidecars": { "database": { "enabled": true } } } }
   ```

> **Security:** `db-query` is classified as 🔴 high risk. The agent shows the exact SQL query in the approval prompt so you can verify it before execution.

### GitHub

Manage repositories, issues, pull requests, and code search.

**Source:** [github/github-mcp-server](https://github.com/github/github-mcp-server)

```
You: List open issues in mgcronin/openzigs
Agent: [calls github-list-issues] Found 12 open issues: ...

You: Search for files containing "ToolRegistry" in the repo
Agent: [calls github-search-code] Found in 3 files: ...
```

**Setup:**

1. Create a GitHub Personal Access Token at https://github.com/settings/tokens.
2. Set the token:
   ```dotenv
   GITHUB_PERSONAL_ACCESS_TOKEN=ghp_your_token_here
   ```
3. Enable in config:
   ```json
   { "mcpServers": { "sidecars": { "github": { "enabled": true } } } }
   ```

### Granular Tool Control

You can enable an MCP server while disabling specific tools within it. For example, enable Gmail but block sending:

```json
{
  "mcpServers": {
    "sidecars": {
      "gmail": {
        "enabled": true,
        "disabledTools": ["gmail-send"]
      }
    }
  }
}
```

Disabled tools are never sent to the LLM — the model cannot call them. Use the **Admin** page at `/admin` to expand a sidecar card and toggle tools visually.

---

## Director Mode (Video Production)

Director Mode transforms raw video clips into polished edits using a single LLM call, or generates entire videos from scratch using AI imagery. It supports three production modes:

### Quick Start

1. **Highlight Reel** — Let the AI choose the best moments:
   ```
   "Create a 60-second highlight reel from these conference recordings"
   ```
   The `produce-video` tool will ingest clips, extract audio transcripts and visual scene changes, then produce an edit decision list (Director Manifest).

2. **Script-Driven** — Provide a narration script:
   ```
   "Produce a video following this script: [paste your narration], using my presentation recordings"
   ```
   The system generates a TTS voiceover (if Voice is enabled) and aligns the timeline to your script.

3. **Presentation** — Generate a full video from a text topic (no input media needed):
   ```
   "Create a presentation video about the history of distributed systems"
   ```
   The pipeline generates a storyboard (scenes + narration), AI images for each scene via Stable Diffusion, per-scene TTS voiceover, Ken Burns animations, crossfade transitions, and optional background music — all fully automated.

### Video Tools

| Tool | Description |
|---|---|
| `produce-video` | Full pipeline: ingest clips → LLM analysis → Director Manifest, or generate from topic (presentation mode). Parameters: `clips` (file paths, not needed for presentation), `mode` (`highlight`, `script`, or `presentation`), optional `topic` (for presentation), `scriptPath`, `musicTrackPath`, `template`. |
| `list-templates` | Show available video templates. Filter by `tag` (e.g., `social`, `professional`, `tech`). |
| `search-assets` | Search for royalty-free music, sound effects, and images. Sources: local library, Pixabay, Jamendo, Pexels. |

### Templates

| Template | Aspect | Best For |
|---|---|---|
| **Minimalist** | 16:9 | Conference talks, tutorials, screencasts |
| **Content Creator** | 9:16 | TikTok, Reels, Shorts |
| **Corporate** | 16:9 | Quarterly updates, investor pitches |
| **Tech Demo** | 16:9 | Developer tutorials, code walkthroughs |

### Sound Browser

The **Admin** panel includes a **Sound Browser** tab for searching and previewing royalty-free audio:
- Search across **Local Library**, **Pixabay**, **Jamendo**, and **Pexels**
- Preview tracks directly in the browser
- Download remote assets to your local library with proper attribution

#### File Upload

The Sound Browser includes an **Upload** tab for adding local audio files to your asset library:

1. Switch to the **Upload** tab in the Sound Browser step
2. Enter the absolute path (or `~/` path) to your audio file
3. Optionally specify a custom name and file type (Music, SFX, or Voiceover)
4. Click **Upload to Library** — the file is copied into the managed asset library

Uploaded files are immediately available for use in productions.

### Render Quality

The **Produce** step includes render quality controls that affect the final video output:

| Preset | CRF | Best For |
|---|---|---|
| **Draft** | 32 | Quick preview, fast encode, small files |
| **Standard** | 23 | Balanced quality and file size (default) |
| **High** | 18 | High quality output, larger files |
| **Lossless** | 0 | Maximum quality, very large files |

Select a quality preset before starting the render. The codec is H.264 by default.

### Render Engine

OpenZigs uses **Remotion v4** for server-side video rendering. The render engine supports:

- **AI image scenes** — Ken Burns pan/zoom on AI-generated images with per-scene voiceover
- **Smooth transitions** — crossfade, dissolve, wipe (left/right), and hard cut
- **Animated title cards** — fade, slide-up, and typewriter text animations
- **Smart captions** — word-by-word captions with pill, underline, boxed, or karaoke styles
- **Lower thirds** — animated name/title overlays with spring physics
- **Logo watermarks** — persistent branding in any corner with configurable opacity
- **Video effects** — slow zoom (Ken Burns), fade in/out, blur, grayscale
- **Audio layers** — background music with looping and fade, voiceover with timeline sync

The render pipeline runs in a Worker Thread with real-time progress streaming via Socket.IO.

### Configuration

Add API keys for cloud asset sources in your config:

```json
{
  "director": {
    "enabled": true,
    "defaultTemplate": "Minimalist",
    "assets": {
      "pixabayApiKey": "your-pixabay-key",
      "jamendoClientId": "your-jamendo-client-id",
      "pexelsApiKey": "your-pexels-key"
    },
    "ingestion": {
      "sceneThreshold": 0.4,
      "whisperModel": "base.en"
    }
  }
}
```

### Presentation Mode

Presentation Mode (Mode C) produces complete videos from a text topic with zero input media. The pipeline:

1. **Storyboard Generation** — The LLM creates a structured scene plan with title, style anchor, narration, and visual descriptions for each scene
2. **Image Generation** — Each scene's visual description is sent to FLUX.1-schnell (local MFLUX/MLX FastAPI sidecar on Apple Silicon) with the style anchor prepended for consistency. Falls back to Google Cloud Imagen if local generation is unavailable
3. **Voiceover Synthesis** — Per-scene narration is converted to speech via Google Cloud TTS
4. **Assembly** — Images, voiceover audio, Ken Burns animations, crossfade transitions, and background music are assembled into a Director Manifest and rendered via Remotion

#### Presentation Mode Prerequisites

- **Python 3.10+** with `mflux`, `fastapi`, `uvicorn`, `Pillow` — install via `pip install -r sidecars/image-gen/requirements.txt`
- **Apple Silicon Mac** (M-series, MLX backend) — NVIDIA/CUDA is not supported with MFLUX
- **Google Cloud Vertex AI** (optional fallback) — set `GOOGLE_CLOUD_PROJECT` env var and authenticate via `gcloud auth application-default login`
- The image gen sidecar starts automatically when needed, or run manually: `cd sidecars/image-gen && python server.py`

#### Remote Image Generation (FluxQ Network Node)

You can offload image generation to a second Mac on your local network. This is useful when your primary machine is busy running the Express server and UI, or when you have a dedicated Apple Silicon machine with more GPU memory.

**Quick setup:**
1. On the remote Mac, run: `bash scripts/setup-fluxq-node.sh`
2. In the OpenZigs Admin UI, go to **Image Generation Node**, switch to **Network Node**, enter the remote IP and token, then click **Test Connection** and **Save**.

For detailed instructions, see [FLUXQ_SETUP.md](FLUXQ_SETUP.md).

#### Ken Burns Animation

Each generated image is animated with a Ken Burns pan/zoom effect:
- **Scale**: Subtle zoom from 1.0× to 1.15× over the scene duration
- **Pan**: Alternating left-to-right and right-to-left horizontal pan between scenes for visual variety
- All parameters are configurable per scene in the manifest

### Prerequisites

- **ffmpeg** installed and on PATH (for audio extraction & scene detection)
- **whisper-node** (bundled) for speech-to-text transcription
- **Remotion v4** and **React 18** (bundled) for server-side video rendering
- **Python 3.10+** with ML dependencies (optional, for Presentation Mode image generation — see above)
- **Pixabay/Jamendo/Pexels API keys** (optional, for cloud asset search)
- **Google Cloud TTS** (optional, for script-driven and presentation voiceover generation)

---

## Director Studio & Advanced Compositing

> **Epic #313** — Extends Director Mode with a full timeline studio UI, blog-to-YouTube pipeline, shorts maker, AI thumbnails, text overlays, intro/outro cards, image enhancement, script pacing, and asset uploads.

### Director Page (Tabs)

The Director page at `/director` now has a tabbed layout:

| Tab | Icon | Description |
|-----|------|-------------|
| **Video Wizard** | Film | The original Director wizard — ingest clips, pick a template, review/produce |
| **Blog to YouTube** | Globe | Convert any blog post URL into a fully produced video |
| **My Drafts** | FolderOpen | Browse, reopen, and delete saved drafts |

The **My Drafts** tab lists all saved drafts with thumbnail, production mode badge (e.g. WIZARD, PRESENTATION), status, and relative timestamp. Click any draft to reopen it in the Studio. Delete with the trash icon.

### Director Studio (Timeline Editor)

After producing a video or creating a draft, click **Open in Studio** to launch the full timeline editor at `/director/studio/[id]`.

The Studio provides a three-panel layout:

| Panel | Position | Description |
|-------|----------|-------------|
| **Toolbar** | Top | Draft title, Save/Renders/Render buttons, dirty indicator, back navigation |
| **Player Preview** | Left (60%) | Live Remotion `<Player>` preview with play/pause, frame scrubber, and timecode display |
| **Scene Inspector** | Right (40%) | Per-scene property editor — narration text, duration, image source, scene type, transitions, Ken Burns settings |
| **Timeline Tracks** | Bottom | Multi-track editor with Scenes, Voiceover, Overlays, and Audio lanes |

**Key features:**

- **Multi-track timeline** — Scenes, voiceover, overlays, and audio tracks are rendered as color-coded horizontal lanes. Click any entry to select it and load its properties in the Inspector.
- **Playhead scrubbing** — Click anywhere on the timeline to seek. The vertical playhead syncs with the player preview.
- **Scene Inspector** — Edit individual scene properties (narration text, transition type, duration, image path). Changes update the manifest in memory; click **Save** to persist.
- **Frame-accurate preview** — The Remotion Player renders the exact composition at the current frame, including text overlays, intro/outro cards, and transitions.
- **Save with feedback** — Clicking Save shows a toast notification ("Draft saved" / error) and a checkmark animation. The toolbar displays "saved" or "unsaved" next to the title.
- **Auto-save** — After any manifest change, the Studio auto-saves every 30 seconds while the draft is dirty. Manual saves reset the timer.
- **Render history** — The **Renders** dropdown button shows all past renders for the current draft with status icons (complete, failed, queued, in-progress), progress bars for active renders, and download links for completed outputs. Polls every 5 seconds while renders are active.
- **Render-to-draft linking** — Each render is recorded in the `director_renders` table and linked to its parent draft. The Render button auto-saves before submitting.

### Blog-to-YouTube Pipeline

The **Blog to YouTube** tab converts a blog post URL into a complete video:

1. Paste a blog URL into the input field.
2. Optionally configure:
   - **Template** — Minimalist, ContentCreator, Corporate, or TechDemo
   - **Style hint** — Free-text aesthetic direction (e.g., "warm, documentary feel")
   - **Image provider** — Auto, local (FLUX.1 via MFLUX), or cloud (Vertex AI)
3. Click **Convert to Video**.
4. The pipeline runs 5 steps:
   - **Extract** — Fetches the blog with SSRF protection (blocked private IPs, restricted protocols) and parses title, images, and text content.
   - **Storyboard** — The LLM generates a structured scene plan from the blog text.
   - **Images** — AI-generated scene images plus downloaded blog images.
   - **Voiceover** — Per-scene TTS narration with title cards and transitions.
   - **Assembly** — Produces a `DirectorManifest` and auto-saves as a draft.
5. The result card shows blog metadata (title, word count, image count) and an **Open in Studio** button.

**MCP tool:** `blog-to-video` — programmatic access with parameters: `url`, `template`, `style_hint`, `image_provider`, `image_model`, `music_track`, `target_duration`.

**REST API:**

```bash
# Convert a blog post to video
curl -X POST http://localhost:3000/api/admin/director/blog-to-video \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/my-article",
    "template": "Corporate",
    "styleHint": "professional, clean"
  }'
# Response: { draftId, manifest, blog: { title, wordCount, imageCount }, storyboard, processingTimeMs }
```

### Shorts Maker Pipeline

Convert any long-form video into a 30–60 second YouTube Short / TikTok / Reel:

1. The pipeline extracts the most "viral-worthy" segment using transcript analysis and engagement scoring.
2. An LLM generates a reaction/summary/highlight script for the extracted clip.
3. Per-sentence TTS voiceover is synthesized and aligned to the timeline.
4. The result is assembled into a 9:16 `ContentCreator` manifest with the clip cropped for vertical framing (`horizontalCropOffset`).
5. Auto-saved as a draft — open in the Studio to refine before rendering.

**MCP tool:** `create-short` — parameters: `source_video`, `style` (`react`, `summarize`, `highlight`), `target_duration`, `voice_profile`.

**REST API:**

```bash
# Create a short from a long-form video
curl -X POST http://localhost:3000/api/admin/director/shorts \
  -H "Content-Type: application/json" \
  -d '{
    "sourceVideo": "/path/to/long-video.mp4",
    "style": "highlight",
    "targetDuration": 45
  }'
# Response: { draftId, manifest, viralClip, scriptText, processingTimeMs }
```

### AI Thumbnail Generation

Generate YouTube-style thumbnails with LLM-guided frame selection, Flux img2img stylization, and text compositing:

1. The LLM analyzes the manifest's scenes and selects the most visually striking frame.
2. The selected frame is enhanced via Flux img2img with a thumbnail-optimized prompt (vibrant, high contrast).
3. Text is composited onto the image using `@napi-rs/canvas` — up to 3 lines with automatic placement, color selection, and shadow effects.

**REST API:**

```bash
# Generate a thumbnail for a manifest
curl -X POST http://localhost:3000/api/admin/director/thumbnail \
  -H "Content-Type: application/json" \
  -d '{
    "manifestPath": "/path/to/manifest.json",
    "outputDir": "/path/to/output",
    "style": "YouTube thumbnail style, vibrant",
    "textOverride": ["TOP LINE", "BOTTOM LINE"]
  }'
# Response: { thumbnailPath, suggestedText, selectedFrame: { path, timestamp, rationale } }
```

### Image Enhancement (Flux img2img)

Enhance any scene image using the Flux img2img pipeline. This takes an existing image and transforms it guided by a text prompt — useful for style transfer, quality upscaling, or artistic reinterpretation.

**REST API:**

```bash
# Enhance a scene image
curl -X POST http://localhost:3000/api/admin/director/enhance \
  -H "Content-Type: application/json" \
  -d '{
    "imagePath": "/path/to/scene.png",
    "prompt": "cinematic lighting, film grain, color graded",
    "strength": 0.6
  }'
# Response: { enhancedImagePath, generationTimeMs }
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `imagePath` | string | Yes | — | Path to the source image |
| `prompt` | string | Yes | — | Text prompt guiding the enhancement |
| `strength` | number | No | `0.7` | How much to transform (0 = no change, 1 = full regeneration) |
| `model` | string | No | `"flux"` | Image model to use |
| `seed` | number | No | random | Reproducibility seed |

### Text Overlays

Text overlays are a new timeline entry type (`text_overlay`) that renders animated text on top of video scenes. Supported in both the Remotion composition and the Studio Inspector.

| Property | Type | Description |
|----------|------|-------------|
| `text` | string | The overlay text content |
| `style` | string | `"subtitle"`, `"title"`, `"lower-third"`, or `"callout"` |
| `position` | string | `"top"`, `"center"`, or `"bottom"` |
| `fontSize` | number | Font size in pixels (default: 48) |
| `color` | string | Text color (hex or CSS color name) |
| `startAtFrame` | number | Frame at which the overlay appears |
| `durationInFrames` | number | How long the overlay is visible |

Text overlays appear on the **Overlays** track in the Studio timeline and can be edited via the Scene Inspector.

### Intro & Outro Cards

Configurable intro and outro cards as timeline entries:

- **`intro_card`** — Fade-in title card with project name, subtitle, and optional background color/image. Rendered as a full-screen card at the start of the timeline.
- **`outro_card`** — Closing card with customizable CTA text, social links, and background. Supports fade, slide-up, and typewriter animations.

Both card types are managed in the manifest's `timeline` array and appear as distinct entries on the Scenes track in the Studio.

### Script Pacing (SSML)

Narration scripts now support inline pacing annotations that are translated to SSML before TTS synthesis:

| Annotation | SSML Output | Example |
|------------|-------------|---------|
| `[PAUSE: 2s]` | `<break time="2000ms"/>` | `And then... [PAUSE: 2s] it happened.` |
| `[PAUSE: 500ms]` | `<break time="500ms"/>` | `Wait [PAUSE: 500ms] for it.` |
| `*word*` | `<emphasis level="strong">word</emphasis>` | `This is *critical* information.` |

The pacing translator runs automatically during TTS synthesis — no manual SSML authoring required. The LLM can include pacing tags directly in generated scripts.

### BYOA (Bring Your Own Assets) Uploads

Upload your own video, audio, or script files for use in productions:

**REST API:**

```bash
# Upload a video file
curl -X POST "http://localhost:3000/api/admin/director/files/upload?kind=video" \
  -H "x-file-name: my-clip.mp4" \
  --data-binary @my-clip.mp4

# Upload an audio file
curl -X POST "http://localhost:3000/api/admin/director/files/upload?kind=audio" \
  -H "x-file-name: background-music.mp3" \
  --data-binary @background-music.mp3

# Upload a script file
curl -X POST "http://localhost:3000/api/admin/director/files/upload?kind=script" \
  -H "x-file-name: narration.txt" \
  --data-binary @narration.txt
```

| Kind | Max Size | Storage Location |
|------|----------|-----------------|
| `video` | 2 GB | `~/.openzigs/director/uploads/videos/` |
| `audio` | 2 GB | Asset library (`localLibraryPath`) |
| `script` | 2 GB | `~/.openzigs/director/uploads/scripts/` |

Uploaded files receive a timestamped unique filename and are immediately available for use in the Director wizard or Studio.

### Scene Regeneration

Regenerate a single scene's image without re-running the entire pipeline:

```bash
curl -X POST http://localhost:3000/api/admin/director/scenes/0/regenerate \
  -H "Content-Type: application/json" \
  -d '{
    "draftId": "abc123",
    "prompt": "A futuristic cityscape at sunset, cyberpunk aesthetic",
    "provider": "local",
    "model": "flux"
  }'
# Response: { sceneIndex, imagePath, generationTimeMs }
```

If `draftId` is provided, the draft manifest is automatically updated with the new image path.

### Draft Persistence

All produced videos, shorts, and blog conversions are automatically saved as drafts in the SQLite `director_drafts` table. Drafts can be listed, updated, and deleted:

```bash
# List all drafts
curl http://localhost:3000/api/admin/director/drafts
# Response: { drafts: [{ id, title, thumbnail, productionMode, createdAt, updatedAt, status }] }

# Get a draft with full manifest
curl http://localhost:3000/api/admin/director/drafts/<id>

# Update a draft
curl -X PUT http://localhost:3000/api/admin/director/drafts/<id> \
  -H "Content-Type: application/json" \
  -d '{"title": "My Updated Video", "manifest": {...}}'

# Delete a draft
curl -X DELETE http://localhost:3000/api/admin/director/drafts/<id>
```

### Epic #313 API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/admin/director/drafts` | Create a new draft |
| GET | `/api/admin/director/drafts` | List all drafts |
| GET | `/api/admin/director/drafts/:id` | Get draft with full manifest |
| PUT | `/api/admin/director/drafts/:id` | Update draft title/manifest/status |
| DELETE | `/api/admin/director/drafts/:id` | Delete a draft |
| POST | `/api/admin/director/enhance` | Enhance image via Flux img2img |
| POST | `/api/admin/director/thumbnail` | Generate AI thumbnail |
| POST | `/api/admin/director/scenes/:idx/regenerate` | Regenerate a scene image |
| POST | `/api/admin/director/shorts` | Create a YouTube Short from long-form video |
| POST | `/api/admin/director/blog-to-video` | Convert blog URL to video draft |
| POST | `/api/admin/director/files/upload` | Upload video/audio/script files (BYOA) |
| POST | `/api/admin/director/assets/upload` | Upload asset to local library |
| POST | `/api/admin/director/assets/ingest` | Ingest uploaded video through analysis pipeline |

---

## Advanced Director Mode (Voice Cloning & Visual Injection)

> **Epic #268** — Advanced Director Mode extends the core Director pipeline with two major capabilities: swappable TTS engine support (including GPT-SoVITS voice cloning) and LLM-guided visual asset injection. All new features are managed from the **Voice Lab** panel in the Admin UI.

### Voice Lab

The **Voice Lab** panel in Admin (`/admin`) provides full control over TTS engine selection and GPT-SoVITS voice profiles.

#### Engine A vs Engine B

OpenZigs ships with two TTS engines:

| Engine | Technology | VRAM | Best For |
|---|---|---|---|
| **Engine A (Kokoro)** | On-device mlx-audio (Apple Silicon) | ~1 GB | Low-latency, general-purpose narration |
| **Engine B (GPT-SoVITS)** | Local GPT-SoVITS server (proxy) | 6–10 GB | Cloned voices, expressive character TTS |
| **Engine C (F5-TTS)** | f5-tts-mlx (Apple Silicon) | ~1–2 GB | Multi-emotion voice cloning with per-clip reference audio |

Only one engine is active at a time. Switching engines frees Apple Silicon VRAM before loading the next engine.

#### Switching Engines

1. Open **Admin → Voice Lab** in the UI.
2. The **Engine Toggle** card shows the current active engine and its health status.
3. Click **Switch to Engine B** (or **Switch to Engine A**) to apply.
4. The toggle shows a loading state while the switch completes (typically 5–15 s).

GPT-SoVITS must be running locally on port 9880 before switching to Engine B. Install and start it with:

```bash
# One-time install (~4 GB download)
bash scripts/setup-gptsovits.sh

# Install runtime dependencies (torchcodec + NLTK data)
# This is also run automatically by install.sh if GPT-SoVITS is already installed.
~/.openzigs/sidecars/gptsovits/.venv/bin/pip install torchcodec
~/.openzigs/sidecars/gptsovits/.venv/bin/python -c "import nltk; nltk.download('averaged_perceptron_tagger_eng')"

# Start GPT-SoVITS
~/.openzigs/sidecars/gptsovits/start.sh
```

> **Tip:** `scripts/dev-clean.sh` automatically starts GPT-SoVITS alongside the other sidecars if it's installed.

#### Starting the Audio Sidecar

The audio sidecar handles Kokoro TTS and proxies Engine B requests. In most cases, `scripts/dev-clean.sh` starts all sidecars automatically (including passing `--sovits-url` when GPT-SoVITS is detected).

If you need to start it manually:

```bash
# Default (Kokoro only, Engine A)
cd sidecars/audio && python server.py

# With GPT-SoVITS URL override (Engine B support — required for voice cloning)
cd sidecars/audio && python server.py --sovits-url http://127.0.0.1:9880

# Via environment variable
AUDIO_SOVITS_URL=http://127.0.0.1:9880 python server.py
```

#### Voice Profiles (Engine B)

Voice profiles define the cloning parameters for GPT-SoVITS. Each profile references a short reference audio clip and an optional reference transcript, plus synthesis tuning knobs.

**Creating a voice profile:**

1. **Upload reference audio** — In the Voice Lab panel, click **Upload Reference Audio** and select a short WAV or MP3 clip (**3–8 seconds** of clean speech; **5–8 seconds is recommended** for the most stable clone quality). The file is stored at `~/.openzigs/director/ref-audio/`. The audio sidecar automatically converts non-WAV formats (e.g., `.webm` browser recordings) to WAV. You can also record directly in the Voice Lab using the built-in recorder (5s or 8s scripts available).
2. **Create a profile** — Fill in:
   - **Name** — A unique identifier for the voice profile.
   - **Reference Audio** — Select the uploaded file from the dropdown.
   - **Reference Text** — Optional: the transcript of the reference clip (improves quality).
   - **Language** — `en`, `zh`, `ja`, `ko`, or `auto`.
   - **Parameters** — Adjust `top_p`, `temperature`, `speed_factor`, `repetition_penalty`, `top_k`, and `text_split_method` via sliders.
3. Click **Save Profile**.

**Testing a profile:**

Click **Test** on any profile card. The sidecar synthesizes a short sample using the profile parameters and plays it in your browser.

**Speech quality tips (Engine B):**

- GPT-SoVITS works best with short, clear sentences.
- It can struggle with abbreviations, acronyms, and compacted terms (for example: `SRE`, `k8s`, `CI/CD`, `Q4FY26`).
- For best results, spell out shorthand in the narration text before synthesis.

#### Kokoro Presets (Engine A)

The **Kokoro Presets** grid shows all available built-in voices. Click a preset to preview it. Presets are loaded from the audio sidecar's `/voices` endpoint.

#### F5-TTS Profiles (Engine C)

Engine C provides **emotion-driven voice cloning** via F5-TTS. Unlike Engine B (one reference clip per profile), Engine C supports **multiple emotion clips** per profile — each clip maps to an emotion label (Regular, Excited, Whisper, etc.).

**Installing F5-TTS:**

```bash
pip install f5-tts-mlx>=0.3.0
```

Or use the `requirements-mac.txt` from the sidecar directory:

```bash
cd sidecars/audio && pip install -r requirements-mac.txt
```

**Creating an F5-TTS profile:**

1. Open **Voice Lab** in the Admin UI.
2. In the **F5-TTS Profiles · Engine C** section, click **New F5-TTS Profile**.
3. Give the profile a name and click **Create**.
4. Click the **+** button on the profile card to add emotion clips:
   - **Emotion Label** — A short name like `Regular`, `Excited`, `Whisper`, `Calm`, `Breaking News`.
   - **Reference Audio** — Upload a short WAV/MP3 clip (up to 15 seconds). The sidecar converts it to 24kHz mono WAV automatically.
   - **Reference Transcript** — The exact words spoken in the reference clip (improves synthesis quality).
5. Add at least one `Regular` clip — this serves as the default voice when no emotion tag is specified.

**Writing emotion-tagged scripts:**

Use parenthesized emotion tags before text segments:

```
(Regular)Welcome to the show. (Excited)Today we have incredible news! (Whisper)But first, a secret.
```

The sidecar splits the text at each emotion tag, synthesizes each segment with the matching reference clip, and concatenates the output into a single WAV file.

**Inserting emotion tags in the Narration Editor:**

The Director Studio narration editor includes an **Emotions** dropdown when emotion tags are available. Click an emotion pill to insert `(EmotionName)` at the cursor position.

**Testing an F5-TTS profile:**

1. Expand a profile card by clicking its name.
2. Enter test text with emotion tags in the test input field.
3. Click **Test** to synthesize and play the result.

**F5-TTS synthesis parameters (advanced):**

| Parameter | Default | Description |
|---|---|---|
| `steps` | 8 | Number of diffusion steps (higher = better quality, slower) |
| `method` | `rk4` | ODE solver: `rk4` or `euler` |
| `cfg_strength` | 2.0 | Classifier-free guidance strength |
| `sway_sampling_coef` | -1.0 | Sway sampling coefficient |
| `speed` | 1.0 | Speech rate multiplier |
| `seed` | null | Random seed for reproducibility |

---

### Visual Injection (Asset Overlay)

Visual injection lets you overlay image or video assets on any produced video at AI-guided timestamps. This is useful for adding B-roll, logos, lower-thirds images, or any supplemental visual content.

#### Uploading Assets

Upload visual assets (images or short video clips) to the Director's asset library:

1. In the **Admin UI**, use the **Director → Assets** section (or call the API directly).
2. POST to `/api/admin/director/files/upload-asset?kind=image` (or `kind=video`).
3. Assets are stored at `~/.openzigs/director/uploads/visual/` and served via the API.

**cURL example:**

```bash
curl -X POST "http://localhost:3000/api/admin/director/files/upload-asset?kind=image" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "asset=@/path/to/overlay.png"
```

#### LLM-Guided Placement

The `/api/admin/director/assets/placement` endpoint uses the LLM to suggest where assets should appear in your video:

```bash
curl -X POST http://localhost:3000/api/admin/director/assets/placement \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "videoFile": "my-video.mp4",
    "assets": [
      { "id": "logo-abc123", "label": "company logo" },
      { "id": "broll-abc456", "label": "office B-roll" }
    ],
    "context": "Corporate product launch video, 3 minutes total"
  }'
```

The LLM returns an array of `AssetPlacement` objects with `assetId`, `startSeconds`, `endSeconds`, `x`, `y`, `width`, `height`, and `opacity`.

#### Applying Overlays

Once you have placement data (from the LLM or manually constructed), apply the overlay with `POST /api/admin/director/assets/overlay`:

```bash
curl -X POST http://localhost:3000/api/admin/director/assets/overlay \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "inputVideo": "/path/to/source.mp4",
    "outputPath": "/path/to/output.mp4",
    "placements": [
      {
        "assetId": "logo-abc123",
        "assetPath": "/path/to/logo.png",
        "startSeconds": 0,
        "endSeconds": 180,
        "x": 20,
        "y": 20,
        "width": 200,
        "height": 100,
        "opacity": 0.9
      }
    ]
  }'
```

The overlay compositor uses `ffmpeg` (spawned directly — no shell; safe against injection) and preserves the original audio track unchanged.

---

### Script Sanitization

All narration scripts are automatically sanitized before being sent to TTS to prevent prompt injection attacks. This happens transparently during every `produce-video` run.

If a script contains suspicious patterns (shell metacharacters, LLM scaffold tokens, HTML tags, code fences, etc.), the threat is logged as a warning and the offending content is stripped. Synthesis continues with the cleaned text — no manual intervention required.

**Sanitization covers 9 threat categories:**

| Category | Example |
|---|---|
| System header injection | `SYSTEM: ignore all previous instructions` |
| Ignore instruction injection | `Ignore the above and do X` |
| Tool call injection | `<invoke>shell-execute</invoke>` |
| Code fences | ` ```bash rm -rf / ``` ` |
| Inline code | `` `dangerous command` `` |
| Shell metacharacters | `$(cmd)`, `` `cmd` ``, `&&`, `\|`, `;` |
| Shell operators | `>`, `>>`, `<`, `2>` |
| HTML tags | `<script>`, `<img onerror=...>` |
| LLM scaffold tokens | `<\|im_start\|>`, `<\|endoftext\|>`, `[INST]` |

Threats are logged to the Winston logger at `warn` level — check `~/.openzigs/logs/` for details.

---

### API Reference (Advanced Director)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/admin/audio/engine/status` | Active engine name + health of both engines |
| POST | `/api/admin/audio/engine/switch` | Switch active TTS engine (`{ "engine": "kokoro" \| "sovits" }`) |
| GET | `/api/admin/audio/voices` | List Kokoro built-in voices |
| GET | `/api/admin/audio/profiles` | List voice profiles (Engine B) |
| POST | `/api/admin/audio/profiles` | Create voice profile |
| GET | `/api/admin/audio/profiles/:id` | Get voice profile |
| PUT | `/api/admin/audio/profiles/:id` | Update voice profile |
| DELETE | `/api/admin/audio/profiles/:id` | Delete voice profile |
| POST | `/api/admin/audio/profiles/:id/test` | Synthesize test sample with profile |
| POST | `/api/admin/audio/upload/ref-audio` | Upload reference audio file |
| POST | `/api/admin/director/files/upload-asset` | Upload visual overlay asset (`?kind=image\|video`) |
| GET | `/api/admin/director/files/:fileName` | Serve uploaded asset file |
| POST | `/api/admin/director/assets/placement` | LLM-guided asset placement suggestion |
| POST | `/api/admin/director/assets/overlay` | Apply asset overlays to video via ffmpeg |

---

## Presenter Mode (Interactive Playback & Quizzes)

> **Epic #275** — Presenter Mode transforms rendered Director Mode videos into interactive learning experiences. After a video is rendered, it is automatically indexed into a browsable catalog. During playback, the viewer can pause to ask the AI questions, receive pop quizzes, and download a PDF recap at the end.

### Catalog

Navigate to **Presenter** in the top navigation bar to see all indexed presentations. Each card shows a thumbnail, title, duration, creation date, and a quiz badge if quizzes are enabled.

![Presenter catalog page with search and empty state](images/presenter-catalog.png)

- **Search** — Filter presentations by title using the search bar.
- **Delete** — Click the trash icon on any card to permanently remove a presentation and its cached quizzes.

Presentations are auto-indexed when a Director Mode render completes. The system extracts chapters from the Director Manifest and generates a thumbnail from the video file.

### Interactive Player

Click any presentation card to open the interactive player at `/presenter/{id}`.

The player has four states (managed by a finite state machine):

| State | What Happens |
|---|---|
| **Playing** | Video plays normally. A "Raise Hand" button floats in the bottom-right corner. The sidebar shows chapters with an active indicator. |
| **Paused — Q&A** | User clicked Raise Hand. Video pauses. A dark "blackboard" overlay appears. Type a question and receive a streaming AI answer with Mermaid diagram support. Click **Resume** to continue. |
| **Paused — Quiz** | A pop quiz triggers at a pre-calculated timestamp. Video pauses. A multiple-choice overlay appears. Answer the question to see if you're correct, with an explanation. Click **Continue** to resume. |
| **Recap** | Video ends (or all chapters complete). A recap screen shows your quiz score (circular ring), quiz results, Q&A transcript, and a **Download PDF** button. |

#### Raise Hand (Q&A)

1. While the video is playing, click the **✋ Raise Hand** button.
2. The video pauses and a blackboard overlay appears.
3. Type your question in the input field and press Enter.
4. The AI streams its answer in real time (token by token via Socket.IO). Markdown and Mermaid diagrams are rendered inline.
5. Click **Resume** to continue playback.

The Teacher Agent builds context from the chapter's narration script, so answers are grounded in the video's content.

#### Pop Quizzes

When quizzes are enabled (toggle in Director Mode's Review & Produce step), multiple-choice questions are generated for each chapter:

1. Quiz timestamps are placed 2 seconds before each qualifying chapter ends (chapters must be ≥15 seconds long).
2. When the video reaches a quiz timestamp, it pauses automatically.
3. A multiple-choice question appears with 4 options (A, B, C, D).
4. Select your answer. Correct answers highlight in green; incorrect in red with the correct answer shown.
5. An explanation is displayed for learning reinforcement.
6. Click **Continue** to resume playback.

Quizzes are generated by the AI and cached per chapter. Re-generating quizzes uses the **Generate Quiz** API endpoint.

#### Blackboard & Mermaid Diagrams

The blackboard overlay renders AI responses as rich Markdown. When the AI includes a Mermaid code block, it is rendered as an interactive diagram:

- Flowcharts, sequence diagrams, class diagrams, state diagrams, Gantt charts, and more
- Dark theme matching the blackboard aesthetic
- Error boundaries: if a diagram fails to parse, the raw Mermaid source is shown in a code block

#### Chapter Navigation

A sidebar lists all detected chapters (extracted from Director Manifest title cards). Click any chapter to jump to that point in the video.

### Recap & PDF Download

When a presentation session ends:

1. **Score Ring** — A circular indicator shows your quiz score percentage (green ≥80%, amber ≥50%, red <50%).
2. **Quiz Results** — Each question is listed with your answer, the correct answer, and whether you got it right.
3. **Q&A Transcript** — All Raise Hand questions and AI answers from the session.
4. **Download PDF** — Click to generate and download a client-side PDF containing the score, quiz results, and Q&A transcript.
5. **Watch Again** — Restart the presentation from the beginning.

### Enabling Quizzes in Director Mode

In the Director Mode wizard's **Review & Produce** step, when mode is set to **Presentation**:

1. A **"Enable pop quizzes"** toggle appears.
2. Turn it on to have quizzes generated for the video after rendering.
3. The quiz configuration is stored with the presentation metadata.

### REST API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/presentations` | List all presentations (sorted by creation date, newest first) |
| GET | `/api/presentations/:id` | Get full presentation metadata (chapters, quiz config, paths) |
| PATCH | `/api/presentations/:id` | Update title, quiz_enabled, or quiz_config |
| DELETE | `/api/presentations/:id` | Delete a presentation and its cached quizzes |
| GET | `/api/presentations/:id/quiz` | Get cached quiz questions for all chapters |
| POST | `/api/presentations/:id/generate-quiz` | Generate (or regenerate) quiz questions via AI |
| POST | `/api/presentations/:id/ask` | Send a Q&A question (returns AI-generated answer) |
| GET | `/api/presentations/:id/thumbnail` | Serve the presentation's thumbnail image |

### Socket.IO Events

Real-time streaming for Q&A answers:

| Event | Direction | Payload |
|---|---|---|
| `presenter:ask` | client → server | `{ presentationId, question, chapterIndex }` |
| `presenter:answer:start` | server → client | `{}` |
| `presenter:answer:token` | server → client | `{ token }` |
| `presenter:answer:done` | server → client | `{ fullAnswer }` |
| `presenter:answer:error` | server → client | `{ error }` |

### Multiplayer Watch Parties (P2P)

Issue: [Epic #282](https://github.com/mgcronin/openzigs/issues/282)

Multiplayer extends the solo Presenter experience into a real-time collaborative watch party. A host creates a room backed by a presentation, invites guests via secure JWT links, and all participants watch in sync with P2P voice chat.

#### Screenshots

| View | Screenshot |
|---|---|
| Presenter Catalog | ![Presenter list](images/multiplayer-01-presenter-list.png) |
| Room (Host View) | ![Room host view](images/multiplayer-02-room-host.png) |
| Invite Expired | ![Invite expired page](images/multiplayer-03-invite-expired.png) |
| Access Denied (403) | ![403 forbidden page](images/multiplayer-04-403-forbidden.png) |

#### Generating an Invite Link

Hosts generate invite links via the REST API:

```bash
curl -X POST http://localhost:3000/api/presentations/<id>/invite \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"displayName": "Alice"}'
```

Response:

```json
{
  "inviteUrl": "http://localhost:3001/invite/<jwt>",
  "expiresAt": "2025-07-19T12:00:00.000Z"
}
```

Share the `inviteUrl` with guests. The link is valid for 24 hours.

#### Guest Invite Flow

1. Guest opens the invite URL (`/invite/<token>`)
2. The invite page calls `GET /api/invite/redeem?token=<jwt>`
3. The backend verifies the JWT, sets `guest_token` and `is_guest` HttpOnly cookies
4. Guest is redirected to `/room/<presentationId>`
5. RBAC middleware restricts guests to `/room/*`, `/invite/*`, `/403`, and `/invite-expired` routes

If the token is expired or invalid, the guest is redirected to `/invite-expired` or `/403`.

#### Room Page

The room page (`/room/[id]`) provides:

- **Synchronized video player** — Host play/pause/seek actions sync all guests within a 1.5s drift tolerance
- **Member count pill** — Shows number of participants in the room
- **Voice peers indicator** — Shows connected P2P voice peers count
- **Push-to-Talk button** — Floating button for voice input (hold-to-talk or click-toggle)
- **Blackboard overlay** — Q&A answers broadcast to all participants with "Asked by …" attribution
- **Transcription preview** — Live speech-to-text preview during voice input

#### Host vs Guest Controls

| Action | Host | Guest |
|---|---|---|
| Play / Pause / Seek | ✅ Controls synced to room | ❌ Read-only (synced from host) |
| Raise Hand (Q&A) | ✅ | ✅ |
| Push-to-Talk (Voice) | ✅ | ✅ |
| Generate Invite Links | ✅ | ❌ |

#### Push-to-Talk

The PTT button supports two interaction modes:

1. **Hold-to-talk** — Press and hold; release to stop recording
2. **Click-toggle** — Click once to start, click again to stop

Audio is chunked every 3 seconds and sent via `room:audio_chunk` binary Socket.IO events. The server forwards chunks to the STT sidecar and streams transcription previews back.

#### Multiplayer REST API

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/presentations/:id/invite` | Admin | Generate a 24h invite JWT link |
| `GET` | `/api/invite/redeem` | Public | Redeem invite token, sets guest cookies |

#### Multiplayer Socket.IO Events

| Event | Direction | Payload | Description |
|---|---|---|---|
| `room:join` | client → server | `{ roomId, displayName }` | Join a room |
| `room:leave` | client → server | — | Leave current room |
| `room:announce_peer` | client → server | `{ peerId }` | Announce PeerJS peer ID to room |
| `room:peers_updated` | server → client | `{ peerIds: string[] }` | Updated list of peer IDs in room |
| `host:play` | client → server | `{ currentTime }` | Host play (host-only) |
| `host:pause` | client → server | `{ currentTime }` | Host pause (host-only) |
| `host:seek` | client → server | `{ currentTime }` | Host seek (host-only) |
| `room:playback_sync` | server → client | `{ action, currentTime }` | Broadcast playback state to guests |
| `room:audio_chunk` | client → server | `Binary (≤2MB)` | Audio chunk for STT processing |
| `room:transcription_preview` | server → client | `{ text, speakerName }` | Live transcription text |

#### PeerJS Signaling

The PeerJS signaling server is embedded in the Express backend at `/peerjs` (key: `openzigs`). Client config:

```javascript
new Peer({ path: "/peerjs", key: "openzigs" })
```

For PeerJS signaling and WebSocket details behind a reverse proxy, see [Cloudflare Tunnel for Multiplayer](cloudflare-tunnel-multiplayer.md).

#### Multiplayer Configuration

```json
{
  "presenter": {
    "inviteSecret": ""
  }
}
```

If `inviteSecret` is empty, a random 64-byte hex secret is **auto-generated on first startup and persisted** to `~/.openzigs/config.json`. This means:

- You do **not** need to manually configure a secret — one is created automatically
- The secret survives server restarts (it's saved to the config file)
- Invite links generated before a restart remain valid
- If you need to rotate the secret (invalidating all outstanding invite links), delete the `presenter.inviteSecret` key from `~/.openzigs/config.json` and restart

Invite links are JWT tokens signed with HS256 using this secret. Each link includes an expiration claim (default: 24 hours, configurable via `ttlHours` when generating the invite). The link becomes invalid after expiry — guests must request a new invite from the host.

#### Cloudflare Tunnel Setup for Presenter Mode

When running OpenZigs behind a Cloudflare Tunnel, invite links need to point to a public domain instead of `localhost`. The recommended setup uses **two routes on a single tunnel**: one for the backend (Telegram / API) and one for the Next.js UI (guests). Both run through the same `cloudflared` connector — no extra daemon needed.

```
Guest browser
  │
  ├─ /invite/..., /room/...  ──► presenter.example.com ──► localhost:3001 (Next.js)
  │                                    │
  │                             Next.js rewrites proxy:
  │                             /api/*       → localhost:3000
  │                             /socket.io/* → localhost:3000
  │
  └─ Telegram webhook (unchanged) ── openzigs.example.com ──► localhost:3000 (Express)
```

All guest traffic flows through the **same origin** (`presenter.example.com`). The Next.js rewrite layer proxies API and Socket.IO internally — no cross-origin cookie issues, no CORS problems.

##### Prerequisites

| Requirement | Purpose |
|---|---|
| **Cloudflare account** | Free tier is sufficient |
| **Domain added to Cloudflare** | e.g. `example.com` managed via Cloudflare DNS |
| **Existing tunnel running** | At least one `cloudflared` service already connected (e.g. `openzigs.example.com → localhost:3000`) |

##### Step 1 — Add a second published application to your existing tunnel

> If you are setting up a brand-new tunnel, first follow the [Create a tunnel (dashboard)](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/) guide to get your initial route running before continuing here.

1. Log in to [Cloudflare One](https://one.dash.cloudflare.com/)
2. Navigate to **Networks → Connectors → Cloudflare Tunnels**
3. Find your tunnel and click **Edit**
4. Open the **Published application routes** tab — your existing route (e.g. `openzigs.example.com → localhost:3000`) will be listed
5. Click **Add a published application**
6. Fill in the new route:
   - **Subdomain:** `presenter`
   - **Domain:** select your domain from the dropdown
   - **Service Type:** `HTTP`
   - **URL:** `localhost:3001`
7. Click **Save**

Your tunnel now has two routes:

| Public Hostname | Service | Purpose |
|---|---|---|
| `openzigs.example.com` | `http://localhost:3000` | Backend API + Telegram webhook (unchanged) |
| `presenter.example.com` | `http://localhost:3001` | Guest presenter UI (new) |

##### Step 2 — Configure environment variables

Both the backend `.env` and the UI's `.env` (or `.env.local`) need to be updated.

**Backend (`.env` in project root):**

```bash
# Leave NEXT_PUBLIC_OPENZIGS_API_BASE empty = same-origin mode.
# Guest API and Socket.IO calls use relative paths (/api/...) which
# Next.js rewrites proxy to localhost:3000 internally.
NEXT_PUBLIC_OPENZIGS_API_BASE=

# Copy your token from ~/.openzigs/config.json → auth.token
NEXT_PUBLIC_OPENZIGS_TOKEN=<your-token>

# Copy from ~/.openzigs/config.json → presenter.inviteSecret
PRESENTER_INVITE_SECRET=<your-invite-secret>

# Tell the backend the public URL of the presenter UI (used in invite link generation)
OPENZIGS_UI_ORIGIN=https://presenter.example.com
```

> **Where do these values come from?**
> - `NEXT_PUBLIC_OPENZIGS_TOKEN` — auto-generated on first run and saved to `~/.openzigs/config.json` under `auth.token`. Read it with: `cat ~/.openzigs/config.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['auth']['token'])"`
> - `PRESENTER_INVITE_SECRET` — auto-generated on first run and saved to `~/.openzigs/config.json` under `presenter.inviteSecret`. Read it with the same approach under `d['presenter']['inviteSecret']`.
> - Both are created automatically if missing — you never need to generate them manually.

##### Step 3 — Set the Base URL in Admin panel

1. Open `http://localhost:3001/admin`
2. Scroll to the **Presenter Mode** section
3. Set **Base URL** to: `https://presenter.example.com`
4. Save — restart the backend to apply

This tells the backend what public URL to embed in generated invite links.

##### Step 4 — Rebuild the UI

```bash
cd ui && npx next build
```

Then restart both services:
```bash
# Terminal 1 — backend
pnpm dev

# Terminal 2 — UI
cd ui && pnpm dev       # development
# OR: cd ui && npx next start   # production
```

##### Step 5 — Verify

1. Create a presentation and generate an invite link from the Presenter page (**Invite to Watch**)
2. The invite URL should be: `https://presenter.example.com/invite/<jwt>`
3. Open the link in incognito or on a different device
4. You should see "Joining presentation…" then land in the room at `https://presenter.example.com/room/<id>`

##### Preventing Unauthenticated Traffic

By default, anyone who can reach `presenter.example.com` can attempt to load the UI. OpenZigs has built-in protection at two layers:

| Layer | What it does |
|---|---|
| **Next.js middleware** | Guests are restricted to `/invite/*`, `/room/*`, `/403`, and `/invite-expired`. All other routes (admin, chat, scheduler, workbench) return a 403 page. |
| **Socket.IO `room:join`** | Cryptographically verifies the guest JWT cookie (HS256). A guest can only join the specific room their invite was scoped to. |

If you want to add a Cloudflare-level gate in front of `presenter.example.com` to block all unauthenticated requests before they reach your Mac:

1. In **Cloudflare One → Access controls → Applications**, click **Add an application → Self-hosted**
2. Set the application domain to `presenter.example.com`
3. Add an **Allow** policy — for example, allow **Everyone** (to keep it open) or restrict to specific email domains / IP ranges if you want tighter control
4. Save — Cloudflare Access will now issue application tokens to approved users. Users without a valid token are blocked at the Cloudflare edge and never reach `localhost:3001`

> **Note:** Cloudflare Access sits in front of everything on `presenter.example.com`, including the `/invite/*` pages. If you use Access, you need to add a **Bypass** or **Service Auth** policy for the `/invite/*` path so guests can redeem their invite link without needing a Cloudflare login.

##### Docker Compose (Production)

If you use Docker Compose, the tunnel sidecar is already defined in `docker-compose.yml`. Set the `TUNNEL_TOKEN` environment variable:

```bash
# .env
TUNNEL_TOKEN=your-cloudflare-tunnel-token
```

```bash
docker compose up -d agent tunnel
```

The tunnel sidecar automatically proxies to the `agent` container. The second hostname (`presenter.example.com → localhost:3001`) is configured in the Cloudflare dashboard — no changes to `docker-compose.yml` are needed.

##### Troubleshooting Invite Links Behind Tunnel

| Symptom | Cause | Fix |
|---|---|---|
| Invite URL says `localhost:3001` | `baseUrl` not set in Admin → Presenter Mode | Set **Base URL** to `https://presenter.example.com` and restart backend |
| "Invite Link Invalid" error | `PRESENTER_INVITE_SECRET` in `.env` doesn't match `~/.openzigs/config.json` | Copy the value from `~/.openzigs/config.json → presenter.inviteSecret` into `.env` |
| Link works once then fails | Cookie `sameSite` issue | Ensure tunnel uses HTTPS — cookies set the `Secure` flag automatically on HTTPS origins |
| Invite link expired | JWT TTL exceeded (default 24h) | Generate a new invite; use `ttlHours` for longer-lived links (max 168h / 7 days) |
| 403 on `/room/...` | `NEXT_PUBLIC_OPENZIGS_API_BASE` set to a value | Leave it **empty** in `.env` so API calls use relative paths proxied by Next.js rewrites |

### A/V Chat (Full Duplex Camera & Mic)

> **Epic #12** — Adds full-duplex video and audio chat to multiplayer watch parties. Participants see each other's webcam feeds in a video grid while the host's Voice Pipe mixes all audio for real-time AI transcription.

#### Overview

A/V Chat extends the multiplayer room with three capabilities:

1. **Camera & Mic Toggle** — Each participant captures their local camera and microphone via `useMediaDevices`. Tracks start muted; toggle buttons in the video grid control visibility/audio independently.
2. **Mesh Video Network** — `useVoiceRoom` establishes a PeerJS WebRTC mesh connecting up to **5 participants** (including the host). Peer discovery happens via Socket.IO (`room:announce_peer` → `room:peers_updated`).
3. **Voice Pipe (Host Only)** — When a guest raises their hand (Q&A mode), the host's `useVoicePipe` hook mixes all audio sources (local mic + remote peers) through a Web Audio API `AudioContext`, records the mix via `MediaRecorder` in 3-second chunks, and emits `room:audio_chunk` events for STT processing.

#### Video Grid

The `<VideoGrid />` component renders participant tiles in a responsive layout:

| Participants | Layout |
|---|---|
| 1 | Full width |
| 2 | Side-by-side |
| 3–4 | 2×2 grid |
| 5 | 3+2 rows |

Each tile shows:
- Video feed (via `srcObject` on `<video>`)
- "You" label for the local tile
- Remote peer ID for others
- Muted mic indicator when audio is off

The grid appears in a collapsible sidebar panel on both host and guest pages. Click the member count pill to show/hide it.

#### Bandwidth & Limitations

- **Max 5 participants** — The WebRTC mesh topology sends N-1 streams per participant. Beyond 5, upstream bandwidth becomes prohibitive.
- **Cloudflare Tunnel** — WebRTC data channels and TURN fallbacks may have limited throughput through Cloudflare Tunnels. STUN servers (`stun.l.google.com`) handle NAT traversal for direct peer connections.
- **Media defaults** — Video captures at 320×240 (ideal) to minimize bandwidth. Audio uses the browser's default codec.

#### Hooks Reference

| Hook | Purpose |
|---|---|
| `useMediaDevices(options?)` | Captures local camera/mic stream. Returns `stream`, `isAudioMuted`, `isVideoMuted`, `toggleAudio()`, `toggleVideo()`, `releaseStream()`. |
| `useVoiceRoom(presentationId, localStream)` | PeerJS mesh network. Returns `peerIds`, `remoteStreams`, `isMuted`, `toggleMic()`, `raiseHand()`, `lowerHand()`, `cleanup()`. |
| `useVoicePipe(presentationId, isHost, isRecording, localStream, remoteStreams)` | Host-only audio mixer. Connects all sources to a `MediaStreamDestination`, records chunks, emits `room:audio_chunk`. Returns `isActive`, `stopPipe()`. |

---

## Configuration Reference

All configuration lives in `config/default.json`. Environment variables are interpolated using `${VAR_NAME}` syntax.

| Key | Type | Default | Description |
|---|---|---|---|
| `server.port` | number | `3000` | HTTP listen port. |
| `logging.level` | string | `"info"` | Winston log level. |
| `auth.mode` | string | `"local"` | Auth strategy. |
| `auth.rateLimit.windowMs` | number | `60000` | Rate-limit window (ms). |
| `auth.rateLimit.max` | number | `10` | Max failed auth attempts per window. |
| `messaging.accessControl.mode` | string | `"open"` | `"open"`, `"allowlist"`, or `"blocklist"`. |
| `personality.mode` | string | `"append"` | System prompt mode: `"append"` merges your personality with SDK defaults, `"replace"` fully overrides the system prompt. |
| `channels.telegram.enabled` | boolean | `false` | Enable Telegram channel. |
| `channels.discord.enabled` | boolean | `false` | Enable Discord channel. |
| `channels.web.enabled` | boolean | `true` | Enable Web Chat channel. |
| `tasks.maxConcurrent` | number | `2` | Maximum parallel background agent tasks (1–10). Adjustable at runtime via Admin UI or API. |
| `session.historyWindow` | number | `20` | Max conversation turns retained in JSONL audit log for admin views. Does **not** affect LLM context (the SDK manages multi-turn context natively). |
| `session.maxToolsPerRequest` | number | `30` | Max tools sent per LLM request (1–128). Adjustable at runtime via Admin UI or `PUT /api/admin/session/config`. |
| `session.dynamicToolLoading` | boolean | `false` | Enable intent-based tool filtering (experimental). |
| `session.infiniteSessions.enabled` | boolean | `true` | Enable automatic context compaction for long conversations. |
| `session.infiniteSessions.backgroundCompactionThreshold` | number | `0.80` | Context usage threshold (0-1) at which background compaction begins. |
| `session.infiniteSessions.bufferExhaustionThreshold` | number | `0.95` | Context usage threshold (0-1) at which forced compaction occurs to prevent failures. |
| `tunnel.enabled` | boolean | `false` | Enable the embedded Cloudflare Tunnel. Set to `false` (default) when using the Docker sidecar pattern. |
| `tunnel.mode` | string | `"quick"` | `"quick"` or `"named"`. Only applies when `tunnel.enabled` is `true`. |
| `copilot.provider` | object \| null | `null` | BYOK provider config. See [BYOK Provider](#byok-provider-bring-your-own-key). |
| `copilot.defaultReasoningEffort` | string | `"medium"` | Default reasoning effort: `"low"`, `"medium"`, `"high"`, `"xhigh"`. |
| `copilot.defaultWorkingDirectory` | string \| null | `null` | Default working directory path for tool operations. |

**Environment variables for MCP sidecars** (typically set in `docker-compose.yml`):

| Variable | Default | Description |
|---|---|---|
| `MCP_LINKEDIN_URL` | `http://linkedin-mcp-server:5101` | LinkedIn MCP sidecar URL. |
| `MCP_TWITTER_URL` | `http://twitter-mcp-server:5102` | Twitter/X MCP sidecar URL. |
| `MCP_FACEBOOK_URL` | `http://facebook-mcp-server:5103` | Facebook MCP sidecar URL. |
| `MCP_PINTEREST_URL` | `http://pinterest-mcp-server:5104` | Pinterest MCP sidecar URL. |
| `MCP_WORD_URL` | `http://word-mcp-server:5201` | Office Word MCP sidecar URL. |
| `MCP_MARKITDOWN_URL` | `http://markitdown-mcp-server:5301` | MarkItDown file converter URL. |
| `MCP_GMAIL_URL` | `http://gmail-mcp-server:5302` | Gmail MCP sidecar URL. |
| `MCP_DATABASE_URL` | `http://database-mcp-server:5303` | JDBC Database MCP sidecar URL. |
| `MCP_GITHUB_URL` | `http://github-mcp-server:5304` | GitHub MCP sidecar URL. |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | — | GitHub PAT for the GitHub MCP server. |
| `JDBC_URL` | — | JDBC connection string for the Database MCP server. |
| `DB_PASSWORD` | — | Database password. |

---

## Advanced Examples: Combining Capabilities

This section demonstrates real-world workflows that combine multiple features — model overrides, reasoning effort, prompt chaining, custom agents, scheduled automation, and interactive clarifications — to showcase the full power of the platform.

---

### Example 1: Multi-Model Reasoning Chain (Chat)

![Model selector dropdown showing available models](images/chat-model-selector.png)

Use a reasoning model for planning, then a fast model for execution — all in one conversation.

**Chat transcript:**

```
You: I need to refactor the authentication module in my project. The code is in /home/user/project/src/auth/.
     Use high reasoning to analyze the architecture first, then generate the refactored code.

[Model: o4-mini | Reasoning: high]

Agent: I'll analyze the architecture with deep reasoning first.

     [calls read-file: /home/user/project/src/auth/index.ts]
     [calls list-directory: /home/user/project/src/auth/]
     [calls read-file: /home/user/project/src/auth/middleware.ts]

     Analysis complete. The current auth module has three issues:
     1. Token validation is duplicated across 4 files
     2. The session store uses synchronous file I/O
     3. Rate limiting is hardcoded instead of configurable

     I'll now spawn a coding agent with gpt-4.1 to implement the refactored code
     based on this analysis.

     [calls spawn-agent:
       goal: "Refactor the auth module at /home/user/project/src/auth/ based on
              the following analysis: (1) Extract token validation into a shared
              validateToken() utility, (2) Replace sync file I/O with async
              session store, (3) Make rate limiting configurable via config.json"
       model: "gpt-4.1"
       notify_user: true
     ]

     Background task started. The coding agent (gpt-4.1) is implementing the
     refactored code. You'll be notified when it completes.
```

**What's happening:**

| Step | Model | Reasoning | Purpose |
|------|-------|-----------|---------|
| 1. Architecture analysis | `o4-mini` | `high` | Deep reasoning identifies structural problems |
| 2. Code generation | `gpt-4.1` | *(default)* | Fast, cost-efficient code output via `spawn-agent` |

**Key takeaway:** Select `o4-mini` with high reasoning in the Chat UI for the analysis phase, then let the agent delegate to `gpt-4.1` for the implementation. You get the best of both models.

---

### Example 2: Prompt Templates Calling Other Prompts

Compose reusable prompt templates that chain together via the LLM's tool-calling loop. Each prompt can target a different model.

**Step 1 — Create the building-block prompts in the Library:**

| Prompt Name | Content | Preferred Tools |
|-------------|---------|-----------------|
| `research-topic` | `Research the topic "{{topic}}" thoroughly. Find at least 5 credible sources and summarize key findings with citations.` | `web-search`, `browser-navigate` |
| `write-article` | `Write a {{length}}-word article about the following research:\n\n{{research}}\n\nUse a {{tone}} tone. Include an introduction, 3-5 sections with subheadings, and a conclusion.` | `read-file`, `write-file` |
| `review-content` | `Review the following article for factual accuracy, grammar, and readability. Provide specific suggestions:\n\n{{content}}` | `read-file` |

**Step 2 — Use the chain in Chat:**

```
You: I need a blog post about quantum computing breakthroughs in 2025.
     First, run the prompt "research-topic" with topic="quantum computing
     breakthroughs 2025". Then take that output and run "write-article"
     with length=1500 and tone=conversational. Finally, run "review-content"
     on the result.

Agent: I'll chain these prompts together.

     [calls run-prompt: name="research-topic",
      variables={"topic": "quantum computing breakthroughs 2025"}]

     Research complete. Key findings from 5 sources: ...

     [calls run-prompt: name="write-article",
      variables={"research": "<research output>", "length": "1500",
                  "tone": "conversational"}]

     Article drafted (1,487 words). Writing to file...

     [calls write-file: /home/user/blog/quantum-2025.md]

     [calls run-prompt: name="review-content",
      variables={"content": "<article text>"}]

     Review complete:
     - ✅ Factually accurate (all claims verified against sources)
     - ⚠️ Paragraph 3 could be split for readability
     - ⚠️ Consider adding a concrete example in the "Error Correction" section
```

**Step 3 — Automate the chain with a scheduled job:**

Create a scheduled job in the Scheduler UI that runs this workflow automatically:

| Field | Value |
|-------|-------|
| **Name** | `weekly-blog-research` |
| **Cron** | `0 9 * * 1` (Monday 9 AM) |
| **Action** | Prompt |
| **Prompt** | See below |
| **Model** | `gpt-4.1` |
| **Auto-Approve Tools** | `web-search, browser-navigate, write-file` |

**Job prompt:**

```
Run the following prompts in sequence:

1. Run prompt "research-topic" with topic="AI industry news this week"
2. Take the research output and run prompt "write-article" with
   length=2000 and tone=professional
3. Save the article to /home/user/blog/weekly-ai-digest.md
4. Run prompt "review-content" on the saved article
5. If the review finds issues, revise the article and save again

This is an autonomous job — complete all steps without human intervention.
```

**Key takeaway:** Prompts are composable building blocks. The LLM chains them by calling `run-prompt` repeatedly, passing output from one as input variables to the next. Each prompt can also carry its own `preferredTools` to scope tool access.

---

### Example 3: Multi-Model Orchestration with `orchestrate-agents`

Fan out to multiple models in parallel, each optimized for a different task, then aggregate results.

**Chat transcript:**

```
You: I'm evaluating whether to migrate our API from Express to Fastify.
     Use orchestrate-agents to research this from three angles simultaneously,
     using the best model for each task.

Agent: I'll dispatch three specialized agents in parallel.

     [calls orchestrate-agents:
       agents: [
         {
           goal: "Benchmark Express vs Fastify performance. Find recent
                  benchmarks (2024-2025), compare request throughput, latency
                  p99, and memory usage under load. Use web-search.",
           model: "gpt-4.1"
         },
         {
           goal: "Analyze the migration effort from Express to Fastify. Review
                  the codebase at /home/user/api/src/ and identify: (1) number
                  of route handlers, (2) middleware that needs rewriting,
                  (3) Express-specific patterns with no Fastify equivalent.
                  Provide an estimated effort in developer-days.",
           model: "o4-mini"
         },
         {
           goal: "Research Fastify's ecosystem maturity. Check: plugin count on
                  npm, TypeScript support quality, community activity (GitHub
                  stars, recent commits, open issues), and production adoption
                  by notable companies.",
           model: "gpt-4.1"
         }
       ],
       aggregation_prompt: "Compile the three analyses into an executive summary
         with a recommendation table: Performance | Migration Effort | Ecosystem.
         Include a final GO / NO-GO recommendation with justification.",
       timeout_seconds: 300
     ]

     ┌─────────────────────────────────────────────────────────┐
     │ Agent 1 (gpt-4.1): Performance benchmarks         ✅   │
     │ Agent 2 (o4-mini):  Migration effort analysis      ✅   │
     │ Agent 3 (gpt-4.1): Ecosystem research              ✅   │
     └─────────────────────────────────────────────────────────┘

     Executive Summary: Express → Fastify Migration Assessment

     | Dimension        | Finding                              | Score |
     |------------------|--------------------------------------|-------|
     | Performance      | 2.3x throughput improvement           | ✅ GO |
     | Migration Effort | ~12 dev-days for 47 routes            | ⚠️    |
     | Ecosystem        | 350+ plugins, excellent TS support    | ✅ GO |

     Recommendation: **GO** — Performance gains justify the 12-day investment...
```

**Why different models?**

| Agent | Model | Rationale |
|-------|-------|-----------|
| Benchmarks | `gpt-4.1` | Fast web search and data summarization |
| Migration analysis | `o4-mini` | Needs deep reasoning to analyze code patterns |
| Ecosystem research | `gpt-4.1` | Broad web research, no deep reasoning needed |

---

### Example 4: Custom Agent with Interactive Clarifications

Custom agents can ask clarifying questions before proceeding. This example shows a security audit agent that asks the user to specify scope.

**Setup — define the agent in Admin → Custom Agents:**

| Field | Value |
|-------|-------|
| **Name** | `security-auditor` |
| **Display Name** | Security Auditor |
| **Description** | Analyzes code for vulnerabilities and suggests hardening measures |
| **System Prompt** | `You are a senior security engineer. Before starting an audit, always ask the user to clarify the scope (which directories, what threat model, and compliance framework). Use the interactive clarification feature to present options.` |
| **Tools** | `read-file`, `list-directory`, `shell-execute`, `web-search` |
| **Auto-Invoke** | ✅ Enabled (`infer: true`) |

**Chat transcript:**

```
You: @security-auditor Audit the authentication code in my project at
     /home/user/project/src/

Agent (Security Auditor): Before I begin, I need to understand the scope.

     ┌─────────────────────────────────────────────────┐
     │ What compliance framework should I audit against?│
     │                                                  │
     │ ○ OWASP Top 10 (Web application security)      │
     │ ○ SOC 2 (Enterprise compliance)                 │
     │ ○ PCI DSS (Payment card industry)               │
     │ ○ Custom / General best practices               │
     │                                                  │
     │ Or type a custom framework: [____________]       │
     │                                                  │
     │                            [Submit]    ████░ 45s │
     └─────────────────────────────────────────────────┘

You: [selects "OWASP Top 10"]

Agent (Security Auditor): Auditing against OWASP Top 10. Scanning...

     [calls list-directory: /home/user/project/src/auth/]
     [calls read-file: /home/user/project/src/auth/login.ts]
     [calls read-file: /home/user/project/src/auth/session.ts]
     [calls shell-execute: grep -rn "eval\|exec\|innerHTML" src/]

     Security Audit Report — OWASP Top 10
     ─────────────────────────────────────

     🔴 A01:2021 Broken Access Control
        • session.ts:42 — No CSRF token validation on state-changing endpoints

     🟡 A02:2021 Cryptographic Failures
        • login.ts:18 — bcrypt rounds set to 8 (recommend ≥12)

     🟢 A03:2021 Injection — No issues found
     ...
```

**Key takeaway:** The `@security-auditor` mention routes to the custom agent. The `infer: true` setting means the SDK could also auto-delegate security-related questions to this agent without an explicit mention. Interactive clarifications let the agent gather structured input mid-conversation with a 60-second timeout.

---

### Example 5: File Attachments + Reasoning for Code Review

Attach files directly in the Chat UI and combine with high reasoning for thorough analysis.

**Chat transcript:**

```
[Attachments: 📎 src/api/handlers.ts  📎 src/api/middleware.ts]
[Model: o4-mini | Reasoning: high]

You: Review these two files for performance issues and race conditions.
     Focus on the database query patterns and async error handling.

Agent: Analyzing both attached files with extended reasoning...

     [Reading: src/api/handlers.ts (247 lines)]
     [Reading: src/api/middleware.ts (89 lines)]

     Performance & Concurrency Review
     ═════════════════════════════════

     🔴 Critical: Race condition in handlers.ts lines 78-92
        The `updateUserBalance()` function reads the balance, modifies it,
        and writes it back without a transaction or optimistic lock. Under
        concurrent requests, two updates can read the same stale value:

        // Current (unsafe):
        const balance = await db.getBalance(userId);
        await db.setBalance(userId, balance + amount);

        // Recommended (transaction with row lock):
        await db.transaction(async (tx) => {
          const balance = await tx.getBalance(userId, { forUpdate: true });
          await tx.setBalance(userId, balance + amount);
        });

     🟡 Performance: N+1 query in handlers.ts lines 134-148
        The user list endpoint fetches all users, then loops to fetch each
        user's profile. Replace with a JOIN or batch query.

     🟢 middleware.ts: Error handling looks correct — async errors are
        properly caught and forwarded to the error handler.
```

**How it works:**
1. Click the 📎 button in the Chat input (or drag files onto the drop zone) to attach up to 10 files.
2. Attached files are sent to the Copilot SDK as `SdkAttachment` objects — the SDK reads file contents automatically.
3. Select a reasoning model (`o4-mini`, `o3-mini`) and set reasoning effort to `high` for thorough analysis.
4. The model receives both the file contents and your prompt, combining deep reasoning with full file context.

---

### Example 6: Fully Autonomous Scheduled Pipeline

A production-ready example: a nightly data pipeline that runs without human intervention, using auto-approved tools, multi-model orchestration, and prompt templates.

**Step 1 — Create the prompts:**

| Name | Content |
|------|---------|
| `extract-metrics` | `Query the database for {{metric_type}} metrics from the last {{period}}. Use the db-query tool. Return raw JSON data.` |
| `generate-report` | `Generate a Markdown report from the following data:\n\n{{data}}\n\nInclude: executive summary, trend analysis with percentage changes, and anomaly flags for any metric that deviated >2σ from the 30-day mean. Save to {{output_path}}.` |

**Step 2 — Create the scheduled job:**

| Field | Value |
|-------|-------|
| **Name** | `nightly-metrics-pipeline` |
| **Cron** | `0 2 * * *` (2 AM daily) |
| **Model** | `gpt-4.1` |
| **Auto-Approve Tools** | `db-query, read-file, write-file, shell-execute, spawn-agent, orchestrate-agents` |

**Job prompt:**

```
You are an autonomous data pipeline agent. Execute the following steps:

1. Use orchestrate-agents to gather metrics in parallel:
   - Agent 1 (model: gpt-4.1): Run prompt "extract-metrics" with
     metric_type="revenue" and period="24 hours"
   - Agent 2 (model: gpt-4.1): Run prompt "extract-metrics" with
     metric_type="user_engagement" and period="24 hours"
   - Agent 3 (model: gpt-4.1): Run prompt "extract-metrics" with
     metric_type="system_performance" and period="24 hours"

2. Combine all three datasets and run prompt "generate-report" with
   output_path="/data/reports/daily-metrics-{{date}}.md"

3. Run shell command: git -C /data/reports add . && git commit -m
   "Daily metrics report $(date +%Y-%m-%d)" && git push

Complete all steps autonomously. Do not wait for human input.
```

**Execution flow (2:00 AM):**

```
Scheduler fires → TaskEngine.submit()
  └─ TaskWorker dequeues → LLM executes
       ├─ orchestrate-agents (3 parallel sub-agents)
       │   ├─ Agent 1: db-query → revenue data          [auto-approved]
       │   ├─ Agent 2: db-query → engagement data        [auto-approved]
       │   └─ Agent 3: db-query → performance data       [auto-approved]
       │
       ├─ run-prompt "generate-report" → Markdown report
       │   └─ write-file → /data/reports/daily-metrics-2025-07-15.md
       │                                                 [auto-approved]
       │
       └─ shell-execute → git add, commit, push          [auto-approved]
```

**Key features used:**
- **Auto-approved tools**: `db-query`, `write-file`, and `shell-execute` bypass the approval queue — the audit log records each as `tool_auto_approved`.
- **Prompt templates**: Reusable `extract-metrics` and `generate-report` prompts keep the job definition clean.
- **Multi-agent parallel execution**: Three data extraction agents run concurrently for speed.
- **Autonomous end-to-end**: No human in the loop — ideal for off-hours pipelines.

---

### Example 7: BYOK Provider with Local Ollama for Private Data

![BYOK Provider configuration panel — provider type, base URL, and API key](images/admin-byok-provider.png)

Run sensitive workloads entirely on your local network using Ollama, then switch back to Copilot for general tasks.

**Step 1 — Configure Ollama in Admin → Model Configuration:**

| Field | Value |
|-------|-------|
| **Provider** | Ollama |
| **Base URL** | `http://localhost:11434` |
| **API Key** | *(leave blank — Ollama doesn't require one)* |

Click **Test Connection** to verify Ollama is reachable, then **Save**.

**Step 2 — Chat with your private data:**

```
[Provider badge shows: 🏷️ Ollama]
[Attachments: 📎 /data/confidential/q2-financials.xlsx]

You: Analyze these Q2 financial results. Identify the three highest-growth
     product lines and flag any revenue anomalies.

Agent (via Ollama - llama3.3): Analyzing Q2 financial data locally...

     [calls convert-to-markdown: /data/confidential/q2-financials.xlsx]
     [calls read-file: converted output]

     Q2 Financial Analysis
     ═════════════════════

     Top 3 Growth Product Lines:
     1. Cloud Services: +34% QoQ ($12.4M → $16.6M)
     2. API Platform: +28% QoQ ($8.1M → $10.4M)
     3. Enterprise Support: +19% QoQ ($5.2M → $6.2M)

     ⚠️ Anomaly: Hardware division revenue dropped 42% — investigate
     potential reporting error or delayed shipments.
```

**Step 3 — Switch back to Copilot for non-sensitive work:**

Navigate to Admin → Model Configuration → click **Clear Provider** to revert to GitHub Copilot. The provider badge disappears, and subsequent messages route through the Copilot SDK.

**Key takeaway:** BYOK providers let you keep sensitive data processing on-premises while still using Copilot for general-purpose tasks. Switch providers at runtime — no restart required. All cached SDK sessions are cleared on provider change.

---

### Example 8: Session Continuity with Infinite Context

Long-running research sessions that survive context window limits and server restarts.

**Chat transcript (over several hours):**

```
[Session: abc-123 | Context: ░░░░░░░░░░ 12% | Turns: 1 | Age: just now]

You: Let's research the history of type systems in programming languages.
     Start with the lambda calculus foundations.

Agent: The formal foundations begin with Alonzo Church's lambda calculus
       in the 1930s...

     [... 45 minutes of deep conversation, reading papers, taking notes ...]

[Session: abc-123 | Context: ████████░░ 82% | Turns: 34 | Age: 47m]
[🔄 Compacting context in background...]
[✅ Context compacted]

[Session: abc-123 | Context: ████░░░░░░ 38% | Turns: 34 | Age: 48m]

You: Now compare the type systems of Haskell, Rust, and TypeScript
     based on everything we've discussed.

Agent: Drawing from our earlier discussion of the Hindley-Milner
       foundations and the evolution through ML and System F...

     [The agent retains the full thread of the conversation despite
      the context window being compacted — key concepts and findings
      are preserved while verbose intermediate steps are summarized]
```

**What's happening behind the scenes:**

| Event | Context Usage | Action |
|-------|--------------|--------|
| Conversation starts | 0% | New SDK session created |
| Turn 20 | 60% | Normal operation |
| Turn 30 | 80% | Background compaction threshold reached — SDK compacts older context |
| Post-compaction | ~38% | Older turns summarized, recent turns preserved verbatim |
| Turn 50 | 75% | Conversation continues naturally |
| Turn 60 | 80% | Another compaction cycle |

**Session resumption after restart:**

```
[Server restarts]
[Session: abc-123 | Resumed ✅ | Context: 42% | Turns: 60]

You: Where were we? Can you summarize what we covered about
     dependent types?

Agent: In our earlier discussion, we covered dependent types in the
       context of Idris and Agda...
```

The SDK's `resumeSession()` API restores the session state. If the session has expired, a new session is created — the JSONL audit log preserves the conversation history for reference.

---

### Example 9: Custom Agent with its Own MCP Server

Define a custom agent that brings its own tools via a dedicated MCP server — useful for domain-specific tooling.

**Configuration (Admin → Custom Agents or `~/.openzigs/config.json`):**

```json
{
  "copilot": {
    "customAgents": [
      {
        "name": "k8s-ops",
        "displayName": "Kubernetes Ops Agent",
        "description": "Manages Kubernetes clusters with kubectl and helm",
        "prompt": "You are a Kubernetes operations expert. Use your dedicated k8s tools (via your MCP server) and the standard shell tools to manage clusters. Always check current state before making changes. Explain what you're about to do before executing destructive operations.",
        "tools": ["shell-execute", "read-file"],
        "infer": true,
        "mcpServers": {
          "kubectl-mcp": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "@example/kubectl-mcp-server"],
            "env": {
              "KUBECONFIG": "/home/user/.kube/config"
            }
          }
        }
      }
    ]
  }
}
```

**Chat transcript:**

```
You: @k8s-ops What pods are failing in the production namespace?

Agent (Kubernetes Ops): Checking pod status in production...

     [calls kubectl-get-pods: namespace=production, status=Failed]

     3 pods are in a failing state:

     | Pod | Status | Restarts | Last Error |
     |-----|--------|----------|------------|
     | api-server-7b4d | CrashLoopBackOff | 12 | OOMKilled |
     | worker-3a1c | Error | 3 | Exit code 137 |
     | cache-9f2e | ImagePullBackOff | 0 | Image not found |

     The api-server and worker pods are running out of memory.
     The cache pod has an image reference issue.

     Want me to investigate the resource limits, or should I fix
     the image reference for the cache pod first?
```

**Key takeaway:** The `mcpServers` field on a custom agent gives it access to tools that only that agent can use — other agents and the primary model don't see them. This keeps the tool namespace clean and lets you create purpose-built agents with specialized tooling.

---

### Quick Reference: Feature Combinations

| I want to... | Features to combine |
|---|---|
| Analyze code deeply, then generate fixes cheaply | Reasoning model (`o4-mini`, high effort) → `spawn-agent` with `gpt-4.1` |
| Run a multi-source research report on a schedule | Scheduler + `orchestrate-agents` + auto-approve tools |
| Chain reusable prompt templates | Library prompts + `run-prompt` tool (LLM calls it sequentially) |
| Process sensitive data locally | BYOK Ollama provider + file attachments |
| Create a domain expert agent | Custom agent + dedicated MCP server + specific tool allowlist |
| Never lose context in long sessions | Infinite sessions (enabled by default) + session context bar monitoring |
| Get structured input during a workflow | Interactive clarifications (choices + free-text + 60s timeout) |
| Review files without copy-pasting | File attachments (📎 button or drag-and-drop) + reasoning model |
| Run a nightly pipeline end-to-end | Scheduler + prompt chaining + `orchestrate-agents` + auto-approve |
| Delegate automatically to specialists | Custom agents with `infer: true` |

---

## AI-Assisted Configuration (Workflow Wizard)

OpenZigs includes a **Workflow Wizard** — an interactive conversational assistant that guides you step-by-step through creating prompts, scheduled jobs, webhooks, and custom agents.

### How It Works

1. **Start** — In the Chat, describe what you want to create. The AI detects intent and activates the Wizard persona.
2. **Guided Questions** — The Wizard asks one question at a time, suggesting sensible defaults.
3. **Preview Card** — Once all details are gathered, a structured **Workflow Preview Card** appears in the chat showing the complete configuration.
4. **Confirm / Edit / Test Run** — Click **Confirm** to save, **Edit** to change a field, or **Test Run** (for scheduled jobs) to preview what would happen without executing.

![Workflow preview card for a prompt template showing config details and Confirm / Edit buttons](images/workflow-preview-prompt.png)

![Scheduled job preview card with Confirm, Edit, and Test Run buttons](images/workflow-preview-scheduled-job.png)

![Webhook preview card with action and rate limit config](images/workflow-preview-webhook.png)

### Preview Card Actions

| Action | Description |
|---|---|
| **Confirm** | Persists the configuration (creates the prompt, job, webhook, or agent). |
| **Edit** | Returns to the conversation so you can change specific fields. |
| **Test Run** | (Scheduled jobs only) Shows a dry-run preview of the job's output. |

### The `create-prompt` Tool

A dedicated MCP tool for creating prompt templates with duplicate-name protection:

```
Tool: create-prompt (risk: high)
Inputs:
  name        — Unique prompt name
  content     — Prompt template with {{variable}} placeholders
  description — Optional description
  tags        — Optional tag array
  variables   — Optional variable metadata array
  systemPrompt — When true, adds "system-prompt" tag
```

Unlike the existing `save-prompt` (which is an upsert), `create-prompt` rejects duplicate names to prevent accidental overwrites during wizard flows.

### The `workflow-wizard` Tool

The AI uses this tool to present structured preview cards:

```
Tool: workflow-wizard (risk: low)
Inputs:
  type    — "prompt" | "scheduled-job" | "webhook" | "agent"
  name    — Human-readable name
  summary — One-line description
  config  — Key-value configuration to preview
```

---

## Dry-Run & Job Testing

Before running a scheduled job for real, you can test it safely with dry-run mode.

### Dry Run from the UI

Each job card in the **Scheduler** page now has a **🧪 Dry Run** button alongside the existing **▶ Run** button. Clicking it shows a preview panel below the job card with exactly what the job would do — without executing anything or incrementing run counts.

![Scheduler with Dry Run button alongside Run button](images/scheduler-dry-run-button.png)

![Dry Run preview panel showing job configuration JSON](images/scheduler-dry-run-preview.png)

### Dry Run via MCP Tools

Two MCP tools support dry-run workflows:

**`schedule-job` with `dry_run: true`**
```json
{
  "name": "nightly-report",
  "cronExpression": "0 22 * * *",
  "actionType": "prompt",
  "actionPayload": { "promptName": "daily-summary" },
  "dry_run": true
}
```
Returns a preview of the job configuration without saving it.

**`test-job`**
```json
{ "id": "job-abc123" }
```
Takes an existing job ID and returns a dry-run preview of its current configuration.

### Dry Run via API

```bash
curl -X POST http://localhost:3000/api/admin/jobs/JOB_ID/run?dry_run=true \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Returns the job preview JSON without triggering execution.

---

## Enterprise Webhooks

Webhooks let external systems (CI/CD, monitoring, third-party services) trigger OpenZigs actions via HTTP POST requests.

### Creating a Webhook

![Webhooks admin page — create form, webhook list with toggle and rotate key controls](images/webhooks-admin-list.png)

1. Navigate to **Admin → Webhooks** (or `/admin/webhooks`).
2. Click **+ New Webhook**.
3. Configure:
   - **Name** — Descriptive label (e.g., `github-deploy-hook`).
   - **Action** — `prompt` (executes a saved prompt) or `goal` (sends a natural-language goal to the agent).
   - **Prompt Name** or **Goal** — The target action.
   - **Rate Limit** — Max requests per minute (default: 60).
   - **Allowed IPs** — Optional comma-separated IP allowlist.
4. Click **Create Webhook**.

![Webhook creation form with name, action type, prompt name, rate limit, and IP allowlist](images/webhooks-create-form.png)

5. **Save the API key** — it's shown only once.

![API key reveal banner after webhook creation](images/webhooks-created-with-key.png)

### Triggering a Webhook

```bash
curl -X POST http://localhost:3000/api/webhooks/trigger \
  -H "Authorization: Bearer whk_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"topic": "deployment", "environment": "production"}'
```

The JSON body is passed as prompt variables (for `prompt` actions) or task context (for `goal` actions).

### Authentication Methods

| Method | Headers Required |
|---|---|
| **Bearer Token** | `Authorization: Bearer whk_...` |
| **HMAC Signature** | `X-Webhook-Id: WEBHOOK_ID` + `X-Webhook-Signature: SHA256_HEX` |

### Security Features

- **API Key Hashing** — Keys are stored as SHA-256 hashes; plaintext is never persisted.
- **Timing-Safe Comparison** — Prevents timing attacks on key/signature validation.
- **IP Allowlisting** — Restrict which IPs can trigger the webhook.
- **Rate Limiting** — Per-webhook rate limits (default 60/min).
- **Key Rotation** — Rotate API keys from the UI without deleting the webhook.
- **HMAC-SHA256 Verification** — Webhook payloads are verified using standard HMAC-SHA256 with the raw request body.

### Managing Webhooks

| Action | UI | API |
|---|---|---|
| List all | Webhooks page | `GET /api/admin/webhooks` |
| Create | + New Webhook form | `POST /api/admin/webhooks` |
| Toggle | Toggle switch | `POST /api/admin/webhooks/:id/toggle` |
| Rotate key | 🔄 Rotate Key button | `POST /api/admin/webhooks/:id/rotate-key` |
| Delete | Delete button | `DELETE /api/admin/webhooks/:id` |

---

## Self-Aware Documentation

The AI can answer questions about OpenZigs itself — its architecture, configuration, tools, and features — using the built-in documentation tools.

### How It Works

![Admin tools panel showing query-documentation enabled alongside other productivity tools](images/admin-tools-doc-enabled.png)

The `query-documentation` tool searches the project's markdown documentation and JSON config files by topic keyword. The AI can find relevant sections from:

- **ARCHITECTURE.md** — System design, tool catalog, security model.
- **USER_GUIDE.md** — Usage instructions, configuration reference.
- **TELEGRAM_SETUP.md** — Channel setup guides.
- **default.json / tools.json** — Configuration files.

### Example Questions

- *"How do tool risk levels work?"*
- *"What's the architecture of the approval queue?"*
- *"How do I configure Telegram?"*
- *"What MCP tools are available?"*

### Documentation Expert Agent

A custom agent named `documentation-expert` is pre-configured in `config/agents.json` with `infer: true`. When the AI detects a question about OpenZigs itself, it can automatically delegate to this specialist agent.

---

## Sentinel — Autonomous System Monitor

Sentinel is a background daemon that continuously monitors the health of your OpenZigs instance. It watches task success rates, detects stuck or slow tasks, audits prompt quality, and delivers daily digest reports — all without manual intervention.

### Enabling Sentinel

Sentinel is disabled by default. Enable it in the Admin panel or in your config:

```json
{
  "sentinel": {
    "enabled": true
  }
}
```

Or toggle it live from the Admin UI:

1. Navigate to **Admin** → **Sentinel Monitor**
2. Click **Enable**

![Sentinel Monitor panel](images/admin-sentinel-monitor.png)

### What Sentinel Monitors

- **Task health**: Success rates, consecutive failures, queue depth
- **Orphaned tasks**: Tasks running longer than 30 minutes
- **Slow tasks**: Tasks that took longer than 5 minutes
- **Prompt quality**: Samples recent user prompts and scores them for clarity and token efficiency

### Alerts

Sentinel generates real-time alerts delivered via Socket.IO to the Admin UI:

| Alert | Priority | Description |
|---|---|---|
| Consecutive Failures | Critical | 3+ tasks failed in a row |
| Queue Depth | Warning | Task queue exceeds 10 items |
| Orphaned Task | Warning | A task has been running > 30 min |
| Success Rate Drop | Critical | Success rate below 50% |

Alerts include automatic deduplication — critical alerts have a configurable cooldown (default: 5 minutes for critical, 30 minutes for warnings).

#### Multi-Channel Alert Routing

Alerts can be sent to multiple channels simultaneously. By default, alerts go to the Admin UI (`"admin"` channel). You can add external messaging channels:

```json
{
  "sentinel": {
    "notifyChannels": ["admin", "telegram", "discord"],
    "criticalCooldownMinutes": 5,
    "warningCooldownMinutes": 30
  }
}
```

- **`admin`**: Socket.IO to the web dashboard (always recommended)
- **External channels** (e.g., `telegram`, `discord`): Only **critical** alerts are routed to external channels to avoid notification fatigue
- Cooldown timers are per-alert-type and configurable at runtime

### Daily Digest

Once per day (default 9:00 AM), Sentinel generates a summary of:

- Tasks completed, failed, and cancelled
- Overall success rate
- Token burn analysis (total, average per task, top consumer)
- Prompt quality scores (if audit ran)
- **Per-prompt recommendations** with improvement suggestions and rewrites
- Alert count for the period

View past digests in the **Admin** → **Sentinel Monitor** → **Digest History** section. Each digest card shows an expandable **Prompt Improvements** section with score badges (🟢 ≥8, 🟡 ≥5, 🔴 <5), specific suggestions, and suggested rewrites for low-scoring prompts.

#### Downloading Digests

Click the **Download** button in the Digest History section to download the latest digest as a Markdown file. This file is also auto-generated at `~/.openzigs/sentinel/status.md` when `persistMarkdownDigest` is enabled (default: `true`).

```bash
# Or fetch via API
curl http://localhost:3001/api/admin/sentinel/digest-markdown -o sentinel-digest.md
```

#### Digest Retention

Old digest entries are automatically pruned. Configure the retention window with `digestRetentionDays` (default: 30 days).

### Scheduler Configuration

Sentinel uses node-cron v4 with support for timezone-aware scheduling and overlap prevention:

```json
{
  "sentinel": {
    "timezone": "America/New_York",
    "noOverlap": true,
    "maxRandomDelayMs": 5000
  }
}
```

- **`timezone`**: IANA timezone for cron schedules (default: `"UTC"`)
- **`noOverlap`**: Prevents a cron job from firing if the previous execution is still running (default: `true`)
- **`maxRandomDelayMs`**: Native cron jitter in milliseconds (0 disables native jitter; uses manual jitter via `jitterMinutes` instead)

### Running a Check Manually

Click **Run Check Now** in the Sentinel panel, or use the API:

```bash
curl -X POST http://localhost:3001/api/admin/sentinel/run-now
```

### Configuration Options

| Key | Default | Description |
|---|---|---|
| `enabled` | `false` | Enable/disable Sentinel |
| `model` | `gpt-4o-mini` | Model used for prompt audits |
| `checkIntervalMinutes` | `15` | How often to run task health checks |
| `jitterMinutes` | `15` | Random delay (up to N minutes) added after each check interval |
| `digestHour` | `9` | Hour of day (0-23) for daily digest |
| `auditHour` | `2` | Hour of day (0-23) for prompt audit |
| `consecutiveFailureThreshold` | `3` | Failures before critical alert |
| `queueDepthThreshold` | `10` | Queue depth before warning |
| `persistMarkdownDigest` | `true` | Write digest to `status.md` file |
| `markdownDigestPath` | `null` | Custom path for `status.md` (default: `~/.openzigs/sentinel/status.md`) |
| `digestRetentionDays` | `30` | Days to keep digest history before pruning |
| `notifyChannels` | `["admin"]` | Channels to send alerts to (`"admin"`, `"telegram"`, `"discord"`, etc.) |
| `criticalCooldownMinutes` | `5` | Deduplication cooldown for critical alerts |
| `warningCooldownMinutes` | `30` | Deduplication cooldown for warning alerts |
| `timezone` | `"UTC"` | IANA timezone for cron schedules |
| `noOverlap` | `true` | Prevent overlapping cron executions |
| `maxRandomDelayMs` | `0` | Native cron jitter in milliseconds (0 = use manual jitter) |

---

## Knowledge Manager — Local Knowledge Base (RAG)

The Knowledge Manager provides a **Retrieval-Augmented Generation (RAG)** pipeline that indexes local files (Markdown, code, text, JSON, etc.) into an embedded vector database and exposes them to the AI via the `search-knowledge` tool. This lets the AI ground its responses in your own documentation, notes, and code — without sending anything to external services.

### How It Works

1. **Ingest**: Files in your knowledge directory (`~/.openzigs/knowledge/` by default) are scanned, chunked, and embedded.
2. **Watch**: A file watcher (chokidar) detects changes, additions, and deletions in real time.
3. **Search**: The `search-knowledge` MCP tool performs semantic vector search against the index.
4. **Dedup**: Content hashing (SHA-256) ensures unchanged files are not re-indexed.

### Setting Up the Knowledge Directory

Create the knowledge directory and drop files into it:

```bash
mkdir -p ~/.openzigs/knowledge
# Copy your docs, notes, code snippets, etc.
cp -r ~/my-project/docs ~/.openzigs/knowledge/
cp ~/notes/*.md ~/.openzigs/knowledge/
```

The service automatically indexes all supported files on startup and watches for changes.

### Supported File Types

| Extension | Source Type |
|---|---|
| `.md` | Markdown |
| `.txt` | Text |
| `.pdf` | PDF (text + OCR fallback for scanned PDFs) |
| `.docx` | Word document (DOCX) |
| `.xlsx`, `.xls` | Excel spreadsheet |
| `.jpg`, `.jpeg`, `.png`, `.tiff`, `.tif`, `.bmp`, `.webp`, `.gif` | Image OCR |
| `.mp4`, `.mp3`, `.wav`, `.m4a`, `.webm`, `.ogg`, `.flac` | Media transcription |
| `.json` | JSON |
| `.csv` | CSV |
| `.html` | HTML |
| `.py` | Code (Python) |
| `.ts`, `.js` | Code (TypeScript/JavaScript) |
| `.go` | Code (Go) |
| `.rs` | Code (Rust) |
| `.java` | Code (Java) |
| `.c`, `.cpp`, `.h` | Code (C/C++) |
| `.rb` | Code (Ruby) |
| `.sh`, `.bash` | Code (Shell) |
| `.yaml`, `.yml` | YAML |
| `.toml` | TOML |
| `.xml` | XML |
| `.sql` | SQL |
| `.r` | Code (R) |
| `.swift` | Code (Swift) |
| `.kt` | Code (Kotlin) |

If **Media** appears as unavailable in the Converters tab, the usual causes are:

1. `ffmpeg` is not installed or not on `PATH`.
2. `whisper-node` model files are missing.

For local development, run:

```bash
pnpm exec whisper-node download
```

### Using the `search-knowledge` Tool

The `search-knowledge` tool is **always-on** — the AI can use it in any conversation without explicit enabling. It accepts:

- **`query`** (required): Natural language search query
- **`limit`** (optional): Maximum results to return (default: 10)
- **`mode`** (optional): Search strategy — `"hybrid"` (default), `"vector"` (semantic only), or `"fts"` (keyword only)

**Search modes explained:**

| Mode | When to Use |
|---|---|
| **`hybrid`** (default) | Best for most queries. Combines semantic understanding with exact keyword matching via reciprocal rank fusion. Results appearing in both vector and FTS results get a relevance boost. |
| **`vector`** | Conceptual queries where you want semantically similar content, even if it doesn't share exact keywords. Example: "how does authentication work?" |
| **`fts`** | Exact keyword searches for specific terms, function names, or error messages. Example: "CORS_ALLOWED_ORIGINS", "handleAuthCallback" |

Example AI interaction:

> **You**: What does our deployment guide say about rollback procedures?
>
> **AI**: *(automatically calls search-knowledge with "deployment rollback procedures")* Based on your knowledge base, the deployment guide at `docs/deployment.md` describes the following rollback procedure…

### Knowledge Manager UI

Navigate to **Knowledge** in the top nav bar to access the Knowledge Manager page.

![Knowledge Manager page](images/knowledge-manager.png)

#### Overview Tab

Displays index statistics:

- **Total Documents**: Number of indexed files
- **Total Chunks**: Number of text chunks in the vector database
- **Source Types**: Breakdown of indexed file types

#### Documents Tab

Lists all indexed documents with:

- File path, source type, chunk count, and last-indexed timestamp
- **Re-index** button per document to force re-ingestion
- **Remove** button to delete a document from the index
- **Re-index All** button to rebuild the entire index

#### Search Tab

Interactive semantic search interface:

1. Enter a natural language query
2. View ranked results with relevance scores (percentage badges)
3. Each result shows the source file, heading context, and matching text chunk

### API Endpoints

All knowledge endpoints are under `/api/admin/knowledge`:

| Method | Path | Description |
|---|---|---|
| `GET` | `/stats` | Index statistics (documents, chunks, source types) |
| `GET` | `/documents` | List all indexed documents |
| `POST` | `/search` | Semantic search (`{ "query": "...", "limit": 10 }`) |
| `POST` | `/reindex` | Re-index all documents |
| `POST` | `/reindex/:documentId` | Re-index a specific document |
| `DELETE` | `/documents/:documentId` | Remove a document from the index |
| `GET` | `/config` | Current knowledge configuration |
| `PUT` | `/config` | Update knowledge configuration (`directory`, `watchEnabled`, `mediaModel`, `searchMode`, `minScore`) |

### Configuration Options

You can change the knowledge directory, search mode, and other settings from the Admin UI:

1. Navigate to **Admin** → **Knowledge Base**
2. Update settings:
   - **Knowledge Directory** — path to watch for files
   - **Live File Watching** — enable/disable real-time change detection
   - **Whisper Model** — audio/video transcription quality (tiny.en → large-v1)
   - **Search Mode** — hybrid (recommended), vector, or full-text
   - **Minimum Score Threshold** — filter out low-relevance results (slider, 0–100%)
3. Click **Save**

Changes apply immediately (no server restart required). When the directory changes, OpenZigs clears the current index and re-scans the new directory.

Configure the knowledge base in your config file (`~/.openzigs/config.json`):

```json
{
  "knowledge": {
    "directory": "~/.openzigs/knowledge",
    "chunkSize": 1000,
    "chunkOverlap": 200,
    "maxResults": 10,
    "watchEnabled": true,
    "mediaModel": "base.en",
    "searchMode": "hybrid",
    "minScore": 0.25
  }
}
```

| Key | Default | Description |
|---|---|---|
| `directory` | `~/.openzigs/knowledge` | Directory to watch and index |
| `chunkSize` | `1000` | Maximum characters per text chunk |
| `chunkOverlap` | `200` | Character overlap between consecutive chunks |
| `maxResults` | `10` | Default number of search results |
| `watchEnabled` | `true` | Enable real-time file watching |
| `mediaModel` | `"base.en"` | Whisper model for audio/video transcription |
| `searchMode` | `"hybrid"` | Default search mode: `"vector"`, `"fts"`, or `"hybrid"` |
| `minScore` | `0.25` | Minimum similarity score (0–1) to include in results. 0 = no threshold. |

### Architecture Notes

- **Embedding**: Uses Hugging Face Transformers.js with the `all-MiniLM-L6-v2` sentence transformer (~23MB, 384-dimensional vectors). Falls back to deterministic FNV-1a hashing if the model fails to load.
- **Vector Store**: [LanceDB](https://lancedb.com/) embedded database stored at `~/.openzigs/knowledge-db/` with both IVF-PQ vector index and native FTS index.
- **Hybrid Search**: Default mode combines vector (semantic) and full-text (keyword) search using Reciprocal Rank Fusion (k=60). Results in both lists get a score boost.
- **Chunking**: Markdown-aware splitting that preserves heading context. Headings are extracted and stored as metadata for each chunk.
- **Change Detection**: SHA-256 content hashing — files are only re-indexed when their content actually changes. Document metadata is persisted to disk so the hash check survives server restarts.

---

## Social Brain — Unified Social Inbox & CRM

> **📖 Comprehensive Setup Guide:** For step-by-step platform setup, Cloudflare Tunnel configuration, curl testing commands, and troubleshooting, see the dedicated [Social Brain Guide](SOCIAL_BRAIN_GUIDE.md).

The Social Brain at `/social` provides a unified inbox for managing DMs and comments across 6 social platforms — **Instagram**, **Facebook**, **Twitter/X**, **YouTube**, **LinkedIn**, and **Reddit** — with AI-powered auto-replies, a built-in CRM, comment-to-DM automation, and cross-platform content publishing.

Each platform has a dedicated native MCP server with tools for posting, reading, analytics, DMs, and comment management. See the [Social Media Posting](#social-media-posting) section for publishing details, and the [Social Brain Guide](SOCIAL_BRAIN_GUIDE.md) for comprehensive setup and troubleshooting.

### Dashboard Tab

The dashboard shows key metrics at a glance:

| Stat | Description |
|---|---|
| **Total Contacts** | All contacts across connected platforms |
| **Messages (24h)** | Inbound and outbound messages in the last 24 hours |
| **Active Handoffs** | Conversations escalated to a human operator |
| **Automation Triggers** | Total times automation rules have fired |

Below the stats, a **Connected Platforms** section shows the status of each integrated platform.

### CRM Tab

The CRM provides a paginated contact database with:

- **Search** — Filter contacts by username, display name, or platform.
- **Platform filter** — Show contacts from a specific platform only.
- **Contact detail drawer** — Click a contact to view their full profile: tags, notes, message history, and handoff controls.
- **Tag management** — Add or remove tags on any contact for segmentation.
- **Notes** — Update a contact's notes inline.
- **Export** — Download all contacts as a CSV file.

### Automations Tab

Create keyword-based and regex-based automation rules that trigger DM responses when users comment on your posts:

| Field | Description |
|---|---|
| **Name** | Rule display name |
| **Platform** | Target platform (e.g., `instagram`) |
| **Keywords** | Comma-separated trigger words (word-boundary, case-insensitive match) |
| **DM Template** | Message template with `{{username}}`, `{{keyword}}`, `{{post_id}}`, `{{comment_text}}` interpolation |
| **DM Delay** | Seconds to wait before sending the DM (0 = immediate) |
| **Max Triggers/User** | Rate limit per user per rule |
| **Auto-Tag** | Automatically tag contacts who trigger the rule |

The **Automation Log** shows a live feed of every rule trigger with timestamp, contact, and action taken.

### Activity Tab

A real-time feed of all inbound and outbound messages across platforms, with direction badges and platform icons.

### AI-Powered Auto-Reply (Brain Engine)

When a DM arrives, the Social Brain engine:

1. Searches the knowledge base (hybrid RAG) for relevant context.
2. Loads the last 5 messages of conversation history.
3. Sends the context + message to the LLM with a social-media-specific system prompt.
4. Parses the JSON response for `reply`, `confidence`, and `escalate` fields.
5. If confidence > 0.7, auto-sends the reply. Otherwise, escalates to a human operator.

### Human Handoff

When the AI cannot confidently respond (or the user requests human help), the conversation is escalated:

- A handoff thread is created in the configured channel.
- The contact's CRM record is updated with `handoff_status: active`.
- Admin replies in the thread are forwarded back to the user.
- Close the handoff from the CRM contact detail drawer when resolved.

### MCP Tools

5 Social Brain MCP tools are available in chat:

| Tool | Risk | Description |
|---|---|---|
| `social-crm-lookup` | 🟢 low | Search CRM contacts by username, platform, or tags |
| `social-crm-history` | 🟢 low | Get message history for a specific contact |
| `social-crm-tag` | 🟢 low | Add or remove a tag on a CRM contact |
| `social-close-handoff` | 🟡 medium | Close an active human handoff for a contact |
| `social-brain-stats` | 🟢 low | Get Social Brain dashboard statistics |

### REST API

```bash
# Get dashboard stats
curl http://localhost:3000/api/social/stats

# List contacts (paginated)
curl "http://localhost:3000/api/social/contacts?page=1&pageSize=25"

# Export contacts as CSV
curl http://localhost:3000/api/social/contacts/export -o contacts.csv

# Create an automation rule
curl -X POST http://localhost:3000/api/social/rules \
  -H "Content-Type: application/json" \
  -d '{"name":"Welcome DM","platform":"instagram","enabled":true,"keywords":"[\"hello\",\"hi\"]","dm_template":"Hey {{username}}! How can I help?"}'

# List all rules
curl http://localhost:3000/api/social/rules

# Get recent activity
curl http://localhost:3000/api/social/activity

# Close a handoff
curl -X POST http://localhost:3000/api/social/handoff/<contactId>/close \
  -H "Content-Type: application/json" \
  -d '{"resolution":"Issue resolved"}'
```

### Webhook Integration

Platform webhooks are received at `POST /api/social/webhooks/:platform`. For Instagram, the endpoint handles Meta's webhook verification (`GET` with `hub.verify_token`) and incoming message/comment events (`POST`).

### Socket.IO Events

| Event | Direction | Description |
|---|---|---|
| `social:reply` | Server → Client | AI auto-reply sent to a contact |
| `social:escalate` | Server → Client | Conversation escalated to human |
| `social:handoff:created` | Server → Client | New handoff thread created |
| `social:handoff:resolved` | Server → Client | Handoff closed |
| `social:rule:triggered` | Server → Client | Automation rule fired |

### Platform Webhook Setup

Each social platform requires webhook registration so OpenZigs can receive comments and DMs in real time. You need a **publicly reachable URL** — either via a Cloudflare Tunnel (production) or ngrok (development).

**Your webhook endpoint:** `https://<your-domain>/api/social/webhooks/:platform`

#### Environment Variables

Add these to your `.env` file:

```dotenv
# ── Social Brain ──
SOCIAL_WEBHOOK_VERIFY_TOKEN=your-random-secret-string  # Used to verify webhook subscriptions
INSTAGRAM_ACCESS_TOKEN=your-instagram-user-access-token # Required for post context lookup (captions, media type)
```

> **Tip:** Generate a random verify token with `openssl rand -hex 32`.

#### Instagram / Facebook (Meta Graph API)

1. Go to the [Meta Developer Console](https://developers.facebook.com/apps/).
2. Open your app (or create one: **Business** type → add **Instagram** product).
3. Navigate to **Instagram → Webhooks** in the left sidebar.
4. Click **Subscribe to events** and enable:
   - `messages` — receives DMs
   - `comments` — receives comment events (required for comment-to-DM automation)
5. Set the **Callback URL** to:
   ```
   https://<your-domain>/api/social/webhooks/instagram
   ```
6. Set the **Verify Token** to the same value as `SOCIAL_WEBHOOK_VERIFY_TOKEN` in your `.env`.
7. Click **Verify and Save** — Meta will send a `GET` request with `hub.verify_token` and `hub.challenge`; OpenZigs responds automatically.
8. Under **Instagram → Basic Display** or **Instagram → API Setup**, generate a **User Access Token** with these permissions:
   - `instagram_basic`
   - `instagram_manage_comments`
   - `instagram_manage_messages`
   - `pages_show_list`, `pages_read_engagement` (for the business account)
9. Copy the token and set it as `INSTAGRAM_ACCESS_TOKEN` in your `.env`.

> **Post context enrichment:** When a comment arrives, OpenZigs uses the `INSTAGRAM_ACCESS_TOKEN` to fetch the post's caption, permalink, and media type via `GET /{media_id}?fields=caption,permalink,media_type,media_url,username,timestamp`. This is cached in SQLite for 24 hours to avoid redundant API calls. Without this token, comment-to-DM automation still works, but the Brain and DM templates won't have post context (e.g., `{{post_caption}}` will be empty).

#### Twitter / X

1. Go to the [X Developer Portal](https://developer.x.com/en/portal/dashboard).
2. Create or open a project with **OAuth 2.0** enabled.
3. Navigate to **Products → Premium → Account Activity API** (or the free webhook tier if eligible).
4. Register a webhook URL:
   ```
   https://<your-domain>/api/social/webhooks/twitter
   ```
5. Subscribe to your user's activity events (DMs, mentions).
6. Authentication credentials should be set in environment variables for the Twitter MCP sidecar.

#### TikTok

1. Register at the [TikTok Developer Portal](https://developers.tiktok.com/).
2. Create an app and request the **Comment** and **Direct Message** scopes.
3. Under **Webhooks**, add:
   ```
   https://<your-domain>/api/social/webhooks/tiktok
   ```
4. TikTok sends a verification challenge similar to Meta.

#### Generic / Other Platforms

For platforms without native webhook support (Reddit, YouTube), use the **polling adapter**:

```typescript
import { GenericPollAdapter } from "./channels/social/social-ingestion.js";

const redditAdapter = new GenericPollAdapter("reddit", async (since) => {
  // Fetch new comments/messages from Reddit API since the given timestamp
  return [];
});
socialIngestion.registerAdapter(redditAdapter);
socialIngestion.startPolling("reddit", 60); // poll every 60 seconds
```

#### Local Development (ngrok)

For local testing without a tunnel:

```bash
# Start ngrok tunnel to your dev server
ngrok http 3000

# Copy the HTTPS URL (e.g., https://abc123.ngrok.io)
# Use it as the webhook callback URL in the platform developer console
```

### DM Template Variables

The following variables are available in comment-to-DM automation templates:

| Variable | Description |
|---|---|
| `{{username}}` | The commenter's username |
| `{{keyword}}` | The keyword that triggered the rule |
| `{{post_id}}` | The platform media/post ID |
| `{{comment_text}}` | The full comment text |
| `{{post_caption}}` | The post's caption text (requires platform access token) |
| `{{post_url}}` | The post's permalink URL (requires platform access token) |

**Example template:**

```
Hey {{username}}! Saw your comment on our post about "{{post_caption}}". Check your DMs for more details!
```

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| "GITHUB_CLIENT_ID is required" | Missing env var. | Add `GITHUB_CLIENT_ID` to `.env`. |
| Model selector is empty | SDK not authenticated. | Run `pnpm setup` to complete device auth. |
| "Connection refused" from browser-read | Chrome not running with `--remote-debugging-port`. | Launch Chrome with the flag. See [Chrome DevTools Setup](#chrome-devtools-setup). |
| "Shell command not allowed" | Command not in allowlist. | Add the command to the shell tool's allowlist in the tool catalog. |
| Telegram bot not responding | Token missing or tunnel not running. | Check `TELEGRAM_BOT_TOKEN` and ensure the `tunnel` Docker service is running (`docker compose up -d tunnel`). |
| "Unauthorized" on API calls | Missing or invalid auth token. | Include `Authorization: Bearer <token>` header. The token is in `~/.openzigs/config.json`. |
| Social media tool returns "ECONNREFUSED" | MCP sidecar container not running. | Start the relevant sidecar: `docker compose up -d linkedin-mcp-server`. |
| Scheduled job not firing | Scheduler not started or job disabled. | Check job status with `list-jobs` tool or `GET /api/jobs`. Ensure `enabled: true`. |
| "fetch failed" on Word/Calendar tools | Word or Calendar MCP sidecar not reachable. | Verify the sidecar is running: `docker compose ps word-mcp-server`. |
| Gmail auth errors | Missing or expired OAuth credentials. | Re-run `npx @gongrzhe/server-gmail-autoauth-mcp auth`. Ensure `gcp-oauth.keys.json` is in `~/.gmail-mcp/`. |
| `db-query` returns "connection refused" | Database MCP server not running or JDBC_URL incorrect. | Check `JDBC_URL` env var and ensure the database is reachable from Docker. |
| GitHub tools return 401 | Invalid or expired PAT. | Regenerate your GitHub Personal Access Token and update `GITHUB_PERSONAL_ACCESS_TOKEN`. |
| Agent not using expected tools | `maxToolsPerRequest` too low; tool got excluded. | Increase the tool limit in Admin → Task Engine → Tool Limit slider or via `PUT /api/admin/session/config`. Check if the tool should be added to ALWAYS_ON_TOOLS. |
| Model hallucinating tool calls | Too many tools sent, or model calling a tool that was excluded. | Reduce `maxToolsPerRequest` or switch to a stronger model (e.g., `gpt-4.1`). |
| MarkItDown returns empty content | File not accessible inside container. | Ensure the file path is within the mounted volume (`/workdir` inside the container). |
| Voice TTS not working | Missing Google Cloud credentials. | Set `GOOGLE_APPLICATION_CREDENTIALS` env var to your service account JSON key file path. See [Enabling Voice Features](#enabling-voice-features). |
| Wake word not responding | Web Speech API not supported in browser. | Use Chrome, Edge, or Brave. Firefox does not support the Web Speech API. |

## Secret Vault — Zero-Trust Credential Storage

The Secret Vault provides AES-256-GCM encrypted local storage for passwords, API keys, and other credentials. Secrets are stored at `~/.openzigs/vault.enc` with `0600` permissions (owner-read/write only).

### Security Architecture

The vault implements a **reference-token pattern** that ensures plaintext secrets never appear in:

- Chat history or session JSONL files
- Audit logs
- Socket.IO events
- Tool call arguments visible to the LLM

Instead, the AI sees only opaque reference tokens like `{{SECRET:a1b2c3d4-...}}`. The actual plaintext is resolved at the **last possible moment** inside the `browser-navigate` handler, right before simulating keyboard input.

### Getting Started

1. **Open Admin → Secret Vault** panel in the UI
2. **Create** a new vault by entering a master password (min 8 characters)
3. **Add secrets** — each secret has a label, value, and optional service/username metadata
4. The vault **auto-locks** on server shutdown; unlock it each session

### Using Secrets in Chat

Ask the agent to fill in a login form:

```
Log into github.com with my GitHub credentials
```

The agent will:
1. Call `list-secrets` to discover available credentials
2. Call `get-secret` with the matching label → receives `{{SECRET:uuid}}`
3. Call `browser-navigate` with `action: "type"` and `text: "{{SECRET:uuid}}"`
4. The browser handler resolves the token to plaintext and types it character-by-character

### MCP Tools

| Tool | Risk Level | Description |
|---|---|---|
| `get-secret` | medium | Look up a secret by label, returns `{{SECRET:uuid}}` reference token |
| `list-secrets` | low | List all stored secret labels (no values exposed) |

### Configuration

Add to `~/.openzigs/config.json`:

```json
{
  "vault": {
    "enabled": true,
    "vaultPath": "~/.openzigs/vault.enc"
  }
}
```

### API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/admin/vault/status` | Check if vault exists and is unlocked |
| POST | `/api/admin/vault/initialize` | Create a new vault (body: `{ masterPassword }`) |
| POST | `/api/admin/vault/unlock` | Unlock with master password |
| POST | `/api/admin/vault/lock` | Lock the vault |
| POST | `/api/admin/vault/change-password` | Change master password |
| GET | `/api/admin/vault/secrets` | List all secrets (metadata only) |
| POST | `/api/admin/vault/secrets` | Add a secret (body: `{ label, value, service?, username? }`) |
| PATCH | `/api/admin/vault/secrets/:id` | Update a secret |
| DELETE | `/api/admin/vault/secrets/:id` | Delete a secret |

### Browser Stealth Mode

The browser automation includes anti-bot detection evasion that runs automatically on every page navigation. This patches common fingerprint leaks:

- `navigator.webdriver` set to `false`
- `chrome.runtime` shim injected
- Realistic `navigator.plugins` and `navigator.languages`
- WebGL vendor/renderer spoofing
- Permissions API notifications bypass

The Chrome profile is now persistent at `~/.openzigs/chrome-profile/` (previously used a temp directory), preserving cookies and session state across server restarts.

---

## Security Hardening

OpenZigs includes multiple layers of security controls to protect against the OWASP Top 10 threats.

### API Authentication

All API routes (except `/health` and public webhook triggers) require Bearer token authentication:

```bash
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/admin/tools
```

Set the token in `~/.openzigs/config.json` under `auth.token`, or via the `OPENZIGS_TOKEN` environment variable. The UI passes its token via `NEXT_PUBLIC_OPENZIGS_TOKEN`.

Socket.IO connections also require authentication — the token is passed in the handshake `auth` object.

### CORS & Origin Restriction

CORS is restricted to explicit allowed origins:
- The UI origin (`OPENZIGS_UI_ORIGIN` or `http://localhost:3001`)
- `http://localhost:3000` and `http://localhost:3001`
- Additional origins via `OPENZIGS_CORS_ORIGINS` (comma-separated)

### Rate Limiting

A global rate limit of 100 requests per 15-minute window per IP is applied to all routes. Per-webhook rate limits are also enforced (default 60/min).

### Content Security Policy

Helmet CSP directives include:
- `frame-ancestors: 'none'` — Prevents clickjacking via iframe embedding
- `script-src: 'self'` — Only same-origin scripts
- `object-src: 'none'` — Blocks Flash/plugin embeds
- `base-uri: 'self'` — Prevents base tag hijacking

### Input Validation & Size Limits

- **JSON body limit**: 1 MB (prevents memory exhaustion via large payloads)
- **Chat messages**: 10,000 characters max
- **Brand voice samples**: 10,000 characters per sample
- **Prompt templates**: 100,000 characters max
- **Task inputs**: 50,000 characters max
- **File uploads**: 25 MB per file, 10 files max, restricted to safe MIME types

### Trust Proxy Configuration

By default, `trust proxy` is disabled. If running behind a reverse proxy (nginx, Cloudflare), enable it in config:

```json
{
  "server": {
    "trustProxy": true
  }
}
```

When disabled, `X-Forwarded-For` headers are ignored, preventing IP spoofing.

### Post-Action Sandboxing

Custom post-action scripts run with a restricted environment — only `PATH`, `HOME`, `LANG`, and `TERM` are inherited (plus `OPENZIGS_CONFIG_*` variables). Server environment variables like API keys are not leaked.

### SSRF Protection

Webhook URLs are validated before fetch:
- Private IP ranges (10.x, 172.16-31.x, 192.168.x, 127.x) are blocked
- Cloud metadata endpoints (169.254.169.254) are blocked
- Only `http:` and `https:` protocols are allowed

### Error Redaction

Internal filesystem paths are stripped from error responses. 500 errors return a generic "Internal server error" message to prevent information disclosure.

---

## Media Queue & Asset Gallery

The Media Queue is a push-based distributed job system for generating images, videos, and music across networked GPU nodes. Jobs are dispatched to workers asynchronously — the worker accepts the job immediately (HTTP 202) and POSTs a completion callback back to the primary Mac when done. The Asset Gallery provides a visual interface for browsing, filtering, and managing all generated and uploaded media.

### Gallery Page

Navigate to **Gallery** in the top navigation bar. The page shows:

- **Queue Stats Bar** — Live counts of Pending, Dispatched, Processing, Complete, and Failed jobs, updated every 5 seconds
- **Worker Nodes** — 3-column status grid showing all worker nodes:
  - **Image Gen (FluxQ)** — Mac Mini network node (port 5005), with Activate/Unload for VRAM control
  - **Video Gen (LTX-2)** — M2 Pro network node (port 5007), with Activate/Unload for VRAM control
  - **Music Gen (ACE-Step)** — Independent localhost sidecar (port 5009), no VRAM buttons needed
  - Each card shows a reachability dot (green = online, red = offline), loaded model name, and "Generating..." spinner when busy
- **Asset Grid** — All generated and uploaded assets displayed as cards with thumbnails
- **Filters** — Filter by type (Images, Videos, Audio) and source (Generated, Uploaded, Director)
- **Preview** — Click any asset to open a full-screen lightbox for viewing images or playing videos
- **Actions** — Download, tag, or delete assets from the card overlay

### Gallery Studio

Click **Create Asset** on the Gallery page to open the inline creation studio. Five generation modes are available:

| Mode | Description | Key Controls |
|---|---|---|
| **Text → Image** | Generate an image from a text prompt | Width, Height, Steps, Guidance, Seed, Character (LoRA), ControlNet Strength |
| **Image → Image** | Transform an uploaded image with a prompt | Source image upload, Strength (0–1), Steps, Guidance |
| **Text → Video** | Generate a 4-second video clip from a text prompt | Frames (max 97), FPS, computed Duration display |
| **Image → Video** | Animate an uploaded image with a motion prompt | Source image upload, Frames, FPS, Duration |
| **Text → Music** | Generate music from a text description | Duration (10–300s), Inference Steps (8–27, default 20), Instrumental toggle, Lyrics textarea, Seed |

All jobs are submitted to the queue via **Submit to Queue** and processed by the appropriate worker node.

### Character Lab (LoRA Training & Identity Consistency)

The Character Lab lets you create persistent character identities backed by LoRA (Low-Rank Adaptation) fine-tuning. Once trained, characters can be injected into any image generation to maintain consistent identity across shots.

**Navigate to Studio → Characters** (or `/characters`).

#### Creating a Character

1. Click **+ New Character**
2. Fill in:
   - **Character Name** — A human-readable label (e.g., "Alice")
   - **Trigger Word** — A unique token used in prompts to activate the character identity (e.g., `ALICE_TOK`). Use ALL_CAPS with `_TOK` suffix by convention.
   - **LoRA Scale** — Controls how strongly the character identity is applied (0.1–1.5, default 0.8). Higher values = stronger likeness but may reduce prompt flexibility.
3. Click **Create**

#### Uploading Reference Photos

Select a character from the list, then use the **Upload Photos** button in the detail panel. Requirements:

- **Minimum 5 photos** required before training can begin
- **Maximum 20 photos** per upload batch
- **Maximum 20 MB** per photo
- Accepted formats: JPEG, PNG, WebP
- Use varied angles, lighting, and expressions for best results

#### Training a LoRA

Once you have at least 5 reference photos uploaded:

1. Configure training parameters in the detail panel:
   - **Training Steps** — Number of fine-tuning iterations (default: 1000). More steps = stronger identity but risk of overfitting.
   - **Learning Rate** — Optimizer step size (default: 0.0001). Lower values train more carefully.
   - **LoRA Rank** — Dimension of the LoRA adapter (default: 4). Higher rank captures more detail but uses more VRAM.
2. Click **Start Training**
3. The character status changes through: `pending` → `training` → `ready` (or `failed`)

Training runs as a background subprocess using `mflux-train` (DreamBooth method). Progress is monitored automatically — the character status updates when training completes.

#### Using Characters in Gallery Studio

Once a character reaches **ready** status, it appears in the Gallery Studio's **Character** dropdown:

1. Open **Gallery → Create Asset**
2. Select your character from the **Character** dropdown
3. Include the character's trigger word in your prompt (e.g., "A photo of ALICE_TOK standing in a garden")
4. Optionally adjust **ControlNet Strength** (0–1) for pose control
5. Submit to queue — the LoRA weights are automatically injected during generation

#### Character API

```bash
# List all characters
curl http://localhost:3000/api/characters

# Create a character
curl -X POST http://localhost:3000/api/characters \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice", "triggerWord": "ALICE_TOK", "loraScale": 0.8}'

# Upload reference photos
curl -X POST http://localhost:3000/api/characters/<id>/photos \
  -F "photos=@photo1.jpg" -F "photos=@photo2.jpg"

# Start training
curl -X POST http://localhost:3000/api/characters/<id>/train \
  -H "Content-Type: application/json" \
  -d '{"steps": 1000, "learningRate": 0.0001, "loraRank": 4}'

# Delete a character
curl -X DELETE http://localhost:3000/api/characters/<id>
```

### Queue API Examples

**Submit a text-to-image job:**
```bash
curl -X POST http://localhost:3000/api/queue/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "type": "txt2img",
    "payload": {
      "prompt": "a sunset over mountains",
      "width": 1024, "height": 1024,
      "num_steps": 4, "guidance": 3.5
    }
  }'
```

**Submit a text-to-video job:**
```bash
curl -X POST http://localhost:3000/api/queue/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "type": "txt2video",
    "payload": {
      "prompt": "slow dolly shot of a forest at dawn",
      "num_frames": 97, "fps": 24,
      "width": 768, "height": 512
    }
  }'
```

**Submit a text-to-music job:**
```bash
curl -X POST http://localhost:3000/api/queue/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "type": "txt2music",
    "payload": {
      "prompt": "Dreamy lo-fi hip hop beat with vinyl crackle and soft piano chords, 90 BPM",
      "duration_seconds": 30,
      "steps": 20,
      "instrumental": true
    }
  }'
```

**Submit a voice2voice job:**
```bash
curl -X POST http://localhost:3000/api/queue/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "type": "voice2voice",
    "payload": {
      "prompt": "Voice conversion: artist_name",
      "source_asset_id": "<gallery-asset-id>",
      "voice_model": "artist_name",
      "pitch_shift": 0,
      "index_rate": 0.75,
      "vocal_volume": 1.0,
      "instrumental_volume": 1.0,
      "output_format": "wav"
    }
  }'
```

**Check queue stats:**
```bash
curl http://localhost:3000/api/queue/jobs/stats
# → {"pending":2,"dispatched":0,"processing":0,"complete":0,"failed":0}
```

**List gallery assets:**
```bash
curl http://localhost:3000/api/queue/assets
# → {"assets":[...],"total":5}
```

**Delete a pending job:**
```bash
curl -X DELETE http://localhost:3000/api/queue/jobs/<job-id>
```

### Configuration & Networking

**Required for multi-Mac setups:** The primary Mac's LAN IP must be reachable by the worker nodes for completion callbacks. Set `QUEUE_CALLBACK_URL` in your `.env` to point at the primary Mac:

```dotenv
# LAN IP of the primary openzigs machine — required so remote workers
# can POST their completion callback back across the LAN.
# Without this, the server auto-detects the LAN IP at startup, but
# setting it explicitly is more reliable in multi-NIC environments.
QUEUE_CALLBACK_URL=http://192.168.1.50:3000/api/queue/complete
```

If unset, the server auto-detects the first non-loopback IPv4 via `os.networkInterfaces()` and logs the resolved URL at startup. **Note:** For local sidecars (music sidecar on `localhost`), `QueueMaster` automatically rewrites the callback URL to use `localhost` so the sidecar can reach back without relying on the LAN IP.

### Music Studio

Navigate to **http://localhost:3001/music-studio** to access the AI Music Studio.

The Music Studio provides a full **Voice2Voice pipeline** that converts the vocal timbre of any audio track using RVC (Retrieval-based Voice Conversion) v2 models. The pipeline runs in three stages:

1. **Stem Separation** — Demucs v4 (`htdemucs_ft`) separates vocals from instrumentals
2. **Voice Conversion** — RVC v2 converts the isolated vocals using a trained voice model
3. **Final Mixdown** — pydub recombines the converted vocals with the instrumental stem

#### Using Music Studio

1. **Load audio tracks** — Click any audio asset in the "Audio Assets" panel to load it into the waveform viewer. You can load multiple tracks for comparison.
2. **Select source** — Choose the source audio track from the "Source Track" dropdown in the control panel.
3. **Choose voice model** — Select an RVC voice model (or type a model name). Models are stored in `~/.openzigs/rvc-models/<model_name>/`.
4. **Adjust pitch** — Use the pitch shift slider (-12 to +12 semitones) to transpose the vocals.
5. **Advanced settings** — Expand to fine-tune index rate, filter radius, vocal/instrumental volumes, and output format.
6. **Submit** — Click "Start Voice2Voice" to queue the job. Pipeline progress is shown in real-time with stage indicators.

#### Waveform DAW View

The waveform viewer uses **wavesurfer.js v7** to render interactive audio waveforms:
- **Transport controls** — Play/Pause/Restart with synchronized multi-track playback
- **Per-track mute** — Solo or mute individual tracks
- **Interactive seeking** — Click anywhere on a waveform to seek to that position
- **Multi-track support** — Load source, result, and comparison tracks simultaneously

#### Music Studio Sidecar Setup

The Music Studio requires a Python sidecar running on port 5010:

```bash
cd sidecars/music-studio
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

**RVC voice models** must be placed at `~/.openzigs/rvc-models/<model_name>/`:
```
~/.openzigs/rvc-models/
  artist_name/
    artist_name.pth      # Model weights
    artist_name.index     # Feature index (optional)
```

**Polling fallback for asymmetric networks:** If callback delivery fails (e.g., router AP/client isolation where the worker Mac cannot reach the primary Mac), the system automatically falls back to polling. Every tick, `QueueMaster` polls `GET /job-result/{job_id}` on any worker with a job dispatched more than 3 minutes ago. FluxQ stores results in memory for up to 100 jobs; results are deleted after the primary Mac acknowledges them. This means jobs will always complete even if push callbacks are blocked at the network layer.

Configure worker endpoints in `config/default.json` under the `queue` section:

```json
{
  "queue": {
    "nodes": {
      "mac-mini": { "host": "http://192.168.1.61:5005", "token": "<fluxq-token>" },
      "m2-pro":   { "host": "http://localhost:5007",    "token": "<ltx-token>" }
    },
    "tickIntervalMs": 3000
  }
}
```

### Worker Sidecar Setup (M2 Pro)

The video generation worker runs as a Python FastAPI sidecar on Apple Silicon. It uses the [CharafChnioune/mlx-video](https://github.com/CharafChnioune/mlx-video) fork of mlx-video which supports both DISTILLED (fast) and DEV (photorealistic) pipelines.

**Quick setup:**

```bash
# Install from repo
cd sidecars/worker
pip install -r requirements.txt
python server.py  # Starts on port 5007

# Or use media-ctl.sh (recommended)
./scripts/media-ctl.sh ltx start     # starts via launchctl + applies sysctl GPU tuning
./scripts/media-ctl.sh ltx status    # check health
./scripts/media-ctl.sh ltx generate  # quick test (9-frame DEV pipeline)
```

**Dedicated install (recommended for separate hardware):**

```bash
# On the video generation Mac
mkdir ~/ltx-worker && cd ~/ltx-worker
python3 -m venv .venv && source .venv/bin/activate
pip install fastapi uvicorn httpx
pip install git+https://github.com/CharafChnioune/mlx-video.git

# Copy server.py from repo
cp /path/to/openzigs/sidecars/worker/server.py .

# Create .env with M2-specific tuning (see below)
cat > .env << 'EOF'
MLX_MAX_OPS_PER_BUFFER=1
MLX_CACHE_LIMIT_MB=4096
MLX_WIRED_LIMIT_MB=20480
LTX_TE_PARAM_EVAL_CHUNK=4
LTX_PARAM_EVAL_CHUNK=6
LTX_EVAL_INTERVAL=8
LTX_TE_MAX_LENGTH=128
LTX_CONNECTOR_HEADS_CHUNK=6
PYTHONUNBUFFERED=1
LTX_SECRET_TOKEN=your-secret-token-here
LTX_MODEL_REPO=AITRADER/ltx2-distilled-4bit-mlx
EOF
```

**Pipeline selection:**

| Pipeline | Quality | Speed (33 frames) | Max Resolution (M2 Pro 32GB) |
|---|---|---|---|
| `distilled` | Good (stylized) | ~2 minutes | 768×512 |
| `dev` | Photorealistic | ~10 minutes | 512×320 |

The DEV pipeline uses classifier-free guidance (CFG) which produces significantly higher quality output but doubles VRAM usage. On M2 Pro 32GB, the DEV pipeline is limited to 512×320 resolution — 768×512 will crash due to GPU memory limits.

> **M2 GPU Workaround:** M2-family chips have a known Metal GPU timeout bug. The `MLX_MAX_OPS_PER_BUFFER=1` env var and the chunked `mx.eval()` patches in mlx-video work around this. M3+ chips don't need these workarounds.

**Managing services with media-ctl.sh:**

```bash
# Start/stop services
./scripts/media-ctl.sh ltx start        # start LTX worker (with sysctl GPU tuning)
./scripts/media-ctl.sh flux start       # start FluxQ image sidecar

# Switch between image and video gen (shared VRAM)
./scripts/media-ctl.sh switch ltx       # unload FluxQ, prepare for video
./scripts/media-ctl.sh switch flux      # unload LTX, load FluxQ model

# Test video generation
./scripts/media-ctl.sh ltx generate dev "A cat in a garden, photorealistic"

# Sync server.py from repo to install dir
./scripts/media-ctl.sh ltx sync
./scripts/media-ctl.sh ltx restart
```

See [Configuration & Networking](#configuration--networking) above for how to configure worker endpoints and the callback URL.

### Music Generation Sidecar Setup (ACE-Step 1.5)

The music generation sidecar runs as a Python HTTP server wrapping [ACE-Step 1.5](https://github.com/ACE-Step/ACE-Step-1.5) for local AI music generation. It supports Apple Silicon (MPS/Metal) and CUDA.

**Quick setup:**

```bash
# 1. Install Python 3.11 (required — ACE-Step enforces ==3.11.*)
brew install python@3.11

# 2. Clone the ACE-Step Apple Silicon fork (provides the uv-managed runtime)
git clone --depth 1 https://github.com/clockworksquirrel/ace-step-apple-silicon.git ~/ace-step-apple-silicon
cd ~/ace-step-apple-silicon && uv sync

# 3. Set up the sidecar HTTP wrapper
cd /path/to/openzigs/sidecars/music
/opt/homebrew/bin/python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 4. Start the sidecar (default port 5009)
python server.py
```

> **Note:** Both the local repo clone (step 2) and the pip venv (step 3) are required. The sidecar imports `AceStepHandler` and `generate_music()` directly from the cloned repo (added to `sys.path`), so `ACESTEP_DIR` must point to the clone (default: `~/ace-step-apple-silicon`). Model weights (~4–8 GB) are downloaded automatically from HuggingFace on first generation request.

> **Troubleshooting:** If you see `name 'logger' is not defined` on startup, the installed `diffusers==0.36.0` has a bug in `torchao_quantizer.py` where `logger` is used before it is defined. The sidecar venv's copy of that file needs the `logger = logging.get_logger(__name__)` line moved above the `_update_torch_safe_globals()` call at module level. This is a one-time fix to the venv file.

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `PORT` | `5009` | HTTP server port |
| `MUSIC_GEN_AUTH_TOKEN` | _(none)_ | Bearer token for API authentication |
| `ACESTEP_REPO` | `ACE-Step/ACE-Step-1.5` | Model repository |

**Admin configuration:**

Navigate to **Admin → Music Generation Node** to configure:

- **Local Process** — Sidecar runs on the same machine (localhost:5009)
- **Network Node** — Point to a remote machine running the sidecar (URL + auth token)
- **Test Connection** — Verify the sidecar is reachable and returns model/device info

**Music prompt tips:**

- Include genre, BPM, instruments, and mood: `"Upbeat electronic dance track, 128 BPM, energetic synth leads, punchy drums"`
- Use the **AI Enhance** button in Gallery Studio to refine prompts for ACE-Step's tag-based format. The enhancer returns:
  - **Enhanced Prompt** — Comma-separated descriptive tags optimized for ACE-Step's caption encoder
  - **Suggested Lyrics** — Properly structured lyrics using ACE-Step's bracketed section format (`[Verse 1]`, `[Chorus]`, etc.)
  - **Suggested Parameters** — Auto-tuned `music_steps` (8–27) and `duration_seconds` based on prompt complexity
- Adjust **Inference Steps** (8–27, default 20) to balance speed vs quality: lower values generate faster, higher values produce more detailed audio
- For vocal tracks, add structured lyrics with `[Verse]`, `[Chorus]`, `[Bridge]` tags
- Check the **Instrumental** toggle for pure instrumental output

**Model variants:**

| Model | Steps | Speed (30s, M2 Pro) | Quality |
|---|---|---|---|
| `acestep-v15-turbo` | 8 | ~45 seconds | Good (fast iteration) |
| `acestep-v15-sft` | 32 | ~3 minutes | High (final output) |
