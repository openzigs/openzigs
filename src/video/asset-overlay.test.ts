import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "node:os";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    access: vi.fn(),
    unlink: vi.fn(),
    stat: vi.fn(),
  },
}));

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { overlayAssets } from "./asset-overlay.js";
import type { OverlayOptions } from "./asset-overlay.js";

const HOME = os.homedir();

function mockSpawnSuccess(_stdout = "", probeJson = '{"streams":[{"duration":"10.5"}]}') {
  let callCount = 0;
  vi.mocked(spawn).mockImplementation(() => {
    callCount++;
    const proc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    } as any;

    // Capture close handler
    proc.on.mockImplementation((event: string, cb: Function) => {
      if (event === "close") {
        if (callCount <= 1) {
          // ffmpeg call succeeds
          setTimeout(() => cb(0), 0);
        } else {
          // ffprobe call - emit stdout data first
          const dataHandler = proc.stdout.on.mock.calls.find(
            (c: any[]) => c[0] === "data",
          );
          if (dataHandler) dataHandler[1](Buffer.from(probeJson));
          setTimeout(() => cb(0), 0);
        }
      }
    });

    return proc;
  });
}

function makeOptions(overrides: Partial<OverlayOptions> = {}): OverlayOptions {
  return {
    backgroundPath: `${HOME}/video/bg.mp4`,
    placements: [
      {
        assetPath: `${HOME}/video/overlay.png`,
        startTimeSec: 2,
        endTimeSec: 8,
        position: "center",
      },
    ],
    outputPath: `${HOME}/video/output.mp4`,
    ...overrides,
  };
}

describe("asset-overlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
    vi.mocked(fs.stat).mockResolvedValue({ size: 12345 } as any);
  });

  it("rejects when no placements provided", async () => {
    const opts = makeOptions({ placements: [] });
    await expect(overlayAssets(opts)).rejects.toThrow("at least one placement is required");
  });

  it("rejects paths outside allowed directories", async () => {
    const opts = makeOptions({
      backgroundPath: "/etc/passwd",
    });
    await expect(overlayAssets(opts)).rejects.toThrow("Security");
  });

  it("rejects asset paths outside allowed directories", async () => {
    const opts = makeOptions({
      placements: [
        {
          assetPath: "/usr/local/bin/evil",
          startTimeSec: 0,
          endTimeSec: 5,
        },
      ],
    });
    await expect(overlayAssets(opts)).rejects.toThrow("Security");
  });

  it("rejects output paths outside allowed directories", async () => {
    const opts = makeOptions({
      outputPath: "/var/www/output.mp4",
    });
    await expect(overlayAssets(opts)).rejects.toThrow("Security");
  });

  it("allows paths under home directory", async () => {
    mockSpawnSuccess();
    const opts = makeOptions();
    const result = await overlayAssets(opts);
    expect(result.outputPath).toBe(`${HOME}/video/output.mp4`);
  });

  it("allows paths under /tmp", async () => {
    mockSpawnSuccess();
    const opts = makeOptions({
      backgroundPath: "/tmp/bg.mp4",
      placements: [{ assetPath: "/tmp/overlay.png", startTimeSec: 0, endTimeSec: 5 }],
      outputPath: "/tmp/out.mp4",
    });
    const result = await overlayAssets(opts);
    expect(result.outputPath).toBe("/tmp/out.mp4");
  });

  it("removes existing output when overwrite is true", async () => {
    mockSpawnSuccess();
    const opts = makeOptions();
    await overlayAssets(opts);
    expect(fs.unlink).toHaveBeenCalledWith(opts.outputPath);
  });

  it("does not remove output when overwrite is false", async () => {
    mockSpawnSuccess();
    const opts = makeOptions({ overwrite: false });
    await overlayAssets(opts);
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it("builds correct ffmpeg inputs for multiple placements", async () => {
    mockSpawnSuccess();
    const opts = makeOptions({
      placements: [
        { assetPath: `${HOME}/v/o1.png`, startTimeSec: 1, endTimeSec: 3, position: "top-left" },
        { assetPath: `${HOME}/v/o2.png`, startTimeSec: 4, endTimeSec: 7, position: "bottom-right" },
      ],
    });
    await overlayAssets(opts);

    // First spawn (ffmpeg) should have both -i args
    const firstCall = vi.mocked(spawn).mock.calls[0];
    expect(firstCall[0]).toBe("ffmpeg");
    const args = firstCall[1] as string[];
    expect(args.filter(a => a === "-i").length).toBe(3); // 1 bg + 2 overlays
  });

  it("applies scale factor in filter graph", async () => {
    mockSpawnSuccess();
    const opts = makeOptions({
      placements: [
        { assetPath: `${HOME}/v/ov.png`, startTimeSec: 0, endTimeSec: 5, scale: 0.5 },
      ],
    });
    await overlayAssets(opts);

    const ffmpegArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const filterIdx = ffmpegArgs.indexOf("-filter_complex");
    const filterGraph = ffmpegArgs[filterIdx + 1];
    expect(filterGraph).toContain("iw*0.5");
    expect(filterGraph).toContain("ih*0.5");
  });

  it("applies opacity via colorchannelmixer", async () => {
    mockSpawnSuccess();
    const opts = makeOptions({
      placements: [
        { assetPath: `${HOME}/v/ov.png`, startTimeSec: 0, endTimeSec: 5, opacity: 0.7 },
      ],
    });
    await overlayAssets(opts);

    const ffmpegArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const filterIdx = ffmpegArgs.indexOf("-filter_complex");
    const filterGraph = ffmpegArgs[filterIdx + 1];
    expect(filterGraph).toContain("colorchannelmixer=aa=0.700");
  });

  it("uses custom x/y coordinates when provided", async () => {
    mockSpawnSuccess();
    const opts = makeOptions({
      placements: [
        { assetPath: `${HOME}/v/ov.png`, startTimeSec: 0, endTimeSec: 5, x: 100, y: 200, position: "custom" },
      ],
    });
    await overlayAssets(opts);

    const ffmpegArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const filterIdx = ffmpegArgs.indexOf("-filter_complex");
    const filterGraph = ffmpegArgs[filterIdx + 1];
    expect(filterGraph).toContain("x=100:y=200");
  });

  it("returns correct output stats", async () => {
    mockSpawnSuccess("", '{"streams":[{"duration":"15.3"}]}');
    vi.mocked(fs.stat).mockResolvedValue({ size: 99999 } as any);

    const opts = makeOptions();
    const result = await overlayAssets(opts);

    expect(result.fileSizeBytes).toBe(99999);
    expect(result.durationSec).toBeCloseTo(15.3);
  });

  it("handles ffmpeg spawn error", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const proc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
      } as any;
      proc.on.mockImplementation((event: string, cb: Function) => {
        if (event === "error") {
          setTimeout(() => cb(new Error("ffmpeg not found")), 0);
        }
      });
      return proc;
    });

    const opts = makeOptions();
    await expect(overlayAssets(opts)).rejects.toThrow("Failed to spawn ffmpeg");
  });

  it("handles ffmpeg non-zero exit code", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const proc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
      } as any;
      proc.on.mockImplementation((event: string, cb: Function) => {
        if (event === "close") {
          setTimeout(() => cb(1), 0);
        }
      });
      return proc;
    });

    const opts = makeOptions();
    await expect(overlayAssets(opts)).rejects.toThrow("ffmpeg exited with code 1");
  });

  it("includes enable between clause in filter graph", async () => {
    mockSpawnSuccess();
    const opts = makeOptions({
      placements: [
        { assetPath: `${HOME}/v/ov.png`, startTimeSec: 3, endTimeSec: 10 },
      ],
    });
    await overlayAssets(opts);

    const ffmpegArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const filterIdx = ffmpegArgs.indexOf("-filter_complex");
    const filterGraph = ffmpegArgs[filterIdx + 1];
    expect(filterGraph).toContain("between(t,3,10)");
  });

  it("uses correct position presets in overlay", async () => {
    mockSpawnSuccess();
    const opts = makeOptions({
      placements: [
        { assetPath: `${HOME}/v/ov.png`, startTimeSec: 0, endTimeSec: 5, position: "top-center" },
      ],
    });
    await overlayAssets(opts);

    const ffmpegArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const filterIdx = ffmpegArgs.indexOf("-filter_complex");
    const filterGraph = ffmpegArgs[filterIdx + 1];
    expect(filterGraph).toContain("(main_w-overlay_w)/2");
    expect(filterGraph).toContain("y=10");
  });
});
