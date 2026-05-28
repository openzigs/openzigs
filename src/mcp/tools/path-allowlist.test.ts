import { describe, expect, it } from "vitest";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertPathAllowed,
  PathNotAllowedError,
  sniffFileMime,
} from "./path-allowlist.js";

const RENDERS_DIR = path.join(
  os.homedir(),
  ".openzigs",
  "renders",
  "__allowlist_tests__",
);

const MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const BMP = Buffer.from([0x42, 0x4d, 0x00, 0x00]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

const write = async (name: string, body: Buffer): Promise<string> => {
  await fsPromises.mkdir(RENDERS_DIR, { recursive: true });
  const p = path.join(RENDERS_DIR, name);
  await fsPromises.writeFile(p, body);
  return p;
};

describe("assertPathAllowed", () => {
  it("accepts a file inside ~/.openzigs/renders", async () => {
    const file = await write(`ok-${Date.now()}.mp4`, MP4);
    await expect(assertPathAllowed(file)).resolves.toBe(file);
  });

  it("rejects /etc/passwd", async () => {
    await expect(assertPathAllowed("/etc/passwd")).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });

  it("rejects ~/.openzigs/auth.json (deny-listed basename)", async () => {
    const target = path.join(os.homedir(), ".openzigs", "auth.json");
    await expect(assertPathAllowed(target)).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });

  it("rejects ~/.openzigs/config.json even though it sits in openzigs home", async () => {
    const target = path.join(os.homedir(), ".openzigs", "config.json");
    await expect(assertPathAllowed(target)).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });

  it("follows symlinks and rejects ones pointing outside the allowlist", async () => {
    const outsideDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "openzigs-escape-"),
    );
    const outsideFile = path.join(outsideDir, "secret.mp4");
    await fsPromises.writeFile(outsideFile, MP4);
    const link = await write(`escape-${Date.now()}.mp4`, Buffer.alloc(0));
    await fsPromises.rm(link);
    await fsPromises.symlink(outsideFile, link);
    await expect(assertPathAllowed(link)).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
    await fsPromises.rm(outsideDir, { recursive: true, force: true });
  });

  it("accepts paths under caller-supplied extra roots", async () => {
    const extraDirRaw = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "openzigs-extra-"),
    );
    const extraDir = await fsPromises.realpath(extraDirRaw);
    const file = path.join(extraDir, "video.mp4");
    await fsPromises.writeFile(file, MP4);
    await expect(
      assertPathAllowed(file, { extraRoots: [extraDir] }),
    ).resolves.toBe(file);
    await fsPromises.rm(extraDir, { recursive: true, force: true });
  });

  it("rejects empty / missing input", async () => {
    await expect(assertPathAllowed("")).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });
});

describe("sniffFileMime", () => {
  it.each([
    ["mp4", MP4, "video/mp4"],
    ["jpeg", JPEG, "image/jpeg"],
    ["png", PNG, "image/png"],
    ["gif", GIF, "image/gif"],
    ["bmp", BMP, "image/bmp"],
    ["webm-mkv", WEBM, "video/webm"],
  ])("detects %s", async (label, body, expected) => {
    const f = await write(`sniff-${label}-${Date.now()}`, body);
    await expect(sniffFileMime(f)).resolves.toBe(expected);
  });

  it("returns null for arbitrary bytes", async () => {
    const f = await write(
      `garbage-${Date.now()}`,
      Buffer.from("not a media file at all"),
    );
    await expect(sniffFileMime(f)).resolves.toBeNull();
  });
});

describe("module export sanity", () => {
  it("exposes the expected named exports", () => {
    expect(typeof assertPathAllowed).toBe("function");
    expect(typeof sniffFileMime).toBe("function");
  });
});
