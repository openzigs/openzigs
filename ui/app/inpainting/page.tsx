"use client";

export const dynamic = "force-dynamic";

import { useState, useRef, useCallback, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import { fetchJson, buildMediaUrl } from "@/lib/api";
import {
  Paintbrush,
  Upload,
  Download,
  RotateCcw,
  Layers,
  Palette,
  ImageIcon,
  X,
  Sparkles,
  Undo2,
  Type,
  PaintBucket,
} from "lucide-react";

// ── Types ───────────────────────────────────────────────────

interface InpaintQueueResponse {
  jobId: string;
  status: string;
  message: string;
}

interface QueueJob {
  id: string;
  status: string;
  result?: {
    file_path?: string;
    asset_id?: string;
    filename?: string;
  };
}

interface GalleryAsset {
  id: string;
  filename: string;
  type: string;
  file_path: string;
}

// Subset of CharacterProfile from src/characters/character-repository.ts.
// Epic #868 — only the fields the picker needs.
interface CharacterProfile {
  id: string;
  name: string;
  triggerWord: string;
  trainedLoraPath: string | null;
  status: "pending" | "training" | "ready" | "failed";
}

type EditMode = "semantic" | "mask";

// Models that do whole-image semantic editing via text prompt (no mask support)
const SEMANTIC_MODELS = new Set(["flux-kontext"]);

// ── Page Component ──────────────────────────────────────────

export default function InpaintingPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [brushSize, setBrushSize] = useState(30);
  const [brushFeather, setBrushFeather] = useState(0.4);
  const [isDrawing, setIsDrawing] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [selectedStyle, setSelectedStyle] = useState("");
  const [resultImage, setResultImage] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 512, height: 512 });
  const [showGalleryPicker, setShowGalleryPicker] = useState(false);
  const [selectedModel, setSelectedModel] = useState("flux-kontext");
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [editMode, setEditMode] = useState<EditMode>("semantic");
  // Epic #868 — selected character LoRA (empty string == none).
  const [selectedCharacterId, setSelectedCharacterId] = useState("");
  // Undo: store mask snapshots (ImageData from maskCanvas)
  const maskHistory = useRef<ImageData[]>([]);
  const [maskHistoryLen, setMaskHistoryLen] = useState(0);

  const isMaskMode = editMode === "mask";
  const isSemanticModel = SEMANTIC_MODELS.has(selectedModel);

  // When switching to a semantic model, force semantic mode
  useEffect(() => {
    if (isSemanticModel && editMode === "mask") {
      setEditMode("semantic");
    }
  }, [isSemanticModel, editMode]);

  const IMAGE_GEN_MODELS = [
    {
      id: "flux-kontext",
      name: "Flux Kontext",
      bestFor: "Targeted edits — swap objects, change colors, add/remove things",
      description:
        "Context-aware editor. Describe the change in plain language and it modifies only the relevant part while keeping everything else intact. Best choice for most editing tasks.",
      supportsMask: false,
      recommended: true,
    },
    {
      id: "flux-dev",
      name: "Flux Dev",
      bestFor: "Creative re-imaginings where full-scene changes are OK",
      description:
        "High-quality 25-step generator adapted for img2img. Treats your image as a loose starting point — may alter areas you wanted to keep. Good for stylistic overhauls.",
      supportsMask: true,
      recommended: false,
    },
    {
      id: "flux-schnell",
      name: "Flux Schnell",
      bestFor: "Quick drafts and style experiments",
      description:
        "Fast 4-step generator. Same tradeoffs as Flux Dev but much quicker. Use to quickly test ideas before committing to a full Flux Dev run.",
      supportsMask: true,
      recommended: false,
    },
    {
      id: "z-image-turbo",
      name: "Z-Image Turbo",
      bestFor: "Style transfers and LoRA-driven character edits",
      description:
        "Fast LoRA-compatible model. Best when you want to apply a specific art style or character LoRA to an image. Not ideal for precise regional edits.",
      supportsMask: true,
      recommended: false,
    },
  ];

  const artStyles = [
    { id: "", name: "None (auto)" },
    { id: "photorealistic", name: "Photorealistic" },
    { id: "oil-painting", name: "Oil Painting" },
    { id: "watercolor", name: "Watercolor" },
    { id: "anime", name: "Anime" },
    { id: "cyberpunk", name: "Cyberpunk" },
    { id: "comic-book", name: "Comic Book" },
    { id: "minimalist", name: "Minimalist" },
  ];

  const apiBase =
    process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "http://localhost:3000";
  const authToken = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";

  // ── Canvas sizing ──
  useEffect(() => {
    if (!sourceImage) return;
    const img = new window.Image();
    img.onload = () => {
      const maxDim = 768;
      const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      setCanvasSize({ width: w, height: h });
    };
    img.src = sourceImage;
  }, [sourceImage]);

  // ── Draw image on canvas ──
  useEffect(() => {
    if (!sourceImage) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const img = new window.Image();
    img.onload = () => {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }
    };
    img.src = sourceImage;
  }, [sourceImage, canvasSize]);

  // ── Image upload ──
  const handleImageUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        showToast("Please select an image file", "error");
        return;
      }
      setSourceFile(file);
      setResultImage(null);
      maskHistory.current = [];
      setMaskHistoryLen(0);

      const reader = new FileReader();
      reader.onload = (ev) => {
        setSourceImage(ev.target?.result as string);
      };
      reader.readAsDataURL(file);
    },
    [],
  );

  // ── Save mask snapshot for undo ──
  const saveMaskSnapshot = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const mctx = maskCanvas.getContext("2d");
    if (!mctx) return;
    const snap = mctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    maskHistory.current.push(snap);
    if (maskHistory.current.length > 50) maskHistory.current.shift();
    setMaskHistoryLen(maskHistory.current.length);
  }, []);

  // ── Undo last stroke ──
  const undoStroke = useCallback(() => {
    if (maskHistory.current.length === 0) return;
    maskHistory.current.pop();
    setMaskHistoryLen(maskHistory.current.length);
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const mctx = maskCanvas.getContext("2d");
    if (!mctx) return;

    if (maskHistory.current.length === 0) {
      mctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    } else {
      mctx.putImageData(maskHistory.current[maskHistory.current.length - 1], 0, 0);
    }

    // Redraw display canvas: original image + current mask overlay
    if (!sourceImage) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new window.Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      // Overlay the mask
      const maskData = mctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
      const overlay = ctx.createImageData(canvas.width, canvas.height);
      for (let i = 0; i < maskData.data.length; i += 4) {
        if (maskData.data[i] > 128 && maskData.data[i + 3] > 0) {
          overlay.data[i] = 255;
          overlay.data[i + 1] = 80;
          overlay.data[i + 2] = 80;
          overlay.data[i + 3] = 100;
        }
      }
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
      const tempCtx = tempCanvas.getContext("2d")!;
      tempCtx.putImageData(overlay, 0, 0);
      ctx.drawImage(tempCanvas, 0, 0);
    };
    img.src = sourceImage;
  }, [sourceImage]);

  // ── Drawing handlers — active in both modes ──
  // In semantic mode: draws annotation markers that Kontext uses for targeting
  // In mask mode: draws a mask for non-Kontext models
  const startDrawing = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      saveMaskSnapshot();
      setIsDrawing(true);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      const radius = brushSize / 2;

      // Visual overlay: green for Kontext annotation, red for mask mode
      const color = isSemanticModel ? "0, 220, 0" : "255, 80, 80";
      const gradient = ctx.createRadialGradient(x, y, radius * (1 - brushFeather), x, y, radius);
      gradient.addColorStop(0, `rgba(${color}, 0.5)`);
      gradient.addColorStop(1, `rgba(${color}, 0)`);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();

      // Clean mask canvas (solid circle for actual mask data)
      const maskCanvas = maskCanvasRef.current;
      if (maskCanvas) {
        const mctx = maskCanvas.getContext("2d");
        if (mctx) {
          mctx.beginPath();
          mctx.arc(x, y, radius, 0, Math.PI * 2);
          mctx.fillStyle = "rgba(255, 0, 0, 1)";
          mctx.fill();
        }
      }
    },
    [brushSize, brushFeather, saveMaskSnapshot, isSemanticModel],
  );

  const draw = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDrawing) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      const radius = brushSize / 2;

      const color = isSemanticModel ? "0, 220, 0" : "255, 80, 80";
      const gradient = ctx.createRadialGradient(x, y, radius * (1 - brushFeather), x, y, radius);
      gradient.addColorStop(0, `rgba(${color}, 0.5)`);
      gradient.addColorStop(1, `rgba(${color}, 0)`);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();

      const maskCanvas = maskCanvasRef.current;
      if (maskCanvas) {
        const mctx = maskCanvas.getContext("2d");
        if (mctx) {
          mctx.beginPath();
          mctx.arc(x, y, radius, 0, Math.PI * 2);
          mctx.fillStyle = "rgba(255, 0, 0, 1)";
          mctx.fill();
        }
      }
    },
    [isDrawing, brushSize, brushFeather, isSemanticModel],
  );

  const stopDrawing = useCallback(() => setIsDrawing(false), []);

  // ── Clear mask ──
  const clearMask = useCallback(() => {
    if (!sourceImage) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new window.Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = sourceImage;
    const maskCanvas = maskCanvasRef.current;
    if (maskCanvas) {
      const mctx = maskCanvas.getContext("2d");
      mctx?.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    }
    maskHistory.current = [];
    setMaskHistoryLen(0);
  }, [sourceImage]);

  // ── Gallery picker ──
  const galleryQuery = useQuery<{ assets: GalleryAsset[] }>({
    queryKey: ["gallery-images-inpainting"],
    queryFn: () => fetchJson("/api/queue/assets?type=image&limit=30"),
    enabled: showGalleryPicker,
  });

  // ── Character library (epic #868) ────────────────────────────
  const charactersQuery = useQuery<{ characters: CharacterProfile[] }>({
    queryKey: ["characters-inpainting"],
    queryFn: () => fetchJson("/api/characters"),
    staleTime: 30_000,
  });
  const readyCharacters = (charactersQuery.data?.characters ?? []).filter(
    (c) => c.status === "ready" && c.trainedLoraPath,
  );
  // Selecting a character inserts its trigger word into the prompt so the
  // trained activation token actually fires during sampling. Clearing the
  // selection removes the trigger word so the prompt stays clean.
  const handleCharacterChange = useCallback(
    (newId: string) => {
      const prevChar = readyCharacters.find(
        (c) => c.id === selectedCharacterId,
      );
      const nextChar = readyCharacters.find((c) => c.id === newId);

      let next = prompt;
      if (prevChar?.triggerWord) {
        const escaped = prevChar.triggerWord.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        next = next
          .replace(new RegExp(`\\b${escaped}\\b\\s*`, "i"), "")
          .trim();
      }
      if (nextChar?.triggerWord) {
        const escaped = nextChar.triggerWord.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        if (!new RegExp(`\\b${escaped}\\b`, "i").test(next)) {
          next = next ? `${nextChar.triggerWord} ${next}` : nextChar.triggerWord;
        }
      }
      setPrompt(next);
      setSelectedCharacterId(newId);
    },
    [prompt, readyCharacters, selectedCharacterId],
  );

  const loadFromGallery = useCallback(async (asset: GalleryAsset) => {
    try {
      const url = buildMediaUrl(`/api/queue/assets/${asset.id}/file`);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("Failed to fetch image");
      const blob = await resp.blob();
      const file = new File([blob], asset.filename, { type: blob.type });
      setSourceFile(file);
      setResultImage(null);
      maskHistory.current = [];
      setMaskHistoryLen(0);
      const reader = new FileReader();
      reader.onload = (ev) => {
        setSourceImage(ev.target?.result as string);
      };
      reader.readAsDataURL(blob);
      setShowGalleryPicker(false);
      showToast(`Loaded "${asset.filename}" from gallery`, "success");
    } catch (err) {
      showToast(
        `Failed to load image: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  }, []);

  // ── Enhance prompt (vision-guided when image is loaded) ──
  const enhancePrompt = useCallback(async () => {
    if (!prompt.trim() || isEnhancing) return;
    setIsEnhancing(true);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

      // Extract base64 payload from the data URL so the backend can write it to
      // a temp file and pass it to the vision model as an attachment
      let imageBase64: string | undefined;
      let mimeType: string | undefined;
      if (sourceImage?.startsWith("data:")) {
        const [header, b64] = sourceImage.split(",");
        const match = header.match(/data:(image\/[a-z+]+);base64/);
        if (match && b64) {
          mimeType = match[1];
          imageBase64 = b64;
        }
      }

      const res = await fetch(`${apiBase}/api/admin/creative/enhance-prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt,
          ...(imageBase64 ? { image: imageBase64, mime_type: mimeType } : {}),
        }),
      });
      if (!res.ok) {
        const { error } = (await res.json()) as { error: string };
        showToast(error || "Failed to enhance prompt", "error");
        return;
      }
      const { enhancedPrompt } = (await res.json()) as {
        enhancedPrompt: string;
      };
      setPrompt(enhancedPrompt);
      showToast(
        imageBase64 ? "Prompt enhanced with image context!" : "Prompt enhanced!",
        "success",
      );
    } catch (err) {
      showToast(
        `Enhance failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setIsEnhancing(false);
    }
  }, [prompt, isEnhancing, apiBase, authToken, sourceImage]);

  // ── Check if mask has any paint ──
  const hasMaskPaint = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return false;
    const mctx = maskCanvas.getContext("2d");
    if (!mctx) return false;
    const data = mctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 128 && data[i + 3] > 0) return true;
    }
    return false;
  }, []);

  // ── Build an annotated image for Kontext ──
  // Bakes bright green annotation over the painted regions directly into the
  // source image. Kontext natively understands colored annotation boxes and
  // removes them from the output automatically.
  const buildAnnotatedImage = useCallback(async (): Promise<Blob | null> => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas || !sourceImage) return null;
    const mctx = maskCanvas.getContext("2d");
    if (!mctx) return null;

    const maskData = mctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);

    // Load original image at canvas resolution
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const el = new window.Image();
      el.onload = () => res(el);
      el.onerror = rej;
      el.src = sourceImage;
    });

    const w = maskCanvas.width;
    const h = maskCanvas.height;
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d")!;
    ctx.drawImage(img, 0, 0, w, h);

    // Draw bright green (0, 255, 0) annotation over painted areas
    const imgData = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < maskData.data.length; i += 4) {
      if (maskData.data[i] > 128 && maskData.data[i + 3] > 0) {
        imgData.data[i] = 0;       // R
        imgData.data[i + 1] = 255; // G
        imgData.data[i + 2] = 0;   // B
        imgData.data[i + 3] = 255; // A
      }
    }
    ctx.putImageData(imgData, 0, 0);

    return new Promise<Blob>((resolve) =>
      out.toBlob((b) => resolve(b!), "image/png"),
    );
  }, [sourceImage]);

  // ── Generate ──
  const inpaint = useMutation({
    mutationFn: async () => {
      if (!sourceFile) throw new Error("No image uploaded");
      if (!prompt.trim()) throw new Error("No prompt provided");

      const hasPaint = hasMaskPaint();

      const formData = new FormData();
      formData.append("model", selectedModel);
      if (selectedStyle) formData.append("style_id", selectedStyle);
      // Epic #868 — attach selected character so the API injects its trained LoRA.
      if (selectedCharacterId) formData.append("character_id", selectedCharacterId);

      if (isSemanticModel && hasPaint) {
        // Kontext: bake annotation into the source image
        const annotatedBlob = await buildAnnotatedImage();
        if (annotatedBlob) {
          formData.append("image", annotatedBlob, "annotated.png");
          // Append annotation context to the prompt
          formData.append(
            "prompt",
            `${prompt}. The bright green area in the image marks the region to change.`,
          );
        } else {
          formData.append("image", sourceFile);
          formData.append("prompt", prompt);
        }
      } else {
        formData.append("image", sourceFile);
        formData.append("prompt", prompt);

        // Non-Kontext models: include B/W mask if painted
        if (hasPaint && !isSemanticModel) {
          const maskCanvas = maskCanvasRef.current!;
          const maskCtx = maskCanvas.getContext("2d")!;
          const imageData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
          const outCanvas = document.createElement("canvas");
          outCanvas.width = maskCanvas.width;
          outCanvas.height = maskCanvas.height;
          const outCtx = outCanvas.getContext("2d")!;
          const bwData = outCtx.createImageData(maskCanvas.width, maskCanvas.height);
          for (let i = 0; i < imageData.data.length; i += 4) {
            const on = imageData.data[i] > 128 && imageData.data[i + 3] > 0;
            bwData.data[i] = on ? 255 : 0;
            bwData.data[i + 1] = on ? 255 : 0;
            bwData.data[i + 2] = on ? 255 : 0;
            bwData.data[i + 3] = 255;
          }
          outCtx.putImageData(bwData, 0, 0);
          const maskBlob = await new Promise<Blob>((resolve) =>
            outCanvas.toBlob((b) => resolve(b!), "image/png"),
          );
          formData.append("mask", maskBlob, "mask.png");
        }
      }

      const headers: Record<string, string> = {};
      if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

      const submitRes = await fetch(`${apiBase}/api/admin/creative/inpaint`, {
        method: "POST",
        body: formData,
        headers,
      });
      if (!submitRes.ok) {
        const text = await submitRes.text();
        throw new Error(text || `Server error: ${submitRes.status}`);
      }
      const { jobId } = (await submitRes.json()) as InpaintQueueResponse;

      // Poll for completion
      const maxPolls = 60;
      const pollInterval = 5000;
      for (let i = 0; i < maxPolls; i++) {
        await new Promise((r) => setTimeout(r, pollInterval));
        const pollRes = await fetch(`${apiBase}/api/queue/jobs/${jobId}`, {
          headers,
        });
        if (!pollRes.ok) continue;

        const job = (await pollRes.json()) as QueueJob;
        if (job.status === "complete") return job;
        if (job.status === "failed") {
          throw new Error("Inpainting job failed on the worker");
        }
      }

      throw new Error(
        "Generation is taking longer than expected. The result will appear in the Gallery when complete.",
      );
    },
    onSuccess: (job) => {
      let rawUrl: string | null = null;
      if (job.result?.asset_id) {
        rawUrl = `${apiBase}/api/queue/assets/${job.result.asset_id}/file`;
      } else if (job.result?.file_path) {
        const filename = job.result.file_path.split("/").pop();
        rawUrl = `${apiBase}/api/admin/gallery/file/${filename}`;
      }
      if (rawUrl) setResultImage(rawUrl);
      showToast("Generation complete!", "success");
    },
    onError: (err: Error) => {
      showToast(`Failed: ${err.message}`, "error");
    },
  });

  const currentModelInfo = IMAGE_GEN_MODELS.find((m) => m.id === selectedModel);

  return (
    <div className="min-h-screen bg-zinc-950 p-6 text-zinc-100">
      <div className="mx-auto max-w-[1200px] space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Paintbrush className="h-6 w-6 text-purple-400" />
          <h1 className="text-2xl font-bold">Inpainting Studio</h1>
        </div>
        <p className="text-sm text-zinc-400">
          Upload an image, paint over the area to change (optional), describe what you want, and generate.
        </p>

        {/* Mode Switcher */}
        {sourceImage && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setEditMode("semantic")}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
                editMode === "semantic"
                  ? "bg-purple-600 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
              }`}
            >
              <Type className="h-4 w-4" />
              Semantic Edit
            </button>
            <button
              onClick={() => {
                if (isSemanticModel) {
                  showToast(
                    "Flux Kontext uses text prompts only — switch to a different model for mask-based inpainting",
                    "error",
                  );
                  return;
                }
                setEditMode("mask");
              }}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
                editMode === "mask"
                  ? "bg-purple-600 text-white"
                  : isSemanticModel
                    ? "cursor-not-allowed bg-zinc-800/50 text-zinc-600"
                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
              }`}
            >
              <PaintBucket className="h-4 w-4" />
              Mask Inpaint
            </button>
          </div>
        )}

        {/* Leave-page notice */}
        {inpaint.isPending && (
          <div className="flex items-start gap-3 rounded-lg border border-blue-800/60 bg-blue-950/40 px-4 py-3 text-sm text-blue-300">
            <span className="mt-0.5 text-base leading-none">💡</span>
            <span>
              Your image is being generated — you can safely leave this page.
              The result will appear in the{" "}
              <a href="/gallery" className="underline hover:text-blue-200">
                Gallery
              </a>{" "}
              automatically when it&apos;s ready.
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Left: Canvas + Controls */}
          <div className="space-y-4">
            <SectionCard
              title={
                <span className="flex items-center gap-2">
                  <Layers className="h-4 w-4" />
                  Source Image
                </span>
              }
            >
              <div className="space-y-4">
                <div className="flex gap-2">
                  <label className="flex w-fit cursor-pointer items-center gap-2 rounded-lg bg-zinc-800 px-4 py-2 transition hover:bg-zinc-700">
                    <Upload className="h-4 w-4" />
                    <span className="text-sm">Upload Image</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleImageUpload}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowGalleryPicker(true)}
                    className="flex items-center gap-2 rounded-lg bg-zinc-800 px-4 py-2 text-sm transition hover:bg-zinc-700"
                  >
                    <ImageIcon className="h-4 w-4" />
                    From Gallery
                  </button>
                </div>

                <div
                  className={`relative inline-block overflow-hidden rounded-lg border border-zinc-700 ${!sourceImage ? "hidden" : ""}`}
                >
                  <canvas
                    ref={canvasRef}
                    width={canvasSize.width}
                    height={canvasSize.height}
                    className="max-w-full cursor-crosshair"
                    style={{ display: "block" }}
                    onMouseDown={startDrawing}
                    onMouseMove={draw}
                    onMouseUp={stopDrawing}
                    onMouseLeave={stopDrawing}
                  />
                  {sourceImage && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-3 py-2">
                      <p className="text-xs text-zinc-300">
                        {isSemanticModel
                          ? "Paint over the area to change (optional) — Kontext uses it as a targeting annotation."
                          : "Paint over the area to fill — the mask tells the model where to generate."}
                      </p>
                    </div>
                  )}
                </div>
                <canvas
                  ref={maskCanvasRef}
                  width={canvasSize.width}
                  height={canvasSize.height}
                  className="hidden"
                />

                {!sourceImage && (
                  <div className="flex h-64 items-center justify-center rounded-lg border-2 border-dashed border-zinc-700 text-sm text-zinc-500">
                    No image loaded. Upload a file or pick one from the Gallery.
                  </div>
                )}
              </div>
            </SectionCard>

            {/* Brush Controls */}
            {sourceImage && (
              <SectionCard
                title={
                  <span className="flex items-center gap-2">
                    <PaintBucket className="h-4 w-4" />
                    Brush Controls
                  </span>
                }
              >
                <div className="space-y-3">
                  <div className="flex items-center gap-4">
                    <label className="w-14 text-sm text-zinc-400">Size:</label>
                    <input
                      type="range"
                      min={5}
                      max={120}
                      value={brushSize}
                      onChange={(e) => setBrushSize(Number(e.target.value))}
                      className="flex-1"
                    />
                    <span className="w-12 text-right text-sm">{brushSize}px</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <label className="w-14 text-sm text-zinc-400">Feather:</label>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={brushFeather}
                      onChange={(e) => setBrushFeather(Number(e.target.value))}
                      className="flex-1"
                    />
                    <span className="w-12 text-right text-sm">
                      {Math.round(brushFeather * 100)}%
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={undoStroke}
                      disabled={maskHistoryLen === 0}
                      className="flex items-center gap-1.5 rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Undo2 className="h-3.5 w-3.5" />
                      Undo
                    </button>
                    <button
                      onClick={clearMask}
                      className="flex items-center gap-1.5 rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Clear All
                    </button>
                  </div>
                </div>
              </SectionCard>
            )}

            {/* Prompt tips */}
            {sourceImage && isSemanticModel && (
              <SectionCard
                title={
                  <span className="flex items-center gap-2">
                    <Type className="h-4 w-4" />
                    How Semantic Editing Works
                  </span>
                }
              >
                <div className="space-y-3 text-sm text-zinc-400">
                  <p>
                    Flux Kontext reads your image and changes only what you
                    describe. The more precisely you identify the subject, the
                    better the result.
                  </p>

                  {/* Formula */}
                  <div className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                      Prompt formula
                    </p>
                    <p className="font-mono text-xs text-zinc-300">
                      Change{" "}
                      <span className="rounded bg-blue-900/60 px-1 text-blue-300">
                        [the specific subject]
                      </span>{" "}
                      to{" "}
                      <span className="rounded bg-green-900/60 px-1 text-green-300">
                        [what you want instead]
                      </span>
                    </p>
                    <p className="mt-1.5 text-[11px] text-zinc-500">
                      Name the subject by what it <em>is</em>, not where it is.
                    </p>
                  </div>

                  {/* Examples — tappable to fill prompt */}
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-zinc-300">
                      Tap an example to use it:
                    </p>
                    <div className="space-y-1.5">
                      {[
                        {
                          bad: "Replace the pillow with a dog on it next to the fireplace with a cat",
                          good: "Replace the dog with a tabby cat in the same pose",
                          why: "Name the subject (the dog), not its surroundings",
                        },
                        {
                          bad: "A cat sitting there",
                          good: "Change the dog on the couch to a tabby cat",
                          why: "Be explicit — describe the full change, not just the result",
                        },
                        {
                          bad: "Make it look like winter",
                          good: "Replace the green lawn with snow-covered ground",
                          why: "Identify what changes, not just the mood",
                        },
                        {
                          bad: "Put sunglasses on",
                          good: "Add aviator sunglasses to the person's face",
                          why: "Specify the subject when there are multiple people or objects",
                        },
                      ].map(({ bad, good, why }) => (
                        <button
                          key={good}
                          type="button"
                          onClick={() => setPrompt(good)}
                          className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-left transition hover:border-purple-600/50 hover:bg-zinc-800"
                        >
                          <div className="flex items-start gap-2">
                            <span className="mt-0.5 shrink-0 text-[10px] font-bold text-red-400">
                              ✗
                            </span>
                            <span className="text-[11px] text-zinc-500 line-through">
                              {bad}
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-start gap-2">
                            <span className="mt-0.5 shrink-0 text-[10px] font-bold text-green-400">
                              ✓
                            </span>
                            <span className="text-[11px] font-medium text-zinc-200">
                              {good}
                            </span>
                          </div>
                          <p className="mt-1 text-[10px] text-zinc-500">{why}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </SectionCard>
            )}
          </div>

          {/* Right: Settings + Result */}
          <div className="space-y-4">
            <SectionCard
              title={
                <span className="flex items-center gap-2">
                  <Palette className="h-4 w-4" />
                  Generation Settings
                </span>
              }
            >
              <div className="space-y-4">
                {/* Prompt */}
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-xs text-zinc-400">
                      {isMaskMode
                        ? "What should fill the painted area?"
                        : "Describe the change you want"}
                    </label>
                    <button
                      type="button"
                      onClick={enhancePrompt}
                      disabled={!prompt.trim() || isEnhancing}
                      className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-purple-400 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-600"
                      title={
                        sourceImage
                          ? "AI will look at your image and rewrite the prompt for Flux Kontext"
                          : "Rewrite the prompt as a precise Flux Kontext edit instruction"
                      }
                    >
                      <Sparkles className="h-3 w-3" />
                      {isEnhancing
                        ? sourceImage
                          ? "Analysing image…"
                          : "Enhancing…"
                        : sourceImage
                          ? "Enhance with Vision"
                          : "Enhance with AI"}
                    </button>
                  </div>
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder={
                      isMaskMode
                        ? "e.g. a tabby cat sitting and looking at the camera"
                        : "e.g. Replace the pillow with a tabby cat"
                    }
                    className="h-24 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 p-3 text-sm focus:border-purple-500 focus:outline-none"
                  />
                </div>

                {/* Art Style */}
                <div>
                  <label className="mb-1 block text-xs text-zinc-400">
                    Art Style
                  </label>
                  <select
                    value={selectedStyle}
                    onChange={(e) => setSelectedStyle(e.target.value)}
                    className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm"
                  >
                    {artStyles.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Character LoRA picker (epic #868) */}
                <div>
                  <label
                    htmlFor="inpaint-character-picker"
                    className="mb-1 block text-xs text-zinc-400"
                  >
                    Character
                    {isSemanticModel && (
                      <span className="ml-2 text-amber-400">
                        (not available with Flux Kontext)
                      </span>
                    )}
                  </label>
                  <select
                    id="inpaint-character-picker"
                    value={selectedCharacterId}
                    onChange={(e) => handleCharacterChange(e.target.value)}
                    disabled={
                      isSemanticModel ||
                      charactersQuery.isLoading ||
                      readyCharacters.length === 0
                    }
                    className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="">No character</option>
                    {readyCharacters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.triggerWord})
                      </option>
                    ))}
                  </select>
                  {charactersQuery.isLoading && (
                    <p className="mt-1 text-xs text-zinc-500">
                      Loading characters…
                    </p>
                  )}
                  {charactersQuery.isError && (
                    <p className="mt-1 text-xs text-red-400">
                      Failed to load characters.
                    </p>
                  )}
                  {!charactersQuery.isLoading &&
                    !charactersQuery.isError &&
                    readyCharacters.length === 0 && (
                      <p className="mt-1 text-xs text-zinc-500">
                        No trained characters yet — train one in the Character
                        Library to inject it into edits.
                      </p>
                    )}
                </div>

                {/* Model Picker */}
                <div>
                  <label className="mb-2 block text-xs text-zinc-400">
                    Image Model
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {IMAGE_GEN_MODELS.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setSelectedModel(m.id)}
                        className={`relative rounded-lg border p-2.5 text-left transition ${
                          selectedModel === m.id
                            ? "border-purple-500 bg-purple-900/30"
                            : "border-zinc-700 bg-zinc-800/60 hover:border-zinc-500"
                        }`}
                      >
                        {m.recommended && (
                          <span className="mb-1 inline-block rounded bg-purple-600/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-100">
                            Best for editing
                          </span>
                        )}
                        <p className="text-xs font-semibold text-zinc-100">
                          {m.name}
                        </p>
                        <p className="mt-0.5 text-[10px] leading-snug text-zinc-400">
                          {m.bestFor}
                        </p>
                      </button>
                    ))}
                  </div>
                  {selectedModel && (
                    <p className="mt-2 text-xs text-zinc-500">
                      {currentModelInfo?.description}
                    </p>
                  )}
                </div>

                <button
                  onClick={() => inpaint.mutate()}
                  disabled={!sourceImage || !prompt || inpaint.isPending}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-purple-600 px-4 py-2.5 font-medium transition hover:bg-purple-500 disabled:cursor-not-allowed disabled:bg-zinc-700"
                >
                  {inpaint.isPending ? (
                    <span className="animate-pulse">
                      Generating — safe to leave page…
                    </span>
                  ) : (
                    <>
                      <Paintbrush className="h-4 w-4" />
                      Generate
                    </>
                  )}
                </button>
              </div>
            </SectionCard>

            {resultImage && (
              <SectionCard
                title={
                  <span className="flex items-center gap-2">
                    <Download className="h-4 w-4" />
                    Result
                  </span>
                }
              >
                <div className="space-y-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={resultImage}
                    alt="Inpainting result"
                    className="max-w-full rounded-lg border border-zinc-700"
                  />
                  <div className="flex gap-2">
                    <a
                      href={resultImage}
                      download
                      className="flex items-center gap-2 rounded-lg bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
                    >
                      <Download className="h-4 w-4" />
                      Download
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        // Use result as new source for iterative editing
                        fetch(resultImage)
                          .then((r) => r.blob())
                          .then((blob) => {
                            const file = new File([blob], "result.png", { type: "image/png" });
                            setSourceFile(file);
                            setResultImage(null);
                            maskHistory.current = [];
                            setMaskHistoryLen(0);
                            const reader = new FileReader();
                            reader.onload = (ev) => {
                              setSourceImage(ev.target?.result as string);
                            };
                            reader.readAsDataURL(blob);
                            showToast("Result loaded as new source — edit again!", "success");
                          })
                          .catch(() => showToast("Failed to load result", "error"));
                      }}
                      className="flex items-center gap-2 rounded-lg bg-purple-600/30 px-4 py-2 text-sm text-purple-300 hover:bg-purple-600/50"
                    >
                      <Paintbrush className="h-4 w-4" />
                      Edit This Result
                    </button>
                  </div>
                </div>
              </SectionCard>
            )}
          </div>
        </div>
      </div>

      {/* Gallery Picker Modal */}
      {showGalleryPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="relative mx-4 w-full max-w-2xl rounded-2xl border border-zinc-700 bg-zinc-900 shadow-xl">
            <div className="flex items-center justify-between border-b border-zinc-700 px-6 py-4">
              <h2 className="text-lg font-semibold">
                Select Image from Gallery
              </h2>
              <button
                onClick={() => setShowGalleryPicker(false)}
                className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-6">
              {galleryQuery.isLoading && (
                <div className="flex justify-center py-8 text-sm text-zinc-400">
                  Loading gallery images...
                </div>
              )}
              {galleryQuery.data?.assets?.length === 0 && (
                <div className="py-8 text-center text-sm text-zinc-500">
                  No images found in gallery.
                </div>
              )}
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                {galleryQuery.data?.assets?.map((asset) => (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => loadFromGallery(asset)}
                    className="group relative aspect-square overflow-hidden rounded-lg border border-zinc-700 transition hover:border-purple-500"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={buildMediaUrl(
                        `/api/queue/assets/${asset.id}/file`,
                      )}
                      alt={asset.filename}
                      className="h-full w-full object-cover"
                    />
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2">
                      <span className="block truncate text-xs text-zinc-300">
                        {asset.filename}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <ToastContainer />
    </div>
  );
}
