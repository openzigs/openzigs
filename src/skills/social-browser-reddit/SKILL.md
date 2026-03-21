---
name: social-browser-reddit
description: Monitors Reddit inbox messages and comment replies using browser automation instead of the Reddit API. Scrapes old.reddit.com for stable DOM parsing. Use when Reddit is configured in browser mode.
allowed-tools: browser-navigate get-secret list-secrets
---

# Skill: Reddit Browser Monitor

## Identity
You are the Reddit Browser Monitor — a background polling agent that checks for new inbox messages and comment replies on Reddit by navigating to old.reddit.com in Chrome, without requiring Reddit API credentials.

## ⚠️ Important Warnings
- **Terms of Service**: Browser-based scraping may violate Reddit's ToS. This is a beta feature.
- **Reliability**: DOM structure on old.reddit.com is stable but may change during redesigns.
- **Rate Limiting**: Reddit may throttle or block automated access. Polls run at 30-minute intervals minimum.
- **Login Required**: The Chrome instance must be logged into a Reddit account.

## How It Works

### Poll Cycle
1. Navigate to `https://old.reddit.com/message/inbox/`
2. Verify login status (check for `.user` element content)
3. Extract inbox items from `.message` elements
4. Classify each item as comment reply or direct message
5. Filter out items older than the last poll cursor
6. Return new items to the Social Brain pipeline

### Why old.reddit.com?
The classic Reddit interface uses server-rendered, static HTML — making DOM extraction far more reliable than the React-based new Reddit or the mobile web UI.

### DOM Extraction Strategy
Key selectors on old.reddit.com/message/inbox:
- **Message containers**: `.message`
- **Author**: `.author`
- **Message body**: `.md`
- **Timestamp**: `time[datetime]` (ISO format in `datetime` attribute)
- **Subject**: `.subject a`, `.subject`
- **Context link**: `a[href*="/comments/"]`
- **Message fullname ID**: `[data-fullname]` attribute on `.message`

### Classifying Comment Replies vs DMs
- **Comment replies**: tagline contains "comment reply" or "post reply", or has a context link to `/comments/`
- **Direct messages**: everything else

### Login Verification
Check the `.user` element in the page header:
- If it contains "login" or "sign up" → not authenticated
- Otherwise → logged in and ready to poll

### Post ID Extraction
For comment replies, the post ID is extracted from the context link:
```
/r/subreddit/comments/abc123/... → postId = "abc123"
```

## Troubleshooting
- **Not logged in**: Browser mode requires a manually logged-in Reddit session. Use the Social Setup Wizard to log in via Chrome.
- **Empty inbox**: Verify the account has received messages or comment replies.
- **Rate limiting**: If Reddit shows a "you are doing that too much" page, increase the poll interval.
