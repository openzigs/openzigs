# OpenZigs Security Guide

Comprehensive reference for securing an OpenZigs deployment. Covers every security layer from edge authentication to local sandboxing.

> **Vulnerability disclosure:** To report a security vulnerability, see [SECURITY.md](../SECURITY.md) in the project root.

---

## Table of Contents

- [Security Architecture Overview](#security-architecture-overview)
- [Layer 1: Edge Authentication (Cloudflare Access)](#layer-1-edge-authentication-cloudflare-access)
- [Layer 2: Server-Side JWT Validation (Defense-in-Depth)](#layer-2-server-side-jwt-validation-defense-in-depth)
- [Layer 3: API Authentication (Bearer Token)](#layer-3-api-authentication-bearer-token)
- [Layer 4: Tool Risk Classification & Approval Queue](#layer-4-tool-risk-classification--approval-queue)
- [Layer 5: Secret Vault (AES-256-GCM)](#layer-5-secret-vault-aes-256-gcm)
- [Network Security](#network-security)
- [Route Protection Matrix](#route-protection-matrix)
- [Input Validation & Size Limits](#input-validation--size-limits)
- [Sandbox & Isolation](#sandbox--isolation)
- [Audit Trail & Logging](#audit-trail--logging)
- [Configuration Reference](#configuration-reference)
- [Credential Rotation Procedure](#credential-rotation-procedure)
- [Threat Model & Known Risks](#threat-model--known-risks)
- [Security Checklist](#security-checklist)

---

## Security Architecture Overview

OpenZigs uses a defense-in-depth model with five concentric security layers:

```
┌─────────────────────────────────────────┐
│  Layer 1: Cloudflare Access (Edge)      │  ← email OTP before traffic reaches server
│  ┌───────────────────────────────────┐  │
│  │  Layer 2: CF JWT Validation       │  │  ← server verifies JWT signature/expiry
│  │  ┌─────────────────────────────┐  │  │
│  │  │  Layer 3: Bearer Token Auth │  │  │  ← every API call authenticated
│  │  │  ┌───────────────────────┐  │  │  │
│  │  │  │  Layer 4: Approval Q  │  │  │  │  ← high-risk tools require human OK
│  │  │  │  ┌─────────────────┐  │  │  │  │
│  │  │  │  │ Layer 5: Vault  │  │  │  │  │  ← secrets encrypted at rest
│  │  │  │  └─────────────────┘  │  │  │  │
│  │  │  └───────────────────────┘  │  │  │
│  │  └─────────────────────────────┘  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

**Local-only access** (no tunnel): Layers 1–2 are not applicable. Layers 3–5 protect everything. The server binds to `localhost` by default.

**Tunnel access** (public hostname): All five layers are active. An attacker must:
1. Bypass Cloudflare Access (email OTP)
2. Present a valid CF JWT (verified server-side)
3. Know the Bearer token (not in client bundles — but currently `NEXT_PUBLIC_*` exposes it; see [Known Risks](#threat-model--known-risks))
4. Get human approval for high-risk tools
5. Crack AES-256-GCM to access vault secrets

---

## Layer 1: Edge Authentication (Cloudflare Access)

**When running behind a Cloudflare Tunnel, Cloudflare Access is mandatory.** Without it, every API endpoint and the admin UI are reachable by anyone who discovers your hostname.

### How It Works

Cloudflare Access intercepts requests at the edge (before they reach your server). Unauthenticated users see a Cloudflare login page with email OTP. Authenticated sessions are valid for 24 hours.

Access uses **path-based application separation**: more-specific paths take precedence. Two categories of applications are created:

**Bypass apps** — specific paths where Cloudflare auth is skipped, because they have their own app-level authentication:

| Path | App-Level Auth |
|---|---|
| `/api/queue/complete` | `Authorization: Bearer <workerSecret>` |
| `/telegram/webhook` | `X-Telegram-Bot-Api-Secret-Token` header |
| `/api/social/webhooks/*` | HMAC-SHA256 per platform |
| `/api/*/oauth/callback` | OAuth CSRF `state` parameter |
| `/health` | None (read-only, no sensitive data) |
| `/presenter/*`, `/socket.io/*`, `/peerjs/*` | `guest_token` cookie / JWT invite |
| `/api/invite/redeem` | JWT with `presenterInviteSecret` |
| `/api/presentations/*` | Guest API endpoints |

**Protected catch-all apps** — everything else requires email OTP:

| Domain | What's Protected |
|---|---|
| `agent.example.com` | Admin panel, chat, gallery, scheduler, tasks, knowledge, API |
| `presenter.example.com` | Admin and room management routes |

### Setup

```bash
# Automated — prompts for credentials, creates all Access apps, updates config
bash scripts/setup-cloudflare-access.sh
```

The script creates all bypass and protected applications via the Cloudflare API. No credentials are hardcoded. See [USER_GUIDE.md — Securing the Tunnel](USER_GUIDE.md#securing-the-tunnel-with-cloudflare-access) for step-by-step instructions.

### Tunnel Operation (Manual Start)

> **Do NOT use a LaunchDaemon.** Running `cloudflared` as a system daemon means it runs as `root` 24/7, expanding the attack surface unnecessarily. A solo-developer deployment should start the tunnel on-demand and stop it when done.

Start the tunnel manually (runs as your user, not root):

```bash
cloudflared tunnel run --token "$(cat ~/.openzigs/tunnel-token)" 2>&1 | tee /tmp/cloudflared.log
```

Or inline with the token from the Cloudflare dashboard:

```bash
cloudflared tunnel run --token <YOUR_TUNNEL_TOKEN>
```

Stop with **Ctrl+C**. The tunnel is only active while this process runs.

```bash
# Check if tunnel is running
pgrep -la cloudflared

# If a LaunchDaemon plist still exists, ensure it's disabled:
ls /Library/LaunchDaemons/com.cloudflare.cloudflared.plist 2>/dev/null && \
  echo "WARNING: LaunchDaemon still active — disable it:" && \
  echo "  sudo launchctl bootout system/com.cloudflare.cloudflared" && \
  echo "  sudo mv /Library/LaunchDaemons/com.cloudflare.cloudflared.plist{,.disabled}"
```

**Why not a daemon?**
- Runs as `root` — unnecessary privilege escalation
- Always-on = 24/7 attack surface even when you're not working
- Tunnel token stored in plaintext in the plist (readable by any local process)
- Harder to notice misconfigurations when the tunnel silently restarts on boot

---

## Layer 2: Server-Side JWT Validation (Defense-in-Depth)

Even with Cloudflare Access configured at the edge, the Express server independently validates the `CF-Access-JWT-Assertion` header on every request that arrives through the tunnel.

### What It Does

1. Checks for the `CF-Access-JWT-Assertion` header
2. Fetches the JWKS public keys from `https://<team-domain>.cloudflareaccess.com/cdn-cgi/access/certs` (cached for 1 hour)
3. Verifies the JWT: RS256 signature, expiry, and audience claim
4. Rejects with `403 Cloudflare Access validation failed` on any failure
5. Attaches the user's email from the JWT to the request

### Why It Matters

If Access policies are accidentally deleted or misconfigured at the Cloudflare dashboard, the server still rejects unauthenticated requests. Without this layer, a misconfigured Access policy = fully open server.

### When It's Skipped

- **No CF headers**: Direct/localhost requests pass through (no JWT to validate)
- **`cfAccessTeamDomain` not configured**: Warning logged once, requests allowed through
- This allows local development to work without Cloudflare

### Configuration

```json
{
  "tunnel": {
    "cfAccessTeamDomain": "your-team.cloudflareaccess.com",
    "cfAccessAudience": ["aud-tag-for-agent-app", "aud-tag-for-presenter-app"]
  }
}
```

The `setup-cloudflare-access.sh` script sets these automatically when creating Access apps.

### Implementation

- **File**: `src/auth/cloudflare-access.ts`
- **Middleware**: `cfAccessGuard()` — mounted in `src/app.ts` before all routes
- **Crypto**: Node.js Web Crypto API (`crypto.subtle`) — no external dependencies
- **Tests**: `src/auth/cloudflare-access.test.ts`

---

## Layer 3: API Authentication (Bearer Token)

All API routes except `/health` and public webhook endpoints require a Bearer token.

### Token Lifecycle

1. **Auto-generated** on first run (64 hex characters via `crypto.randomBytes`)
2. **Stored** in `~/.openzigs/config.json` under `auth.token` with `0600` permissions
3. **Validated** by `createAuthMiddleware` using constant-time comparison (`timingSafeEqual`)
4. **Passed** in every request as `Authorization: Bearer <token>`

### Socket.IO Authentication

WebSocket connections (chat, real-time streaming) require the token in the handshake:

```javascript
const socket = io("http://localhost:3000", {
  auth: { token: "your-token" }
});
```

Validated in the `io.use()` middleware in `src/server.ts`.

### Rate Limiting

| Scope | Limit | Window |
|---|---|---|
| Global (all routes) | 5,000 requests | 15 minutes |
| Failed auth attempts | 10 attempts | Configurable via `auth.rateLimit.windowMs` |

### Setup Route Protection

`POST /api/setup/config`, `/complete`, and `/reset` require Bearer token authentication **after initial setup is complete** (the `.setup-complete` flag exists in `~/.openzigs/`). This prevents unauthenticated config overwrites via exposed ports or tunnels.

During first-time setup (before the flag exists), these routes are open to allow the setup wizard to work.

### Queue Callback Authentication

`POST /api/queue/complete` (worker result uploads, up to 50 MB):

- **When `auth.workerSecret` is configured**: Requires `Authorization: Bearer <workerSecret>`
- **When `auth.workerSecret` is NOT configured**: Only accepts requests from localhost (`127.0.0.1`, `::1`). Non-localhost requests are rejected with 401.

A startup warning is logged when `workerSecret` is not configured.

### Roles

| Role | Permissions |
|---|---|
| `admin` | Full access: enable/disable tools, decide approvals, view logs, modify config |
| `operator` | Read tools/approvals/logs, decide approvals |
| `viewer` | Read-only health endpoint |

---

## Layer 4: Tool Risk Classification & Approval Queue

Every MCP tool is classified at registration time with a risk level that determines whether human approval is required.

### Risk Levels

| Level | Badge | Behavior | Examples |
|---|---|---|---|
| **Low** | 🟢 | Auto-approved, no prompt | `read-file`, `list-directory`, `web-search`, `list-prompts` |
| **Medium** | 🟡 | Logged, executed without pause | `browser-read`, `social-timeline`, `schedule-job` |
| **High** | 🔴 | **Execution paused** — requires human approval | `write-file`, `shell-execute`, `social-post`, `browser-navigate` |

### Approval Flow

```
Tool Call → onPreToolUse Hook → Risk Check
  🟢 Low / 🟡 Medium → Execute immediately
  🔴 High → Approval Queue → Web / Telegram / Discord
    → First response wins → Approve → Execute
                          → Deny → Skip + Log
```

Approvals are multi-channel: the approval prompt is sent to all connected channels (Web chat, Telegram, Discord) simultaneously. The first response wins.

### Interactive Chat Auto-Approve

When a human user is actively chatting (interactive session), certain high-risk tools are auto-approved to avoid forcing the user through the approval queue for actions they just requested:

`shell-execute`, `browser-navigate`, `write-file`, `list-secrets`, `get-secret`, `ingest-youtube`, `submit-media-job`, `save-draft-media`, `produce-video`, `transcribe-audio`, `save-memory`

**Background/automated tasks** (scheduled jobs, spawned agents) always go through the full approval queue.

---

## Layer 5: Secret Vault (AES-256-GCM)

Encrypted local storage for passwords, API keys, and sensitive credentials.

### Architecture

- **Encryption**: AES-256-GCM with PBKDF2 key derivation (100,000 iterations)
- **Storage**: `~/.openzigs/vault.enc` with `0600` permissions
- **Master password**: Required to unlock; not stored anywhere

### Reference Token Pattern

Plaintext secrets never appear in chat history, audit logs, Socket.IO events, or tool call arguments. Instead:

1. AI calls `list-secrets` → sees labels only
2. AI calls `get-secret` → receives opaque `{{SECRET:uuid}}` reference token
3. AI passes token to `browser-navigate` → handler resolves to plaintext at the last moment
4. Plaintext is typed character-by-character into the browser, then discarded

### Auto-Lock

The vault automatically locks on server shutdown. Must be unlocked each session.

---

## Network Security

### CORS

Restricted to explicit origin allowlist:
- UI origin (`OPENZIGS_UI_ORIGIN` or `http://localhost:3001`)
- `http://localhost:3000` and `http://localhost:3001`
- Any localhost origin (any port) — for local dev servers
- Additional origins via `OPENZIGS_CORS_ORIGINS` (comma-separated)

**Important**: CORS does NOT protect against direct API calls (curl, scripts). It only prevents browser-based cross-origin requests.

### Content Security Policy

Helmet enforces strict CSP:

| Directive | Value | Purpose |
|---|---|---|
| `frame-ancestors` | `'none'` | Anti-clickjacking |
| `script-src` | `'self'` | Only same-origin scripts |
| `object-src` | `'none'` | Block Flash/plugin embeds |
| `base-uri` | `'self'` | Prevent base tag hijacking |
| `form-action` | `'self'` | Prevent form submission to external targets |

### Trust Proxy

Disabled by default. Enable only when behind a reverse proxy:

```json
{ "server": { "trustProxy": true } }
```

When disabled, `X-Forwarded-For` headers are ignored, preventing IP spoofing.

### JSON Body Limit

1 MB default (prevents memory exhaustion via large payloads). Queue callback endpoint allows 50 MB for media uploads.

### Error Redaction

- Internal filesystem paths are stripped from error responses
- 500 errors return generic `"Internal server error"` message
- Stack traces are never sent to the client

---

## Route Protection Matrix

Complete matrix of every route and its authentication requirements:

| Route Pattern | Auth Required | Notes |
|---|---|---|
| `GET /health` | No | Read-only status, uptime, memory |
| `GET /api/setup/status` | No | Setup wizard state check |
| `GET /api/setup/prerequisites` | No | System requirements check |
| `POST /api/setup/config` | **After setup** | Bearer token required once `.setup-complete` exists |
| `POST /api/setup/complete` | **After setup** | Same as above |
| `POST /api/setup/reset` | **After setup** | Same as above |
| `POST /api/queue/complete` | workerSecret or localhost | 50 MB body limit |
| `POST /telegram/webhook` | Webhook secret header | `X-Telegram-Bot-Api-Secret-Token` |
| `POST /api/social/webhooks/:platform` | HMAC signature | Per-platform verification |
| `GET /api/*/oauth/callback` | CSRF state | OAuth state parameter |
| `POST /api/webhooks/trigger` | Webhook auth | Bearer token or HMAC signature |
| `POST /api/webhooks/firecrawl` | HMAC | Firecrawl's own HMAC secret |
| `GET /api/invite/redeem` | JWT | Signed with `presenterInviteSecret` |
| `GET,POST /api/admin/*` | **Bearer token** | All admin endpoints |
| `GET,POST /api/knowledge/*` | **Bearer token** | Knowledge base operations |
| `GET,POST /api/social/*` | **Bearer token** | Social media management |
| `GET,POST /api/vault/*` | **Bearer token** | Secret vault operations |
| `GET,POST /api/tasks/*` | **Bearer token** | Task engine operations |
| `GET,POST /api/models/*` | **Bearer token** | Model management |
| `GET /api/logs` | **Bearer token** | Audit log access |
| Socket.IO | **Auth handshake** | Token in `auth` object |

---

## Input Validation & Size Limits

| Input | Limit | Enforcement |
|---|---|---|
| JSON body | 1 MB | Express `json({ limit })` |
| Queue callback body | 50 MB | Route-specific override |
| Chat messages | 10,000 chars | Socket.IO handler |
| Brand voice samples | 10,000 chars | API validator |
| Prompt templates | 100,000 chars | API validator |
| Task inputs | 50,000 chars | API validator |
| File uploads | 25 MB per file, 10 max | Multer config |
| File MIME types | Allowlist only | text, JSON, PDF, DOCX, images, audio, video |
| MCP server commands | `/^[a-zA-Z0-9_.\-/]+$/` | Regex validation |
| Admin rule updates | Zod `.strict()` | Rejects unknown fields |

---

## Sandbox & Isolation

### Post-Action Scripts

Custom post-action scripts run in a restricted environment:
- **Inherited**: `PATH`, `HOME`, `LANG`, `TERM` only
- **Blocked**: All server env vars (API keys, tokens, secrets)
- **Exposed**: `OPENZIGS_CONFIG_*` variables only

### MCP Command Validation

- Server command names validated against `/^[a-zA-Z0-9_.\-/]+$/`
- `which` lookups use `execFileSync` (no shell interpretation)
- Docker sidecars run in isolated containers

### SSRF Protection (Webhooks)

Webhook destination URLs are validated before fetch:
- **Blocked**: Private IPs (10.x, 172.16–31.x, 192.168.x, 127.x), cloud metadata (169.254.169.254)
- **Allowed**: `http:` and `https:` protocols only

### Browser Automation

- Chrome profile persisted at `~/.openzigs/chrome-profile/`
- Anti-bot stealth patches applied automatically
- Secret vault references resolved at the last moment (never in chat history)

---

## Audit Trail & Logging

All security-relevant events are logged by `AuditLogger` to `~/.openzigs/logs/` (JSONL format):

| Category | Events Logged |
|---|---|
| `session` | Session create, restore, destroy |
| `message` | Chat messages (user and AI) |
| `tool` | Tool requested, approved, denied, result, error |
| `security` | Auth failures, rate limit hits, blocked requests |
| `system` | Server start/stop, config changes, tunnel state |

Logs are queryable via `GET /api/logs` with filters: `category`, `level`, `since`, `until`, `limit`.

**Value redaction**: Sensitive values (tokens, passwords, keys) are automatically redacted in log output.

---

## Configuration Reference

All security-related config fields in `~/.openzigs/config.json`:

```json
{
  "auth": {
    "token": "your-64-hex-char-token",
    "mode": "local",
    "workerSecret": "secret-for-queue-callbacks",
    "rateLimit": {
      "windowMs": 60000,
      "max": 10
    }
  },
  "tunnel": {
    "enabled": false,
    "cfAccessTeamDomain": "your-team.cloudflareaccess.com",
    "cfAccessAudience": ["agent-aud-tag", "presenter-aud-tag"]
  },
  "server": {
    "trustProxy": false
  },
  "vault": {
    "enabled": true,
    "vaultPath": "~/.openzigs/vault.enc"
  },
  "channels": {
    "telegram": {
      "webhookSecret": "random-secret-for-telegram-webhook"
    }
  }
}
```

| Field | Purpose | Default |
|---|---|---|
| `auth.token` | Bearer token for API + Socket.IO auth | Auto-generated |
| `auth.workerSecret` | Bearer token for worker callbacks | Not set (localhost-only) |
| `auth.rateLimit.windowMs` | Failed auth rate limit window | 60000 (1 min) |
| `auth.rateLimit.max` | Max failed attempts per window | 10 |
| `tunnel.enabled` | Whether server spawns quick tunnels | `false` |
| `tunnel.cfAccessTeamDomain` | CF Access team for JWT validation | Not set (validation skipped) |
| `tunnel.cfAccessAudience` | Application Audience Tags | Not set (audience not checked) |
| `server.trustProxy` | Trust X-Forwarded-For headers | `false` |
| `vault.enabled` | Enable secret vault | `true` |
| `channels.telegram.webhookSecret` | Telegram webhook verification | Not set |

### File Permissions

| File | Permissions | Content |
|---|---|---|
| `~/.openzigs/config.json` | `0600` | Auth tokens, secrets, config |
| `~/.openzigs/vault.enc` | `0600` | AES-256-GCM encrypted vault |
| `~/.openzigs/auth.json` | `0600` | Copilot device auth state |
| `~/.openzigs/logs/` | `0700` | Audit logs |

---

## Credential Rotation Procedure

### Rotate Auth Token

```bash
# 1. Generate new token
NEW_TOKEN=$(openssl rand -hex 32)

# 2. Update server config
python3 -c "
import json, os
config_path = os.path.expanduser('~/.openzigs/config.json')
with open(config_path) as f: config = json.load(f)
config['auth']['token'] = '$NEW_TOKEN'
with open(config_path, 'w') as f: json.dump(config, f, indent=2); f.write('\n')
print('Config updated')
"

# 3. Update UI env
sed -i '' "s/NEXT_PUBLIC_OPENZIGS_TOKEN=.*/NEXT_PUBLIC_OPENZIGS_TOKEN=$NEW_TOKEN/" ui/.env.local

# 4. Restart server + rebuild UI
# (pnpm dev for backend, cd ui && pnpm dev for frontend)
```

### Rotate Worker Secret

```bash
NEW_SECRET=$(openssl rand -hex 32)
# Update ~/.openzigs/config.json → auth.workerSecret
# Update CALLBACK_SECRET env var on all worker machines
# Restart server + workers
```

### Rotate Telegram Webhook Secret

```bash
NEW_SECRET=$(openssl rand -hex 32)
# Update ~/.openzigs/config.json → channels.telegram.webhookSecret
# Re-register webhook:
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://agent.example.com/telegram/webhook" \
  -d "secret_token=$NEW_SECRET"
```

---

## Threat Model & Known Risks

### Known Risk: Auth Token in Client Bundle

**Severity**: High (when tunnel is active)

The auth token is currently passed to the Next.js frontend via `NEXT_PUBLIC_OPENZIGS_TOKEN`, which bakes it into the client-side JavaScript bundle. Anyone who loads the UI can extract it from the JS source.

**Mitigations in place**:
- Cloudflare Access (Layer 1) prevents unauthorized users from loading the UI
- CF JWT validation (Layer 2) provides server-side verification
- Token can be rotated quickly if compromised

**Future mitigation**: Move to a server-side session/cookie mechanism so the token is never in the client bundle.

### Threat: Tunnel Without Access Policies

If a Cloudflare Tunnel is running without Access policies, the entire server is exposed. The server-side JWT validation (Layer 2) mitigates this — requests through the tunnel without valid CF JWTs are rejected with 403.

### Threat: Shell Execution via Chat

The `shell-execute` tool is auto-approved in interactive chat sessions. An attacker with chat access could execute arbitrary commands as the server's OS user.

**Mitigations**: Layers 1–3 must all be compromised before chat access is possible. Background tasks require explicit human approval.

### Threat: Social Platform Token Compromise

If an attacker gains chat access, they could use social media tools to interact with connected platform APIs (post, comment, DM).

**Mitigation**: Rotate all social platform tokens immediately if a security breach is suspected.

### Threat: LaunchDaemon Running Tunnel as Root

**Severity**: Medium

A system LaunchDaemon runs `cloudflared` as `root` with `KeepAlive` enabled. This means:
- The tunnel restarts automatically on crash or reboot — even if you didn't intend it
- The process runs with full root privileges (unnecessary for an HTTP proxy)
- The tunnel token is stored in plaintext in the plist, readable by any local process
- 24/7 uptime means the attack surface is always exposed

**Mitigation**: Do not use a LaunchDaemon. Start the tunnel manually as your user. See [Tunnel Operation](#tunnel-operation-manual-start).

---

## Security Checklist

Pre-deployment checklist for any OpenZigs instance accessible beyond localhost:

- [ ] **Cloudflare Access configured** — all routes gated behind email OTP
- [ ] **CF JWT validation enabled** — `tunnel.cfAccessTeamDomain` and `cfAccessAudience` set in config
- [ ] **Auth token rotated** — not the auto-generated default
- [ ] **Worker secret set** — `auth.workerSecret` configured if using remote workers
- [ ] **Telegram webhook secret set** — `channels.telegram.webhookSecret` configured
- [ ] **Trust proxy disabled** — unless behind a known reverse proxy
- [ ] **Vault master password set** — strong, unique password
- [ ] **Social platform tokens secured** — stored in vault or env vars with `0600` permissions
- [ ] **Audit logs reviewed** — check `~/.openzigs/logs/` for suspicious activity
- [ ] **No orphaned tunnel processes** — check `pgrep -la cloudflared`
- [ ] **Quick tunnel disabled** — `tunnel.enabled: false` in config
- [ ] **No LaunchDaemon for cloudflared** — check `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist` does not exist (use manual start instead)
- [ ] **File permissions verified** — `ls -la ~/.openzigs/config.json` shows `0600`
