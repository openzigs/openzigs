# Outbox vs Scheduler: Architecture Guide

## Current System Overview

OpenZigs has **two independent scheduling-adjacent systems** that handle different use cases but share common infrastructure (TaskEngine + background tasks).

### 1. Scheduler (`src/productivity/scheduler.ts`)

**Purpose**: General-purpose cron job system for recurring AI tasks.

| Feature | Details |
|---------|---------|
| **Storage** | SQLite `scheduled_jobs` table |
| **Trigger** | Cron expressions (e.g., `0 9 * * 1-5` = weekdays at 9 AM) |
| **Action Types** | `prompt` (AI chat), `shell` (CLI command), `custom`, `outbox` |
| **Execution** | Submits to TaskEngine as background tasks |
| **UI** | `/scheduler` page — create/edit/toggle/delete jobs |
| **Examples** | "Summarize my inbox every morning", "Run code review daily", "Post to Twitter every Monday" |

### 2. Outbox (`src/outbox/`)

**Purpose**: Social media publishing queue — schedule and review posts before they go live.

| Feature | Details |
|---------|---------|
| **Storage** | SQLite `outbox_queue` table |
| **Trigger** | `OutboxPoller` cron (every 2 min) claims items past `scheduled_time` |
| **Content** | Platform-specific posts (text, images, URLs, attachments) |
| **Execution** | Submits to TaskEngine → `universal-publisher` skill |
| **UI** | `/outbox` page — queue, preview, publish now, retry |
| **Status Machine** | `pending → processing → published/failed` (+ `canceled`) |

## How They Relate

```
┌──────────────┐      ┌──────────────┐
│   Scheduler  │      │    Outbox     │
│  (cron jobs) │      │ (post queue)  │
└──────┬───────┘      └──────┬────────┘
       │                     │
       │  submit()           │  submit()
       ▼                     ▼
  ┌─────────────────────────────┐
  │         TaskEngine          │
  │   (background task runner)  │
  └─────────────┬───────────────┘
                │
                ▼
  ┌─────────────────────────────┐
  │     TaskWorker + Copilot    │
  │  (AI executes the task)     │
  └─────────────────────────────┘
```

**They do NOT overlap** — they serve distinct purposes:
- **Scheduler** = recurring automation ("do X every day at 9 AM")
- **Outbox** = content pipeline ("publish this tweet at 3 PM today")

## When to Use Which

| Scenario | System |
|----------|--------|
| "Post this tweet at 3 PM" | **Outbox** |
| "Every Monday, write a LinkedIn post about our blog" | **Scheduler** (prompt job that creates an outbox item) |
| "Publish this image to Pinterest right now" | **Outbox** (Publish Now) |
| "Run security audit every night" | **Scheduler** |
| "Queue 5 tweets for the week" | **Outbox** (5 items, different scheduled_times) |
| "Every day, find trending topics and draft tweets" | **Scheduler** → Outbox pipeline |

## The Recurring Content Gap

There's currently a **gap** for the "recurring social post" use case:

> "Post a motivational quote to Twitter every Monday at 9 AM"

This requires **both systems working together**:

1. **Scheduler**: A cron job that fires every Monday at 9 AM
2. **Job execution**: The AI generates fresh content
3. **Outbox**: The generated content lands in the outbox for optional review, then gets published

### Current Workaround

Create a Scheduler job with a prompt like:
> "Generate a motivational quote and post it to Twitter. Use the social-post tool."

This works but **bypasses the outbox entirely** — the AI posts directly, with no review step, no outbox history, and no retry/failure tracking.

### Scheduler → Outbox Bridge (Implemented)

The scheduler supports an `"outbox"` action type that creates outbox items instead of running arbitrary prompts:

```typescript
actionType: "outbox"

// actionPayload for "outbox" type:
{
  platforms: ["twitter", "linkedin"],
  contentTemplate: "{{day_of_week}} motivation: stay curious!",
  reviewRequired: false,  // true = stays canceled until reviewed, false = auto-publish
  assetUrl: "https://example.com/banner.jpg",  // optional
  assetType: "image",  // optional
  title: "Weekly Motivation",  // optional
  platformMetadata: {},  // optional
}
```

**Template variables**: `{{today}}`, `{{now}}`, `{{day_of_week}}`, `{{month}}`, `{{year}}` — automatically interpolated at execution time.

**AI-generated content** (`generationPrompt`): Instead of a static template, provide a `generationPrompt` field and the scheduler will delegate to TaskEngine for AI content generation:

```typescript
{
  platforms: ["twitter", "linkedin"],
  generationPrompt: "Write a post about the latest AI trends for {{today}}",
  reviewRequired: true,
}
```

When `generationPrompt` is set and TaskEngine is available, the scheduler submits an AI task that generates content and creates outbox items. If TaskEngine is not available, it falls back to static `contentTemplate` insertion.

**Flow**: Scheduler fires → (AI generates content OR uses template) → Creates outbox items → If `reviewRequired: true`, items stay in canceled state for human review.

## Architecture Principles

1. **Outbox is the publishing ledger**: ALL social posts should flow through the outbox, even automated ones. This gives you a unified audit trail, retry logic, and status tracking.

2. **Scheduler is the cron engine**: It answers "when should things happen?" It should never directly call platform APIs.

3. **TaskEngine is the executor**: Both systems submit tasks here. The task engine provides queuing, concurrency limits, and worker management.

4. **Publish Now is for one-offs**: Skip the scheduling delay, create + immediately publish. The item still appears in the outbox for tracking.

## Resolved Gaps

| Gap | Status | Implementation |
|-----|--------|----------------|
| Scheduler → Outbox bridge (`"outbox"` action type) | ✅ Done | `actionType: "outbox"` with `contentTemplate` + variable interpolation |
| Outbox item edit (change content/time after queuing) | ✅ Done | `PATCH /api/admin/outbox/:id` — edits pending/canceled items. UI edit modal in `/outbox` page |
| Batch scheduling (queue N posts at once) | ✅ Done | `POST /api/admin/outbox/batch` — create up to 50 items in one call |
| Recurring template posts (same format, fresh content) | ✅ Done | `generationPrompt` field in outbox scheduler payload delegates to TaskEngine for AI content |
| Cross-platform campaign (same content → multiple platforms) | ✅ Done | Add-to-outbox modal creates N items. Scheduler `platforms` array creates items per platform |
