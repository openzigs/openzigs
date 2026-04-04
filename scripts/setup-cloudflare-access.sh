#!/usr/bin/env bash
set -euo pipefail

# ── Cloudflare Access Setup Script ──
# Secures agent.openzigs.com and presenter.openzigs.com with Cloudflare Access.
#
# WHAT THIS DOES
# ──────────────
# Creates Cloudflare Access applications that gate every route behind an
# email OTP login, while bypassing specific routes that must remain public
# (webhooks, OAuth callbacks, health check, etc.).
#
# Cloudflare Access uses path-based APPLICATION separation (not policy-level
# path rules). More-specific paths take precedence over broader ones. So we:
#   1. Create a small Bypass app per public path (Everyone policy)
#   2. Create one catch-all app per domain with an Allow policy (email only)
#
# PREREQUISITES
# ─────────────
# 1. A Cloudflare account with your domains (agent.openzigs.com, presenter.openzigs.com)
#    proxied through Cloudflare (orange-cloud in DNS).
#
# 2. A Cloudflare API token with the following permissions:
#      • Account > Cloudflare Zero Trust > Edit
#      • Account > Access: Apps and Policies > Edit
#    Create one at: https://dash.cloudflare.com/profile/api-tokens
#    → Use the "Zero Trust" template or custom-create with those two scopes.
#
# 3. Your Cloudflare Account ID (found in the right sidebar of any zone page,
#    or at https://dash.cloudflare.com → select your account → URL contains the ID).
#
# USAGE
# ─────
# Option A — environment variables (recommended for CI/CD):
#   export CF_API_TOKEN="cfut_..."
#   export CF_ACCOUNT_ID="4bb2e897..."
#   export ALLOWED_EMAIL="you@example.com"    # defaults to prompt if unset
#   bash scripts/setup-cloudflare-access.sh
#
# Option B — interactive prompts (handy for one-time setup):
#   bash scripts/setup-cloudflare-access.sh
#   (script will prompt for any missing values)
#
# IDEMPOTENCY
# ───────────
# Re-running this script is safe — it lists existing apps first and prints
# them so you can spot duplicates. It does NOT auto-delete existing apps.
# If you need a clean slate, delete apps manually in the Zero Trust dashboard
# at https://one.dash.cloudflare.com/ → Access → Applications.
#
# AFTER RUNNING
# ─────────────
# 1. Verify protected routes return 302:
#      curl -s -o /dev/null -w '%{http_code}' https://yourhost.com/admin
# 2. Verify bypass routes pass through (without auth redirect):
#      curl -s -o /dev/null -w '%{http_code}' https://yourhost.com/health
# 3. Open an incognito window → navigate to your domain → confirm Cloudflare
#    login page appears before your admin UI.

# ── Credentials ──
# Read from env if set, otherwise prompt interactively.

if [[ -z "${CF_API_TOKEN:-}" ]]; then
  read -rsp "Cloudflare API Token (Zero Trust > Edit): " CF_API_TOKEN
  echo ""
fi

if [[ -z "${CF_ACCOUNT_ID:-}" ]]; then
  read -rp "Cloudflare Account ID: " CF_ACCOUNT_ID
fi

if [[ -z "${ALLOWED_EMAIL:-}" ]]; then
  read -rp "Admin email address to allow (e.g. you@example.com): " ALLOWED_EMAIL
fi

# ── Domain configuration ──
# Edit these to match your actual public hostnames.
AGENT_DOMAIN="${AGENT_DOMAIN:-agent.openzigs.com}"
PRESENTER_DOMAIN="${PRESENTER_DOMAIN:-presenter.openzigs.com}"

API="https://api.cloudflare.com/client/v4"

# Helper: POST to CF API
cf_post() {
  local endpoint="$1"
  local body="$2"
  local resp
  resp=$(curl -s -X POST "$API$endpoint" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body")
  local success
  success=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success', False))")
  if [[ "$success" != "True" ]]; then
    echo "ERROR on POST $endpoint:"
    echo "$resp" | python3 -m json.tool 2>/dev/null || echo "$resp"
    return 1
  fi
  echo "$resp"
}

# Helper: Create a bypass app at a specific domain+path with an "Everyone" bypass policy
create_bypass_app() {
  local name="$1"
  local domain="$2"
  local path="$3"
  echo "  Creating bypass app: $domain/$path ($name)"
  local app_body
  app_body=$(python3 -c "
import json, sys
print(json.dumps({
  'name': sys.argv[1],
  'domain': sys.argv[2] + '/' + sys.argv[3],
  'type': 'self_hosted',
  'session_duration': '24h',
  'auto_redirect_to_identity': False,
  'http_only_cookie_attribute': True,
  'same_site_cookie_attribute': 'lax'
}))
" "$name" "$domain" "$path")
  local app_resp
  app_resp=$(cf_post "/accounts/$CF_ACCOUNT_ID/access/apps" "$app_body")
  local app_id
  app_id=$(echo "$app_resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['id'])")
  # Add bypass policy: Include Everyone
  cf_post "/accounts/$CF_ACCOUNT_ID/access/apps/$app_id/policies" '{
    "name": "Bypass",
    "decision": "bypass",
    "precedence": 1,
    "include": [{"everyone": {}}]
  }' > /dev/null
  echo "    ✓ $app_id"
}

# Helper: Create the main catch-all app with email-based Allow policy
create_protected_app() {
  local name="$1"
  local domain="$2"
  echo "  Creating protected app: $domain ($name)"
  local app_body
  app_body=$(python3 -c "
import json, sys
print(json.dumps({
  'name': sys.argv[1],
  'domain': sys.argv[2],
  'type': 'self_hosted',
  'session_duration': '24h',
  'auto_redirect_to_identity': False,
  'http_only_cookie_attribute': True,
  'same_site_cookie_attribute': 'lax'
}))
" "$name" "$domain")
  local app_resp
  app_resp=$(cf_post "/accounts/$CF_ACCOUNT_ID/access/apps" "$app_body")
  local app_id
  app_id=$(echo "$app_resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['id'])")
  # Add Allow policy for admin email
  local policy_body
  policy_body=$(python3 -c "
import json, sys
print(json.dumps({
  'name': 'Admin Access',
  'decision': 'allow',
  'precedence': 1,
  'include': [{'email': {'email': sys.argv[1]}}]
}))
" "$ALLOWED_EMAIL")
  cf_post "/accounts/$CF_ACCOUNT_ID/access/apps/$app_id/policies" "$policy_body" > /dev/null
  echo "    ✓ $app_id"
}

echo "=== Verifying API token ==="
verify=$(curl -s "$API/user/tokens/verify" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json")
status=$(echo "$verify" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('status','unknown'))")
if [[ "$status" != "active" ]]; then
  echo "Token verification failed: $status"
  echo "$verify" | python3 -m json.tool 2>/dev/null
  exit 1
fi
echo "Token is active."

# ── First, clean up the partially-created app from the previous run ──
echo ""
echo "=== Checking for existing apps to avoid duplicates ==="
existing=$(curl -s "$API/accounts/$CF_ACCOUNT_ID/access/apps" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json")
echo "$existing" | python3 -c "
import sys, json
data = json.load(sys.stdin)
apps = data.get('result', [])
for a in apps:
    domain = a.get('domain','')
    if 'openzigs.com' in domain:
        print(f'  Found: {a[\"name\"]} ({domain}) — id: {a[\"id\"]}')
" 2>/dev/null || true

# ────────────────────────────────────────────────
# 1. AGENT domain — BYPASS apps (specific paths)
# ────────────────────────────────────────────────
echo ""
echo "=== $AGENT_DOMAIN — Bypass apps for public endpoints ==="

# Worker callbacks (protected by workerSecret at app level — no CF auth needed)
create_bypass_app "Agent: Worker Callbacks" "$AGENT_DOMAIN" "api/queue/complete"

# Telegram webhook (validated by X-Telegram-Bot-Api-Secret-Token at app level)
create_bypass_app "Agent: Telegram Webhook" "$AGENT_DOMAIN" "telegram/webhook"

# Social webhooks (HMAC-SHA256 verified by each platform at app level)
create_bypass_app "Agent: Social Webhooks" "$AGENT_DOMAIN" "api/social/webhooks/*"

# Health check (informational only — no sensitive data exposed)
create_bypass_app "Agent: Health Check" "$AGENT_DOMAIN" "health"

# OAuth callbacks (CSRF state parameter validated at app level)
create_bypass_app "Agent: Pinterest OAuth" "$AGENT_DOMAIN" "api/pinterest/oauth/callback"
create_bypass_app "Agent: LinkedIn OAuth" "$AGENT_DOMAIN" "api/linkedin/oauth/callback"
create_bypass_app "Agent: YouTube OAuth" "$AGENT_DOMAIN" "api/youtube/oauth/callback"
create_bypass_app "Agent: TikTok OAuth" "$AGENT_DOMAIN" "api/tiktok/oauth/callback"

# ── AGENT domain — PROTECTED catch-all ──
echo ""
echo "=== $AGENT_DOMAIN — Protected catch-all ==="
create_protected_app "OpenZigs Agent API" "$AGENT_DOMAIN"

echo "✓ $AGENT_DOMAIN fully configured"

# ────────────────────────────────────────────────
# 2. PRESENTER domain — BYPASS apps (specific paths)
# ────────────────────────────────────────────────
echo ""
echo "=== $PRESENTER_DOMAIN — Bypass apps for public endpoints ==="

# Invite redemption (JWT-verified at app level)
create_bypass_app "Presenter: Invite Redeem" "$PRESENTER_DOMAIN" "api/invite/redeem"

# Presenter viewer pages (guest_token cookie auth at app level)
create_bypass_app "Presenter: Viewer Pages" "$PRESENTER_DOMAIN" "presenter/*"

# Socket.IO for real-time room sync (guests need this)
create_bypass_app "Presenter: Socket.IO" "$PRESENTER_DOMAIN" "socket.io/*"

# PeerJS for WebRTC voice rooms
create_bypass_app "Presenter: PeerJS Voice" "$PRESENTER_DOMAIN" "peerjs/*"

# Presenter API endpoints guests need (quiz, ask, thumbnails, notes)
create_bypass_app "Presenter: Presentations API" "$PRESENTER_DOMAIN" "api/presentations/*"

# ── PRESENTER domain — PROTECTED catch-all ──
echo ""
echo "=== $PRESENTER_DOMAIN — Protected catch-all ==="
create_protected_app "OpenZigs Presenter" "$PRESENTER_DOMAIN"

echo "✓ $PRESENTER_DOMAIN fully configured"

echo ""
echo "=== Done ==="
echo "Both domains now enforce Cloudflare Access authentication."
echo "Specific paths are bypassed for: worker callbacks, webhooks, OAuth, invites, presenter viewer."
echo "All other routes require email OTP for: $ALLOWED_EMAIL"
echo ""
echo "=== Verification steps ==="
echo "  1. Protected route (expect 302 — redirects to Cloudflare login):"
echo "       curl -s -o /dev/null -w '%{http_code}' https://$AGENT_DOMAIN/"
echo ""
echo "  2. Bypass route — health (expect 200, passes through directly):"
echo "       curl -s -o /dev/null -w '%{http_code}' https://$AGENT_DOMAIN/health"
echo ""
echo "  3. Bypass route — worker callback (expect 401, app-level auth rejects missing secret):"
echo "       curl -s -o /dev/null -w '%{http_code}' -X POST https://$AGENT_DOMAIN/api/queue/complete"
echo ""
echo "  4. Open incognito → https://$AGENT_DOMAIN → you should see the Cloudflare login page."
echo ""
echo "  5. After logging in with $ALLOWED_EMAIL you should reach your agent dashboard."
echo ""
echo "=== Tunnel ==="
echo "  cloudflared is managed as a system launchd daemon (RunAtLoad=true, KeepAlive=true):"
echo "    Start:   sudo launchctl bootstrap system /Library/LaunchDaemons/com.cloudflare.cloudflared.plist"
echo "    Stop:    sudo launchctl bootout system/com.cloudflare.cloudflared"
echo "    Status:  pgrep -la cloudflared"
echo "    Logs:    tail -f /Library/Logs/com.cloudflare.cloudflared.err.log"
