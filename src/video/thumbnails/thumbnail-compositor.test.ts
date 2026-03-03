import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@napi-rs/canvas", () => {
  const _ctx = {
    drawImage: vi.fn(),
    createLinearGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    measureText: vi.fn().mockReturnValue({ width: 100 }),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    roundRect: vi.fn(),
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    lineJoin: "miter",
    font: "12px serif",
    textAlign: "start",
    textBaseline: "alphabetic",
  };
  const _canvas = {
    getContext: vi.fn().mockReturnValue(_ctx),
    toBuffer: vi.fn().mockReturnValue(Buffer.from("fake-image-data")),
  };
  return {
    createCanvas: vi.fn().mockReturnValue(_canvas),
    loadImage: vi.fn().mockResolvedValue({ width: 1280, height: 720 }),
    _canvas,
    _ctx,
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as nodeFs from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { compositeThumbnail } from "./thumbnail-compositor.js";
import type { ThumbnailCompositeOptions } from "./thumbnail-compositor.js";

// Synchronous accessors since dynamic import resolves from cache
const canvasMod = await import("@napi-rs/canvas") as any;
const mockCanvas = canvasMod._canvas;
const mockCtx = canvasMod._ctx;

function makeOptions(overrides: Partial<ThumbnailCompositeOptions> = {}): ThumbnailCompositeOptions {
  return {
    backgroundPath: "/tmp/bg.jpg",
    textLines: ["AMAZING VIDEO", "YOU WON'T BELIEVE"],
    textPlacement: "bottom",
    textColor: "#ffffff",
    outputPath: "/tmp/thumb.jpg",
    ...overrides,
  };
}

describe("thumbnail-compositor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvas.getContext.mockReturnValue(mockCtx);
    mockCanvas.toBuffer.mockReturnValue(Buffer.from("fake-image-data"));
    mockCtx.measureText.mockReturnValue({ width: 100 });
    mockCtx.createLinearGradient.mockReturnValue({ addColorStop: vi.fn() });
    vi.mocked(nodeFs.existsSync).mockReturnValue(true);
  });

  it("creates canvas with default dimensions", async () => {
    await compositeThumbnail(makeOptions());
    expect(createCanvas).toHaveBeenCalledWith(1280, 720);
  });

  it("creates canvas with custom dimensions", async () => {
    await compositeThumbnail(makeOptions({ width: 1920, height: 1080 }));
    expect(createCanvas).toHaveBeenCalledWith(1920, 1080);
  });

  it("loads background image", async () => {
    await compositeThumbnail(makeOptions());
    expect(loadImage).toHaveBeenCalledWith("/tmp/bg.jpg");
  });

  it("draws background stretched to fill canvas", async () => {
    await compositeThumbnail(makeOptions());
    expect(mockCtx.drawImage).toHaveBeenCalled();
  });

  it("creates gradient overlay for bottom text placement", async () => {
    await compositeThumbnail(makeOptions({ textPlacement: "bottom" }));
    const gradient = mockCtx.createLinearGradient.mock.results[0].value;
    expect(gradient.addColorStop).toHaveBeenCalled();
  });

  it("creates gradient overlay for top text placement", async () => {
    await compositeThumbnail(makeOptions({ textPlacement: "top" }));
    expect(mockCtx.createLinearGradient).toHaveBeenCalled();
  });

  it("creates gradient overlay for center text placement", async () => {
    await compositeThumbnail(makeOptions({ textPlacement: "center" }));
    expect(mockCtx.createLinearGradient).toHaveBeenCalled();
  });

  it("renders text lines with fill and stroke", async () => {
    const opts = makeOptions({ textLines: ["LINE 1", "LINE 2"] });
    await compositeThumbnail(opts);
    // Each line should get: drop shadow fillText + strokeText + fill fillText = 3 per line
    // Plus gradient fill, so fillText called multiple times
    expect(mockCtx.fillText).toHaveBeenCalled();
    expect(mockCtx.strokeText).toHaveBeenCalled();
  });

  it("skips stroke when textStrokeWidth is 0", async () => {
    const opts = makeOptions({ textStrokeWidth: 0 });
    await compositeThumbnail(opts);
    expect(mockCtx.strokeText).not.toHaveBeenCalled();
  });

  it("writes JPEG output by default", async () => {
    const opts = makeOptions();
    const result = await compositeThumbnail(opts);
    expect(mockCanvas.toBuffer).toHaveBeenCalledWith("image/jpeg");
    expect(nodeFs.writeFileSync).toHaveBeenCalledWith("/tmp/thumb.jpg", expect.any(Buffer));
    expect(result).toBe("/tmp/thumb.jpg");
  });

  it("writes PNG output when specified", async () => {
    const opts = makeOptions({ outputFormat: "png", outputPath: "/tmp/thumb.png" });
    await compositeThumbnail(opts);
    expect(mockCanvas.toBuffer).toHaveBeenCalledWith("image/png");
  });

  it("creates output directory if it does not exist", async () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(false);
    const opts = makeOptions({ outputPath: "/tmp/new-dir/thumb.jpg" });
    await compositeThumbnail(opts);
    expect(nodeFs.mkdirSync).toHaveBeenCalledWith("/tmp/new-dir", { recursive: true });
  });

  it("draws arrows clickbait overlay", async () => {
    const opts = makeOptions({ clickbaitOverlay: "arrows" });
    await compositeThumbnail(opts);
    // Arrows use beginPath, moveTo, lineTo, closePath, fill
    expect(mockCtx.beginPath).toHaveBeenCalled();
    expect(mockCtx.moveTo).toHaveBeenCalled();
    expect(mockCtx.fill).toHaveBeenCalled();
  });

  it("draws circles clickbait overlay", async () => {
    const opts = makeOptions({ clickbaitOverlay: "circles" });
    await compositeThumbnail(opts);
    expect(mockCtx.arc).toHaveBeenCalled();
    expect(mockCtx.stroke).toHaveBeenCalled();
  });

  it("draws emoji clickbait overlay", async () => {
    const opts = makeOptions({ clickbaitOverlay: "emoji" });
    await compositeThumbnail(opts);
    // emoji fillText for 🔥 and 😱
    const fillTextCalls = mockCtx.fillText.mock.calls;
    const emojiCalls = fillTextCalls.filter((c: any[]) => c[0] === "🔥" || c[0] === "😱");
    expect(emojiCalls.length).toBe(2);
  });

  it("draws badge clickbait overlay", async () => {
    const opts = makeOptions({ clickbaitOverlay: "badge" });
    await compositeThumbnail(opts);
    expect(mockCtx.roundRect).toHaveBeenCalled();
    const fillTextCalls = mockCtx.fillText.mock.calls;
    const badgeCalls = fillTextCalls.filter((c: any[]) => c[0] === "MUST SEE");
    expect(badgeCalls.length).toBe(1);
  });

  it("returns the output path", async () => {
    const result = await compositeThumbnail(makeOptions());
    expect(result).toBe("/tmp/thumb.jpg");
  });

  it("auto-sizes font down when text is too wide", async () => {
    // First call returns wide, subsequent returns narrow
    let callCount = 0;
    mockCtx.measureText.mockImplementation(() => {
      callCount++;
      return { width: callCount <= 2 ? 2000 : 100 };
    });

    await compositeThumbnail(makeOptions({ textLines: ["VERY LONG TEXT LINE HERE"] }));
    // Font should have been adjusted (measureText called multiple times)
    expect(callCount).toBeGreaterThan(2);
  });
});
