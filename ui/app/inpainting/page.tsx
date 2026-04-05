"use client";

export const dynamic = "force-dynamic";

import { useState, useRef, useCallback } from "react";
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

interface InpaintResult {
  outputPath: string;
  width: number;
  height: number;
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

  // ── Handle image upload ──
  const handleImageUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setSourceFile(file);

      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        setSourceImage(dataUrl);

        const img = new Image();
        img.onload = () => {
          const canvas = canvasRef.current;
          if (!canvas) return;

          // Scale to fit 512px max dimension
          const maxDim = 768;
          const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          setCanvasSize({ width: w, height: h });
          canvas.width = w;
          canvas.height = h;

          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.clearRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
          }
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
      setResultImage(null);
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
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
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
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
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
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = sourceImage;
  }, [sourceImage]);

  // ── Generate inpainting ──
  const inpaint = useMutation({
    mutationFn: async () => {
      if (!sourceFile) throw new Error("No image uploaded");

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

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "http://localhost:3000"}/api/admin/creative/inpaint`,
        {
          method: "POST",
          body: formData,
          headers: {
            Authorization: `Bearer ${process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? ""}`,
          },
        },
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<InpaintResult>;
    },
    onSuccess: (data) => {
      showToast("Inpainting complete!", "success");
      // Convert server path to gallery URL for display
      const filename = data.outputPath.split("/").pop();
      setResultImage(
        `${process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "http://localhost:3000"}/api/admin/gallery/file/${filename}`,
      );
    },
    onError: (err: Error) => {
      showToast(`Inpainting failed: ${err.message}`, "error");
    },
  });

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div className="max-w-[1200px] mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Paintbrush className="w-6 h-6 text-purple-400" />
          <h1 className="text-2xl font-bold">Inpainting Studio</h1>
        </div>
        <p className="text-zinc-400 text-sm">
          Upload an image, paint over the areas you want to replace, describe
          what you want, and let AI fill it in.
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Canvas + Controls */}
          <div className="space-y-4">
            <SectionCard
              title="Source Image"
              icon={<Layers className="w-4 h-4" />}
            >
              <div className="space-y-4">
                <label className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg cursor-pointer transition w-fit">
                  <Upload className="w-4 h-4" />
                  <span className="text-sm">Upload Image</span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleImageUpload}
                  />
                </label>

                {sourceImage && (
                  <div className="relative border border-zinc-700 rounded-lg overflow-hidden inline-block">
                    <canvas
                      ref={canvasRef}
                      width={canvasSize.width}
                      height={canvasSize.height}
                      className="cursor-crosshair"
                      onMouseDown={startDrawing}
                      onMouseMove={draw}
                      onMouseUp={stopDrawing}
                      onMouseLeave={stopDrawing}
                    />
                  </div>
                )}
              </div>
            </SectionCard>

            {sourceImage && (
              <SectionCard
                title="Brush Controls"
                icon={<Eraser className="w-4 h-4" />}
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
                  <span className="text-sm w-10 text-right">{brushSize}px</span>
                  <button
                    onClick={clearMask}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-sm"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Clear
                  </button>
                </div>
              </SectionCard>
            )}
          </div>

          {/* Right: Prompt + Style + Result */}
          <div className="space-y-4">
            <SectionCard
              title="Inpainting Prompt"
              icon={<Palette className="w-4 h-4" />}
            >
              <div className="space-y-4">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Describe what should replace the masked area..."
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg p-3 text-sm resize-none h-24 focus:outline-none focus:border-purple-500"
                />

                <div>
                  <label className="block text-xs text-zinc-400 mb-1">
                    Art Style
                  </label>
                  <select
                    value={selectedStyle}
                    onChange={(e) => setSelectedStyle(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm"
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
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-purple-600 hover:bg-purple-500 disabled:bg-zinc-700 disabled:cursor-not-allowed rounded-lg font-medium transition"
                >
                  {inpaint.isPending ? (
                    <span className="animate-pulse">Generating...</span>
                  ) : (
                    <>
                      <Paintbrush className="w-4 h-4" />
                      Generate Inpainting
                    </>
                  )}
                </button>
              </div>
            </SectionCard>

            {resultImage && (
              <SectionCard
                title="Result"
                icon={<Download className="w-4 h-4" />}
              >
                <div className="space-y-3">
                  <img
                    src={resultImage}
                    alt="Inpainting result"
                    className="rounded-lg border border-zinc-700 max-w-full"
                  />
                  <a
                    href={resultImage}
                    download
                    className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm w-fit"
                  >
                    <Download className="w-4 h-4" />
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
