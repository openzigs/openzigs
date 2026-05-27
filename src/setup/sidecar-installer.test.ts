import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SidecarInstaller, SIDECAR_NAMES } from "./sidecar-installer.js";

describe("SidecarInstaller", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sci-"));
    await fs.mkdir(path.join(repoRoot, "sidecars"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("lists all 8 known sidecars with description", async () => {
    const installer = new SidecarInstaller({ repoRoot });
    const statuses = await installer.listStatus();
    expect(statuses).toHaveLength(SIDECAR_NAMES.length);
    expect(statuses.map((s) => s.name).sort()).toEqual(
      [...SIDECAR_NAMES].sort(),
    );
    for (const s of statuses) {
      expect(s.description).toBeTruthy();
    }
  });

  it("marks a sidecar installed when server.py + venv both exist", async () => {
    const dir = path.join(repoRoot, "sidecars", "audio");
    await fs.mkdir(path.join(dir, "venv"), { recursive: true });
    await fs.writeFile(path.join(dir, "server.py"), "# stub");
    const installer = new SidecarInstaller({ repoRoot });
    const status = await installer.statusOf("audio");
    expect(status.installed).toBe(true);
    expect(status.hasServer).toBe(true);
    expect(status.hasVenv).toBe(true);
  });

  it("marks a sidecar uninstalled if either component is missing", async () => {
    const dir = path.join(repoRoot, "sidecars", "image-gen");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "server.py"), "# no venv");
    const installer = new SidecarInstaller({ repoRoot });
    const s = await installer.statusOf("image-gen");
    expect(s.installed).toBe(false);
    expect(s.hasServer).toBe(true);
    expect(s.hasVenv).toBe(false);
  });

  it("returns the mac install script on darwin", () => {
    const installer = new SidecarInstaller({
      repoRoot,
      osInfo: { platform: "darwin", arch: "arm64" },
    });
    const { script, supported } = installer.installScript();
    expect(supported).toBe(true);
    expect(script).toMatch(/start-mac-sidecars\.sh$/);
  });

  it("returns the cuda script on linux", () => {
    const installer = new SidecarInstaller({
      repoRoot,
      osInfo: { platform: "linux", arch: "x64" },
    });
    const { script, supported } = installer.installScript();
    expect(supported).toBe(true);
    expect(script).toMatch(/setup-cuda-sidecars\.sh$/);
  });

  it("reports unsupported on win32", () => {
    const installer = new SidecarInstaller({
      repoRoot,
      osInfo: { platform: "win32", arch: "x64" },
    });
    const { supported } = installer.installScript();
    expect(supported).toBe(false);
  });

  it("statusOf rejects unknown sidecar names (no path traversal)", async () => {
    const installer = new SidecarInstaller({ repoRoot });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      installer.statusOf("../../etc/passwd" as any),
    ).rejects.toThrow(/unknown sidecar/);
  });

  it("streamInstall rejects unknown sidecar names", async () => {
    const installer = new SidecarInstaller({ repoRoot });
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const _ of installer.streamInstall("../bad" as any)) {
        void _;
      }
    }).rejects.toThrow(/unknown sidecar/);
  });

  it("streamInstall yields error + done when script missing", async () => {
    const installer = new SidecarInstaller({
      repoRoot,
      osInfo: { platform: "darwin", arch: "arm64" },
    });
    const events = [];
    for await (const e of installer.streamInstall("audio")) events.push(e);
    expect(events.some((e) => e.kind === "error")).toBe(true);
    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    expect((done as { code: number }).code).toBe(1);
  });

  it("streamInstall yields error + done on unsupported platform", async () => {
    const installer = new SidecarInstaller({
      repoRoot,
      osInfo: { platform: "win32", arch: "x64" },
    });
    const events = [];
    for await (const e of installer.streamInstall("audio")) events.push(e);
    expect(events[0]!.kind).toBe("error");
    expect(events.at(-1)!.kind).toBe("done");
  });

  it("streamInstall runs the script and emits stdout + done(0)", async () => {
    const script = path.join(repoRoot, "scripts", "start-mac-sidecars.sh");
    await fs.writeFile(script, "#!/bin/bash\necho hello-$1\nexit 0\n", {
      mode: 0o755,
    });
    const installer = new SidecarInstaller({
      repoRoot,
      osInfo: { platform: "darwin", arch: "arm64" },
    });
    const events = [];
    for await (const e of installer.streamInstall("audio")) events.push(e);
    const logs = events.filter((e) => e.kind === "log");
    expect(
      logs.some((l) => "message" in l && l.message.includes("hello-audio")),
    ).toBe(true);
    const done = events.find((e) => e.kind === "done");
    expect((done as { code: number }).code).toBe(0);
  });
});
