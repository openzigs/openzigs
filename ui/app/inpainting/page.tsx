"use client";

export const dynamic = "force-dynamic";

import { useState, useRef, useCallback, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";

import { SectionCard } from "@/components/section-card";
import { ToastContainer, showToast } from "@/components/toast";
import {
  Paintbrush,
  Upload,
  Eraser,
  Download,
  RotateCcw,
  Layers,
  Palette,
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

// ── Page Component ──────────────────────────────────────────

export default function InpaintingPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [brushSize, setBrushSize] = useState(20);
  const [isDrawing, setIsDrawing] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [selectedStyle, setSelectedStyle] = useState("");
  const [resultImage, setResultImage] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 512, height: 512 });

  // ── Art styles from the art-style-tools ──
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

  // ── Draw source image onto canvas after React renders the element ──
  useEffect(() => {
    if (!sourceImage) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const img = new window.Image();
    img.onload = () => {
      const maxDim = 768;
      const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);

      if (canvas.width !== w || canvas.height !== h) {
        setCanvasSize({ width: w, height: h });
        canvas.width = w;
        canvas.height = h;
      }

      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
      }
    };
    img.src = sourceImage;
  }, [sourceImage]);

  // ── Handle image upload ──
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

      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        setSourceImage(dataUrl);
      };
      reader.readAsDataURL(file);
    },
    [],
  );

  // ── Drawing handlers (mask painting) ──
  const startDrawing = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
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
      ctx.beginPath();
      ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 0, 0, 0.4)";
      ctx.fill();
    },
    [brushSize],
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
      ctx.beginPath();
      ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 0, 0, 0.4)";
      ctx.fill();
    },
    [isDrawing, brushSize],
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
  }, [sourceImage]);

  // ── Generate inpainting ──
  const apiBase =
    process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "http://localhost:3000";
  const authToken = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";

  const inpaint = useMutation({
    mutationFn: async () => {
      if (!sourceFile) throw new Error("No image uploaded");
      if (!prompt.trim()) throw new Error("No prompt provided");

      const formData = new FormData();
      formData.append("image", sourceFile);
      formData.append("prompt", prompt);
      if (selectedStyle) formData.append("style_id", selectedStyle);

      // Extract mask from canvas (red areas)
      const canvas = canvasRef.current;
      if (canvas) {
        const maskCanvas = document.createElement("canvas");
        maskCanvas.width = canvas.width;
        maskCanvas.height = canvas.height;
        const maskCtx = maskCanvas.getContext("2d")!;
        const ctx = canvas.getContext("2d")!;
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const maskData = maskCtx.createImageData(canvas.width, canvas.height);

        for (let i = 0; i < imageData.data.length; i += 4) {
          const r = imageData.data[i];
          const g = imageData.data[i + 1];
          const isMask = r > 200 && g < 100;
          maskData.data[i] = isMask ? 255 : 0;
          maskData.data[i + 1] = isMask ? 255 : 0;
          maskData.data[i + 2] = isMask ? 255 : 0;
          maskData.data[i + 3] = 255;
        }
        maskCtx.putImageData(maskData, 0, 0);

        const maskBlob = await new Promise<Blob>((resolve) =>
          maskCanvas.toBlob((b) => resolve(b!), "image/png"),
        );
        formData.append("mask", maskBlob, "mask.png");
      }

      // Submit the inpaint job
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

      // Poll for completion (max ~5 minutes)
      const maxPolls = 60;
      const pollInterval = 5000;
      for (let i = 0; i < maxPolls; i++) {
        await new Promise((r) => setTimeout(r, pollInterval));

        const pollRes = await fetch(`${apiBase}/api/queue/jobs/${jobId}`, {
          headers,
        });
        if (!pollRes.ok) continue;

        const job = (await pollRes.json()) as QueueJob;
        if (job.status === "complete") {
          return job;
        }
        if (job.status === "failed") {
          throw new Error("Inpainting job failed on the worker");
        }
      }

      throw new Error("Inpainting timed out — check the Queue page for status");
    },
    onSuccess: (job) => {
      showToast("Inpainting complete!", "success");
      if (job.result?.asset_id) {
        setResultImage(
          `${apiBase}/api/queue/assets/${job.result.asset_id}/file`,
        );
      } else if (job.result?.file_path) {
        const filename = job.result.file_path.split("/").pop();
        setResultImage(`${apiBase}/api/admin/gallery/file/${filename}`);
      }
    },
    onError: (err: Error) => {
      showToast(`Inpainting failed: ${err.message}`, "error");
    },
  });

  return (
    <div className="min-h-screen bg-zinc-950 p-6 text-zinc-100">
      <div className="mx-auto max-w-[1200px] space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Paintbrush className="h-6 w-6 text-purple-400" />
          <h1 className="text-2xl font-bold">Inpainting Studio</h1>
        </div>
        <p className="text-sm text-zinc-400">
          Upload an image, paint over the areas you want to replace, describe
          what you want, and let AI fill it in.
        </p>

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

                {/* Canvas is always in the DOM — hidden when no image to avoid race conditions */}
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
                </div>

                {!sourceImage && (
                  <div className="flex h-64 items-center justify-center rounded-lg border-2 border-dashed border-zinc-700 text-sm text-zinc-500">
                    No image loaded. Click &ldquo;Upload Image&rdquo; above.
                  </div>
                )}
              </div>
            </SectionCard>

            {sourceImage && (
              <SectionCard
                title={
                  <span className="flex items-center gap-2">
                    <Eraser className="h-4 w-4" />
                    Brush Controls
                  </span>
                }
              >
                <div className="flex items-center gap-4">
                  <label className="text-sm text-zinc-400">Size:</label>
                  <input
                    type="range"
                    min={5}
                    max={80}
                    value={brushSize}
                    onChange={(e) => setBrushSize(Number(e.target.value))}
                    className="flex-1"
                  />
                  <span className="w-10 text-right text-sm">{brushSize}px</span>
                  <button
                    onClick={clearMask}
                    className="flex items-center gap-1.5 rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Clear
                  </button>
                </div>
              </SectionCard>
            )}
          </div>

          {/* Right: Prompt + Style + Result */}
          <div className="space-y-4">
            <SectionCard
              title={
                <span className="flex items-center gap-2">
                  <Palette className="h-4 w-4" />
                  Inpainting Prompt
                </span>
              }
            >
              <div className="space-y-4">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Describe what should replace the masked area..."
                  className="h-24 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 p-3 text-sm focus:border-purple-500 focus:outline-none"
                />

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

                <button
                  onClick={() => inpaint.mutate()}
                  disabled={!sourceImage || !prompt || inpaint.isPending}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-purple-600 px-4 py-2.5 font-medium transition hover:bg-purple-500 disabled:cursor-not-allowed disabled:bg-zinc-700"
                >
                  {inpaint.isPending ? (
                    <span className="animate-pulse">Generating...</span>
                  ) : (
                    <>
                      <Paintbrush className="h-4 w-4" />
                      Generate Inpainting
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
                  <a
                    href={resultImage}
                    download
                    className="flex w-fit items-center gap-2 rounded-lg bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
                  >
                    <Download className="h-4 w-4" />
                    Download Result
                  </a>
                </div>
              </SectionCard>
            )}
          </div>
        </div>
      </div>
      <ToastContainer />
    </div>
  );
}
