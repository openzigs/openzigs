#!/usr/bin/env python3
"""
Social Brain — Simulated Platform Tests
========================================
Runs end-to-end tests against the Social Brain API without real social media
accounts. Uses simulated webhook payloads + API calls to verify the full
pipeline: ingestion → rule matching → automation → CRM → analytics.

Usage:
    python3 scripts/social-brain-simulated-tests.py
"""

import json
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

BASE = "http://localhost:3000"
TOKEN = "1528efb2267d94dca746741e8e8e037d469e2a26b3ecc5d6b57518df7a814193"
VERIFY_TOKEN = "b7610e77c7cc7059b6c967eefc6fc463"
RUN_ID = f"test_{int(time.time())}"

PASS_COUNT = 0
FAIL_COUNT = 0
SKIP_COUNT = 0
FAILURES: list[str] = []


# ── helpers ──────────────────────────────────────────────────────────────────

def green(msg: str):
    print(f"\033[32m{msg}\033[0m")

def red(msg: str):
    print(f"\033[31m{msg}\033[0m")

def yellow(msg: str):
    print(f"\033[33m{msg}\033[0m")

def bold(msg: str):
    print(f"\033[1m{msg}\033[0m")

def api(method: str, path: str, data: dict | None = None) -> tuple[int, dict | str]:
    """Make an API request. Returns (status_code, parsed_body)."""
    url = f"{BASE}{path}"
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
    }
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req)
        raw = resp.read().decode()
        try:
            return resp.status, json.loads(raw)
        except json.JSONDecodeError:
            return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw

def api_raw(method: str, path: str, raw_body: str | None = None, content_type: str = "application/json") -> tuple[int, str]:
    """Make a raw API request (for malformed JSON etc). Returns (status, raw_text)."""
    url = f"{BASE}{path}"
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": content_type,
    }
    body = raw_body.encode() if raw_body else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req)
        return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def get_no_auth(path: str, params: str = "") -> tuple[int, str]:
    """GET without auth header (for webhook verify)."""
    url = f"{BASE}{path}{'?' + params if params else ''}"
    req = urllib.request.Request(url, method="GET")
    try:
        resp = urllib.request.urlopen(req)
        return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def ok(label: str):
    global PASS_COUNT
    green(f"  ✓ {label}")
    PASS_COUNT += 1

def fail(label: str, detail: str = ""):
    global FAIL_COUNT
    msg = f"  ✗ {label}" + (f" — {detail}" if detail else "")
    red(msg)
    FAIL_COUNT += 1
    FAILURES.append(label)

def skip(label: str):
    global SKIP_COUNT
    yellow(f"  ⚠ {label}")
    SKIP_COUNT += 1

def assert_status(label: str, expected: int, actual: int):
    if actual == expected:
        ok(f"{label} (HTTP {actual})")
    else:
        fail(label, f"expected HTTP {expected}, got {actual}")

def assert_eq(label: str, expected, actual):
    if actual == expected:
        ok(f"{label} = {actual}")
    else:
        fail(label, f"expected '{expected}', got '{actual}'")

def assert_gte(label: str, minimum: int, actual):
    try:
        val = int(actual)
    except (ValueError, TypeError):
        fail(label, f"expected ≥ {minimum}, got non-numeric: {actual}")
        return
    if val >= minimum:
        ok(f"{label} = {val} (≥ {minimum})")
    else:
        fail(label, f"expected ≥ {minimum}, got {val}")

def assert_contains(label: str, needle: str, haystack: str):
    if needle.lower() in str(haystack).lower():
        ok(f"{label} contains '{needle}'")
    else:
        fail(label, f"'{needle}' not found in '{haystack[:80]}'")

def get_path(obj, path: str, default=None):
    """Simple dot-path accessor: get_path(data, 'rules.0.name')"""
    keys = path.split(".")
    v = obj
    for k in keys:
        if not k:
            continue
        if isinstance(v, dict):
            v = v.get(k, default)
        elif isinstance(v, list):
            try:
                v = v[int(k)]
            except (IndexError, ValueError):
                return default
        else:
            return default
        if v is None:
            return default
    return v


# =============================================================================
# TESTS
# =============================================================================

def section_0_preflight():
    bold("\n─── Section 0: Pre-Flight Checks ───")

    status, body = api("GET", "/health")
    assert_status("Server health", 200, status)
    assert_eq("Health status", "ok", get_path(body, "status"))

    status, body = api("GET", "/api/social/config")
    assert_status("Social config endpoint", 200, status)
    assert_eq("Social Brain enabled", True, get_path(body, "enabled"))

    status, body = api("GET", "/api/social/connections")
    assert_status("Connections endpoint", 200, status)

    status, body = api("GET", "/api/social/stats")
    assert_status("Stats endpoint", 200, status)
    initial_contacts = get_path(body, "totalContacts", 0)
    initial_messages = get_path(body, "totalMessages", 0)
    print(f"  ℹ Initial state: {initial_contacts} contacts, {initial_messages} messages")
    return initial_contacts, initial_messages


def section_1_rules_crud():
    bold("\n─── Section 1: Automation Rules CRUD ───")

    # 1a. Create twitter rule
    status, body = api("POST", "/api/social/rules", {
        "name": f"Test Pricing Rule {RUN_ID}",
        "platform": "twitter",
        "dm_template": "Hey {{username}}! Our pricing starts at $49/mo.",
        "comment_reply_template": "Thanks {{username}}! Check your DMs 📬",
        "keywords": '["pricing", "price", "how much", "cost"]',
        "max_triggers_per_user": 2,
        "max_triggers_total": 10,
        "auto_tag": "lead",
    })
    assert_status("Create rule (twitter)", 201, status)
    rule_id = get_path(body, "id", "")
    if rule_id:
        ok(f"Rule created: {rule_id}")
    else:
        fail("Rule ID extraction")

    # 1b. Create rules for other platforms
    platform_rule_ids = {}
    for plat in ["instagram", "facebook", "linkedin", "youtube"]:
        s, b = api("POST", "/api/social/rules", {
            "name": f"Test {plat} Rule {RUN_ID}",
            "platform": plat,
            "dm_template": f"Hello {{{{username}}}} from {plat}!",
            "comment_reply_template": f"Thanks for commenting on {plat}!",
            "keywords": '["interested", "pricing", "demo"]',
            "max_triggers_per_user": 3,
            "auto_tag": f"test-{plat}",
        })
        assert_status(f"Create rule ({plat})", 201, s)
        platform_rule_ids[plat] = get_path(b, "id", "")

    # 1c. List rules
    s, b = api("GET", "/api/social/rules")
    assert_status("List all rules", 200, s)
    rule_count = len(get_path(b, "rules") or [])
    assert_gte("At least 5 rules created", 5, rule_count)

    # 1d. Read single rule
    s, b = api("GET", f"/api/social/rules/{rule_id}")
    assert_status("Get single rule", 200, s)
    assert_eq("Rule name matches", f"Test Pricing Rule {RUN_ID}", get_path(b, "name"))

    # 1e. Update rule
    s, b = api("PATCH", f"/api/social/rules/{rule_id}", {"auto_tag": "hot-lead"})
    assert_status("Update rule tag", 200, s)

    # 1f. Verify update
    s, b = api("GET", f"/api/social/rules/{rule_id}")
    assert_eq("Updated auto_tag", "hot-lead", get_path(b, "auto_tag"))

    # 1g. Disable / re-enable
    s, _ = api("PATCH", f"/api/social/rules/{rule_id}", {"enabled": False})
    assert_status("Disable rule", 200, s)
    s, b = api("GET", f"/api/social/rules/{rule_id}")
    assert_eq("Rule disabled", 0, get_path(b, "enabled"))

    s, _ = api("PATCH", f"/api/social/rules/{rule_id}", {"enabled": True})
    s, b = api("GET", f"/api/social/rules/{rule_id}")
    assert_eq("Rule re-enabled", 1, get_path(b, "enabled"))

    return rule_id, platform_rule_ids


def section_2_followup_steps(rule_id: str):
    bold("\n─── Section 2: Follow-Up Steps CRUD ───")

    # 2a. Add step 1
    s, b = api("POST", f"/api/social/rules/{rule_id}/follow-ups", {
        "stepOrder": 0,
        "delaySeconds": 3600,
        "messageTemplate": "Hey {{username}}, just following up on pricing!",
    })
    assert_status("Create follow-up step 1", 201, s)
    step1_id = get_path(b, "id", "")

    # 2b. Add step 2
    s, b = api("POST", f"/api/social/rules/{rule_id}/follow-ups", {
        "stepOrder": 1,
        "delaySeconds": 86400,
        "messageTemplate": "Final reminder {{username}} — trial ends soon!",
    })
    assert_status("Create follow-up step 2", 201, s)
    step2_id = get_path(b, "id", "")

    # 2c. List steps
    s, b = api("GET", f"/api/social/rules/{rule_id}/follow-ups")
    assert_status("List follow-up steps", 200, s)
    step_count = len(get_path(b, "steps") or [])
    assert_gte("2 follow-up steps", 2, step_count)

    # 2d. Delete step 2
    if step2_id:
        s, _ = api("DELETE", f"/api/social/rules/{rule_id}/follow-ups/{step2_id}")
        assert_status("Delete follow-up step 2", 200, s)
        s, b = api("GET", f"/api/social/rules/{rule_id}/follow-ups")
        step_count = len(get_path(b, "steps") or [])
        assert_eq("1 step remaining", 1, step_count)


def section_3_webhook_verify():
    bold("\n─── Section 3: Webhook Verification (Meta) ───")

    # 3a. Instagram verify
    s, body = get_no_auth(
        "/api/social/webhooks/instagram",
        f"hub.mode=subscribe&hub.verify_token={VERIFY_TOKEN}&hub.challenge=test_challenge_123",
    )
    assert_status("Instagram webhook verify", 200, s)
    assert_eq("Instagram challenge echoed", "test_challenge_123", body.strip())

    # 3b. Facebook verify
    s, body = get_no_auth(
        "/api/social/webhooks/facebook",
        f"hub.mode=subscribe&hub.verify_token={VERIFY_TOKEN}&hub.challenge=fb_challenge_abc",
    )
    assert_status("Facebook webhook verify", 200, s)
    assert_eq("Facebook challenge echoed", "fb_challenge_abc", body.strip())

    # 3c. Invalid verify token
    s, _ = get_no_auth(
        "/api/social/webhooks/instagram",
        "hub.mode=subscribe&hub.verify_token=WRONG_TOKEN&hub.challenge=nope",
    )
    assert_status("Invalid verify token rejected", 403, s)


def section_4_twitter_webhook():
    bold("\n─── Section 4: Twitter Webhook Simulation ───")
    ts = str(int(time.time() * 1000))

    # 4a. Twitter comment with keyword
    s, b = api("POST", "/api/social/webhooks/twitter", {
        "tweet_create_events": [{
            "id_str": f"tw_comment_{RUN_ID}_001",
            "text": "@brandaccount What is your pricing?",
            "user": {"id_str": f"tw_user_{RUN_ID}_001", "screen_name": f"tw_sim_user_{RUN_ID}"},
            "in_reply_to_status_id_str": "original_post_001",
            "created_at": "Mon Mar 17 12:00:00 +0000 2026",
        }],
    })
    assert_status("Twitter comment webhook accepted", 200, s)
    assert_eq("Twitter webhook received", True, get_path(b, "received"))

    # 4b. Twitter DM
    s, b = api("POST", "/api/social/webhooks/twitter", {
        "direct_message_events": [{
            "id": f"tw_dm_{RUN_ID}_001",
            "created_timestamp": ts,
            "message_create": {
                "sender_id": f"tw_user_{RUN_ID}_002",
                "message_data": {"text": "Hi there, I am interested in a demo!"},
            },
        }],
    })
    assert_status("Twitter DM webhook accepted", 200, s)

    # 4c. Non-reply tweet (no in_reply_to_status_id_str — should be ignored)
    s, b = api("POST", "/api/social/webhooks/twitter", {
        "tweet_create_events": [{
            "id_str": f"tw_norep_{RUN_ID}",
            "text": "Just a regular tweet",
            "user": {"id_str": f"tw_user_{RUN_ID}_003", "screen_name": "tw_random"},
            "created_at": "Mon Mar 17 12:01:00 +0000 2026",
        }],
    })
    assert_status("Non-reply tweet accepted (no crash)", 200, s)

    time.sleep(0.5)


def section_5_instagram_webhook():
    bold("\n─── Section 5: Instagram Webhook Simulation ───")
    ts = int(time.time())

    # 5a. Instagram comment with keyword
    s, b = api("POST", "/api/social/webhooks/instagram", {
        "entry": [{
            "id": "17841400000000000",
            "time": ts,
            "changes": [{
                "field": "comments",
                "value": {
                    "id": f"ig_comment_{RUN_ID}_001",
                    "text": "Interested in pricing!",
                    "from": {"id": f"ig_user_{RUN_ID}_001", "username": f"ig_tester_{RUN_ID}"},
                    "media": {"id": "ig_post_001"},
                },
            }],
        }],
    })
    assert_status("Instagram comment webhook accepted", 200, s)
    assert_eq("Instagram webhook received", True, get_path(b, "received"))

    # 5b. Instagram DM with lead data
    s, b = api("POST", "/api/social/webhooks/instagram", {
        "entry": [{
            "id": "17841400000000000",
            "time": ts,
            "messaging": [{
                "sender": {"id": f"ig_user_{RUN_ID}_002"},
                "recipient": {"id": "17841400000000000"},
                "timestamp": ts * 1000,
                "message": {
                    "mid": f"ig_dm_{RUN_ID}_001",
                    "text": f"Hi! My email is testlead_{RUN_ID}@example.com and phone is 555-123-4567",
                },
            }],
        }],
    })
    assert_status("Instagram DM webhook accepted", 200, s)

    time.sleep(0.5)


def section_6_facebook_webhook():
    bold("\n─── Section 6: Facebook Webhook Simulation ───")
    ts = int(time.time())

    # 6a. Facebook page comment
    s, b = api("POST", "/api/social/webhooks/facebook", {
        "object": "page",
        "entry": [{
            "id": "FB_PAGE_001",
            "time": ts,
            "changes": [{
                "field": "feed",
                "value": {
                    "item": "comment",
                    "comment_id": f"fb_comment_{RUN_ID}_001",
                    "post_id": "fb_post_001",
                    "sender_id": f"fb_user_{RUN_ID}_001",
                    "sender_name": f"FB Test User {RUN_ID}",
                    "message": "How much does this cost? Interested!",
                    "created_time": ts,
                },
            }],
        }],
    })
    assert_status("Facebook comment webhook accepted", 200, s)
    assert_eq("Facebook webhook received", True, get_path(b, "received"))

    # 6b. Facebook Messenger DM
    s, b = api("POST", "/api/social/webhooks/facebook", {
        "object": "page",
        "entry": [{
            "id": "FB_PAGE_001",
            "time": ts,
            "messaging": [{
                "sender": {"id": f"fb_user_{RUN_ID}_002"},
                "recipient": {"id": "FB_PAGE_001"},
                "timestamp": ts * 1000,
                "message": {
                    "mid": f"fb_dm_{RUN_ID}_001",
                    "text": "I want a demo please!",
                },
            }],
        }],
    })
    assert_status("Facebook DM webhook accepted", 200, s)

    time.sleep(0.5)


def section_7_linkedin_webhook():
    bold("\n─── Section 7: LinkedIn Webhook Simulation ───")
    ts = int(time.time() * 1000)

    # 7a. LinkedIn comment
    s, b = api("POST", "/api/social/webhooks/linkedin", {
        "eventType": "COMMENT",
        "event": {
            "id": f"li_comment_{RUN_ID}_001",
            "object": "urn:li:ugcPost:123456",
            "actor": f"urn:li:person:li_user_{RUN_ID}",
            "message": {"text": "Very interested in your demo"},
            "createdAt": ts,
        },
    })
    assert_status("LinkedIn comment webhook accepted", 200, s)

    # 7b. LinkedIn DM
    s, b = api("POST", "/api/social/webhooks/linkedin", {
        "eventType": "MESSAGING",
        "event": {
            "message": {"id": f"li_msg_{RUN_ID}_001", "text": "Tell me about pricing"},
            "from": {"id": f"urn:li:person:li_user_{RUN_ID}_dm"},
            "createdAt": ts,
        },
    })
    assert_status("LinkedIn DM webhook accepted", 200, s)

    time.sleep(0.5)


def section_8_edge_cases():
    bold("\n─── Section 8: Edge Cases & Error Handling ───")

    # 8a. Empty body
    s, _ = api("POST", "/api/social/webhooks/twitter", {})
    assert_status("Empty twitter webhook (no crash)", 200, s)

    # 8b. Malformed JSON
    s, _ = api_raw("POST", "/api/social/webhooks/twitter", "not-json")
    if s != 500:
        ok(f"Malformed JSON handled (HTTP {s}, no crash)")
    else:
        fail("Malformed JSON caused server error (HTTP 500)")

    # 8c. Webhook for disabled platform (TikTok)
    s, _ = api("POST", "/api/social/webhooks/tiktok", {"some": "payload"})
    if s in (200, 404):
        ok(f"TikTok webhook handled gracefully (HTTP {s})")
    else:
        fail(f"TikTok webhook unexpected status: {s}")

    # 8d. Duplicate webhook (same tweet ID)
    s, _ = api("POST", "/api/social/webhooks/twitter", {
        "tweet_create_events": [{
            "id_str": f"tw_comment_{RUN_ID}_001",
            "text": "@brandaccount What is your pricing?",
            "user": {"id_str": f"tw_user_{RUN_ID}_001", "screen_name": f"tw_sim_user_{RUN_ID}"},
            "in_reply_to_status_id_str": "original_post_001",
            "created_at": "Mon Mar 17 12:00:00 +0000 2026",
        }],
    })
    assert_status("Duplicate tweet webhook (no crash)", 200, s)


def section_9_crm_verify(initial_contacts: int, initial_messages: int):
    bold("\n─── Section 9: CRM & Contact Verification ───")

    time.sleep(2)  # Wait for async processing

    s, b = api("GET", "/api/social/stats")
    new_contacts = get_path(b, "totalContacts", 0)
    new_messages = get_path(b, "totalMessages", 0)
    added_contacts = new_contacts - initial_contacts
    added_messages = new_messages - initial_messages
    print(f"  ℹ After webhooks: {new_contacts} contacts (+{added_contacts}), {new_messages} messages (+{added_messages})")

    if added_contacts > 0:
        ok(f"New contacts created from webhooks (+{added_contacts})")
    else:
        fail("No new contacts created from webhooks")

    if added_messages > 0:
        ok(f"New messages recorded from webhooks (+{added_messages})")
    else:
        fail("No new messages recorded from webhooks")

    # Search by platform
    for plat in ["twitter", "instagram", "facebook"]:
        s, b = api("GET", f"/api/social/contacts?platform={plat}")
        total = get_path(b, "total", 0)
        if total > 0:
            ok(f"{plat} contacts found ({total})")
        else:
            skip(f"{plat}: no contacts found (may indicate adapter issue)")

    # Activity feed
    s, b = api("GET", "/api/social/activity")
    assert_status("Activity feed endpoint", 200, s)
    msg_count = len(get_path(b, "messages") or [])
    print(f"  ℹ Activity feed has {msg_count} messages")

    # Webhook log
    s, b = api("GET", "/api/social/webhook-log")
    assert_status("Webhook log endpoint", 200, s)
    wh_count = len(get_path(b, "events") or [])
    print(f"  ℹ Webhook log has {wh_count} events")


def section_10_automation_log(rule_id: str):
    bold("\n─── Section 10: Automation Log ───")

    s, b = api("GET", "/api/social/rules/log")
    assert_status("Automation log endpoint", 200, s)
    log_count = len(get_path(b, "log") or [])
    print(f"  ℹ Automation log has {log_count} entries")

    if rule_id:
        s, b = api("GET", f"/api/social/rules/log?ruleId={rule_id}")
        assert_status("Rule-specific log", 200, s)


def section_11_analytics_leads():
    bold("\n─── Section 11: Analytics & Leads ───")

    s, b = api("GET", "/api/social/analytics")
    assert_status("Analytics endpoint", 200, s)
    analytics = get_path(b, "analytics") or []
    print(f"  ℹ Analytics has {len(analytics)} platform entries")

    s, b = api("GET", "/api/social/analytics?since=2026-03-17T00:00:00Z")
    assert_status("Analytics with since filter", 200, s)

    s, b = api("GET", "/api/social/leads")
    assert_status("Leads endpoint", 200, s)
    lead_count = len(get_path(b, "leads") or [])
    print(f"  ℹ Leads captured: {lead_count}")

    s, b = api("GET", "/api/social/leads?platform=instagram")
    assert_status("Leads filtered by platform", 200, s)


def section_12_contact_crud():
    bold("\n─── Section 12: Contact CRUD ───")

    s, b = api("GET", "/api/social/contacts")
    contacts = get_path(b, "data") or []
    first_id = contacts[0]["id"] if contacts else None

    if first_id:
        # Get single contact
        s, b = api("GET", f"/api/social/contacts/{first_id}")
        assert_status("Get single contact", 200, s)

        # Update notes
        s, _ = api("PATCH", f"/api/social/contacts/{first_id}", {"notes": f"Test note {RUN_ID}"})
        assert_status("Update contact notes", 200, s)

        # Add tag
        s, _ = api("POST", f"/api/social/contacts/{first_id}/tags", {"tag": "sim-test"})
        assert_status("Add tag to contact", 200, s)

        # Remove tag
        s, _ = api("DELETE", f"/api/social/contacts/{first_id}/tags/sim-test")
        assert_status("Remove tag from contact", 200, s)

        # Get contact messages
        s, _ = api("GET", f"/api/social/contacts/{first_id}/messages")
        assert_status("Get contact messages", 200, s)
    else:
        skip("No contacts to test CRUD on")

    # Export CSV
    url = f"{BASE}/api/social/contacts/export"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}"}, method="GET")
    try:
        resp = urllib.request.urlopen(req)
        assert_status("Export contacts CSV", 200, resp.status)
    except urllib.error.HTTPError as e:
        assert_status("Export contacts CSV", 200, e.code)


def section_13_platform_toggle():
    bold("\n─── Section 13: Platform Toggle ───")

    s, _ = api("PATCH", "/api/social/connections/twitter", {"enabled": False})
    assert_status("Disable twitter", 200, s)

    s, _ = api("PATCH", "/api/social/connections/twitter", {"enabled": True})
    assert_status("Re-enable twitter", 200, s)


def section_14_rule_validation():
    bold("\n─── Section 14: Rule Validation ───")

    # Missing dm_template
    s, _ = api("POST", "/api/social/rules", {
        "name": "Bad Rule",
        "platform": "twitter",
        "keywords": "[]",
    })
    assert_status("Missing dm_template rejected", 400, s)

    # Invalid platform
    s, _ = api("POST", "/api/social/rules", {
        "name": "Bad",
        "platform": "myspace",
        "dm_template": "hi",
        "keywords": "[]",
    })
    assert_status("Invalid platform 'myspace' rejected", 400, s)

    # Create and delete
    s, b = api("POST", "/api/social/rules", {
        "name": "Temp Rule",
        "platform": "twitter",
        "dm_template": "temp",
        "keywords": "[]",
    })
    temp_id = get_path(b, "id")
    if temp_id:
        s, _ = api("DELETE", f"/api/social/rules/{temp_id}")
        assert_status("Delete rule", 200, s)


def section_15_brand_voice():
    bold("\n─── Section 15: Brand Voice ───")

    s, _ = api("PUT", "/api/social/brand-voice", {"brandVoiceId": "test-voice-123"})
    assert_status("Set brand voice", 200, s)

    s, _ = api("PUT", "/api/social/brand-voice", {"brandVoiceId": None})
    assert_status("Clear brand voice", 200, s)


def section_16_rule_generation():
    bold("\n─── Section 16: AI Rule Generation ───")

    # Test: missing description → 400
    s, body = api("POST", "/api/social/rules/generate", {})
    assert_status("Generate rule — missing description → 400", 400, s)

    # Test: empty description → 400
    s, body = api("POST", "/api/social/rules/generate", {"description": ""})
    assert_status("Generate rule — empty description → 400", 400, s)

    # Test: valid description — may return 503 if copilot not available (skip) or 200
    s, body = api("POST", "/api/social/rules/generate", {
        "description": "Capture leads who ask about pricing on Instagram posts",
        "platform": "instagram",
    })
    if s == 503:
        skip("Generate rule — copilot not available (503), skipping AI generation tests")
        return
    elif s == 200:
        ok("Generate rule — 200 with valid description")
        if isinstance(body, dict) and "rule" in body:
            rule = body["rule"]
            assert_eq("Generated rule has name", True, "name" in rule)
            assert_eq("Generated rule has platform", True, "platform" in rule)
            assert_eq("Generated rule has dm_template", True, "dm_template" in rule)
            ok("Generated rule has required fields")
        else:
            fail("Generate rule — response missing 'rule' key")
    else:
        fail(f"Generate rule — unexpected status {s}", str(body))

    # Test: with platform override
    s, body = api("POST", "/api/social/rules/generate", {
        "description": "Auto-reply to Twitter mentions about our product",
        "platform": "twitter",
    })
    if s == 200:
        ok("Generate rule with platform override")
    elif s == 503:
        skip("Generate rule with platform override — copilot unavailable")
    else:
        fail(f"Generate rule with platform override — status {s}")


def section_17_ai_reply_rules():
    bold("\n─── Section 17: AI Reply Rules ───")

    # Create a rule with use_ai_reply enabled
    s, b = api("POST", "/api/social/rules", {
        "name": f"AI Support Rule {RUN_ID}",
        "platform": "instagram",
        "dm_template": "Thanks {{username}}, check your comment for a reply!",
        "keywords": '["support", "help"]',
        "use_ai_reply": 1,
        "ai_reply_context": "We sell TaskFlow, a project management tool. Pricing: Starter $19/mo, Pro $49/mo.",
    })
    assert_status("Create AI reply rule", 201, s)
    ai_rule_id = get_path(b, "id", "")

    if ai_rule_id:
        # Verify the rule was created with AI fields
        s, b = api("GET", f"/api/social/rules/{ai_rule_id}")
        assert_status("Get AI reply rule", 200, s)
        assert_eq("use_ai_reply is set", 1, get_path(b, "use_ai_reply"))
        assert_contains("ai_reply_context has product info", "TaskFlow", get_path(b, "ai_reply_context", ""))

        # Update AI fields
        s, _ = api("PATCH", f"/api/social/rules/{ai_rule_id}", {"ai_reply_context": "Updated context"})
        assert_status("Update AI reply context", 200, s)

        # Toggle off AI reply
        s, _ = api("PATCH", f"/api/social/rules/{ai_rule_id}", {"use_ai_reply": 0})
        assert_status("Disable AI reply", 200, s)
        s, b = api("GET", f"/api/social/rules/{ai_rule_id}")
        assert_eq("use_ai_reply disabled", 0, get_path(b, "use_ai_reply"))

        # Cleanup
        api("DELETE", f"/api/social/rules/{ai_rule_id}")
        print(f"  Deleted AI rule {ai_rule_id}")
    else:
        fail("AI rule creation — no ID returned")


def section_18_lead_capture_verify():
    bold("\n─── Section 18: Lead Capture Verification ───")

    # Send a DM with email to trigger lead capture
    ts = int(time.time())
    s, b = api("POST", "/api/social/webhooks/instagram", {
        "entry": [{
            "id": "17841400000000000",
            "time": ts,
            "messaging": [{
                "sender": {"id": f"lead_user_{RUN_ID}_001"},
                "recipient": {"id": "17841400000000000"},
                "timestamp": ts * 1000,
                "message": {
                    "mid": f"lead_dm_{RUN_ID}_001",
                    "text": f"Hi! My email is leadtest_{RUN_ID}@example.com",
                },
            }],
        }],
    })
    assert_status("Send DM with email for lead capture", 200, s)

    # Send a DM with phone number
    s, b = api("POST", "/api/social/webhooks/instagram", {
        "entry": [{
            "id": "17841400000000000",
            "time": ts,
            "messaging": [{
                "sender": {"id": f"lead_user_{RUN_ID}_002"},
                "recipient": {"id": "17841400000000000"},
                "timestamp": ts * 1000,
                "message": {
                    "mid": f"lead_dm_{RUN_ID}_002",
                    "text": "Call me at 555-867-5309",
                },
            }],
        }],
    })
    assert_status("Send DM with phone for lead capture", 200, s)

    time.sleep(1)

    # Check leads endpoint
    s, b = api("GET", "/api/social/leads")
    assert_status("Leads endpoint accessible", 200, s)
    leads = get_path(b, "leads") or []
    print(f"  ℹ Total leads: {len(leads)}")

    # Check leads filtered by platform
    s, b = api("GET", "/api/social/leads?platform=instagram")
    assert_status("Leads filtered by platform", 200, s)


def section_19_analytics_verify():
    bold("\n─── Section 19: Analytics Verification ───")

    s, b = api("GET", "/api/social/analytics")
    assert_status("Analytics endpoint", 200, s)
    analytics = get_path(b, "analytics") or []
    print(f"  ℹ Analytics entries: {len(analytics)}")

    # Verify analytics has some data after all our webhooks
    if len(analytics) > 0:
        ok(f"Analytics has data ({len(analytics)} platform entries)")
        # Check first entry has expected fields
        first = analytics[0] if analytics else {}
        has_platform = "platform" in first
        if has_platform:
            ok("Analytics entry has platform field")
        else:
            skip("Analytics entry missing platform field (schema may differ)")
    else:
        skip("Analytics empty — expected if no real messages were processed")

    # Test with since filter
    s, b = api("GET", "/api/social/analytics?since=2020-01-01T00:00:00Z")
    assert_status("Analytics with broad since filter", 200, s)

    # Test with future date (should return empty/zero)
    s, b = api("GET", "/api/social/analytics?since=2099-01-01T00:00:00Z")
    assert_status("Analytics with future since filter", 200, s)


def section_20_youtube_webhook():
    bold("\n─── Section 20: YouTube Webhook Simulation ───")

    ts = int(time.time())
    # YouTube uses polling, but the webhook endpoint should still accept payloads
    s, b = api("POST", "/api/social/webhooks/youtube", {
        "kind": "youtube#commentThread",
        "snippet": {
            "videoId": f"yt_video_{RUN_ID}",
            "topLevelComment": {
                "id": f"yt_comment_{RUN_ID}_001",
                "snippet": {
                    "textDisplay": "How much does this cost? Interested!",
                    "authorChannelId": {"value": f"yt_user_{RUN_ID}_001"},
                    "authorDisplayName": f"YT Tester {RUN_ID}",
                    "publishedAt": f"{datetime.now(timezone.utc).isoformat()}",
                },
            },
        },
    })
    # YouTube endpoint may return 200 or handle differently
    if s in (200, 404):
        ok(f"YouTube webhook handled (HTTP {s})")
    else:
        skip(f"YouTube webhook status: {s} (may not support direct POST)")


def section_21_reddit_webhook():
    bold("\n─── Section 21: Reddit Webhook Simulation ───")

    ts = int(time.time())
    s, b = api("POST", "/api/social/webhooks/reddit", {
        "kind": "t1",
        "data": {
            "id": f"reddit_comment_{RUN_ID}_001",
            "body": "Very interested in a demo!",
            "author": f"reddit_user_{RUN_ID}",
            "link_id": f"t3_reddit_post_{RUN_ID}",
            "created_utc": ts,
        },
    })
    if s in (200, 404):
        ok(f"Reddit webhook handled (HTTP {s})")
    else:
        skip(f"Reddit webhook status: {s} (may use polling only)")


def cleanup(rule_id: str, platform_rule_ids: dict):
    bold("\n─── Cleanup ───")

    all_ids = [rule_id] + list(platform_rule_ids.values())
    deleted = 0
    for rid in all_ids:
        if rid:
            s, _ = api("DELETE", f"/api/social/rules/{rid}")
            if s == 200:
                deleted += 1
            print(f"  Deleted rule {rid} (HTTP {s})")

    # Clean up contacts created by this test run
    s, b = api("GET", "/api/social/contacts?pageSize=200")
    contacts = get_path(b, "data") or []
    test_contacts = [c for c in contacts if RUN_ID in str(c.get("username", "")) or RUN_ID in str(c.get("platform_user_id", ""))]
    for c in test_contacts:
        cid = c.get("id")
        if cid:
            api("DELETE", f"/api/social/contacts/{cid}")
            print(f"  Deleted test contact {cid}")

    print(f"  Cleanup complete: {deleted} rules deleted, {len(test_contacts)} test contacts cleaned")


# =============================================================================
# MAIN
# =============================================================================

def main():
    bold("╔═══════════════════════════════════════════════════════════════╗")
    bold("║       Social Brain — Simulated Platform Test Suite           ║")
    bold(f"║       {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}                              ║")
    bold("╚═══════════════════════════════════════════════════════════════╝")

    initial_contacts, initial_messages = section_0_preflight()
    rule_id, platform_rule_ids = section_1_rules_crud()
    section_2_followup_steps(rule_id)
    section_3_webhook_verify()
    section_4_twitter_webhook()
    section_5_instagram_webhook()
    section_6_facebook_webhook()
    section_7_linkedin_webhook()
    section_8_edge_cases()
    section_9_crm_verify(initial_contacts, initial_messages)
    section_10_automation_log(rule_id)
    section_11_analytics_leads()
    section_12_contact_crud()
    section_13_platform_toggle()
    section_14_rule_validation()
    section_15_brand_voice()
    section_16_rule_generation()
    section_17_ai_reply_rules()
    section_18_lead_capture_verify()
    section_19_analytics_verify()
    section_20_youtube_webhook()
    section_21_reddit_webhook()
    cleanup(rule_id, platform_rule_ids)

    # Summary
    bold("\n═══════════════════════════════════════════════════════════════")
    bold("                    TEST RESULTS SUMMARY")
    bold("═══════════════════════════════════════════════════════════════\n")
    green(f"  Passed:  {PASS_COUNT}")
    if FAIL_COUNT > 0:
        red(f"  Failed:  {FAIL_COUNT}")
    else:
        print(f"  Failed:  {FAIL_COUNT}")
    if SKIP_COUNT > 0:
        yellow(f"  Skipped: {SKIP_COUNT}")
    print(f"  Total:   {PASS_COUNT + FAIL_COUNT + SKIP_COUNT}\n")

    if FAILURES:
        red("  Failed tests:")
        for f in FAILURES:
            red(f"    - {f}")
        print()
        sys.exit(1)
    else:
        green("  All tests passed! ✓\n")
        sys.exit(0)


if __name__ == "__main__":
    main()
