/**
 * Pitch — shared export helpers (Phase 6 / sub-issues #972 #973 #974).
 *
 * Centralizes:
 *   - Filename sanitization for `Content-Disposition` headers (allowlist
 *     `[a-zA-Z0-9._-]`, fallback `deck-<id>`). Defends against header
 *     injection + path traversal.
 *   - `htmlToPdf` — Decktape subprocess wrapper used by both deck and
 *     speaker-notes PDF exports. Always cleans temp files in `finally`,
 *     hard 60s wall timeout, kills child on AbortSignal.
 *   - `resizeImageForPptx` — `sharp` pre-resize so a 50MB PNG can never
 *     blow up a `.pptx`. ≤1920px wide, re-encodes to PNG, rejects > 5MB
 *     after resize.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import sharp from "sharp";

/** Hard timeout for any decktape invocation (ms). */
export const DEFAULT_PDF_TIMEOUT_MS = 60_000;

/** Max post-resize image bytes for `.pptx` payloads (5 MB). */
export const PPTX_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Max image edge for `.pptx` payloads. */
export const PPTX_IMAGE_MAX_DIMENSION = 1920;

/**
 * Allowlist-based filename sanitization. Anything outside `[a-zA-Z0-9._-]`
 * is replaced with `_`. Empty / fully-stripped strings fall back to
 * `deck-<id>`. Result is always ≤120 chars and never starts/ends with `.`
 * (avoids Windows reserved + hidden-file confusion).
 */
export function safeFilename(
  title: string | null | undefined,
  fallbackId: string,
  ext: string,
): string {
  const ALLOW = /[a-zA-Z0-9._-]/;
  const cleaned = (title ?? "")
    .split("")
    .map((c) => (ALLOW.test(c) ? c : "_"))
    .join("")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 120);
  const base = cleaned.length > 0 ? cleaned : `deck-${fallbackId}`;
  const dot = ext.startsWith(".") ? ext : `.${ext}`;
  return `${base}${dot}`;
}

export interface HtmlToPdfOpts {
  /** Hard timeout in ms. Defaults to 60 000. */
  timeoutMs?: number;
  /** Abort signal — kills the child + cleans temp files. */
  signal?: AbortSignal;
  /** Decktape command (default `reveal`). `generic` for the notes doc. */
  command?: "reveal" | "generic";
  /** Slide size, e.g. `1920x1080`. */
  size?: string;
  /** Override decktape binary path (testing). */
  decktapeBin?: string;
  /**
   * Override `child_process.spawn` for tests. Production path uses the
   * real `spawn` from `node:child_process`. Kept on the type so tests
   * can inject a controllable fake.
   */
  spawnImpl?: typeof spawn;
}

/**
 * Render an HTML document to a PDF via the `decktape` CLI.
 *
 * Hard rules:
 *   - 60s wall timeout — child is `SIGKILL`-ed on expiry
 *   - AbortSignal cancellation — same kill + temp cleanup path
 *   - Temp HTML + PDF files always removed in `finally`
 *   - On non-zero exit, stderr is captured + thrown as a generic Error
 *     (caller decides whether to surface details — the router masks them
 *     so external clients never see the stderr).
 */
export async function htmlToPdf(
  html: string,
  opts: HtmlToPdfOpts = {},
): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PDF_TIMEOUT_MS;
  const command = opts.command ?? "reveal";
  const size = opts.size ?? "1920x1080";
  const resolved = resolveDecktapeInvocation(opts.decktapeBin);
  const spawnFn = opts.spawnImpl ?? spawn;

  const id = randomUUID();
  const tempHtmlPath = join(tmpdir(), `openzigs-pitch-${id}.html`);
  const tempPdfPath = join(tmpdir(), `openzigs-pitch-${id}.pdf`);

  // Defence-in-depth (#977): both temp paths MUST resolve to a child of
  // `os.tmpdir()`. Anything else — a `..` traversal, a symlink redirect,
  // a Windows drive-letter swap — means the LFI guard rejects the request
  // before decktape ever sees a `file://` URL pointing at `/etc/passwd`.
  assertWithinTmpdir(tempHtmlPath);
  assertWithinTmpdir(tempPdfPath);

  // The `file://` URL form is what Decktape needs to load a local doc.
  const tempHtmlUrl = `file://${tempHtmlPath.replace(/\\/g, "/")}`;

  let child: ChildProcess | null = null;
  let timedOut = false;
  let aborted = false;

  const cleanupTemp = async (): Promise<void> => {
    await Promise.all([
      unlink(tempHtmlPath).catch(() => undefined),
      unlink(tempPdfPath).catch(() => undefined),
    ]);
  };

  try {
    await writeFile(tempHtmlPath, html, "utf8");

    const pdfBytes = await new Promise<Buffer>((resolveBuf, reject) => {
      // `--load-pause` gives the CDN-loaded Reveal.js bundle a beat to
      // execute its inline init before decktape's `page.evaluate` probes
      // for `window.Reveal`. Without it, decktape races the script tag
      // and aborts with "Unable to activate the Reveal JS DeckTape
      // plugin" — even though Reveal would be loaded a few hundred
      // milliseconds later. 2s is enough for jsdelivr-cached payloads
      // and conservative for cold cache; the overall 60 s subprocess
      // timeout is the upper bound.
      child = spawnFn(
        resolved.command,
        [
          ...resolved.prefixArgs,
          command,
          "--load-pause",
          "2000",
          "--size",
          size,
          tempHtmlUrl,
          tempPdfPath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      const stderrChunks: Buffer[] = [];
      child.stderr?.on("data", (b: Buffer) => stderrChunks.push(b));

      const timer = setTimeout(() => {
        timedOut = true;
        child?.kill("SIGKILL");
      }, timeoutMs);

      const onAbort = (): void => {
        aborted = true;
        child?.kill("SIGKILL");
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      child.once("error", (err) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        reject(err);
      });

      child.once("close", (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (timedOut) {
          reject(new Error(`PDF export timed out after ${timeoutMs}ms`));
          return;
        }
        if (aborted) {
          reject(new Error("PDF export aborted"));
          return;
        }
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8");
          reject(
            new Error(
              `decktape exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
            ),
          );
          return;
        }
        readFile(tempPdfPath).then(resolveBuf, reject);
      });
    });

    return pdfBytes;
  } finally {
    await cleanupTemp();
  }
}

/**
 * Resolve how to invoke `decktape` cross-platform.
 *
 * Background: `child_process.spawn("decktape", …)` does not resolve npm
 * `.cmd`/`.bat` shims on Windows without `shell: true` (and Node 17+
 * actively rejects them with `EINVAL` for security). The previous
 * production code that relied on a global `decktape` binary on PATH
 * therefore failed on Windows installs even when `pnpm install` had
 * placed a working `node_modules/.bin/decktape.cmd` shim.
 *
 * Strategy:
 *   1. **Preferred** — locate the package's own JS entry through
 *      `require.resolve('decktape/decktape.js')`. We then spawn
 *      `process.execPath` (the running Node binary) with that script
 *      as the first argument. This works on every OS, never needs a
 *      shell, and bypasses both the PATH lookup and the `.cmd`-shim
 *      ENOENT/EINVAL trap. Decktape's own `require()` calls keep
 *      working because Node resolves them relative to the script's
 *      real path inside `node_modules/.pnpm/...`.
 *   2. **Test override** — when callers pass `decktapeBin`, honour it
 *      verbatim and call it with no extra argv prefix. Tests inject a
 *      fake here (eg. `/usr/bin/false`) and assert spawn invocation.
 *   3. **Fallback** — when the package can't be resolved (decktape not
 *      installed, build artefact stripped), try the bare `decktape`
 *      name. On Linux/macOS PATH installs this still works; on
 *      Windows it'll surface a clear ENOENT to the caller, which the
 *      router maps to a 503 + "warm the cache" hint.
 */
function resolveDecktapeInvocation(
  override: string | undefined,
): { command: string; prefixArgs: readonly string[] } {
  if (override) {
    return { command: override, prefixArgs: [] };
  }
  try {
    const requireFromCwd = createRequire(join(process.cwd(), "package.json"));
    const entry = requireFromCwd.resolve("decktape/decktape.js");
    return { command: process.execPath, prefixArgs: [entry] };
  } catch {
    return { command: "decktape", prefixArgs: [] };
  }
}

/**
 * Throw if `candidate` does not resolve to a path inside `os.tmpdir()`,
 * including after symlink resolution.
 *
 * Sub-issue #977 — Phase 6 review noted that an attacker who could control
 * the temp filename (eg. via a future feature accepting upload-named
 * artifacts) could otherwise point decktape at `file:///etc/passwd` via a
 * `..` traversal. Phase 7 review (PR #984) hardened the original
 * lexical-only check: a symlink planted under `os.tmpdir()` and pointing
 * outside (`/tmp/evil -> /etc`) bypassed the previous `path.resolve`
 * containment check. We now resolve the parent directory through
 * `fs.realpathSync` and re-check containment against the realpath of
 * `os.tmpdir()`. The candidate's basename is appended back so the file
 * itself need not exist yet (decktape creates it).
 *
 * Defends against:
 *   - `..` traversal (`/tmp/../etc/passwd`)
 *   - sibling-prefix attacks (`/tmpfoo/x` vs `/tmp`)
 *   - absolute paths outside `tmpdir()` (`/etc/passwd`, `C:\Windows\...`)
 *   - symlink escape (`/tmp/evil -> /etc`, then candidate `/tmp/evil/passwd`)
 *
 * `os.tmpdir()` is OS-controlled and assumed trusted; we resolve its
 * realpath once per call so a symlinked tmpdir (e.g. macOS
 * `/tmp -> /private/tmp`) does not produce a false negative.
 */
export function assertWithinTmpdir(candidate: string): void {
  const tmpReal = realpathSync(tmpdir());
  const normalized = resolve(candidate);
  // Resolve the parent directory through the filesystem so a symlink
  // planted under `tmpdir()` cannot redirect us outside. We do NOT
  // realpath the candidate itself because in the production call site
  // the file does not yet exist (decktape will create it).
  const parent = dirname(normalized);
  let parentReal: string;
  try {
    parentReal = realpathSync(parent);
  } catch {
    // Parent does not exist (or a path component is not a directory) —
    // fail closed. The production path always uses `os.tmpdir()` itself
    // as the parent, which always exists.
    throw new Error(
      `pitch: temp path parent must exist inside os.tmpdir() (got ${candidate})`,
    );
  }
  const resolved = join(parentReal, basename(normalized));

  const sep = process.platform === "win32" ? "\\" : "/";
  const tmpWithSep = tmpReal.endsWith(sep) ? tmpReal : tmpReal + sep;
  // Direct equality with `tmpReal` is also rejected — we want a child
  // path, not the directory itself. `+ path.sep` defends against
  // sibling-prefix attacks (`/tmpfoo` vs `/tmp`).
  if (resolved === tmpReal || !resolved.startsWith(tmpWithSep)) {
    throw new Error(
      `pitch: temp path must be inside os.tmpdir() (got ${candidate})`,
    );
  }
}

/**
 * Pre-resize a raster image for embedding in a `.pptx`. Re-encodes to
 * PNG (strips EXIF / embedded scripts), enforces a max edge, and rejects
 * the result if it's still over the per-image cap.
 *
 * Returns the data URL plus the post-resize byte length so callers can
 * enforce a global file-size budget.
 */
export async function resizeImageForPptx(
  buffer: Buffer,
  opts: { maxEdge?: number; maxBytes?: number } = {},
): Promise<{ dataUrl: string; bytes: number }> {
  const maxEdge = opts.maxEdge ?? PPTX_IMAGE_MAX_DIMENSION;
  const maxBytes = opts.maxBytes ?? PPTX_IMAGE_MAX_BYTES;

  const resized = await sharp(buffer)
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();

  if (resized.byteLength > maxBytes) {
    throw new Error(
      `Image exceeds ${maxBytes} bytes after resize (${resized.byteLength})`,
    );
  }

  return {
    dataUrl: `data:image/png;base64,${resized.toString("base64")}`,
    bytes: resized.byteLength,
  };
}
