"use client";

import { useState, useRef, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import ReactCrop, {
  type Crop,
  type PixelCrop,
  centerCrop,
  makeAspectCrop,
} from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import {
  Maximize2,
  Scissors,
  SlidersHorizontal,
  FileImage,
  Stamp,
  X,
  Link,
  Link2Off,
  Eraser,
  ArrowUpFromLine,
} from "lucide-react";

interface ImageActionsPanelProps {
  filePath: string;
  filename: string;
  imageUrl: string;
  onClose: () => void;
}

type ActionType = "resize" | "crop" | "filter" | "convert" | "watermark" | "remove-bg" | "upscale" | null;

const FILTERS = [
  { key: "grayscale", label: "Grayscale", css: "grayscale(100%)" },
  { key: "sepia", label: "Sepia", css: "sepia(100%)" },
  { key: "blur", label: "Blur", css: "blur(3px)" },
  { key: "sharpen", label: "Sharpen", css: "contrast(150%) brightness(105%)" },
  { key: "negate", label: "Invert", css: "invert(100%)" },
  { key: "normalize", label: "Normalize", css: "contrast(120%) saturate(120%)" },
] as const;

const FORMATS = ["png", "jpeg", "webp", "avif", "tiff"] as const;

const WATERMARK_POSITIONS = [
  ["top-left", "top-center", "top-right"],
  ["center-left", "center", "center-right"],
  ["bottom-left", "bottom-center", "bottom-right"],
] as const;

type WatermarkPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "center-left"
  | "center"
  | "center-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

const API_POSITION_MAP: Record<WatermarkPosition, string> = {
  "top-left": "top-left",
  "top-center": "top-right",
  "top-right": "top-right",
  "center-left": "bottom-left",
  center: "center",
  "center-right": "bottom-right",
  "bottom-left": "bottom-left",
  "bottom-center": "bottom-right",
  "bottom-right": "bottom-right",
};

function centerAspectCrop(
  mediaWidth: number,
  mediaHeight: number,
  aspect: number,
) {
  return centerCrop(
    makeAspectCrop({ unit: "%", width: 80 }, aspect, mediaWidth, mediaHeight),
    mediaWidth,
    mediaHeight,
  );
}

export function ImageActionsPanel({
  filePath,
  filename,
  imageUrl,
  onClose,
}: ImageActionsPanelProps) {
  const queryClient = useQueryClient();
  const [activeAction, setActiveAction] = useState<ActionType>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Natural image dimensions
  const [naturalWidth, setNaturalWidth] = useState(0);
  const [naturalHeight, setNaturalHeight] = useState(0);

  // Resize state
  const [resizeWidth, setResizeWidth] = useState(512);
  const [resizeHeight, setResizeHeight] = useState(512);
  const [resizeFit, setResizeFit] = useState("inside");
  const [aspectLocked, setAspectLocked] = useState(true);
  const aspectRatio = naturalWidth && naturalHeight ? naturalWidth / naturalHeight : 1;

  // Crop state (react-image-crop)
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();

  // Filter state
  const [filterType, setFilterType] = useState<string>("grayscale");
  const [filterIntensity, setFilterIntensity] = useState(3);

  // Convert state
  const [convertFormat, setConvertFormat] = useState<string>("webp");
  const [convertQuality, setConvertQuality] = useState(80);

  // Watermark state
  const [watermarkText, setWatermarkText] = useState("");
  const [watermarkPosition, setWatermarkPosition] =
    useState<WatermarkPosition>("bottom-right");
  const [watermarkOpacity, setWatermarkOpacity] = useState(0.5);

  // Remove background state
  const [bgModel, setBgModel] = useState("u2net");
  const [alphaMatting, setAlphaMatting] = useState(false);

  // Upscale state
  const [upscaleScale, setUpscaleScale] = useState(2);

  const onImageLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const { naturalWidth: nw, naturalHeight: nh } = e.currentTarget;
      setNaturalWidth(nw);
      setNaturalHeight(nh);
      setResizeWidth(nw);
      setResizeHeight(nh);
      // Default crop: 80% centered
      setCrop(centerAspectCrop(nw, nh, nw / nh));
    },
    [],
  );

  const handleResizeWidthChange = (val: number) => {
    setResizeWidth(val);
    if (aspectLocked && naturalWidth && naturalHeight) {
      setResizeHeight(Math.round(val / aspectRatio));
    }
  };

  const handleResizeHeightChange = (val: number) => {
    setResizeHeight(val);
    if (aspectLocked && naturalWidth && naturalHeight) {
      setResizeWidth(Math.round(val * aspectRatio));
    }
  };

  const currentFilterCss =
    FILTERS.find((f) => f.key === filterType)?.css ?? "none";

  const actionMutation = useMutation({
    mutationFn: (body: { action: string; payload: Record<string, unknown> }) =>
      fetchJson(`/api/admin/creative/${body.action}`, {
        method: "POST",
        body: JSON.stringify(body.payload),
      }),
    onSuccess: () => {
      showToast(
        "Image processed successfully — new asset saved to gallery",
        "success",
      );
      queryClient.invalidateQueries({ queryKey: ["gallery-assets"] });
      setActiveAction(null);
    },
    onError: (err: Error) => {
      showToast(`Image action failed: ${err.message}`, "error");
    },
  });

  const handleResize = () => {
    actionMutation.mutate({
      action: "resize",
      payload: {
        file_path: filePath,
        width: resizeWidth,
        height: resizeHeight,
        fit: resizeFit,
      },
    });
  };

  const handleCrop = () => {
    if (!completedCrop || !naturalWidth || !naturalHeight) {
      showToast("Please select a crop area on the image", "error");
      return;
    }
    // completedCrop values are in display pixels; convert to natural image pixels
    const displayImg = imgRef.current;
    if (!displayImg) return;
    const scaleX = naturalWidth / displayImg.width;
    const scaleY = naturalHeight / displayImg.height;
    actionMutation.mutate({
      action: "crop",
      payload: {
        file_path: filePath,
        left: Math.round(completedCrop.x * scaleX),
        top: Math.round(completedCrop.y * scaleY),
        width: Math.round(completedCrop.width * scaleX),
        height: Math.round(completedCrop.height * scaleY),
      },
    });
  };

  const handleFilter = () => {
    actionMutation.mutate({
      action: "filter",
      payload: {
        file_path: filePath,
        filter: filterType,
        intensity: filterIntensity,
      },
    });
  };

  const handleConvert = () => {
    actionMutation.mutate({
      action: "convert",
      payload: {
        file_path: filePath,
        format: convertFormat,
        quality: convertQuality,
      },
    });
  };

  const handleWatermark = () => {
    if (!watermarkText.trim()) {
      showToast("Please enter watermark text", "error");
      return;
    }
    actionMutation.mutate({
      action: "watermark",
      payload: {
        file_path: filePath,
        text: watermarkText,
        position: API_POSITION_MAP[watermarkPosition],
        opacity: watermarkOpacity,
      },
    });
  };

  const handleRemoveBackground = () => {
    actionMutation.mutate({
      action: "remove-background",
      payload: {
        file_path: filePath,
        model: bgModel,
        alpha_matting: alphaMatting,
      },
    });
  };

  const handleUpscale = () => {
    actionMutation.mutate({
      action: "upscale",
      payload: {
        file_path: filePath,
        scale: upscaleScale,
      },
    });
  };

  const actions = [
    { key: "resize" as const, label: "Resize", icon: Maximize2 },
    { key: "crop" as const, label: "Crop", icon: Scissors },
    { key: "filter" as const, label: "Filter", icon: SlidersHorizontal },
    { key: "convert" as const, label: "Convert", icon: FileImage },
    { key: "watermark" as const, label: "Watermark", icon: Stamp },
    { key: "remove-bg" as const, label: "Remove BG", icon: Eraser },
    { key: "upscale" as const, label: "Upscale", icon: ArrowUpFromLine },
  ];

  return (
    <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-card-foreground">
          Edit Image
        </h3>
        <button
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-muted"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* Image preview area */}
        <div className="relative flex items-center justify-center bg-black/30 p-2">
          {activeAction === "crop" ? (
            <ReactCrop
              crop={crop}
              onChange={(c) => setCrop(c)}
              onComplete={(c) => setCompletedCrop(c)}
              className="max-h-64"
            >
              <img
                ref={imgRef}
                src={imageUrl}
                alt={filename}
                className="max-h-64 max-w-full object-contain"
                onLoad={onImageLoad}
                crossOrigin="anonymous"
              />
            </ReactCrop>
          ) : (
            <img
              ref={imgRef}
              src={imageUrl}
              alt={filename}
              className="max-h-64 max-w-full object-contain transition-all duration-300"
              style={
                activeAction === "filter"
                  ? { filter: currentFilterCss }
                  : undefined
              }
              onLoad={onImageLoad}
            />
          )}
          {naturalWidth > 0 && (
            <span className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
              {naturalWidth} × {naturalHeight}
            </span>
          )}
        </div>

        {/* Action tabs */}
        <div className="flex gap-1 overflow-x-auto border-b border-border px-3 py-2">
          {actions.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setActiveAction(activeAction === key ? null : key)}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                activeAction === key
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* Action panels */}
        <div className="p-4">
          {/* Resize */}
          {activeAction === "resize" && (
            <div className="space-y-3">
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="text-xs text-muted-foreground">
                    Width (px)
                  </label>
                  <input
                    type="number"
                    value={resizeWidth}
                    onChange={(e) =>
                      handleResizeWidthChange(Number(e.target.value))
                    }
                    className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
                  />
                </div>
                <button
                  onClick={() => setAspectLocked((v) => !v)}
                  title={
                    aspectLocked
                      ? "Unlock aspect ratio"
                      : "Lock aspect ratio"
                  }
                  className={`mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded border transition ${
                    aspectLocked
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:border-primary"
                  }`}
                >
                  {aspectLocked ? (
                    <Link className="h-3.5 w-3.5" />
                  ) : (
                    <Link2Off className="h-3.5 w-3.5" />
                  )}
                </button>
                <div className="flex-1">
                  <label className="text-xs text-muted-foreground">
                    Height (px)
                  </label>
                  <input
                    type="number"
                    value={resizeHeight}
                    onChange={(e) =>
                      handleResizeHeightChange(Number(e.target.value))
                    }
                    className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">
                  Fit Mode
                </label>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {["cover", "contain", "fill", "inside", "outside"].map(
                    (f) => (
                      <button
                        key={f}
                        onClick={() => setResizeFit(f)}
                        className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                          resizeFit === f
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:bg-muted/80"
                        }`}
                      >
                        {f}
                      </button>
                    ),
                  )}
                </div>
              </div>
              <button
                onClick={handleResize}
                disabled={actionMutation.isPending}
                className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {actionMutation.isPending ? "Processing…" : "Resize Image"}
              </button>
            </div>
          )}

          {/* Crop */}
          {activeAction === "crop" && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Drag on the image above to select the crop region.
              </p>
              {completedCrop && naturalWidth > 0 && imgRef.current && (
                <div className="grid grid-cols-4 gap-2 rounded-lg border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
                  {[
                    [
                      "Left",
                      Math.round(
                        completedCrop.x *
                          (naturalWidth / (imgRef.current?.width ?? 1)),
                      ),
                    ],
                    [
                      "Top",
                      Math.round(
                        completedCrop.y *
                          (naturalHeight / (imgRef.current?.height ?? 1)),
                      ),
                    ],
                    [
                      "Width",
                      Math.round(
                        completedCrop.width *
                          (naturalWidth / (imgRef.current?.width ?? 1)),
                      ),
                    ],
                    [
                      "Height",
                      Math.round(
                        completedCrop.height *
                          (naturalHeight / (imgRef.current?.height ?? 1)),
                      ),
                    ],
                  ].map(([label, val]) => (
                    <div key={label} className="text-center">
                      <div className="font-medium text-foreground">{val}</div>
                      <div>{label}</div>
                    </div>
                  ))}
                </div>
              )}
              <button
                onClick={handleCrop}
                disabled={actionMutation.isPending || !completedCrop}
                className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {actionMutation.isPending ? "Processing…" : "Apply Crop"}
              </button>
            </div>
          )}

          {/* Filter */}
          {activeAction === "filter" && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Live preview shown on image above.
              </p>
              <div className="grid grid-cols-3 gap-2">
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setFilterType(f.key)}
                    className={`rounded-lg border px-2 py-2 text-xs font-medium transition ${
                      filterType === f.key
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-muted text-muted-foreground hover:border-primary/50"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <div>
                <label className="text-xs text-muted-foreground">
                  Intensity: {filterIntensity}
                </label>
                <input
                  type="range"
                  min={0.1}
                  max={20}
                  step={0.1}
                  value={filterIntensity}
                  onChange={(e) => setFilterIntensity(Number(e.target.value))}
                  className="mt-1 w-full"
                />
              </div>
              <button
                onClick={handleFilter}
                disabled={actionMutation.isPending}
                className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {actionMutation.isPending ? "Processing…" : "Apply Filter"}
              </button>
            </div>
          )}

          {/* Convert */}
          {activeAction === "convert" && (
            <div className="space-y-3">
              <div className="grid grid-cols-5 gap-2">
                {FORMATS.map((f) => {
                  const currentExt = filename.split(".").pop()?.toLowerCase();
                  const isCurrent = currentExt === f;
                  return (
                    <button
                      key={f}
                      onClick={() => setConvertFormat(f)}
                      className={`rounded-lg border py-2 text-xs font-semibold uppercase transition ${
                        convertFormat === f
                          ? "border-primary bg-primary text-primary-foreground"
                          : isCurrent
                            ? "border-border bg-muted/50 text-muted-foreground/50 cursor-default"
                            : "border-border bg-muted text-muted-foreground hover:border-primary/50"
                      }`}
                    >
                      {f}
                    </button>
                  );
                })}
              </div>
              <div>
                <label className="text-xs text-muted-foreground">
                  Quality: {convertQuality}%
                </label>
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={convertQuality}
                  onChange={(e) => setConvertQuality(Number(e.target.value))}
                  className="mt-1 w-full"
                />
              </div>
              <button
                onClick={handleConvert}
                disabled={actionMutation.isPending}
                className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {actionMutation.isPending ? "Processing…" : "Convert Image"}
              </button>
            </div>
          )}

          {/* Watermark */}
          {activeAction === "watermark" && (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground">
                  Watermark Text
                </label>
                <input
                  type="text"
                  value={watermarkText}
                  onChange={(e) => setWatermarkText(e.target.value)}
                  placeholder="© Your Name"
                  className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs text-muted-foreground">
                  Position
                </label>
                <div className="inline-grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted p-1.5">
                  {WATERMARK_POSITIONS.map((row) =>
                    row.map((pos) => (
                      <button
                        key={pos}
                        onClick={() =>
                          setWatermarkPosition(pos as WatermarkPosition)
                        }
                        title={pos}
                        className={`h-8 w-8 rounded transition ${
                          watermarkPosition === pos
                            ? "bg-primary"
                            : "bg-background hover:bg-muted-foreground/20"
                        }`}
                        aria-label={pos}
                        aria-pressed={watermarkPosition === pos}
                      />
                    )),
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground capitalize">
                  {watermarkPosition.replace(/-/g, " ")}
                </p>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">
                  Opacity: {Math.round(watermarkOpacity * 100)}%
                </label>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={watermarkOpacity}
                  onChange={(e) => setWatermarkOpacity(Number(e.target.value))}
                  className="mt-1 w-full"
                />
              </div>
              <button
                onClick={handleWatermark}
                disabled={actionMutation.isPending}
                className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {actionMutation.isPending ? "Processing…" : "Add Watermark"}
              </button>
            </div>
          )}

          {/* Remove Background */}
          {activeAction === "remove-bg" && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                AI-powered background removal. The result is a transparent PNG.
              </p>
              <div>
                <label className="text-xs text-muted-foreground">Model</label>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {[
                    { id: "u2net", label: "General" },
                    { id: "u2net_human_seg", label: "People" },
                    { id: "isnet-general-use", label: "Detailed" },
                  ].map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setBgModel(m.id)}
                      className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                        bgModel === m.id
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:bg-muted/80"
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={alphaMatting}
                  onChange={(e) => setAlphaMatting(e.target.checked)}
                  className="rounded"
                />
                Alpha matting (softer edges)
              </label>
              <button
                onClick={handleRemoveBackground}
                disabled={actionMutation.isPending}
                className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {actionMutation.isPending ? "Processing…" : "Remove Background"}
              </button>
            </div>
          )}

          {/* Upscale */}
          {activeAction === "upscale" && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                AI super-resolution using Real-ESRGAN.
                {naturalWidth > 0 && (
                  <> Output: {naturalWidth * upscaleScale} x {naturalHeight * upscaleScale} px</>
                )}
              </p>
              <div>
                <label className="text-xs text-muted-foreground">Scale Factor</label>
                <div className="mt-1 flex gap-2">
                  {[2, 4].map((s) => (
                    <button
                      key={s}
                      onClick={() => setUpscaleScale(s)}
                      className={`flex-1 rounded-lg border py-3 text-center text-sm font-semibold transition ${
                        upscaleScale === s
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-muted text-muted-foreground hover:border-primary/50"
                      }`}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
              </div>
              <button
                onClick={handleUpscale}
                disabled={actionMutation.isPending}
                className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {actionMutation.isPending ? "Processing…" : "Upscale Image"}
              </button>
            </div>
          )}

          {!activeAction && (
            <p className="text-center text-xs text-muted-foreground">
              Select an action above to edit the image.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
