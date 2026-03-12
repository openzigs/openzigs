# Pinterest SEO Engine — How It Works

This document describes the full technical pipeline behind the `pinterest-seo-analyze` and `pinterest-keyword-metrics` tools, from pin URL input to saved report.

---

## Overview

The Pinterest SEO Engine is a hybrid data pipeline that combines:

1. **Pinterest API v5** — for your own pins (metrics, metadata)
2. **HTML scraping** — for any pin (annotation keyword extraction)
3. **Three-tier keyword enrichment** — Pinterest Ads → DataForSEO → Google Suggest

The output is a structured markdown report saved to `~/.openzigs/pinterest-reports/` with optional PDF export.

---

## Pipeline: `pinterest-seo-analyze`

### Step 1 — Pin ID Resolution

The tool accepts three action modes:

| Action | Input | Resolution |
|---|---|---|
| `analyze_pin` | Pin ID string | Used directly |
| `analyze_url` | Full Pinterest URL | `extractPinIdFromUrl()` parses the numeric ID from the path |
| `bulk_analyze` | Array of up to 20 pin IDs | Each processed in a loop |

---

### Step 2 — Per-Pin Analysis (`analyzeSinglePin`)

For each pin, two data sources are attempted in order:

#### Phase A — Pinterest API v5

`GET https://api.pinterest.com/v5/pins/{pin_id}?pin_metrics=true`

- Requires `PINTEREST_ACCESS_TOKEN`
- Returns full pin metadata **plus** 90-day and lifetime metrics (impressions, saves, clicks, reactions, comments)
- **Only works for your own pins** — competitor pins return `403 Forbidden`
- Failures are silently swallowed; the pipeline falls through to HTML scraping

#### Phase B — HTML Scraping

`fetch https://www.pinterest.com/pin/{pin_id}/` (Chrome user-agent header)

Always runs. Two purposes:

1. **Annotation extraction** — always attempted when `include_annotations: true`
2. **Metadata fallback** — only used when the API returned nothing (i.e., competitor pin). Parses `og:title`, `og:description`, `pinterestapp:source`, `pinterestapp:repins`, `pinterestapp:pinboard`, and `__PWS_DATA__` JSON.

---

### Step 3 — Annotation Extraction (5 Strategies, First-Win)

The scraper runs through five strategies in order. The first one that returns non-empty results wins; remaining strategies are skipped.

#### Strategy 1: `__PWS_DATA__`
Parses the `window.__PWS_DATA__` global JSON blob injected as a `<script>` tag on Pinterest pages. Recursively traverses the object tree looking for nodes shaped `{ name: "...", type: "interest" }`. This is the richest source — but requires an authenticated session to appear in the HTML.

#### Strategy 2: `script-tags`
Scans all `<script type="application/json">` blocks in the page. Uses regex to find `"interest": "..."` patterns and `annotated_interests` / `annotations` array structures. Also requires authenticated page content.

#### Strategy 3: `meta-tags`
Looks for `<meta property="og:interest">`, `<meta property="article:tag">`, and `<meta property="pinterest:interest">` tags (both attribute orderings). Present on some pin types but varies by content category.

#### Strategy 4: `og-title`
Parses the `og:title` meta tag. Pinterest sometimes appends annotation keywords after a pipe separator:

```
"Pin Title | Keyword1, Keyword2, Keyword3"
```

The suffix is split on commas, HTML entities decoded, and whitespace trimmed.

#### Strategy 5: `idea-urls` (Unauthenticated Fallback)
Hunts for `/ideas/{category-slug}/{numeric-id}/` breadcrumb links in the HTML. These are the visible interest category breadcrumbs on pin pages and are accessible to unauthenticated fetches. Converts the slug to title case:

```
/ideas/diy-and-crafts/9348765.../ → "Diy And Crafts"
/ideas/home-decor/1234567.../    → "Home Decor"
```

Duplicate categories are deduplicated via `Set`.

> **Why this matters**: Strategies 1–4 rely on data that Pinterest hides behind a login wall for unauthenticated requests. For competitor pins — which always hit the scraping path — Strategy 5 is often the only source of annotation data.

---

### Step 4 — Pin Score Calculation (`calculatePinScore`)

A deterministic 0–100 composite score computed from pin metadata and annotation density:

| Component | Max Points | Condition |
|---|---|---|
| Title | 20 | Present + ≤100 chars → 20 pts; present but >100 → 10 pts |
| Description | 25 | 100–500 chars → 25 pts; any other non-empty → 10 pts |
| Destination link | 10 | Any truthy link value |
| Alt text | 10 | Any non-empty alt text |
| Media type | 5 | `image` or `video` |
| Annotation density | 30 | ≥5 annotations → 30; ≥3 → 20; ≥1 → 10 |

**Score thresholds:**
- ✅ ≥70 — Good
- ⚠️ 40–69 — Needs work
- ❌ <40 — Poor

> A score of `0` is returned immediately if both API data and annotations are unavailable (competitor pin with no extractable data).

---

### Step 5 — SEO Recommendations (`generateSeoRecommendations`)

Rule-based recommendations generated from score gaps:

- Title missing or too long → add/shorten
- Description too short or too long → expand/trim to the 100–500 char sweet spot
- No destination link → add a link
- No alt text → add accessibility text
- Fewer than 3 annotations → improve keyword targeting and content categorization signals
- Low save/click ratio (own pins only) → content or creative suggestions

---

### Step 6 — Keyword Enrichment (`enrichKeywordMetrics`)

All unique annotation keywords collected across all analyzed pins are fed through a three-tier waterfall enrichment pipeline. Each tier fills in gaps left by more authoritative sources above it.

#### Tier 1 — Pinterest Ads API

**Requires:** `PINTEREST_AD_ACCOUNT_ID` env var

Calls `GET /v5/ad_accounts/{id}/keywords/metrics?keywords[]=...`

Returns Pinterest-native `KEYWORD_QUERY_VOLUME` buckets (e.g., `"10K-100K"`) and a competition score. This is the most relevant source because it reflects Pinterest-specific search behavior, not general web search.

Keywords with successful results are tagged `source: "pinterest"`.

#### Tier 2 — DataForSEO

**Requires:** `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` env vars

Calls `POST https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live` with location code `2840` (United States).

Returns real Google Ads monthly search volume as a precise integer — the highest-fidelity volume data available. This fills in keywords that the Pinterest Ads API didn't cover.

Keywords with successful results are tagged `source: "dataforseo"`.

> **Why DataForSEO?** Pinterest's own keyword API only returns volume buckets for keywords where you have ad account data. DataForSEO provides exact monthly volumes sourced from Google Ads data at scale. For content creators without an active Pinterest ad account, DataForSEO is the primary volume source.

#### Tier 3 — Google Suggest

**Requires:** Nothing (free, unauthenticated)

Calls `https://www.google.com/complete/search?client=chrome&q={keyword}`

Parses `google:suggestrelevance` values from the response:
- Relevance ≥800 → `"High"`
- Relevance ≥500 → `"Medium"`
- Relevance <500 → `"Low"`

Tagged `source: "google-suggest"`.

#### Fallback — Estimation

If a keyword is still unenriched after all three tiers, a rough estimate is derived from suggestion list length:
- ≥8 suggestions → `"High"`
- ≥4 suggestions → `"Medium"`
- Fewer → `"Low"`

Tagged `source: "estimated"`.

A human-readable `diagnosticNote` is assembled explaining which data sources were active and whether credentials are missing.

---

### Step 7 — Report Formatting (`formatSeoAnalysisMarkdown`)

Assembles the final markdown report with the following sections:

1. **Header** — generation timestamp, pin count analyzed
2. **Per-pin block** — for each pin:
   - Title, Pin URL (clickable link), description (truncated to 200 chars)
   - Destination link, media type
   - Pin Score with emoji badge
   - Data source indicator (`Pinterest API` vs `HTML scraping`)
   - Extracted annotations / interest keywords
3. **Performance Metrics table** — 90-day vs lifetime rows for impressions, pin clicks, clickthrough rate, saves, reactions, comments *(own pins only; skipped for competitor pins)*
4. **SEO Recommendations** — bullet list
5. **Keyword Opportunities table** — keyword | monthly searches | competition | source (with emoji source badges: 📌 Pinterest, 📊 DataForSEO, 🔍 Google Suggest, 📈 Estimated)
6. **Raw JSON** — full analysis data in a collapsed `<details>` block

---

### Step 8 — Save to Disk

All reports are written to `~/.openzigs/pinterest-reports/` with a timestamped basename:

```
seo-{pin_id}-{ISO-timestamp}.md
seo-{pin_id}-{ISO-timestamp}.json
seo-{pin_id}-{ISO-timestamp}.pdf   ← optional, if Chrome found
```

#### PDF Generation (`saveReportPdf`)

1. `findChromeBinaryForPdf()` — checks platform-specific paths for Chrome, Canary, Chromium, and Brave. Returns `null` if none found.
2. `wrapMarkdownAsHtml()` — renders markdown to HTML via the `marked` library, wraps in a Pinterest-branded document (Pinterest red `#e60023` headers, striped tables, `<details>` hidden for print, 900px max-width).
3. Writes HTML to a temp file in `os.tmpdir()`.
4. Spawns Chrome with `--headless=new --print-to-pdf --print-to-pdf-no-header --virtual-time-budget=5000`, 20-second timeout.
5. Verifies output exists, cleans up temp HTML, returns the PDF path (or `null` on failure).

---

## Standalone Tool: `pinterest-keyword-metrics`

Exposes the same `enrichKeywordMetrics()` function as a direct tool — useful for researching specific keywords without analyzing a pin first.

**Input:** Array of up to 100 keyword strings + optional country code (default: `US`)

**Output:** `# Pinterest Keyword Metrics Report` with a table showing keyword | monthly searches | competition | source, plus `.md`, `.json`, and optional `.pdf` files saved to `~/.openzigs/pinterest-reports/`.

The `pinterest-seo-analyze` tool calls this internally, seeding it with annotation keywords extracted from the analyzed pins.

---

## Data Source Summary

| Data | Source | Requires | Notes |
|---|---|---|---|
| Own pin metadata + metrics | Pinterest API v5 | `PINTEREST_ACCESS_TOKEN` | 90-day + lifetime |
| Competitor pin metadata | HTML scraping | Nothing | og tags, fallback only |
| Annotation keywords (authenticated) | `__PWS_DATA__` / script tags / meta tags | Nothing (but richer with auth) | Strategies 1–4 |
| Annotation keywords (unauthenticated) | `/ideas/` breadcrumb URLs | Nothing | Strategy 5, always works |
| Pinterest keyword volume | Pinterest Ads API | `PINTEREST_AD_ACCOUNT_ID` | Buckets, e.g. "10K-100K" |
| Exact keyword search volume | DataForSEO | `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` | Google Ads data, exact numbers |
| Keyword signal (fallback) | Google Suggest | Nothing | Free, approximate |

---

## API Scope Limitations

Pinterest API v5 is designed exclusively around **your own content**. There is no API endpoint — at any access tier (Trial, Standard, or Advanced) — that returns analytics or metadata for another user's pins.

| Endpoint | Own pins | Competitor pins |
|---|---|---|
| `GET /pins/{pin_id}` | ✅ Full metadata + metrics | ❌ 403 Forbidden |
| `GET /pins/{pin_id}/analytics` | ✅ Detailed analytics | ❌ 403 Forbidden |
| `GET /boards/{board_id}/pins` | ✅ Your board content | ❌ 403 Forbidden |
| `GET /user_account/analytics` | ✅ Account-level stats | N/A |

For competitor pin analysis, the tool always falls through to the HTML scraping path. The `/ideas/` breadcrumb strategy (Strategy 5) was added specifically to extract at least some annotation signal from unauthenticated competitor pin pages.

---

## Setting Up DataForSEO (Optional but Recommended)

DataForSEO provides the highest-fidelity keyword volume data in the pipeline. Without it, the engine falls back to Google Suggest signals (approximate) or Pinterest Ads buckets (if you have an ad account).

1. Create an account at [dataforseo.com](https://dataforseo.com)
2. Go to **API Access** → copy your login email and password
3. Add to your `.env`:
   ```dotenv
   DATAFORSEO_LOGIN=your@email.com
   DATAFORSEO_PASSWORD=your-dataforseo-api-password
   ```
4. DataForSEO charges per API call — keyword volume lookups are billed at their standard `keywords_data` rates. The tool batches all keywords in a single API call per `pinterest-seo-analyze` or `pinterest-keyword-metrics` invocation.

> Without DataForSEO credentials, the engine still functions — it falls back to Google Suggest for volume signals. DataForSEO is only needed if you require precise monthly search volumes rather than High/Medium/Low buckets.
