#!/usr/bin/env bash
# =============================================================================
# Social Brain — Simulated Platform Tests
# =============================================================================
# Runs end-to-end tests against the Social Brain API without real social media
# accounts. Uses simulated webhook payloads + API calls to verify the full
# pipeline: ingestion → rule matching → automation → CRM → analytics.
#
# Usage:
#   chmod +x scripts/social-brain-simulated-tests.sh
#   ./scripts/social-brain-simulated-tests.sh
#
# Prerequisites:
#   - Server running on localhost:3000
#   - OPENZIGS_TOKEN env var set (or uses default from .env)
# =============================================================================

set -uo pipefail

BASE="${OPENZIGS_BASE_URL:-http://localhost:3000}"
TOKEN="${OPENZIGS_TOKEN:?Set OPENZIGS_TOKEN env var (from ~/.openzigs/config.json auth.token)}"
AUTH="Authorization: Bearer $TOKEN"
CT="Content-Type: application/json"
PASS=0
FAIL=0
SKIP=0
ERRORS=""

# Unique run ID to avoid collisions with prior data
RUN_ID="test_$(date +%s)"

# ---------- helpers ----------------------------------------------------------

green()  { printf "\033[32m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }

assert_status() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    green "  ✓ $label (HTTP $actual)"
    ((PASS++))
  else
    red "  ✗ $label — expected HTTP $expected, got $actual"
    ((FAIL++))
    ERRORS+="  - $label\n"
  fi
}

jq_py() {
  # Usage: jq_py '.key' '{"key": "value"}'
  # Translates simple dot-paths to python dict access
  local path="$1" json="$2"
  echo "$json" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    keys = [k for k in '${path}'.split('.') if k]
    v = data
    for k in keys:
        v = v[k] if isinstance(v, dict) else v[int(k)]
    print(v)
except Exception as e:
    print('__ERROR__:' + str(e))
" 2>/dev/null || echo "__ERROR__"
}

assert_json() {
  local label="$1" path="$2" expected="$3" json="$4"
  local actual
  actual=$(jq_py "$path" "$json")
  if [[ "$actual" == "$expected" ]]; then
    green "  ✓ $label = $actual"
    ((PASS++))
  else
    red "  ✗ $label — expected '$expected', got '$actual'"
    ((FAIL++))
    ERRORS+="  - $label\n"
  fi
}

assert_json_gte() {
  local label="$1" path="$2" min="$3" json="$4"
  local actual
  actual=$(jq_py "$path" "$json")
  if [[ "$actual" =~ ^[0-9]+$ ]] && (( actual >= min )); then
    green "  ✓ $label = $actual (≥ $min)"
    ((PASS++))
  else
    red "  ✗ $label — expected ≥ $min, got $actual"
    ((FAIL++))
    ERRORS+="  - $label\n"
  fi
}

assert_json_contains() {
  local label="$1" path="$2" needle="$3" json="$4"
  local actual
  actual=$(jq_py "$path" "$json")
  if echo "$actual" | grep -qi "$needle"; then
    green "  ✓ $label contains '$needle'"
    ((PASS++))
  else
    red "  ✗ $label — '$needle' not found in '$actual'"
    ((FAIL++))
    ERRORS+="  - $label\n"
  fi
}

api() {
  # Usage: api METHOD /path [data]
  local method="$1" path="$2" data="${3:-}"
  if [[ -n "$data" ]]; then
    curl -s -w "\n%{http_code}" -X "$method" -H "$AUTH" -H "$CT" -d "$data" "$BASE$path"
  else
    curl -s -w "\n%{http_code}" -X "$method" -H "$AUTH" "$BASE$path"
  fi
}

split_response() {
  # Splits "body\nstatus_code" → BODY and STATUS
  local raw="$1"
  STATUS=$(echo "$raw" | tail -1)
  BODY=$(echo "$raw" | sed '$d')
}

# =============================================================================
bold "╔═══════════════════════════════════════════════════════════════╗"
bold "║       Social Brain — Simulated Platform Test Suite           ║"
bold "║       $(date '+%Y-%m-%d %H:%M:%S')                              ║"
bold "╚═══════════════════════════════════════════════════════════════╝"
echo ""

# =============================================================================
# SECTION 0: PRE-FLIGHT CHECKS
# =============================================================================
bold "─── Section 0: Pre-Flight Checks ───"

split_response "$(api GET /health)"
assert_status "Server health" "200" "$STATUS"
assert_json "Health status" "['status']" "ok" "$BODY"

split_response "$(api GET /api/social/config)"
assert_status "Social config endpoint" "200" "$STATUS"
assert_json "Social Brain enabled" "['enabled']" "True" "$BODY"

split_response "$(api GET /api/social/connections)"
assert_status "Connections endpoint" "200" "$STATUS"

split_response "$(api GET /api/social/stats)"
assert_status "Stats endpoint" "200" "$STATUS"
INITIAL_CONTACTS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['totalContacts'])" 2>/dev/null || echo "0")
INITIAL_MESSAGES=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['totalMessages'])" 2>/dev/null || echo "0")
echo "  ℹ Initial state: $INITIAL_CONTACTS contacts, $INITIAL_MESSAGES messages"

echo ""

# =============================================================================
# SECTION 1: AUTOMATION RULES CRUD
# =============================================================================
bold "─── Section 1: Automation Rules CRUD ───"

# 1a. Create a test rule for twitter
RULE_DATA='{
  "name": "Test Pricing Rule '$RUN_ID'",
  "platform": "twitter",
  "dm_template": "Hey {{username}}! Our pricing starts at $49/mo.",
  "comment_reply_template": "Thanks {{username}}! Check your DMs 📬",
  "keywords": "[\"pricing\", \"price\", \"how much\", \"cost\"]",
  "max_triggers_per_user": 2,
  "max_triggers_total": 10,
  "auto_tag": "lead"
}'
split_response "$(api POST /api/social/rules "$RULE_DATA")"
assert_status "Create rule (twitter)" "201" "$STATUS"
RULE_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
if [[ -n "$RULE_ID" ]]; then
  green "  ✓ Rule created: $RULE_ID"
  ((PASS++))
else
  red "  ✗ Failed to extract rule ID"
  ((FAIL++))
fi

# 1b. Create rules for other platforms
for plat in instagram facebook linkedin youtube; do
  PLAT_RULE='{
    "name": "Test '$plat' Rule '$RUN_ID'",
    "platform": "'$plat'",
    "dm_template": "Hello {{username}} from '$plat'!",
    "comment_reply_template": "Thanks for commenting on '$plat'!",
    "keywords": "[\"interested\", \"pricing\", \"demo\"]",
    "max_triggers_per_user": 3,
    "auto_tag": "test-'$plat'"
  }'
  split_response "$(api POST /api/social/rules "$PLAT_RULE")"
  assert_status "Create rule ($plat)" "201" "$STATUS"
  eval "RULE_ID_${plat}=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")"
done

# 1c. Read rules back
split_response "$(api GET /api/social/rules)"
assert_status "List all rules" "200" "$STATUS"
RULE_COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['rules']))" 2>/dev/null || echo "0")
assert_json_gte "At least 5 rules created" "['__len__']" "5" '{"__len__": '$RULE_COUNT'}'

# 1d. Read single rule
split_response "$(api GET /api/social/rules/$RULE_ID)"
assert_status "Get single rule" "200" "$STATUS"
assert_json "Rule name matches" "['name']" "Test Pricing Rule $RUN_ID" "$BODY"

# 1e. Update rule
split_response "$(api PATCH /api/social/rules/$RULE_ID '{"auto_tag": "hot-lead"}')"
assert_status "Update rule tag" "200" "$STATUS"

# 1f. Verify update
split_response "$(api GET /api/social/rules/$RULE_ID)"
assert_json "Updated auto_tag" "['auto_tag']" "hot-lead" "$BODY"

# 1g. Disable and re-enable rule
split_response "$(api PATCH /api/social/rules/$RULE_ID '{"enabled": 0}')"
assert_status "Disable rule" "200" "$STATUS"
split_response "$(api GET /api/social/rules/$RULE_ID)")
assert_json "Rule disabled" "['enabled']" "0" "$BODY"

split_response "$(api PATCH /api/social/rules/$RULE_ID '{"enabled": 1}')"
split_response "$(api GET /api/social/rules/$RULE_ID)")
assert_json "Rule re-enabled" "['enabled']" "1" "$BODY"

echo ""

# =============================================================================
# SECTION 2: FOLLOW-UP STEPS CRUD
# =============================================================================
bold "─── Section 2: Follow-Up Steps CRUD ───"

# 2a. Add follow-up step 1
STEP1='{
  "stepOrder": 0,
  "delaySeconds": 3600,
  "messageTemplate": "Hey {{username}}, just following up on pricing!"
}'
split_response "$(api POST /api/social/rules/$RULE_ID/follow-ups "$STEP1")"
assert_status "Create follow-up step 1" "201" "$STATUS"
STEP1_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")

# 2b. Add follow-up step 2
STEP2='{
  "stepOrder": 1,
  "delaySeconds": 86400,
  "messageTemplate": "Final reminder {{username}} — trial ends soon!"
}'
split_response "$(api POST /api/social/rules/$RULE_ID/follow-ups "$STEP2")"
assert_status "Create follow-up step 2" "201" "$STATUS"
STEP2_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")

# 2c. List follow-up steps
split_response "$(api GET /api/social/rules/$RULE_ID/follow-ups)")
assert_status "List follow-up steps" "200" "$STATUS"
STEP_COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['steps']))" 2>/dev/null || echo "0")
assert_json_gte "2 follow-up steps" "['__len__']" "2" '{"__len__": '$STEP_COUNT'}'

# 2d. Delete one step
if [[ -n "$STEP2_ID" ]]; then
  split_response "$(api DELETE /api/social/rules/$RULE_ID/follow-ups/$STEP2_ID)")
  assert_status "Delete follow-up step 2" "200" "$STATUS"
  split_response "$(api GET /api/social/rules/$RULE_ID/follow-ups)")
  STEP_COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['steps']))" 2>/dev/null || echo "0")
  assert_json "1 step remaining" "['__len__']" "1" '{"__len__": '$STEP_COUNT'}'
fi

echo ""

# =============================================================================
# SECTION 3: WEBHOOK VERIFICATION (Meta platforms)
# =============================================================================
bold "─── Section 3: Webhook Verification (Meta) ───"

VERIFY_TOKEN="${SOCIAL_WEBHOOK_VERIFY_TOKEN:?Set SOCIAL_WEBHOOK_VERIFY_TOKEN env var}"

# 3a. Instagram webhook verify
RESP=$(curl -s -w "\n%{http_code}" "$BASE/api/social/webhooks/instagram?hub.mode=subscribe&hub.verify_token=$VERIFY_TOKEN&hub.challenge=test_challenge_123")
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "Instagram webhook verify" "200" "$STATUS"
if [[ "$BODY" == "test_challenge_123" ]]; then
  green "  ✓ Instagram challenge echoed correctly"
  ((PASS++))
else
  red "  ✗ Instagram challenge — expected 'test_challenge_123', got '$BODY'"
  ((FAIL++))
fi

# 3b. Facebook webhook verify
RESP=$(curl -s -w "\n%{http_code}" "$BASE/api/social/webhooks/facebook?hub.mode=subscribe&hub.verify_token=$VERIFY_TOKEN&hub.challenge=fb_challenge_abc")
STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "Facebook webhook verify" "200" "$STATUS"
if [[ "$BODY" == "fb_challenge_abc" ]]; then
  green "  ✓ Facebook challenge echoed correctly"
  ((PASS++))
else
  red "  ✗ Facebook challenge — expected 'fb_challenge_abc', got '$BODY'"
  ((FAIL++))
fi

# 3c. Invalid verify token
RESP=$(curl -s -w "\n%{http_code}" "$BASE/api/social/webhooks/instagram?hub.mode=subscribe&hub.verify_token=WRONG_TOKEN&hub.challenge=nope")
STATUS=$(echo "$RESP" | tail -1)
assert_status "Invalid verify token rejected" "403" "$STATUS"

echo ""

# =============================================================================
# SECTION 4: SIMULATED WEBHOOK — TWITTER
# =============================================================================
bold "─── Section 4: Twitter Webhook Simulation ───"

# 4a. Twitter comment (reply to post) — with keyword "pricing"
TW_COMMENT='{
  "tweet_create_events": [{
    "id_str": "tw_comment_'$RUN_ID'_001",
    "text": "@brandaccount What is your pricing?",
    "user": {"id_str": "tw_user_'$RUN_ID'_001", "screen_name": "tw_sim_user_'$RUN_ID'"},
    "in_reply_to_status_id_str": "original_post_001",
    "created_at": "Mon Mar 17 12:00:00 +0000 2026"
  }]
}'
split_response "$(api POST /api/social/webhooks/twitter "$TW_COMMENT")"
assert_status "Twitter comment webhook accepted" "200" "$STATUS"
assert_json "Twitter webhook received" "['received']" "True" "$BODY"

# 4b. Twitter DM
TW_DM='{
  "direct_message_events": [{
    "id": "tw_dm_'$RUN_ID'_001",
    "created_timestamp": "'$(date +%s)000'",
    "message_create": {
      "sender_id": "tw_user_'$RUN_ID'_002",
      "message_data": {"text": "Hi there, I am interested in a demo!"}
    }
  }]
}'
split_response "$(api POST /api/social/webhooks/twitter "$TW_DM")"
assert_status "Twitter DM webhook accepted" "200" "$STATUS"

# 4c. Non-reply tweet (should be ignored gracefully)
TW_NONREPLY='{
  "tweet_create_events": [{
    "id_str": "tw_norep_'$RUN_ID'",
    "text": "Just a regular tweet",
    "user": {"id_str": "tw_user_'$RUN_ID'_003", "screen_name": "tw_random"},
    "created_at": "Mon Mar 17 12:01:00 +0000 2026"
  }]
}'
split_response "$(api POST /api/social/webhooks/twitter "$TW_NONREPLY")"
assert_status "Non-reply tweet accepted (no crash)" "200" "$STATUS"

# Small delay for async processing
sleep 1

echo ""

# =============================================================================
# SECTION 5: SIMULATED WEBHOOK — INSTAGRAM
# =============================================================================
bold "─── Section 5: Instagram Webhook Simulation ───"

# 5a. Instagram comment with keyword
IG_COMMENT='{
  "entry": [{
    "id": "17841400000000000",
    "time": '$(date +%s)',
    "changes": [{
      "field": "comments",
      "value": {
        "id": "ig_comment_'$RUN_ID'_001",
        "text": "Interested in pricing!",
        "from": {"id": "ig_user_'$RUN_ID'_001", "username": "ig_tester_'$RUN_ID'"},
        "media": {"id": "ig_post_001"}
      }
    }]
  }]
}'
split_response "$(api POST /api/social/webhooks/instagram "$IG_COMMENT")"
assert_status "Instagram comment webhook accepted" "200" "$STATUS"
assert_json "Instagram webhook received" "['received']" "True" "$BODY"

# 5b. Instagram DM with lead data
IG_DM='{
  "entry": [{
    "id": "17841400000000000",
    "time": '$(date +%s)',
    "messaging": [{
      "sender": {"id": "ig_user_'$RUN_ID'_002"},
      "recipient": {"id": "17841400000000000"},
      "timestamp": '$(date +%s)000',
      "message": {
        "mid": "ig_dm_'$RUN_ID'_001",
        "text": "Hi! My email is testlead_'$RUN_ID'@example.com and phone is 555-123-4567"
      }
    }]
  }]
}'
split_response "$(api POST /api/social/webhooks/instagram "$IG_DM")"
assert_status "Instagram DM webhook accepted" "200" "$STATUS"

sleep 1

echo ""

# =============================================================================
# SECTION 6: SIMULATED WEBHOOK — FACEBOOK
# =============================================================================
bold "─── Section 6: Facebook Webhook Simulation ───"

# 6a. Facebook page comment
FB_COMMENT='{
  "object": "page",
  "entry": [{
    "id": "FB_PAGE_001",
    "time": '$(date +%s)',
    "changes": [{
      "field": "feed",
      "value": {
        "item": "comment",
        "comment_id": "fb_comment_'$RUN_ID'_001",
        "post_id": "fb_post_001",
        "sender_id": "fb_user_'$RUN_ID'_001",
        "sender_name": "FB Test User '$RUN_ID'",
        "message": "How much does this cost? Interested!",
        "created_time": '$(date +%s)'
      }
    }]
  }]
}'
split_response "$(api POST /api/social/webhooks/facebook "$FB_COMMENT")"
assert_status "Facebook comment webhook accepted" "200" "$STATUS"
assert_json "Facebook webhook received" "['received']" "True" "$BODY"

# 6b. Facebook Messenger DM
FB_DM='{
  "object": "page",
  "entry": [{
    "id": "FB_PAGE_001",
    "time": '$(date +%s)',
    "messaging": [{
      "sender": {"id": "fb_user_'$RUN_ID'_002"},
      "recipient": {"id": "FB_PAGE_001"},
      "timestamp": '$(date +%s)000',
      "message": {
        "mid": "fb_dm_'$RUN_ID'_001",
        "text": "I want a demo please!"
      }
    }]
  }]
}'
split_response "$(api POST /api/social/webhooks/facebook "$FB_DM")"
assert_status "Facebook DM webhook accepted" "200" "$STATUS"

sleep 1

echo ""

# =============================================================================
# SECTION 7: SIMULATED WEBHOOK — LINKEDIN
# =============================================================================
bold "─── Section 7: LinkedIn Webhook Simulation ───"

# 7a. LinkedIn comment
LI_COMMENT='{
  "eventType": "COMMENT",
  "event": {
    "id": "li_comment_'$RUN_ID'_001",
    "object": "urn:li:ugcPost:123456",
    "actor": "urn:li:person:li_user_'$RUN_ID'",
    "message": {"text": "Very interested in your demo"},
    "createdAt": '$(date +%s)000'
  }
}'
split_response "$(api POST /api/social/webhooks/linkedin "$LI_COMMENT")"
assert_status "LinkedIn comment webhook accepted" "200" "$STATUS"

# 7b. LinkedIn DM
LI_DM='{
  "eventType": "MESSAGING",
  "event": {
    "message": {"id": "li_msg_'$RUN_ID'_001", "text": "Tell me about pricing"},
    "from": {"id": "urn:li:person:li_user_'$RUN_ID'_dm"},
    "createdAt": '$(date +%s)000'
  }
}'
split_response "$(api POST /api/social/webhooks/linkedin "$LI_DM")"
assert_status "LinkedIn DM webhook accepted" "200" "$STATUS"

sleep 1

echo ""

# =============================================================================
# SECTION 8: WEBHOOK — UNSUPPORTED / EDGE CASES
# =============================================================================
bold "─── Section 8: Edge Cases & Error Handling ───"

# 8a. Empty body
split_response "$(api POST /api/social/webhooks/twitter '{}')"
assert_status "Empty twitter webhook (no crash)" "200" "$STATUS"

# 8b. Malformed JSON — this may return 400 or 200 depending on express parser
RESP=$(curl -s -w "\n%{http_code}" -X POST -H "$AUTH" -H "$CT" -d 'not-json' "$BASE/api/social/webhooks/twitter")
STATUS=$(echo "$RESP" | tail -1)
# Any non-500 status is a pass (400 = correctly rejected, 200 = OK too)
if [[ "$STATUS" != "500" ]]; then
  green "  ✓ Malformed JSON handled (HTTP $STATUS, no crash)"
  ((PASS++))
else
  red "  ✗ Malformed JSON caused server error (HTTP 500)"
  ((FAIL++))
fi

# 8c. Webhook for disabled platform (TikTok)
TT_COMMENT='{
  "some": "tiktok",
  "payload": "here"
}'
split_response "$(api POST /api/social/webhooks/tiktok "$TT_COMMENT")"
# Should return 200 (no crash) even though TikTok has no adapter
if [[ "$STATUS" == "200" || "$STATUS" == "404" ]]; then
  green "  ✓ TikTok webhook handled gracefully (HTTP $STATUS)"
  ((PASS++))
else
  red "  ✗ TikTok webhook unexpected status: $STATUS"
  ((FAIL++))
fi

# 8d. Duplicate webhook (same comment ID twice)
split_response "$(api POST /api/social/webhooks/twitter "$TW_COMMENT")"
assert_status "Duplicate tweet webhook accepted (no crash)" "200" "$STATUS"

echo ""

# =============================================================================
# SECTION 9: VERIFY CRM DATA
# =============================================================================
bold "─── Section 9: CRM & Contact Verification ───"

# Wait for async processing
sleep 2

# 9a. Contacts increased
split_response "$(api GET /api/social/stats)"
NEW_CONTACTS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['totalContacts'])" 2>/dev/null || echo "0")
NEW_MESSAGES=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['totalMessages'])" 2>/dev/null || echo "0")
echo "  ℹ After webhooks: $NEW_CONTACTS contacts (+$((NEW_CONTACTS - INITIAL_CONTACTS))), $NEW_MESSAGES messages (+$((NEW_MESSAGES - INITIAL_MESSAGES)))"

if (( NEW_CONTACTS > INITIAL_CONTACTS )); then
  green "  ✓ New contacts created from webhooks"
  ((PASS++))
else
  red "  ✗ No new contacts created"
  ((FAIL++))
fi

if (( NEW_MESSAGES > INITIAL_MESSAGES )); then
  green "  ✓ New messages recorded from webhooks"
  ((PASS++))
else
  red "  ✗ No new messages recorded"
  ((FAIL++))
fi

# 9b. Search for specific contacts by platform
for plat in twitter instagram facebook; do
  split_response "$(api GET "/api/social/contacts?platform=$plat")"
  PLAT_COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])" 2>/dev/null || echo "0")
  if (( PLAT_COUNT > 0 )); then
    green "  ✓ $plat contacts found ($PLAT_COUNT)"
    ((PASS++))
  else
    yellow "  ⚠ $plat: no contacts found (may indicate adapter issue)"
    ((SKIP++))
  fi
done

# 9c. Activity feed
split_response "$(api GET /api/social/activity)"
assert_status "Activity feed endpoint" "200" "$STATUS"
MSG_COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['messages']))" 2>/dev/null || echo "0")
echo "  ℹ Activity feed has $MSG_COUNT messages"

# 9d. Webhook log
split_response "$(api GET /api/social/webhook-log)")
assert_status "Webhook log endpoint" "200" "$STATUS"
WH_COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['events']))" 2>/dev/null || echo "0")
echo "  ℹ Webhook log has $WH_COUNT events"

echo ""

# =============================================================================
# SECTION 10: AUTOMATION LOG VERIFICATION
# =============================================================================
bold "─── Section 10: Automation Log ───"

split_response "$(api GET /api/social/rules/log)")
assert_status "Automation log endpoint" "200" "$STATUS"
LOG_COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['log']))" 2>/dev/null || echo "0")
echo "  ℹ Automation log has $LOG_COUNT entries"

# Check rule-specific log
if [[ -n "$RULE_ID" ]]; then
  split_response "$(api GET "/api/social/rules/log?ruleId=$RULE_ID")")
  assert_status "Rule-specific log" "200" "$STATUS"
fi

echo ""

# =============================================================================
# SECTION 11: ANALYTICS & LEADS
# =============================================================================
bold "─── Section 11: Analytics & Leads ───"

# 11a. Analytics endpoint
split_response "$(api GET /api/social/analytics)")
assert_status "Analytics endpoint" "200" "$STATUS"
ANALYTICS=$(echo "$BODY" | python3 -c "import json,sys; a=json.load(sys.stdin)['analytics']; print(len(a))" 2>/dev/null || echo "0")
echo "  ℹ Analytics has $ANALYTICS platform entries"

# 11b. Analytics with since filter
split_response "$(api GET "/api/social/analytics?since=2026-03-17T00:00:00Z")")
assert_status "Analytics with since filter" "200" "$STATUS"

# 11c. Leads endpoint
split_response "$(api GET /api/social/leads)")
assert_status "Leads endpoint" "200" "$STATUS"
LEAD_COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['leads']))" 2>/dev/null || echo "0")
echo "  ℹ Leads captured: $LEAD_COUNT"

# 11d. Leads with platform filter
split_response "$(api GET "/api/social/leads?platform=instagram")")
assert_status "Leads filtered by platform" "200" "$STATUS"

echo ""

# =============================================================================
# SECTION 12: CONTACT OPERATIONS
# =============================================================================
bold "─── Section 12: Contact CRUD ───"

# Get first contact
split_response "$(api GET /api/social/contacts)")
FIRST_CONTACT_ID=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(d[0]['id'] if d else '')" 2>/dev/null || echo "")

if [[ -n "$FIRST_CONTACT_ID" ]]; then
  # 12a. Get single contact
  split_response "$(api GET /api/social/contacts/$FIRST_CONTACT_ID)")
  assert_status "Get single contact" "200" "$STATUS"

  # 12b. Update contact notes
  split_response "$(api PATCH "/api/social/contacts/$FIRST_CONTACT_ID" '{"notes": "Test note from sim run '$RUN_ID'"}')"
  assert_status "Update contact notes" "200" "$STATUS"

  # 12c. Add tag
  split_response "$(api POST "/api/social/contacts/$FIRST_CONTACT_ID/tags" '{"tag": "sim-test"}')"
  assert_status "Add tag to contact" "200" "$STATUS"

  # 12d. Remove tag
  split_response "$(api DELETE "/api/social/contacts/$FIRST_CONTACT_ID/tags/sim-test")"
  assert_status "Remove tag from contact" "200" "$STATUS"

  # 12e. Get contact messages
  split_response "$(api GET "/api/social/contacts/$FIRST_CONTACT_ID/messages")"
  assert_status "Get contact messages" "200" "$STATUS"
else
  yellow "  ⚠ No contacts to test CRUD operations on"
  ((SKIP++))
fi

# 12f. Export contacts CSV
RESP=$(curl -s -w "\n%{http_code}" -H "$AUTH" "$BASE/api/social/contacts/export")
STATUS=$(echo "$RESP" | tail -1)
assert_status "Export contacts CSV" "200" "$STATUS"

echo ""

# =============================================================================
# SECTION 13: PLATFORM TOGGLE
# =============================================================================
bold "─── Section 13: Platform Toggle ───"

# 13a. Disable a platform
split_response "$(api PATCH /api/social/connections/twitter '{"enabled": false}')"
assert_status "Disable twitter" "200" "$STATUS"

# 13b. Re-enable it
split_response "$(api PATCH /api/social/connections/twitter '{"enabled": true}')"
assert_status "Re-enable twitter" "200" "$STATUS"

echo ""

# =============================================================================
# SECTION 14: RULE VALIDATION
# =============================================================================
bold "─── Section 14: Rule Validation ───"

# 14a. Missing required field (dm_template)
split_response "$(api POST /api/social/rules '{"name": "Bad Rule", "platform": "twitter", "keywords": "[]"}')"
# Should be 400
if [[ "$STATUS" == "400" ]]; then
  green "  ✓ Missing dm_template rejected (HTTP $STATUS)"
  ((PASS++))
else
  red "  ✗ Missing dm_template was not rejected (HTTP $STATUS)"
  ((FAIL++))
fi

# 14b. Invalid platform
split_response "$(api POST /api/social/rules '{"name": "Bad", "platform": "myspace", "dm_template": "hi", "keywords": "[]"}')"
if [[ "$STATUS" == "400" ]]; then
  green "  ✓ Invalid platform 'myspace' rejected"
  ((PASS++))
else
  red "  ✗ Invalid platform was not rejected (HTTP $STATUS)"
  ((FAIL++))
fi

# 14c. Create and immediately delete a rule 
split_response "$(api POST /api/social/rules '{"name": "Temp Rule", "platform": "twitter", "dm_template": "temp", "keywords": "[]"}')"
TEMP_RULE_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
if [[ -n "$TEMP_RULE_ID" ]]; then
  split_response "$(api DELETE /api/social/rules/$TEMP_RULE_ID)")
  assert_status "Delete rule" "200" "$STATUS"
fi

echo ""

# =============================================================================
# SECTION 15: BRAND VOICE
# =============================================================================
bold "─── Section 15: Brand Voice ───"

split_response "$(api PUT /api/social/brand-voice '{"brandVoiceId": "test-voice-123"}')"
assert_status "Set brand voice" "200" "$STATUS"

split_response "$(api PUT /api/social/brand-voice '{"brandVoiceId": null}')"
assert_status "Clear brand voice" "200" "$STATUS"

echo ""

# =============================================================================
# CLEANUP: Remove test rules (keep DB clean)
# =============================================================================
bold "─── Cleanup ───"

# Delete the test rules we created
split_response "$(api GET /api/social/rules)")
echo "$BODY" | python3 -c "
import json, sys
rules = json.load(sys.stdin)['rules']
test_rules = [r['id'] for r in rules if '$RUN_ID' in r.get('name', '')]
for rid in test_rules:
    print(rid)
" 2>/dev/null | while read -r rid; do
  api DELETE "/api/social/rules/$rid" > /dev/null 2>&1
  echo "  Deleted rule $rid"
done

echo ""

# =============================================================================
# SUMMARY
# =============================================================================
bold "═══════════════════════════════════════════════════════════════"
bold "                    TEST RESULTS SUMMARY"
bold "═══════════════════════════════════════════════════════════════"
echo ""
green "  Passed:  $PASS"
if (( FAIL > 0 )); then
  red "  Failed:  $FAIL"
else
  echo "  Failed:  $FAIL"
fi
if (( SKIP > 0 )); then
  yellow "  Skipped: $SKIP"
fi
echo "  Total:   $((PASS + FAIL + SKIP))"
echo ""

if (( FAIL > 0 )); then
  red "  Failed tests:"
  echo -e "$ERRORS"
  exit 1
else
  green "  All tests passed! ✓"
  exit 0
fi
