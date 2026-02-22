# Epic: Director Mode Studio & Advanced Compositing

> **Status**: Planning  
> **Author**: Principal Full-Stack Engineer  
> **Last Updated**: 2025-07-24  
> **Depends On**: Existing Director Mode infrastructure (`src/video/`, `src/remotion/`, `src/api/director.ts`, `ui/components/director/`)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [Sub-Issue 1: Timeline Studio UI](#sub-issue-1-timeline-studio-ui)
4. [Sub-Issue 2: Bring Your Own Assets (BYOA)](#sub-issue-2-bring-your-own-assets-byoa)
5. [Sub-Issue 3: Intro/Outro Cards](#sub-issue-3-introoutro-cards)
6. [Sub-Issue 4: PowerPoint-Style Text Overlays](#sub-issue-4-powerpoint-style-text-overlays)
7. [Sub-Issue 5: Flux img2img Enhancement Pipeline](#sub-issue-5-flux-img2img-enhancement-pipeline)
8. [Sub-Issue 6: Blog-to-YouTube Pipeline](#sub-issue-6-blog-to-youtube-pipeline)
9. [Sub-Issue 7: Script Pacing & TTS Bracket Syntax](#sub-issue-7-script-pacing--tts-bracket-syntax)
10. [Cross-Cutting Concerns](#cross-cutting-concerns)
11. [File Change Manifest](#file-change-manifest)
12. [Dependency Graph](#dependency-graph)

---

## Executive Summary

This epic extends OpenZigs Director Mode from a linear production wizard into an interactive **Studio** with a multi-track timeline editor, real-time preview via `@remotion/player`, per-scene regeneration, and advanced compositing features including text overlays, img2img enhancement, blog-to-video conversion, and TTS pacing control.

### Architectural Directives

| Directive | Rationale |
|-----------|-----------|
| **Text overlays are React components in Remotion, NOT baked into Flux images** | Flux is strictly for pixel/aesthetic generation (txt2img, img2img). Text rendering must be crisp, editable, and resolution-independent — only React/CSS can guarantee that. |
| **TTS pacing uses `[PAUSE: Xs]` bracket syntax, NOT SSML angle brackets** | `ScriptSanitizer` (`src/video/producer/script-sanitizer.ts`) strips all HTML/XML tags via `/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>/g`. Any `<break>` tags would be destroyed. Bracket syntax survives sanitization and is translated to engine-specific SSML/padding in VoiceService *after* sanitization. |
| **Drafts are the central persistence unit** | The Wizard produces a `DirectorManifest` draft; the Studio edits it; "Render Final" consumes it. All state flows through the manifest. |

---

## Architecture Overview

### Current Flow (Pre-Epic)

```
[Director Wizard] → POST /produce → [ProducerService] → [DirectorManifest] → POST /render → [RenderOrchestrator] → MP4
     (6 steps)          (one-shot)       (no persistence)      (ephemeral)         (fire & forget)
```

### Target Flow (Post-Epic)

```
[Director Wizard] ──→ POST /drafts ──→ [Draft DB] ──→ redirect /director/studio/[id]
                                            │
                      ┌─────────────────────┘
                      ▼
              [Studio Timeline UI]
              ├── @remotion/player preview (real-time)
              ├── Multi-track timeline (scenes, audio, overlays)
              ├── Inspector panel (per-scene edit)
              │   ├── Regenerate image (Flux txt2img)
              │   ├── Enhance image (Flux img2img) ← NEW
              │   ├── Edit text overlays ← NEW
              │   ├── Edit voiceover script + pacing tags ← NEW
              │   └── Swap intro/outro cards ← NEW
              ├── Script editor (split-view or tab)
              └── "Render Final" → POST /render
                                            │
              [Blog Import] ──→ POST /blog-to-video ──→ [Draft DB] ──→ redirect /director/studio/[id]
```

### Draft Persistence Model

Drafts are stored in SQLite (`~/.openzigs/openzigs.db`) in a new `director_drafts` table:

```sql
CREATE TABLE IF NOT EXISTS director_drafts (
  id TEXT PRIMARY KEY,          -- nanoid
  title TEXT NOT NULL,
  manifest TEXT NOT NULL,       -- JSON-serialized DirectorManifest
  thumbnail TEXT,               -- base64 or file path to first scene image
  production_mode TEXT NOT NULL, -- 'highlight' | 'script' | 'presentation' | 'blog'
  created_at TEXT NOT NULL,     -- ISO 8601
  updated_at TEXT NOT NULL,     -- ISO 8601
  status TEXT NOT NULL DEFAULT 'draft' -- 'draft' | 'rendering' | 'complete'
);
```

---

## Sub-Issue 1: Timeline Studio UI

### Goal

Build an interactive timeline editor at `/director/studio/[id]` that loads a draft manifest, provides real-time `@remotion/player` preview, multi-track timeline visualization, and a per-scene inspector panel with regeneration capabilities.

### UI Layout

```
┌──────────────────────────────────────────────────────────┐
│  Toolbar: [← Back] [Save Draft] [Undo/Redo] [Render]    │
├──────────────────────────────────────────────────────────┤
│                                                          │
│   ┌──────────────────────────┐  ┌──────────────────────┐ │
│   │                          │  │   Inspector Panel     │ │
│   │   @remotion/player       │  │                       │ │
│   │   (real-time preview)    │  │  Scene: 3 of 8        │ │
│   │                          │  │  [Image Preview]      │ │
│   │   ▶ Play  ⏸ Pause       │  │  Duration: 5.2s       │ │
│   │   00:12 / 01:45          │  │                       │ │
│   └──────────────────────────┘  │  Voiceover:           │ │
│                                 │  [editable textarea]  │ │
│                                 │                       │ │
│                                 │  Image Prompt:        │ │
│                                 │  [editable textarea]  │ │
│                                 │                       │ │
│                                 │  [🔄 Regenerate]      │ │
│                                 │  [✨ Enhance (img2img)]│ │
│                                 │  [📝 Text Overlays]   │ │
│                                 └──────────────────────┘ │
├──────────────────────────────────────────────────────────┤
│  Timeline Tracks                                         │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ Scenes:  [S1][S2][S3▮][S4][S5][S6][S7][S8]         │ │
│  │ Audio:   [═══════ background music ═══════════]     │ │
│  │ Voice:   [v1][v2][v3▮][v4][v5][v6][v7][v8]         │ │
│  │ Overlay: [  logo  ][    lower third    ][caption]   │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### Implementation Details

#### New Files

| File | Purpose |
|------|---------|
| `ui/app/director/studio/[id]/page.tsx` | Next.js App Router page, loads draft by ID |
| `ui/components/director/studio/studio-layout.tsx` | Top-level studio layout component |
| `ui/components/director/studio/timeline-tracks.tsx` | Multi-track timeline with scene blocks |
| `ui/components/director/studio/scene-inspector.tsx` | Right-side inspector for selected scene |
| `ui/components/director/studio/player-preview.tsx` | `@remotion/player` wrapper with transport controls |
| `ui/components/director/studio/studio-toolbar.tsx` | Save, undo/redo, render actions |

#### Modified Files

| File | Changes |
|------|---------|
| `ui/components/director/types.ts` | Add `StudioState`, `TimelineTrack`, `InspectorState` types |
| `ui/components/director/director-wizard.tsx` | After production, redirect to `/director/studio/[draftId]` instead of showing inline result |
| `src/api/director.ts` | Add draft CRUD routes: `POST /drafts`, `GET /drafts`, `GET /drafts/:id`, `PUT /drafts/:id`, `DELETE /drafts/:id` |

#### @remotion/player Integration

The Player component requires:
```tsx
import { Player } from '@remotion/player';

<Player
  component={TemplateComposition}
  inputProps={adaptedProps}        // CompositionInputProps from adapter.ts
  durationInFrames={totalFrames}
  compositionWidth={manifest.composition.width}
  compositionHeight={manifest.composition.height}
  fps={manifest.composition.fps}
  controls                         // built-in transport controls
  loop={false}
  style={{ width: '100%' }}
/>
```

The Player ref API supports:
- `playerRef.current.play()` / `.pause()` / `.seekTo(frame)`
- `playerRef.current.addEventListener('framechange', callback)` for timeline sync

#### Per-Scene Regeneration Flow

1. User selects scene in timeline → Inspector loads scene data
2. User edits image prompt text → clicks "Regenerate"
3. Frontend `POST /api/admin/director/scenes/:sceneIndex/regenerate` with `{ draftId, newPrompt }`
4. Backend calls `ImageGenService.generateImage(newPrompt, options)`
5. Response includes new image path → backend updates draft manifest → pushes update via Socket.IO
6. Player re-renders with new props

#### Draft API Routes

```
POST   /api/admin/director/drafts           → Create draft (returns { id })
GET    /api/admin/director/drafts           → List all drafts
GET    /api/admin/director/drafts/:id       → Get single draft manifest
PUT    /api/admin/director/drafts/:id       → Update draft manifest
DELETE /api/admin/director/drafts/:id       → Delete draft
POST   /api/admin/director/drafts/:id/render → Submit draft for final render
```

---

## Sub-Issue 2: Bring Your Own Assets (BYOA)

### Goal

Allow users to upload their own video clips and images during the wizard or studio phase. Uploaded videos are routed through the existing ingestion pipeline (`src/video/ingestion/`) for ffmpeg keyframe extraction + Copilot Vision analysis + Whisper transcription. Users can choose to bypass AI image generation entirely for scenes using their own assets.

### Implementation Details

#### New Upload Flow

1. **Wizard Step (Visual Assets)**: Already exists in `visual-assets-step.tsx` — extend to support video uploads (currently only images)
2. **Studio Inspector**: Add "Replace with Upload" button per scene
3. **Backend Processing**:
   - Uploaded videos → `POST /api/admin/director/assets/upload` (existing route)
   - Backend routes video through `src/video/ingestion/` pipeline:
     - `audioExtractor` → extract audio track
     - `keyframeAnalyzer` → ffmpeg keyframe extraction + Copilot Vision descriptions
     - `transcriber` → Whisper transcription
   - Returns `ClipAnalysis` with keyframes, transcript segments, visual descriptions
4. **Manifest Integration**:
   - `video_clip` timeline entries reference user-uploaded files directly
   - `image_scene` entries can reference user-uploaded images with `src` pointing to local file

#### Modified Files

| File | Changes |
|------|---------|
| `ui/components/director/visual-assets-step.tsx` | Accept video file uploads (`.mp4`, `.mov`, `.webm`), show ingestion progress |
| `src/api/director.ts` | Add `POST /assets/ingest` route that runs uploaded video through ingestion pipeline |
| `src/video/ingestion/types.ts` | No changes needed — `IngestionInput` already supports file paths |
| `src/video/generators/storyboard-engine.ts` | When `assetsOnlyMode: true`, use user assets directly without generating image prompts |

#### User-Uploaded Asset Schema

Uploaded assets are tracked in the manifest's `metadata.userAssets` array (new field):

```typescript
interface UserAsset {
  id: string;                    // nanoid
  filename: string;              // original filename
  path: string;                  // server-side path
  type: 'video' | 'image';
  analysis?: ClipAnalysis;       // populated after ingestion
  description?: string;          // user-provided or Vision-extracted
}
```

---

## Sub-Issue 3: Intro/Outro Cards

### Goal

Add dedicated intro and outro card support to the `DirectorManifest` schema and Remotion composition. These are distinct from regular `title_card` entries — they have specific positioning (always first/last), support user-uploaded backgrounds, and optionally allow Flux img2img enhancement of uploaded images.

### Schema Changes

#### `src/video/manifest/manifest-types.ts`

```typescript
// New timeline entry types
interface IntroCardEntry {
  type: 'intro_card';
  title: string;                   // main heading (e.g., channel name)
  subtitle?: string;               // tagline or video title
  backgroundSrc?: string;          // user-uploaded image path
  enhancedBackgroundSrc?: string;  // Flux img2img enhanced version
  logoSrc?: string;                // channel logo overlay
  duration: number;                // frames
  animation?: 'fade-in' | 'slide-up' | 'scale-in' | 'typewriter';
}

interface OutroCardEntry {
  type: 'outro_card';
  title: string;                   // e.g., "Thanks for watching!"
  subtitle?: string;               // e.g., "Subscribe & hit the bell"
  backgroundSrc?: string;
  enhancedBackgroundSrc?: string;
  logoSrc?: string;
  ctaText?: string;                // call-to-action text
  duration: number;                // frames
  animation?: 'fade-out' | 'slide-down' | 'scale-out';
}
```

#### `TimelineEntry` Union Update

```typescript
type TimelineEntry =
  | VideoClipEntry
  | OverlayEntry
  | TitleCardEntry
  | TransitionEntry
  | ImageSceneEntry
  | IntroCardEntry    // NEW
  | OutroCardEntry;   // NEW
```

### Remotion Components

#### New: `src/remotion/components/intro-card.tsx`

React component rendering intro card with:
- Full-bleed background image (user-uploaded or Flux-generated)
- Animated title text (spring-based entrance animation)
- Optional subtitle with staggered delay
- Logo overlay in corner position
- All text rendered as React elements — NOT baked into images

#### New: `src/remotion/components/outro-card.tsx`

Similar to intro but with exit animations and CTA text.

#### Animation Implementation

Using Remotion's `spring()` and `interpolate()`:

```tsx
const frame = useCurrentFrame();
const { fps } = useVideoConfig();

const titleOpacity = spring({ frame, fps, config: { damping: 200 } });
const titleY = interpolate(titleOpacity, [0, 1], [50, 0]);

return (
  <AbsoluteFill>
    <Img src={backgroundSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    <div style={{ transform: `translateY(${titleY}px)`, opacity: titleOpacity }}>
      <h1>{title}</h1>
    </div>
  </AbsoluteFill>
);
```

### Modified Files

| File | Changes |
|------|---------|
| `src/video/manifest/manifest-types.ts` | Add `IntroCardEntry`, `OutroCardEntry` to `TimelineEntry` union |
| `src/video/manifest/manifest-schema.ts` | Add Zod schemas for `IntroCardEntrySchema`, `OutroCardEntrySchema` |
| `src/remotion/input-props.ts` | Add `IntroCardProps`, `OutroCardProps` to `TimelineItemSchema` |
| `src/remotion/adapter.ts` | Handle `intro_card` and `outro_card` in `adaptManifest()` |
| `src/remotion/compositions/template-composition.tsx` | Add `renderSegment()` cases for `intro_card` and `outro_card` |
| `src/remotion/components/index.ts` | Export new `IntroCard`, `OutroCard` components |

### Studio UI Integration

- Inspector panel gets "Intro/Outro" tab when first/last scene selected
- Upload zones for background image and logo
- "Enhance via Flux" toggle that sends uploaded background through img2img pipeline (Sub-Issue 5)
- Text fields for title, subtitle, CTA

---

## Sub-Issue 4: PowerPoint-Style Text Overlays

### Goal

Add text overlay slides that render key statements, bullet points, or data callouts as React components within the Remotion pipeline. These are **NOT** baked into Flux-generated images — they are pure React/CSS overlays rendered at composition resolution for crisp, editable text.

### Critical Constraint

> **Flux is strictly for pixel/aesthetic generation.** Text overlays MUST be React components rendered in the Remotion pipeline. This ensures:
> 1. Text is resolution-independent and crisp at any output size
> 2. Text is editable without re-running diffusion
> 3. Font consistency across scenes
> 4. Accessibility (screen readers can parse rendered text)

### Schema Changes

#### New Type: `TextOverlay`

```typescript
interface TextOverlay {
  id: string;
  text: string;                           // main text content
  position: 'center' | 'bottom-third' | 'top-third' | 'custom';
  customPosition?: { x: number; y: number }; // percentage-based
  fontSize?: number;                      // px, default 48
  fontWeight?: 'normal' | 'bold';
  fontFamily?: string;                    // default: system sans-serif
  color?: string;                         // hex, default '#FFFFFF'
  backgroundColor?: string;              // hex with alpha, e.g., '#00000080'
  borderRadius?: number;                  // px
  padding?: number;                       // px
  animation?: 'fade-in' | 'slide-up' | 'typewriter' | 'none';
  startFrame: number;                     // relative to scene start
  durationFrames: number;                 // how long overlay appears
}
```

#### Extension to Existing Entries

Add `textOverlays?: TextOverlay[]` to `ImageSceneEntry` and `VideoClipEntry`:

```typescript
interface ImageSceneEntry {
  type: 'image_scene';
  src: string;
  startAtFrame: number;
  duration: number;
  voiceover?: string;
  scriptText?: string;
  kenBurns?: KenBurnsConfig;
  textOverlays?: TextOverlay[];  // NEW
}
```

### Remotion Component

#### New: `src/remotion/components/text-overlay-layer.tsx`

```tsx
// Renders all text overlays for a scene, each with independent animation timing
const TextOverlayLayer: React.FC<{ overlays: TextOverlay[]; sceneStartFrame: number }> = ({
  overlays,
  sceneStartFrame,
}) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {overlays.map((overlay) => {
        const localFrame = frame - sceneStartFrame - overlay.startFrame;
        if (localFrame < 0 || localFrame >= overlay.durationFrames) return null;

        const opacity = getAnimationOpacity(overlay.animation, localFrame, overlay.durationFrames);
        const transform = getAnimationTransform(overlay.animation, localFrame);

        return (
          <div key={overlay.id} style={getPositionStyle(overlay.position, overlay.customPosition)}>
            <div style={{
              opacity,
              transform,
              fontSize: overlay.fontSize ?? 48,
              fontWeight: overlay.fontWeight ?? 'bold',
              color: overlay.color ?? '#FFFFFF',
              backgroundColor: overlay.backgroundColor ?? '#00000080',
              borderRadius: overlay.borderRadius ?? 8,
              padding: overlay.padding ?? 16,
            }}>
              {overlay.text}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
```

### LLM Integration

When the StoryboardEngine generates scenes for presentation mode, the LLM prompt is extended to extract **key statements** from the narration text:

```
For each scene, also extract 1-2 key statements or data points that should appear
as text overlays on screen. Return them in the scene's textOverlays array.
Focus on: statistics, quotes, key terms, or critical takeaways.
```

### Modified Files

| File | Changes |
|------|---------|
| `src/video/manifest/manifest-types.ts` | Add `TextOverlay` interface, add `textOverlays?: TextOverlay[]` to `ImageSceneEntry` and `VideoClipEntry` |
| `src/video/manifest/manifest-schema.ts` | Add `TextOverlaySchema`, extend `ImageSceneEntrySchema` and `VideoClipEntrySchema` |
| `src/remotion/input-props.ts` | Add `TextOverlayPropsSchema`, extend scene props |
| `src/remotion/adapter.ts` | Pass `textOverlays` through to Remotion props |
| `src/remotion/compositions/template-composition.tsx` | Render `TextOverlayLayer` within each scene segment |
| `src/remotion/components/index.ts` | Export `TextOverlayLayer` |
| `src/video/generators/storyboard-engine.ts` | Extend LLM prompt to extract key statements as text overlays |

### Studio UI Integration

- Inspector "Text Overlays" tab per scene
- Add/edit/delete overlays with inline text editor
- Position picker (center, bottom-third, top-third, custom drag)
- Color picker for text and background
- Animation selector dropdown
- Real-time preview via `@remotion/player`

---

## Sub-Issue 5: Flux img2img Enhancement Pipeline

### Goal

Add image-to-image capability to the Python image generation sidecar and expose it through `ImageGenService`. This enables "Enhance via Flux" actions where a user-uploaded image (e.g., a blog hero image, intro background, or screenshot) is aesthetically enhanced while preserving its structure.

### Python Sidecar Changes

#### New Endpoint: `POST /img2img`

**File**: `sidecars/image-gen/server.py`

```python
class Img2ImgRequest(BaseModel):
    prompt: str
    image: str              # base64-encoded PNG/JPEG
    strength: float = 0.6   # 0.0 = no change, 1.0 = ignore source entirely
    model: str = "flux"
    num_inference_steps: int = 4
    guidance_scale: float = 0.0  # 0 for schnell
    width: Optional[int] = None
    height: Optional[int] = None

@app.post("/img2img")
async def img2img(req: Img2ImgRequest, ...):
    # 1. Decode base64 image to PIL.Image
    # 2. Load appropriate img2img pipeline:
    #    - "flux" → FluxImg2ImgPipeline (from diffusers, already in requirements)
    #    - "sdxl-turbo" → StableDiffusionXLImg2ImgPipeline
    # 3. Run pipeline(prompt=req.prompt, image=pil_image, strength=req.strength, ...)
    # 4. Return base64-encoded result
```

**Key Implementation Notes**:
- `diffusers==0.32.2` (already in `requirements.txt`) includes `FluxImg2ImgPipeline` and `StableDiffusionXLImg2ImgPipeline` — **no new Python dependencies needed**
- Pipeline loading reuses the existing lazy-load + quantization pattern from `load_pipeline()`
- For FLUX.1-schnell: `guidance_scale=0.0`, `num_inference_steps=4`, `strength=0.6-0.95`
- For SDXL-turbo: `guidance_scale=0.0`, `num_inference_steps=4`, `strength=0.5-0.8`
- Images are resized to model-compatible dimensions before processing (multiple of 8)

#### Pipeline Registry Extension

```python
MODEL_REGISTRY = {
    "flux": {
        "txt2img": {"cls": "FluxPipeline", "model_id": "black-forest-labs/FLUX.1-schnell"},
        "img2img": {"cls": "FluxImg2ImgPipeline", "model_id": "black-forest-labs/FLUX.1-schnell"},
    },
    "sdxl-turbo": {
        "txt2img": {"cls": "StableDiffusionXLPipeline", "model_id": "stabilityai/sdxl-turbo"},
        "img2img": {"cls": "StableDiffusionXLImg2ImgPipeline", "model_id": "stabilityai/sdxl-turbo"},
    },
}
```

### TypeScript Service Changes

#### `src/video/generators/image-gen-service.ts`

Add new method:

```typescript
async enhanceImage(
  imagePath: string,
  prompt: string,
  options?: { strength?: number; model?: string }
): Promise<ImageGenResult> {
  // 1. Read image file → base64
  // 2. POST to sidecar /img2img endpoint
  // 3. Decode response → save to output dir
  // 4. Return ImageGenResult with new file path
}
```

### API Route

**File**: `src/api/director.ts`

```
POST /api/admin/director/enhance
Body: { draftId, sceneIndex, prompt, strength }
Response: { enhancedImagePath, sceneIndex }
```

### Modified Files

| File | Changes |
|------|---------|
| `sidecars/image-gen/server.py` | Add `Img2ImgRequest` model, `POST /img2img` endpoint, img2img pipeline loading |
| `src/video/generators/image-gen-service.ts` | Add `enhanceImage()` method |
| `src/api/director.ts` | Add `POST /enhance` route |

---

## Sub-Issue 6: Blog-to-YouTube Pipeline

### Goal

Convert a blog post URL into a draft video manifest. The pipeline fetches the article, extracts text + images, rewrites the content as narration-optimized script, generates scenes, and creates a draft that opens in the Studio for editing.

### Pipeline Flow

```
┌──────────────────┐
│  User pastes URL │
└────────┬─────────┘
         ▼
┌──────────────────────────────────────┐
│  1. Fetch & Parse                     │
│  - HTTP GET article URL               │
│  - Extract: <article> or <main> text  │
│  - Extract: og:image, <img> tags      │
│  - Extract: <title>, meta description │
│  - Strip HTML → clean Markdown        │
└────────┬─────────────────────────────┘
         ▼
┌──────────────────────────────────────┐
│  2. Content Rewrite (LLM)            │
│  - Rewrite article → narration script │
│  - Conversational, YouTube-friendly   │
│  - Insert [PAUSE: Xs] pacing tags     │
│  - Per-section structure preserved    │
└────────┬─────────────────────────────┘
         ▼
┌──────────────────────────────────────┐
│  3. Storyboard Generation            │
│  - StoryboardEngine.generate(script)  │
│  - Each section → scene               │
│  - Blog images as visualAssets option  │
│  - LLM generates image prompts        │
│  - LLM extracts text overlay content  │
└────────┬─────────────────────────────┘
         ▼
┌──────────────────────────────────────┐
│  4. Image Generation                  │
│  - Flux txt2img for new scenes        │
│  - Optionally Flux img2img to enhance │
│    blog hero images                   │
│  - Download & cache blog <img> assets │
└────────┬─────────────────────────────┘
         ▼
┌──────────────────────────────────────┐
│  5. Voiceover Generation              │
│  - ScriptSanitizer → clean text       │
│  - translatePacingTags() → SSML       │
│  - VoiceService.synthesize() per scene│
└────────┬─────────────────────────────┘
         ▼
┌──────────────────────────────────────┐
│  6. Draft Assembly                    │
│  - Assemble DirectorManifest          │
│  - Save to director_drafts table      │
│  - Return draft ID                    │
└────────┬─────────────────────────────┘
         ▼
┌──────────────────────────────────────┐
│  7. Redirect to Studio               │
│  - /director/studio/[draftId]         │
│  - User edits, previews, renders     │
└──────────────────────────────────────┘
```

### Article Extraction

Use the `fetch_webpage`-style approach but server-side:

```typescript
// src/video/blog/blog-extractor.ts
interface BlogContent {
  title: string;
  description: string;
  author?: string;
  publishDate?: string;
  bodyMarkdown: string;         // cleaned article text
  heroImageUrl?: string;         // og:image
  inlineImages: Array<{          // <img> tags from article body
    src: string;
    alt: string;
    position: number;            // character offset in body
  }>;
}

async function extractBlogContent(url: string): Promise<BlogContent>
```

**Security**: URL validation against SSRF — only allow `http://` and `https://` schemes, reject private IP ranges, enforce timeout.

### LLM Rewrite Prompt

```
You are a YouTube video scriptwriter. Rewrite the following blog article as a
narration script for a 3-5 minute video. Rules:
1. Use conversational, engaging tone appropriate for YouTube
2. Preserve the core information and structure
3. Break into clear sections (each becomes a video scene)
4. Add pacing tags: [PAUSE: 1s] for brief pauses, [PAUSE: 2s] for section breaks
5. Add emphasis markers: *important term* for words the narrator should emphasize
6. Start with a hook, end with a summary/CTA
7. Target ~150 words per minute of narration
```

### API Route

```
POST /api/admin/director/blog-to-video
Body: {
  url: string,                    // blog post URL
  options?: {
    enhanceBlogImages?: boolean,  // run blog images through Flux img2img
    voiceId?: string,             // TTS voice selection
    templateId?: TemplateId,      // visual template
    targetDuration?: number,      // seconds
  }
}
Response: { draftId: string }
```

### New Files

| File | Purpose |
|------|---------|
| `src/video/blog/blog-extractor.ts` | Fetch URL, parse HTML, extract text + images |
| `src/video/blog/blog-to-video-service.ts` | Orchestrates the full pipeline: extract → rewrite → storyboard → images → voiceover → draft |

### Modified Files

| File | Changes |
|------|---------|
| `src/api/director.ts` | Add `POST /blog-to-video` route |
| `src/video/generators/storyboard-engine.ts` | Minor: accept `blogImages` option to reference extracted images as `visualAssets` |

### UI Integration

- New "Import Blog" button on Director page
- Simple modal: paste URL, select options (voice, template, enhance images toggle)
- Progress bar showing pipeline stages
- On completion → redirect to Studio

---

## Sub-Issue 7: Script Pacing & TTS Bracket Syntax

### Goal

Implement a custom bracket syntax for TTS pacing control that survives the ScriptSanitizer and is translated to engine-specific SSML or silence padding after sanitization.

### The Problem

The `ScriptSanitizer` (`src/video/producer/script-sanitizer.ts`) applies this regex:

```typescript
const HTML_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>/g;
```

This strips ALL HTML/XML tags including SSML `<break time="2s"/>`. Any SSML tags in the narration script would be destroyed before reaching the TTS engine.

### The Solution: Bracket Syntax

Scripts use a square-bracket syntax that is invisible to the HTML tag regex:

| Bracket Tag | Meaning | SSML Equivalent |
|-------------|---------|-----------------|
| `[PAUSE: 0.5s]` | Half-second pause | `<break time="500ms"/>` |
| `[PAUSE: 1s]` | One-second pause | `<break time="1000ms"/>` |
| `[PAUSE: 2s]` | Two-second pause | `<break time="2000ms"/>` |
| `*emphasis*` | Emphasize word | `<emphasis level="strong">emphasis</emphasis>` |

### Data Flow

```
User/LLM writes script  →  ScriptSanitizer  →  translatePacingTags()  →  TTS Engine
with [PAUSE: 2s] tags      (preserves [...])     (converts to SSML)        (speaks with pauses)
```

### Implementation

#### New: `src/voice/pacing-translator.ts`

```typescript
interface PacingTranslation {
  ssml: string;           // For Google Cloud TTS (SSML input mode)
  plainSegments: Array<{  // For Kokoro/SoVITS (silence-padded segments)
    text: string;
    pauseAfterMs: number;
  }>;
}

const PAUSE_RE = /\[PAUSE:\s*(\d+(?:\.\d+)?)\s*s\]/gi;
const EMPHASIS_RE = /\*([^*]+)\*/g;

function translatePacingTags(sanitizedText: string): PacingTranslation {
  // 1. For SSML output (Google Cloud TTS):
  //    - Replace [PAUSE: Xs] → <break time="Xms"/>
  //    - Replace *word* → <emphasis level="strong">word</emphasis>
  //    - Wrap in <speak>...</speak>
  //
  // 2. For plain-text engines (Kokoro, SoVITS):
  //    - Split text at [PAUSE: Xs] tags
  //    - Return array of { text, pauseAfterMs } segments
  //    - Caller synthesizes each segment separately and concatenates with silence
}
```

#### Modified: `src/voice/voice-service.ts`

The `synthesize()` method is updated to:

1. Call `translatePacingTags(text)` on the input text
2. **For Google Cloud TTS**: Switch from `{ input: { text } }` to `{ input: { ssml } }` when pacing tags are present
3. **For Kokoro/SoVITS**: Synthesize each segment separately, generate silence buffers for pause durations, concatenate audio buffers

```typescript
// Before (current):
const request = {
  input: { text: inputText },
  voice: { languageCode, name: voiceName },
  audioConfig: { audioEncoding, speakingRate, pitch },
};

// After (with pacing):
const pacing = translatePacingTags(inputText);
const hasPacingTags = PAUSE_RE.test(inputText) || EMPHASIS_RE.test(inputText);

const request = {
  input: hasPacingTags ? { ssml: pacing.ssml } : { text: inputText },
  voice: { languageCode, name: voiceName },
  audioConfig: { audioEncoding, speakingRate, pitch },
};
```

### Modified Files

| File | Changes |
|------|---------|
| `src/voice/voice-service.ts` | Integrate `translatePacingTags()`, conditionally use SSML input for Google TTS, segment-based synthesis for local engines |
| `src/video/generators/storyboard-engine.ts` | Update LLM prompt to include `[PAUSE: Xs]` and `*emphasis*` instructions |

### New Files

| File | Purpose |
|------|---------|
| `src/voice/pacing-translator.ts` | `translatePacingTags()` function + regex definitions |
| `src/voice/pacing-translator.test.ts` | Unit tests for bracket→SSML translation |

### Test Cases

```typescript
// pacing-translator.test.ts
describe('translatePacingTags', () => {
  it('converts [PAUSE: 2s] to SSML break', () => {
    const result = translatePacingTags('Hello [PAUSE: 2s] World');
    expect(result.ssml).toBe('<speak>Hello <break time="2000ms"/> World</speak>');
  });

  it('converts *emphasis* to SSML emphasis', () => {
    const result = translatePacingTags('This is *critical* information');
    expect(result.ssml).toBe('<speak>This is <emphasis level="strong">critical</emphasis> information</speak>');
  });

  it('produces plain segments for local TTS', () => {
    const result = translatePacingTags('First part [PAUSE: 1.5s] Second part');
    expect(result.plainSegments).toEqual([
      { text: 'First part', pauseAfterMs: 1500 },
      { text: 'Second part', pauseAfterMs: 0 },
    ]);
  });

  it('handles text with no pacing tags', () => {
    const result = translatePacingTags('Plain text without tags');
    expect(result.ssml).toBe('<speak>Plain text without tags</speak>');
    expect(result.plainSegments).toEqual([
      { text: 'Plain text without tags', pauseAfterMs: 0 },
    ]);
  });

  it('survives ScriptSanitizer round-trip', () => {
    const input = 'Welcome [PAUSE: 1s] to *OpenZigs* Director Mode';
    const sanitized = sanitizeNarrationScript(input);
    expect(sanitized.text).toContain('[PAUSE: 1s]');
    expect(sanitized.text).toContain('*OpenZigs*');
    const result = translatePacingTags(sanitized.text);
    expect(result.ssml).toContain('<break time="1000ms"/>');
    expect(result.ssml).toContain('<emphasis level="strong">OpenZigs</emphasis>');
  });
});
```

---

## Cross-Cutting Concerns

### Draft Persistence & Migration

Add the `director_drafts` table via runtime migration in `src/config/index.ts` or a new migration helper:

```sql
CREATE TABLE IF NOT EXISTS director_drafts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  manifest TEXT NOT NULL,
  thumbnail TEXT,
  production_mode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
);
```

### Socket.IO Events

New events for Studio real-time updates:

| Event | Direction | Payload |
|-------|-----------|---------|
| `director:draft-updated` | Server → Client | `{ draftId, updatedFields }` |
| `director:scene-regenerated` | Server → Client | `{ draftId, sceneIndex, newImagePath }` |
| `director:render-progress` | Server → Client | `{ draftId, progress, stage }` |
| `director:blog-import-progress` | Server → Client | `{ draftId, stage, progress }` |

### Error Handling

- Flux img2img failures fall back to original image (non-destructive)
- Blog extraction failures show user-friendly error ("Could not parse article content")
- TTS pacing translation failures fall back to plain text (strip brackets)
- Draft auto-save on 30-second debounce in Studio UI

### Security Considerations

1. **Blog URL fetching (SSRF)**: Validate URL scheme (`http`/`https` only), reject private IPs (`10.x`, `172.16-31.x`, `192.168.x`, `127.x`, `::1`), enforce response size limit (10MB), timeout (30s)
2. **Img2img input validation**: Max image size (20MB), validate image format (PNG/JPEG/WebP only), strength clamped to `[0.1, 0.95]`
3. **Draft access control**: Drafts inherit session-level auth from existing admin API middleware
4. **Pacing tag validation**: `translatePacingTags()` validates pause duration is within `[0.1, 10]` seconds to prevent abuse

---

## File Change Manifest

### New Files (17)

| # | Path | Sub-Issue | Purpose |
|---|------|-----------|---------|
| 1 | `ui/app/director/studio/[id]/page.tsx` | 1 | Studio page route |
| 2 | `ui/components/director/studio/studio-layout.tsx` | 1 | Studio layout component |
| 3 | `ui/components/director/studio/timeline-tracks.tsx` | 1 | Timeline visualization |
| 4 | `ui/components/director/studio/scene-inspector.tsx` | 1 | Per-scene editor |
| 5 | `ui/components/director/studio/player-preview.tsx` | 1 | @remotion/player wrapper |
| 6 | `ui/components/director/studio/studio-toolbar.tsx` | 1 | Save/render toolbar |
| 7 | `src/remotion/components/intro-card.tsx` | 3 | Intro card Remotion component |
| 8 | `src/remotion/components/outro-card.tsx` | 3 | Outro card Remotion component |
| 9 | `src/remotion/components/text-overlay-layer.tsx` | 4 | Text overlay Remotion component |
| 10 | `src/video/blog/blog-extractor.ts` | 6 | Blog HTML extraction |
| 11 | `src/video/blog/blog-to-video-service.ts` | 6 | Blog→video orchestration |
| 12 | `src/voice/pacing-translator.ts` | 7 | Bracket→SSML translation |
| 13 | `src/voice/pacing-translator.test.ts` | 7 | Pacing translator tests |

### Modified Files (16)

| # | Path | Sub-Issues | Changes |
|---|------|------------|---------|
| 1 | `src/video/manifest/manifest-types.ts` | 1,3,4 | Add IntroCard, OutroCard, TextOverlay types; extend TimelineEntry union |
| 2 | `src/video/manifest/manifest-schema.ts` | 1,3,4 | Zod schemas for new types |
| 3 | `src/remotion/input-props.ts` | 3,4 | Add props schemas for new components |
| 4 | `src/remotion/adapter.ts` | 3,4 | Handle intro_card, outro_card, textOverlays in adaptManifest() |
| 5 | `src/remotion/compositions/template-composition.tsx` | 3,4 | Render new entry types and text overlay layer |
| 6 | `src/remotion/components/index.ts` | 3,4 | Export IntroCard, OutroCard, TextOverlayLayer |
| 7 | `src/api/director.ts` | 1,2,5,6 | Add draft CRUD, /enhance, /blog-to-video, /scenes/:id/regenerate routes |
| 8 | `src/video/generators/image-gen-service.ts` | 5 | Add enhanceImage() method |
| 9 | `sidecars/image-gen/server.py` | 5 | Add /img2img endpoint, img2img pipeline loading |
| 10 | `src/voice/voice-service.ts` | 7 | Integrate translatePacingTags(), SSML/segment synthesis |
| 11 | `src/video/generators/storyboard-engine.ts` | 4,6,7 | Extend prompts for text overlays, blog images, pacing tags |
| 12 | `src/video/producer/producer-service.ts` | 7 | Use pacing-aware TTS in production pipeline |
| 13 | `ui/components/director/types.ts` | 1 | Add StudioState, TimelineTrack types |
| 14 | `ui/components/director/director-wizard.tsx` | 1 | Redirect to Studio after production |
| 15 | `ui/components/director/visual-assets-step.tsx` | 2 | Accept video file uploads |
| 16 | `ui/app/director/page.tsx` | 6 | Add "Import Blog" button |

---

## Dependency Graph

```
Sub-Issue 7 (Script Pacing)         ← No dependencies, can start immediately
Sub-Issue 5 (Flux img2img)          ← No dependencies, can start immediately
Sub-Issue 4 (Text Overlays)         ← No dependencies, can start immediately
Sub-Issue 3 (Intro/Outro Cards)     ← Depends on Sub-Issue 5 (for "Enhance via Flux" toggle)
Sub-Issue 2 (BYOA)                  ← No dependencies, can start immediately
Sub-Issue 1 (Timeline Studio UI)    ← Depends on: Draft persistence (cross-cutting)
Sub-Issue 6 (Blog-to-YouTube)       ← Depends on: Sub-Issues 1, 5, 7
```

### Recommended Implementation Order

1. **Sub-Issue 7** — Script Pacing (standalone, enables all TTS improvements)
2. **Sub-Issue 5** — Flux img2img (standalone, enables enhance features across epic)
3. **Sub-Issue 4** — Text Overlays (standalone Remotion component work)
4. **Sub-Issue 3** — Intro/Outro Cards (uses img2img from #5)
5. **Sub-Issue 1** — Timeline Studio UI (largest, draft persistence + full UI)
6. **Sub-Issue 2** — BYOA (extends Studio with upload capabilities)
7. **Sub-Issue 6** — Blog-to-YouTube (integrates everything: Studio, img2img, pacing)

---

## Appendix: API Reference Snippets

### FluxImg2ImgPipeline (diffusers v0.32.2+)

```python
from diffusers import FluxImg2ImgPipeline
from diffusers.utils import load_image

pipe = FluxImg2ImgPipeline.from_pretrained(
    "black-forest-labs/FLUX.1-schnell",
    torch_dtype=torch.bfloat16
)

# Key parameters:
# - prompt: str — text prompt guiding the transformation
# - image: PIL.Image — source image
# - strength: float (0.0-1.0, default 0.6) — how much to transform
# - num_inference_steps: int (default 4 for schnell)
# - guidance_scale: float (0.0 for schnell)
result = pipe(
    prompt="cinematic, professional lighting, high quality",
    image=source_image,
    strength=0.6,
    num_inference_steps=4,
    guidance_scale=0.0,
).images[0]
```

### @remotion/player Component API

```tsx
import { Player, PlayerRef } from '@remotion/player';

const playerRef = useRef<PlayerRef>(null);

<Player
  ref={playerRef}
  component={TemplateComposition}
  inputProps={compositionInputProps}
  durationInFrames={totalFrames}
  compositionWidth={1920}
  compositionHeight={1080}
  fps={30}
  controls
  loop={false}
  clickToPlay={true}
  style={{ width: '100%' }}
/>

// Programmatic control:
playerRef.current?.play();
playerRef.current?.pause();
playerRef.current?.seekTo(frameNumber);
playerRef.current?.addEventListener('framechange', ({ detail }) => {
  console.log('Current frame:', detail.frame);
});
```

### Google Cloud TTS SSML Input

```typescript
// Switch from plain text to SSML when pacing tags are present:
const request = {
  input: {
    ssml: '<speak>Welcome to OpenZigs. <break time="1000ms"/> Let me show you something <emphasis level="strong">incredible</emphasis>.</speak>'
  },
  voice: { languageCode: 'en-US', name: 'en-US-Neural2-D' },
  audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0, pitch: 0 },
};
```
