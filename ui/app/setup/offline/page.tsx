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
import { fetchJson } from "@/lib/api";
import { CheckCircle2, AlertCircle, ChevronRight, ChevronLeft, Loader2 } from "lucide-react";

type OfflineStep = "detect" | "recommend" | "install" | "test" | "switch";
const STEPS: OfflineStep[] = ["detect", "recommend", "install", "test", "switch"];

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
  vllm?: { reachable: boolean; baseUrl?: string; models?: string[] };
}

interface ProviderResponse {
  provider: { type: string; baseUrl?: string; modelId?: string } | null;
}

const INSTALL_CMDS: Record<string, { label: string; cmd: string }[]> = {
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
    { label: "Install Ollama", cmd: "curl -fsSL https://ollama.com/install.sh | sh" },
    { label: "Pull recommended model", cmd: "ollama pull {{model}}" },
  ],
  unknown: [{ label: "Visit ollama.com", cmd: "https://ollama.com/download" }],
};

export default function OfflineSetupPage() {
  const [step, setStep] = useState<OfflineStep>("detect");
  const [platform, setPlatform] = useState<PlatformResponse | null>(null);
  const [autodetect, setAutodetect] = useState<AutodetectResponse | null>(null);
  const [provider, setProvider] = useState<ProviderResponse["provider"] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPlatform();
  }, [loadPlatform]);

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
      setError(e instanceof Error ? e.message : String(e));
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [platform, autodetect, loadPlatform]);

  const installCmds = useMemo(() => {
    const os = platform?.platform.os ?? "unknown";
    const list = INSTALL_CMDS[os] ?? INSTALL_CMDS.unknown;
    return list.map((c) => ({
      ...c,
      cmd: c.cmd.replace("{{model}}", platform?.recommended.modelId ?? "gemma4:9b"),
    }));
  }, [platform]);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Offline setup wizard</h1>
        <p className="text-sm text-zinc-400">
          Get openzigs running fully on your own hardware — no cloud calls.
        </p>
      </header>

      {alreadyOffline && !done && (
        <div className="mb-6 rounded-lg border border-emerald-700 bg-emerald-900/30 p-4 text-emerald-200">
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-5 w-5" /> You&apos;re already running offline
          </div>
          <p className="mt-1 text-sm">
            Active provider: <code>{provider?.modelId ?? "(model unset)"}</code> @{" "}
            <code>{provider?.baseUrl ?? "(local)"}</code>
          </p>
          <button
            onClick={() => {
              setStep("detect");
              setDone(false);
              void loadPlatform();
            }}
            className="mt-2 rounded bg-emerald-700 px-3 py-1 text-sm text-white hover:bg-emerald-600"
          >
            Re-run wizard
          </button>
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-700 bg-red-900/30 p-3 text-sm text-red-200">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <ol className="mb-6 flex items-center gap-2 text-xs text-zinc-500">
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={`rounded px-2 py-1 ${
              i === idx
                ? "bg-blue-700 text-white"
                : i < idx
                  ? "bg-zinc-800 text-zinc-400"
                  : "bg-zinc-900 text-zinc-600"
            }`}
          >
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      <section className="rounded-lg border border-zinc-800 bg-zinc-950 p-6">
        {step === "detect" && (
          <div>
            <h2 className="mb-2 text-lg font-semibold">1. Detect your hardware</h2>
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : platform ? (
              <ul className="space-y-1 text-sm text-zinc-300">
                <li>OS: {platform.platform.os} ({platform.platform.arch})</li>
                <li>Chip: {platform.platform.chip ?? "(unknown)"}</li>
                <li>Memory: {platform.memoryGb} GB</li>
                <li>GPU: {platform.platform.gpuKind}{platform.largestGpuVramGb ? ` (${platform.largestGpuVramGb} GB VRAM)` : ""}</li>
                <li>Recommended backend: {platform.platform.recommendedBackend}</li>
              </ul>
            ) : (
              <p className="text-sm text-zinc-500">No platform info yet.</p>
            )}
          </div>
        )}

        {step === "recommend" && platform && (
          <div>
            <h2 className="mb-2 text-lg font-semibold">2. Recommended model</h2>
            <p className="text-2xl font-mono">{platform.recommended.modelId}</p>
            <p className="mt-1 text-sm text-zinc-400">
              Quantisation: {platform.recommended.quantisation}
            </p>
            <p className="mt-2 text-sm">{platform.recommended.rationale}</p>
            <p className="mt-2 text-xs text-zinc-500">
              Minimum memory: {Math.round(platform.recommended.minMemoryBytes / 1024 / 1024 / 1024)} GB
            </p>
          </div>
        )}

        {step === "install" && (
          <div>
            <h2 className="mb-2 text-lg font-semibold">3. Install commands</h2>
            <p className="mb-3 text-sm text-zinc-400">
              Run these in your terminal. Skip any you&apos;ve already done.
            </p>
            <ul className="space-y-2">
              {installCmds.map((c) => (
                <li key={c.label}>
                  <p className="text-xs text-zinc-500">{c.label}</p>
                  <pre className="rounded bg-zinc-900 p-2 text-xs text-zinc-200 overflow-x-auto">
                    {c.cmd}
                  </pre>
                </li>
              ))}
            </ul>
          </div>
        )}

        {step === "test" && (
          <div>
            <h2 className="mb-2 text-lg font-semibold">4. Test connection</h2>
            <button
              onClick={runAutodetect}
              disabled={loading}
              className="rounded bg-blue-700 px-3 py-1 text-sm text-white hover:bg-blue-600 disabled:opacity-50"
            >
              {loading ? "Probing..." : "Probe local endpoints"}
            </button>
            {autodetect && (
              <ul className="mt-3 space-y-1 text-sm">
                <li>
                  Ollama: {autodetect.ollama?.reachable ? "✅ reachable" : "❌ not reachable"}
                </li>
                <li>
                  vLLM: {autodetect.vllm?.reachable ? "✅ reachable" : "❌ not reachable"}
                </li>
              </ul>
            )}
          </div>
        )}

        {step === "switch" && (
          <div>
            <h2 className="mb-2 text-lg font-semibold">5. Switch to local provider</h2>
            {done ? (
              <div className="rounded border border-emerald-700 bg-emerald-900/30 p-3 text-sm text-emerald-200">
                Switched to local provider. Visit the{" "}
                <Link href="/admin" className="underline">admin panel</Link> to verify.
              </div>
            ) : (
              <button
                onClick={switchToLocal}
                disabled={loading || !autodetect}
                className="rounded bg-emerald-700 px-3 py-1 text-sm text-white hover:bg-emerald-600 disabled:opacity-50"
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
          className="flex items-center gap-1 rounded px-3 py-1 text-sm text-zinc-300 disabled:opacity-30"
        >
          <ChevronLeft className="h-4 w-4" /> Back
        </button>
        <button
          onClick={() => setStep(STEPS[Math.min(STEPS.length - 1, idx + 1)] as OfflineStep)}
          disabled={idx === STEPS.length - 1}
          className="flex items-center gap-1 rounded bg-zinc-800 px-3 py-1 text-sm text-zinc-100 hover:bg-zinc-700 disabled:opacity-30"
        >
          Next <ChevronRight className="h-4 w-4" />
        </button>
      </nav>
    </div>
  );
}
