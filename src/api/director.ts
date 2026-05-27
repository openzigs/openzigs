/**
 * Director Mode — REST API Router (composition root).
 *
 * After the epic #1113 split, this file is intentionally tiny: it wires the
 * shared `DirectorContext` and delegates every route to a domain sub-router.
 * See `src/api/director/README.md` for the domain catalog.
 *
 * Sub-routers:
 *   - Assets / files / gallery / brand-kits → `./director/assets.ts`
 *   - Storyboard / authoring / config       → `./director/storyboard.ts`
 *   - Render / production pipeline          → `./director/render.ts`
 *   - Publish / YouTube / analytics         → `./director/publish.ts`
 */

import { Router } from "express";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { VoiceService } from "../voice/voice-service.js";
import type { RenderOrchestrator } from "../video/render-orchestrator.js";
import type { BrandVoiceService } from "../personality/brand-voice-service.js";
import type { ToolRegistry } from "../mcp/tool-registry.js";
import { createDirectorContext } from "./director/context.js";
import { registerAssetRoutes } from "./director/assets.js";
import { registerStoryboardRoutes } from "./director/storyboard.js";
import { registerRenderRoutes } from "./director/render.js";
import { registerPublishRoutes } from "./director/publish.js";

export { setDirectorIO } from "./director/context.js";

export interface DirectorRouterOptions {
  copilot: CopilotWrapper;
  voiceService?: VoiceService;
  renderOrchestrator?: RenderOrchestrator;
  brandVoiceService?: BrandVoiceService;
  toolRegistry?: ToolRegistry;
  config: {
    enabled: boolean;
    outputDir: string;
    defaultTemplate: string;
    assets: {
      localLibraryPath: string;
      downloadCachePath: string;
      pixabayApiKey: string;
      jamendoClientId: string;
      pexelsApiKey: string;
    };
  };
}

export const createDirectorRouter = (
  options: DirectorRouterOptions,
): Router => {
  const router = Router();
  const ctx = createDirectorContext(options);

  registerAssetRoutes(router, ctx);
  registerStoryboardRoutes(router, ctx);
  registerRenderRoutes(router, ctx);
  registerPublishRoutes(router, ctx);

  return router;
};
