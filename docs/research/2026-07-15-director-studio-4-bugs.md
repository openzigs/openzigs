# Research: Director Studio — 4 Bug Fixes
**Date**: 2026-07-15  
**Sources**: Local codebase, YouTube Data API v3 docs, Remotion docs (Context7), YouTube MCP server  
**Used for**: Planning bug fix epic for Director Studio  

---

## Research Summary

### Sources Consulted
| Source | Type | Key Findings |
|--------|------|-------------|
| `src/video/youtube-publish-service.ts` | Local | Orchestrates YouTube uploads via MCP tools; NO caption upload logic exists |
| `src/video/youtube-publish-repository.ts` | Local | SQLite persistence for `youtube_publishes` table; no video-exists-check column |
| `src/video/subtitle-export.ts` | Local | Already generates SRT/VTT from manifest timeline — ready to feed into caption upload |
| `src/api/director.ts` | Local | YouTube publish endpoints, subtitle export endpoints, thumbnail Kontext calls |
| `src/remotion/components/image-overlay.tsx` | Local | **BUG**: Uses `objectFit: "fill"` — stretches images |
| `src/remotion/components/KenBurns.tsx` | Local | Correctly uses `objectFit: "cover"` (default) |
| `src/remotion/components/image-scene-segment.tsx` | Local | Wraps KenBurns — correct objectFit |
| `src/video/generators/image-gen-service.ts` | Local | `kontextEdit()` calls sync `/kontext` endpoint, reads binary PNG, 20min timeout |
| `sidecars/image-gen/server.py` | Local | `/kontext` returns binary PNG; `/kontext-async` posts callback with base64 |
| `src/channels/social/platform-api-client.ts` | Local | `fetchPostContext()` returns `null` for deleted videos (empty items array) |
| `external/youtube-mcp/src/youtube_mcp_server.py` | Local | 8 tools registered. NO `captions.insert` or caption-related tool exists |
| `external/youtube-mcp/src/youtube_client.py` | Local | Has `upload_video()` (resumable), `get_video_details()`. NO caption methods |
| `ui/components/director/studio/studio-toolbar.tsx` | Local | YouTube publish UI, subtitle export dropdown. No auto-caption-after-publish |
| `ui/components/director/studio/youtube-publish-history.tsx` | Local | Shows publish history with status badges. No video-exists check or republish |
| YouTube Data API v3 — Captions resource | Web | `captions.insert` requires `snippet.videoId`, `snippet.language`, `snippet.name`; `sync` param deprecated Mar 2024; supports SRT/VTT upload as media body |
| YouTube Data API v3 — Errors reference | Web | `videos.list` returns `notFound (404)` or empty items for deleted videos; `captions.insert` errors: `captionExists (409)`, `videoNotFound (404)`, `contentRequired (400)` |
| Remotion docs (Context7) | Docs | `<Img>` supports `objectFit` via `style` prop; built-in `delayRender`; standard CSS values (`cover`, `contain`, `fill`) |

---

## Bug #1: YouTube Data API — Caption/Subtitle Upload

### Functional Requirements
1. **FR-001**: After a successful YouTube video publish, auto-upload generated subtitles as a caption track *(Source: local analysis of publish workflow)*
2. **FR-002**: Support both SRT and VTT formats for caption upload *(Source: `subtitle-export.ts` already generates both)*
3. **FR-003**: The YouTube MCP server must expose a new `yt_upload_captions` tool *(Source: `youtube_mcp_server.py` — no caption tool exists)*
4. **FR-004**: The YouTube client must implement a `upload_captions()` method using `captions.insert` *(Source: `youtube_client.py` — no caption methods exist)*
5. **FR-005**: Handle `captionExists (409)` conflict gracefully — update existing track or skip *(Source: YouTube API errors docs)*

### Current Implementation
- **`subtitle-export.ts`**: `generateSubtitles(manifest, format)` → produces SRT or VTT string content. `extractSubtitleSegments(manifest)` pulls `scriptText` + timing from timeline scenes.
- **`studio-toolbar.tsx`**: Subtitle export dropdown downloads SRT/VTT to user's machine via API endpoint. No auto-upload.
- **`youtube-publish-service.ts`**: `publish()` method: (1) calls `youtube-upload-video` MCP tool, (2) parses `{success, data: {id, video_id, url}}` response, (3) calls `trySetThumbnail()`. Caption upload is completely absent.
- **YouTube MCP server** (`youtube_mcp_server.py`): Registers 8 tools. None involve captions. `YouTubeClient` class has no caption-related method.

### Root Cause
Caption upload was never implemented. The subtitle export system produces the content but only serves it for download. The YouTube MCP lacks a `captions.insert` tool entirely.

### API Contract for `captions.insert`
```
POST https://www.googleapis.com/upload/youtube/v3/captions
  ?uploadType=multipart
  &part=snippet

Multipart body:
  Part 1 (application/json): { "snippet": { "videoId": "...", "language": "en", "name": "English" } }
  Part 2 (application/octet-stream): SRT/VTT file content (Content-Type: text/plain or application/x-subrip)

Required OAuth scope: youtube.force-ssl
Quota cost: 400 units per insert
```

### Key Error Codes
| Code | Reason | Meaning |
|------|--------|---------|
| 409 | `captionExists` | Track with same language+name exists — must update or use different name |
| 400 | `contentRequired` | Missing caption file body |
| 400 | `invalidMetadata` | Bad `snippet.language`, `snippet.name`, or `snippet.videoId` |
| 404 | `videoNotFound` | Video ID doesn't exist |

### Recommended Fix Approach
1. Add `upload_captions(video_id, language, name, content, format)` → `YouTubeClient` in `youtube_client.py`
2. Add `yt_upload_captions` tool → `youtube_mcp_server.py`
3. After successful publish in `youtube-publish-service.ts`, generate SRT via `generateSubtitles(manifest, 'srt')`, then call new MCP tool `yt_upload_captions`
4. Catch 409 conflict → log warning, don't fail the publish
5. Emit Socket.IO progress event: "Uploading captions…"

---

## Bug #2: YouTube Data API — Video Status/Delete Detection

### Functional Requirements
1. **FR-006**: Before showing "Published" status in history, verify the video still exists on YouTube *(Source: `youtube-publish-history.tsx` — no existence check)*
2. **FR-007**: Detect deleted/removed videos and update local status to `"deleted"` or `"unavailable"` *(Source: `youtube-publish-repository.ts` — no such status value)*
3. **FR-008**: Allow republishing a draft whose previous video was deleted *(Source: `studio-toolbar.tsx` — no republish capability)*

### Current Implementation
- **`platform-api-client.ts`** (`YouTubeApiClient.fetchPostContext()`): Calls `videos?part=snippet,statistics&id={postId}`. Returns `null` when `json.items?.[0]?.snippet` is missing — this naturally handles deleted videos (empty items array).
- **`youtube-publish-repository.ts`**: Schema has `status` enum: `uploading | published | failed | scheduled`. No `deleted` or `unavailable` status.
- **`youtube-publish-history.tsx`**: Polls while `uploading` (5s interval). Shows status badge. Never re-checks a `published` video's existence.
- **YouTube MCP tools**: `yt_get_video_details` calls `videos.list` with `part=snippet,statistics,contentDetails` — returns full resource if video exists, or `{ items: [] }` if deleted.

### Root Cause
No post-publish validation exists. Once a video transitions to `"published"`, the system never checks YouTube again. The `yt_get_video_details` tool can detect deletions (empty `items` array), but nobody calls it after initial publish.

### YouTube API Behavior for Deleted Videos
- `videos.list` with a deleted video ID returns: `{ "kind": "youtube#videoListResponse", "items": [] }` — HTTP 200 with empty items.
- It does NOT return 404 for a standard list call — it simply omits the video from results.
- The API errors page confirms `notFound (404)` for `videos.list` is only for truly invalid requests, not for individual missing videos in a batch list.

### Recommended Fix Approach
1. Add `deleted` status to `youtube_publishes` schema (ALTER TABLE migration)
2. Add `checkVideoExists(videoId)` method → `YouTubePublishService` that calls `yt_get_video_details` and checks for empty items
3. On `GET /youtube/publish/:draftId/status`, check video existence if status is `published` and last check was >1h ago (avoid quota burn)
4. In `youtube-publish-history.tsx`, show `"Deleted on YouTube"` badge with option to republish
5. Add `republish()` method or allow `publish()` when previous status is `deleted`

---

## Bug #3: Remotion — Image Sizing and Object-Fit

### Functional Requirements
1. **FR-009**: User-uploaded images must maintain aspect ratio when displayed as overlays *(Source: `image-overlay.tsx` — uses `objectFit: "fill"` which stretches)*
2. **FR-010**: Image overlay behavior should match Ken Burns component default (`objectFit: "cover"`) *(Source: `KenBurns.tsx` — uses "cover")*

### Current Implementation
- **`image-overlay.tsx`**: 
  ```tsx
  // Line ~45: Image rendering
  style={{ width: "100%", height: "100%", objectFit: "fill" }}
  ```
  Uses `objectFit: "fill"` on both `<Img>` and `<OffthreadVideo>` elements. This stretches content to fill the frame, distorting aspect ratio.

- **`KenBurns.tsx`**: Uses `objectFit` prop with default `"cover"` — correctly crops to fill frame while preserving aspect ratio.

- **`image-scene-segment.tsx`**: Wraps `<KenBurns>` which defaults to `"cover"` — correct.

- **`video-clip-segment.tsx`**: Mixed usage — `"cover"` (lines 150, 179) and `"contain"` (line 166). Context-dependent.

### Root Cause
`image-overlay.tsx` explicitly uses `objectFit: "fill"` which is the CSS value that stretches both axes independently, ignoring aspect ratio. This is almost certainly a bug — `"fill"` is rarely desired for media content.

### Remotion `<Img>` Component Docs (Context7)
- `<Img>` wraps standard HTML `<img>` with automatic `delayRender` (waits for image load before rendering).
- `objectFit` is applied via the `style` prop: `<Img style={{ objectFit: "cover" }} />`
- Standard CSS values apply: `"cover"` (crop to fill), `"contain"` (fit within, may letterbox), `"fill"` (stretch, distort), `"none"` (original size).
- No special behavior between preview and render — sizing is consistent.

### Recommended Fix Approach
1. Change `objectFit: "fill"` → `objectFit: "cover"` in `image-overlay.tsx` for all media elements (images and videos)
2. Consider making `objectFit` a prop with default `"cover"` for consistency with KenBurns
3. Single-line fix per element — low risk

---

## Bug #4: Kontext Image Generation — Response Handling

### Functional Requirements
1. **FR-011**: Kontext edit responses must be reliably parsed in both sync and async code paths *(Source: `image-gen-service.ts`, `server.py`)*
2. **FR-012**: Timeout handling must not leave zombie jobs or unfinished states *(Source: 20-min timeout in ImageGenService)*
3. **FR-013**: Error responses from the sidecar must surface meaningful messages to the UI *(Source: `thumbnail-panel.tsx` catches errors with toast)*

### Current Implementation

#### Sync Path (`kontextEdit()` in `image-gen-service.ts`)
1. Reads image from disk → base64 encodes
2. POSTs JSON to `/kontext` endpoint on sidecar
3. Reads response as `Buffer.from(await response.arrayBuffer())` — expects binary PNG
4. Saves to disk via `saveImage(resultBuffer, "kontext")`
5. 20-minute `AbortSignal.timeout(this.config.localTimeoutMs)`
6. Error path: if `!response.ok`, reads response text and throws

#### Sync Sidecar Endpoint (`/kontext` in `server.py`)
1. Receives JSON: `{ prompt, image (base64), width, height, steps, guidance, seed }`
2. Loads flux-kontext model (first call loads to GPU — can take minutes)
3. Runs generation → returns `Response(content=png_bytes, media_type="image/png")`
4. On error: returns JSON `{ "detail": "..." }` with 4xx/5xx status

#### Async Path (`/kontext-async` in `server.py`)
1. Receives same JSON + `callback_url`
2. Returns 202 immediately with `{ "job_id": "..." }`
3. Background task runs `_run_kontext_task()`:
   - On success: POSTs `{ job_id, status: "completed", media_base64: "...", media_type, metadata }` to callback URL
   - On failure: POSTs `{ job_id, status: "failed", error: "..." }` to callback URL
4. Also stores result in job store for `GET /job-result/{job_id}` polling (one-time retrieval, deleted after fetch)

#### Callers
- **Thumbnail generation** (`director.ts` lines 2830-2930): `imageService.kontextEdit(frame.path, enhancePrompt, {width:1280, height:720, steps:20, guidance:2.5})` with try/catch fallback to original image
- **Hero reel** (`director.ts` lines 1694-1704): `imageService.kontextEdit(userImg.path, ...)` with try/catch fallback
- **Queue Master** (`queue-master.ts` line 718): Dispatches to `/kontext-async` endpoint for background queue jobs

### Root Cause Analysis
The sync path is straightforward — binary PNG response is read correctly. Potential issues:
1. **Model cold-start**: First kontext call loads model to GPU (can take 2-5 min). The 20-min timeout accommodates this, but the UI shows generic "Editing..." with no progress indication.
2. **No retry logic**: If the sidecar returns a transient error (OOM, model load failure), there's no retry.
3. **Error response ambiguity**: When sidecar returns an error, `response.text()` might return JSON (`{"detail":"..."}`) or plain text. The `kontextEdit()` method throws the raw text without parsing.
4. **Async callback failures**: If `_run_kontext_task()` can't POST to the callback URL, the job result is only available via `GET /job-result/{job_id}` (one-time retrieval). If the poller misses it, the job is lost.
5. **Width/height in result**: `kontextEdit()` returns `width: options?.width ?? 0, height: options?.height ?? 0` — if options omit dimensions, the result reports 0×0 even though the image has actual dimensions.

### Recommended Fix Approach
1. Parse error responses: try JSON parse first for `detail` field, fall back to raw text
2. Add optional retry with exponential backoff (1 retry after 5s for transient errors: 503, connection refused)
3. Fix width/height in result: read actual image dimensions from the PNG buffer header (first 24 bytes) or use the sidecar's dimensions
4. For the async path: ensure callback retry (server.py `_run_kontext_task` should retry POST to callback 2-3 times)
5. Surface better progress to UI: emit intermediate Socket.IO events ("Loading model...", "Generating...")

---

## Data Model Insights

### `youtube_publishes` Table (SQLite)
```sql
CREATE TABLE youtube_publishes (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  video_id TEXT,           -- YouTube video ID after upload
  video_url TEXT,
  title TEXT,
  privacy_status TEXT,
  published_at TEXT,
  status TEXT DEFAULT 'uploading',  -- uploading | published | failed | scheduled
  error_message TEXT,
  created_at TEXT,
  updated_at TEXT
);
```
**Needed changes**: Add `deleted` to status enum, add `last_checked_at TEXT` column for video existence polling throttle.

### `captions.insert` Resource Shape
```json
{
  "kind": "youtube#caption",
  "id": "string",
  "snippet": {
    "videoId": "string",
    "language": "string",    // BCP-47 tag, e.g. "en"
    "name": "string",        // Display name, max 150 chars
    "trackKind": "standard", // ASR | forced | standard
    "isDraft": false,
    "status": "serving"      // serving | syncing | failed
  }
}
```

## Integration Points
- **YouTube MCP server** (`external/youtube-mcp/`): Needs new `yt_upload_captions` tool + `YouTubeClient.upload_captions()` method
- **YouTube publish flow**: `youtube-publish-service.ts` → MCP tool calls → YouTube Data API v3
- **Subtitle export**: `subtitle-export.ts` already produces content; needs wiring into publish flow
- **FluxQ sidecar**: Image generation via HTTP (sync/async). Auth via Bearer token.
- **Socket.IO**: Real-time progress events (`publish-progress`, `thumbnail-progress`)

## User Roles & Permissions
- YouTube OAuth required for: `videos.insert`, `captions.insert`, `thumbnails.set` (all write operations)
- Required OAuth scopes: `youtube.upload`, `youtube.force-ssl` (for captions)
- Quota: `captions.insert` costs 400 units/call; `videos.list` costs 1 unit/call

## Technology Recommendations
- For caption upload: use multipart upload (not resumable) — caption files are small (< 1MB)
- For video existence check: use `videos.list` with just `part=id` to minimize quota (1 unit)
- For image objectFit: use `"cover"` as the default across all media overlay components for consistency
- For Kontext error handling: parse JSON error responses and surface the `detail` field

## Open Questions
1. Should caption upload be opt-in (user toggle) or automatic after every publish?
2. What language should the default caption track use? System locale? Always "en"? User-configurable?
3. Should video existence checks run on a schedule (Sentinel cron) or only on-demand when viewing history?
4. For the Kontext async path — is the one-time job result retrieval pattern intentional, or should it persist longer?

## Constraints & Assumptions
- YouTube API daily quota is 10,000 units by default. Each caption upload costs 400 units. Plan for quota awareness.
- The `sync` parameter for `captions.insert` was deprecated March 2024. Subtitle timing must be accurate in the SRT/VTT file.
- Remotion `<Img>` objectFit behavior is consistent between preview and render — no separate handling needed.
- The FluxQ sidecar runs on Apple Silicon (MPS) with MFLUX. GPU memory constraints may cause OOM on concurrent Kontext calls.

## Security Considerations
- YouTube OAuth tokens must be stored securely (already at `~/.openzigs/auth.json` with restricted perms)
- Caption content is generated from user-authored script text — sanitize for any injection risks before upload
- FluxQ Bearer token auth for network mode — already implemented but ensure tokens aren't logged
