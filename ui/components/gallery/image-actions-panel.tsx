"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import {
  Maximize2,
  Scissors,
  SlidersHorizontal,
  FileImage,
  Stamp,
  X,
} from "lucide-react";

interface ImageActionsPanelProps {
  filePath: string;
  filename: string;
  onClose: () => void;
}

type ActionType = "resize" | "crop" | "filter" | "convert" | "watermark" | null;

const FILTERS = [
  "grayscale",
  "blur",
  "sharpen",
  "negate",
  "normalize",
  "sepia",
] as const;

const FORMATS = ["png", "jpeg", "webp", "avif", "tiff"] as const;

const POSITIONS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "center",
] as const;

export function ImageActionsPanel({
  filePath,
  filename,
  onClose,
}: ImageActionsPanelProps) {
  const queryClient = useQueryClient();
  const [activeAction, setActiveAction] = useState<ActionType>(null);

  // Resize state
  const [resizeWidth, setResizeWidth] = useState(512);
  const [resizeHeight, setResizeHeight] = useState(512);
  const [resizeFit, setResizeFit] = useState("inside");

  // Crop state
  const [cropLeft, setCropLeft] = useState(0);
  const [cropTop, setCropTop] = useState(0);
  const [cropWidth, setCropWidth] = useState(256);
  const [cropHeight, setCropHeight] = useState(256);

  // Filter state
  const [filterType, setFilterType] = useState<string>("grayscale");
  const [filterIntensity, setFilterIntensity] = useState(3);

  // Convert state
  const [convertFormat, setConvertFormat] = useState<string>("webp");
  const [convertQuality, setConvertQuality] = useState(80);

  // Watermark state
  const [watermarkPath, setWatermarkPath] = useState("");
  const [watermarkPosition, setWatermarkPosition] = useState("bottom-right");
  const [watermarkOpacity, setWatermarkOpacity] = useState(0.5);

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
    actionMutation.mutate({
      action: "crop",
      payload: {
        file_path: filePath,
        left: cropLeft,
        top: cropTop,
        width: cropWidth,
        height: cropHeight,
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
    if (!watermarkPath.trim()) {
      showToast("Please provide a watermark file path", "error");
      return;
    }
    actionMutation.mutate({
      action: "watermark",
      payload: {
        file_path: filePath,
        watermark_path: watermarkPath,
        position: watermarkPosition,
        opacity: watermarkOpacity,
      },
    });
  };

  const actions = [
    { key: "resize" as const, label: "Resize", icon: Maximize2 },
    { key: "crop" as const, label: "Crop", icon: Scissors },
    { key: "filter" as const, label: "Filter", icon: SlidersHorizontal },
    { key: "convert" as const, label: "Convert", icon: FileImage },
    { key: "watermark" as const, label: "Watermark", icon: Stamp },
  ];

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-lg">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-card-foreground">
          Image Actions
        </h3>
        <button
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <p className="mb-3 truncate text-xs text-muted-foreground">{filename}</p>

      {/* Action buttons */}
      <div className="mb-4 flex flex-wrap gap-2">
        {actions.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setActiveAction(activeAction === key ? null : key)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
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

      {/* Resize form */}
      {activeAction === "resize" && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground">Width</label>
              <input
                type="number"
                value={resizeWidth}
                onChange={(e) => setResizeWidth(Number(e.target.value))}
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Height</label>
              <input
                type="number"
                value={resizeHeight}
                onChange={(e) => setResizeHeight(Number(e.target.value))}
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Fit Mode</label>
            <select
              value={resizeFit}
              onChange={(e) => setResizeFit(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
            >
              {["cover", "contain", "fill", "inside", "outside"].map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={handleResize}
            disabled={actionMutation.isPending}
            className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {actionMutation.isPending ? "Processing..." : "Resize Image"}
          </button>
        </div>
      )}

      {/* Crop form */}
      {activeAction === "crop" && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground">Left</label>
              <input
                type="number"
                value={cropLeft}
                onChange={(e) => setCropLeft(Number(e.target.value))}
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Top</label>
              <input
                type="number"
                value={cropTop}
                onChange={(e) => setCropTop(Number(e.target.value))}
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Width</label>
              <input
                type="number"
                value={cropWidth}
                onChange={(e) => setCropWidth(Number(e.target.value))}
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Height</label>
              <input
                type="number"
                value={cropHeight}
                onChange={(e) => setCropHeight(Number(e.target.value))}
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
              />
            </div>
          </div>
          <button
            onClick={handleCrop}
            disabled={actionMutation.isPending}
            className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {actionMutation.isPending ? "Processing..." : "Crop Image"}
          </button>
        </div>
      )}

      {/* Filter form */}
      {activeAction === "filter" && (
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">Filter</label>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
            >
              {FILTERS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
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
            {actionMutation.isPending ? "Processing..." : "Apply Filter"}
          </button>
        </div>
      )}

      {/* Convert form */}
      {activeAction === "convert" && (
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">Format</label>
            <select
              value={convertFormat}
              onChange={(e) => setConvertFormat(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
            >
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              Quality: {convertQuality}
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
            {actionMutation.isPending ? "Processing..." : "Convert Image"}
          </button>
        </div>
      )}

      {/* Watermark form */}
      {activeAction === "watermark" && (
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">
              Watermark File Path
            </label>
            <input
              type="text"
              value={watermarkPath}
              onChange={(e) => setWatermarkPath(e.target.value)}
              placeholder="/path/to/watermark.png"
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Position</label>
            <select
              value={watermarkPosition}
              onChange={(e) => setWatermarkPosition(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
            >
              {POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              Opacity: {watermarkOpacity.toFixed(1)}
            </label>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.1}
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
            {actionMutation.isPending ? "Processing..." : "Add Watermark"}
          </button>
        </div>
      )}
    </div>
  );
}
