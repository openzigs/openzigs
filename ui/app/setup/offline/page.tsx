"use client";

/**
 * Offline setup wizard (Issue #1061 / Epic #1053).
 *
 * Five-step flow:
 *   1. Detect — current platform + recommended Gemma 4 variant.
 *   2. Recommend — shows the variant + minimum memory required.
 *   3. Install — per-OS install commands (Windows winget / macOS brew / Linux curl).
 *   4. Test connection — calls `/api/admin/local-llm/autodetect`.
 *   5. Switch to local — calls `POST /api/admin/local-llm/provider`.
 *
 * Idempotent: if already running on a local provider the wizard shows a
 * "you're already running offline" banner with a Re-run button.
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/api";
import {
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  ChevronLeft,
  Loader2,
} from "lucide-react";

type OfflineStep = "detect" | "recommend" | "install" | "test" | "switch";
const STEPS: OfflineStep[] = [
  "detect",
  "recommend",
  "install",
  "test",
  "switch",
];

type InstallOs = "windows" | "macos" | "linux";
const INSTALL_OS_OPTIONS: InstallOs[] = ["windows", "macos", "linux"];
const INSTALL_OS_LABEL: Record<InstallOs, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

interface PlatformResponse {
  platform: {
    os: "windows" | "macos" | "linux" | "unknown";
    arch: string;
    chip: string | null;
    gpuKind: "nvidia" | "apple-silicon" | "amd" | "cpu";
    recommendedBackend: "ollama-mlx" | "ollama-cuda" | "ollama-cpu";
    detectedAt: string;
  };
  recommended: {
    modelId: string;
    quantisation: string;
    rationale: string;
    minMemoryBytes: number;
  };
  memoryGb: number;
  unifiedMemoryGb: number | null;
  largestGpuVramGb: number | null;
}

interface AutodetectResponse {
  ollama?: { reachable: boolean; baseUrl?: string; models?: string[] };
  vllm?: {
    reachable: boolean;
    baseUrl?: string;
    models?: string[];
    /** Set when the host platform cannot run vLLM (issue #1075). */
    unsupported?: boolean;
    /** Human-readable reason; surfaced verbatim in the wizard. */
    reason?: string;
  };
}

interface ProviderResponse {
  provider: { type: string; baseUrl?: string; modelId?: string } | null;
}

const INSTALL_CMDS: Record<
  InstallOs | "unknown",
  { label: string; cmd: string }[]
> = {
  windows: [
    { label: "Install Ollama (winget)", cmd: "winget install Ollama.Ollama" },
    { label: "Pull recommended model", cmd: "ollama pull {{model}}" },
  ],
  macos: [
    { label: "Install Ollama (brew)", cmd: "brew install ollama" },
    { label: "Start Ollama with MLX", cmd: "OLLAMA_USE_MLX=1 ollama serve" },
    { label: "Pull recommended model", cmd: "ollama pull {{model}}" },
  ],
  linux: [
    {
      label: "Install Ollama",
      cmd: "curl -fsSL https://ollama.com/install.sh | sh",
    },
    { label: "Pull recommended model", cmd: "ollama pull {{model}}" },
  ],
  unknown: [{ label: "Visit ollama.com", cmd: "https://ollama.com/download" }],
};

/**
 * Bug #1064-#4 — Sanitise error messages so we never dump a raw HTML 404 page
 * (or other server response) into the UI. We accept a short plain-text JSON
 * `error` / `message` field; everything else collapses to a generic notice.
 */
function sanitiseError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  // `fetchJson` formats network errors as `${url} failed with ${status}: ${detail}`.
  // Detail is the most useful piece for the user, so try to recover it.
  const detail = raw.includes("failed with")
    ? raw.split(":").slice(1).join(":").trim()
    : raw;
  if (!detail) return fallback;
  // Refuse anything that looks like HTML or is unreasonably long.
  if (detail.length > 200 || detail.includes("<") || detail.includes("</")) {
    return fallback;
  }
  return detail;
}

export default function OfflineSetupPage() {
  const router = useRouter();
  const [step, setStep] = useState<OfflineStep>("detect");
  const [platform, setPlatform] = useState<PlatformResponse | null>(null);
  const [autodetect, setAutodetect] = useState<AutodetectResponse | null>(null);
  const [provider, setProvider] = useState<ProviderResponse["provider"] | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [installOs, setInstallOs] = useState<InstallOs | null>(null);

  const idx = STEPS.indexOf(step);
  const alreadyOffline = provider?.type === "local-copilot";

  const loadPlatform = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, prov] = await Promise.all([
        fetchJson<PlatformResponse>("/api/system/platform"),
        fetchJson<ProviderResponse>("/api/admin/local-llm/provider").catch(
          () => ({ provider: null }) as ProviderResponse,
        ),
      ]);
      setPlatform(p);
      setProvider(prov.provider);
    } catch (e) {
      setError(sanitiseError(e, "Could not load platform info."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPlatform();
  }, [loadPlatform]);

  // Default the install OS picker to the detected OS once it lands.
  useEffect(() => {
    if (installOs != null) return;
    const detected = platform?.platform.os;
    if (detected && detected !== "unknown") {
      setInstallOs(detected);
    }
  }, [platform, installOs]);

  const runAutodetect = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchJson<AutodetectResponse>(
        "/api/admin/local-llm/autodetect",
        { method: "POST", body: "{}" },
      );
      setAutodetect(r);
    } catch (e) {
      setError(sanitiseError(e, "Could not reach autodetect endpoint."));
    } finally {
      setLoading(false);
    }
  }, []);

  const switchToLocal = useCallback(async () => {
    if (!platform || !autodetect) return;
    setLoading(true);
    setError(null);
    try {
      const reachable = autodetect.ollama?.reachable
        ? { baseUrl: autodetect.ollama.baseUrl ?? "http://127.0.0.1:11434" }
        : autodetect.vllm?.reachable
          ? { baseUrl: autodetect.vllm.baseUrl ?? "http://127.0.0.1:8000" }
          : null;
      if (!reachable) {
        setError(
          "No reachable local provider found. Install + start Ollama or vLLM, then re-run the test.",
        );
        return;
      }
      await fetchJson("/api/admin/local-llm/provider", {
        method: "POST",
        body: JSON.stringify({
          type: "local-copilot",
          baseUrl: reachable.baseUrl,
          modelId: platform.recommended.modelId,
        }),
      });
      setDone(true);
      await loadPlatform();
    } catch (e) {
      setError(sanitiseError(e, "Could not switch to local provider."));
    } finally {
      setLoading(false);
    }
  }, [platform, autodetect, loadPlatform]);

  const activeOs: InstallOs | "unknown" = useMemo(() => {
    if (installOs) return installOs;
    const detected = platform?.platform.os;
    if (detected && detected !== "unknown") return detected;
    return "unknown";
  }, [installOs, platform]);

  const installCmds = useMemo(() => {
    const list = INSTALL_CMDS[activeOs] ?? INSTALL_CMDS.unknown;
    return list.map((c) => ({
      ...c,
      cmd: c.cmd.replace(
        "{{model}}",
        platform?.recommended.modelId ?? "gemma4:9b",
      ),
    }));
  }, [activeOs, platform]);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          Offline setup wizard
        </h1>
        <p className="text-sm text-muted-foreground">
          Get openzigs running fully on your own hardware — no cloud calls.
        </p>
      </header>

      {alreadyOffline && !done && (
        <div className="mb-6 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4 text-emerald-700 dark:text-emerald-200">
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-5 w-5" /> You&apos;re already running
            offline
          </div>
          <p className="mt-1 text-sm">
            Active provider: <code>{provider?.modelId ?? "(model unset)"}</code>{" "}
            @ <code>{provider?.baseUrl ?? "(local)"}</code>
          </p>
          <button
            onClick={() => {
              setStep("detect");
              setDone(false);
              void loadPlatform();
            }}
            className="mt-2 rounded bg-emerald-600 px-3 py-1 text-sm text-white hover:bg-emerald-500"
          >
            Re-run wizard
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-200"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <ol className="mb-6 flex items-center gap-2 text-xs text-muted-foreground">
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={`rounded px-2 py-1 ${
              i === idx
                ? "bg-primary text-primary-foreground"
                : i < idx
                  ? "bg-muted text-muted-foreground"
                  : "bg-card text-muted-foreground/60 border border-border"
            }`}
          >
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      <section className="rounded-lg border border-border bg-card text-card-foreground p-6 shadow-sm">
        {step === "detect" && (
          <div>
            <h2 className="mb-2 text-lg font-semibold">
              1. Detect your hardware
            </h2>
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : platform ? (
              <ul className="space-y-1 text-sm text-card-foreground/80">
                <li>
                  OS: {platform.platform.os} ({platform.platform.arch})
                </li>
                <li>Chip: {platform.platform.chip ?? "(unknown)"}</li>
                <li>Memory: {platform.memoryGb} GB</li>
                <li>
                  GPU: {platform.platform.gpuKind}
                  {platform.largestGpuVramGb
                    ? ` (${platform.largestGpuVramGb} GB VRAM)`
                    : ""}
                </li>
                <li>
                  Recommended backend: {platform.platform.recommendedBackend}
                </li>
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No platform info yet.
              </p>
            )}
          </div>
        )}

        {step === "recommend" && platform && (
          <div>
            <h2 className="mb-2 text-lg font-semibold">2. Recommended model</h2>
            <p className="text-2xl font-mono">{platform.recommended.modelId}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Quantisation: {platform.recommended.quantisation}
            </p>
            <p className="mt-2 text-sm">{platform.recommended.rationale}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Minimum memory:{" "}
              {Math.round(
                platform.recommended.minMemoryBytes / 1024 / 1024 / 1024,
              )}{" "}
              GB
            </p>
          </div>
        )}

        {step === "install" && (
          <div>
            <h2 className="mb-2 text-lg font-semibold">3. Install commands</h2>
            <p className="mb-3 text-sm text-muted-foreground">
              Run these in your terminal. Skip any you&apos;ve already done.
            </p>
            {/* Bug #1064-#5: explicit OS picker so users on a misdetected
                or shared host can still get the right install commands. */}
            <div
              role="tablist"
              aria-label="Install commands by OS"
              className="mb-3 inline-flex rounded-md border border-border bg-muted p-0.5"
            >
              {INSTALL_OS_OPTIONS.map((os) => {
                const selected = activeOs === os;
                return (
                  <button
                    key={os}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setInstallOs(os)}
                    className={`rounded px-3 py-1 text-xs font-medium transition ${
                      selected
                        ? "bg-card text-card-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {INSTALL_OS_LABEL[os]}
                  </button>
                );
              })}
            </div>
            <ul className="space-y-2">
              {installCmds.map((c) => (
                <li key={c.label}>
                  <p className="text-xs text-muted-foreground">{c.label}</p>
                  <pre className="rounded bg-muted p-2 text-xs text-foreground overflow-x-auto">
                    {c.cmd}
                  </pre>
                </li>
              ))}
            </ul>
            {activeOs === "macos" && (
              <div
                className="mt-4 rounded border border-blue-500/30 bg-blue-500/5 p-3 text-xs text-blue-700 dark:text-blue-300"
                role="note"
                data-testid="wizard-remote-ollama-tip"
              >
                <p className="font-medium">
                  Have a second Mac? Run Ollama there instead
                </p>
                <p className="mt-1">
                  A peer Mac with 36 GB+ unified memory can host{" "}
                  <code>gemma4:31b</code> at INT4 and keep this Mac free. After
                  install, go to{" "}
                  <Link href="/admin" className="underline">
                    Admin → Ollama Node
                  </Link>{" "}
                  to point openzigs at the LAN peer. See{" "}
                  <a href="/docs/REMOTE_OLLAMA_SETUP.md" className="underline">
                    docs/REMOTE_OLLAMA_SETUP.md
                  </a>
                  .
                </p>
              </div>
            )}
          </div>
        )}

        {step === "test" && (
          <div>
            <h2 className="mb-2 text-lg font-semibold">4. Test connection</h2>
            <button
              onClick={runAutodetect}
              disabled={loading}
              className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Probing..." : "Probe local endpoints"}
            </button>
            {autodetect && (
              <ul className="mt-3 space-y-1 text-sm">
                <li>
                  Ollama:{" "}
                  {autodetect.ollama?.reachable
                    ? "✅ reachable"
                    : "❌ not reachable"}
                </li>
                <li>
                  vLLM:{" "}
                  {autodetect.vllm?.unsupported
                    ? `⛔ ${autodetect.vllm.reason ?? "not supported on this platform"}`
                    : autodetect.vllm?.reachable
                      ? "✅ reachable"
                      : "❌ not reachable"}
                </li>
              </ul>
            )}
          </div>
        )}

        {step === "switch" && (
          <div>
            <h2 className="mb-2 text-lg font-semibold">
              5. Switch to local provider
            </h2>
            {done ? (
              <div className="rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-200">
                Switched to local provider. Visit the{" "}
                <Link href="/admin" className="underline">
                  admin panel
                </Link>{" "}
                to verify.
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => router.push("/admin")}
                    className="rounded bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-500"
                  >
                    Go to admin
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={switchToLocal}
                disabled={loading || !autodetect}
                className="rounded bg-emerald-600 px-3 py-1 text-sm text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {loading ? "Switching..." : "Switch openzigs to local"}
              </button>
            )}
          </div>
        )}
      </section>

      <nav className="mt-6 flex justify-between">
        <button
          onClick={() => setStep(STEPS[Math.max(0, idx - 1)] as OfflineStep)}
          disabled={idx === 0}
          className="flex items-center gap-1 rounded px-3 py-1 text-sm text-muted-foreground disabled:opacity-30"
        >
          <ChevronLeft className="h-4 w-4" /> Back
        </button>
        <button
          onClick={() =>
            setStep(STEPS[Math.min(STEPS.length - 1, idx + 1)] as OfflineStep)
          }
          disabled={idx === STEPS.length - 1}
          className="flex items-center gap-1 rounded bg-muted px-3 py-1 text-sm text-foreground hover:bg-muted/80 disabled:opacity-30"
        >
          Next <ChevronRight className="h-4 w-4" />
        </button>
      </nav>
    </div>
  );
}
