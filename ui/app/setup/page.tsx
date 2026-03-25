"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/api";
import { CheckCircle2, AlertCircle, ChevronRight, ChevronLeft, Loader2, SkipForward, ExternalLink } from "lucide-react";

/* ── Types ─────────────────────────────────────────────────── */

interface SetupStatus {
  setupComplete: boolean;
  hasConfig: boolean;
  hasEnvFile: boolean;
  configPath: string;
}

interface Prerequisites {
  node: { ok: boolean; version: string; required: string };
  docker: { available: boolean; version: string | null };
  git: { available: boolean; version: string | null };
  platform: {
    os: string;
    arch: string;
    sidecarsSupported: boolean;
    chromePath: string | null;
  };
}

type WizardStep = "welcome" | "prereqs" | "auth" | "platform" | "config" | "complete";

const STEPS: WizardStep[] = ["welcome", "prereqs", "auth", "platform", "config", "complete"];

/* ── Main Component ────────────────────────────────────────── */

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>("welcome");
  const [prereqs, setPrereqs] = useState<Prerequisites | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Config state — all fields optional (user can skip)
  const [githubToken, setGithubToken] = useState("");
  const [telegramToken, setTelegramToken] = useState("");
  const [discordToken, setDiscordToken] = useState("");

  const currentIndex = STEPS.indexOf(step);

  // Check if setup is already complete on mount
  useEffect(() => {
    fetchJson<SetupStatus>("/api/setup/status")
      .then((status) => {
        if (status.setupComplete) {
          router.push("/");
        }
      })
      .catch(() => {
        // Setup API not yet available — stay on wizard
      });
  }, [router]);

  // Load prerequisites when that step is reached
  useEffect(() => {
    if (step === "prereqs" && !prereqs) {
      setLoading(true);
      fetchJson<Prerequisites>("/api/setup/prerequisites")
        .then(setPrereqs)
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setLoading(false));
    }
  }, [step, prereqs]);

  const goNext = useCallback(() => {
    const next = STEPS[currentIndex + 1];
    if (next) setStep(next);
  }, [currentIndex]);

  const goBack = useCallback(() => {
    const prev = STEPS[currentIndex - 1];
    if (prev) setStep(prev);
  }, [currentIndex]);

  const saveConfig = async () => {
    setSaving(true);
    setError(null);
    try {
      const configUpdates: Record<string, unknown> = {};

      if (githubToken.trim()) {
        configUpdates.copilot = { githubToken: githubToken.trim() };
      }
      if (telegramToken.trim()) {
        configUpdates.channels = {
          ...(configUpdates.channels as Record<string, unknown> ?? {}),
          telegram: { enabled: true, token: telegramToken.trim() },
        };
      }
      if (discordToken.trim()) {
        configUpdates.channels = {
          ...(configUpdates.channels as Record<string, unknown> ?? {}),
          discord: { enabled: true, token: discordToken.trim() },
        };
      }

      if (Object.keys(configUpdates).length > 0) {
        await fetchJson("/api/setup/config", {
          method: "POST",
          body: JSON.stringify(configUpdates),
        });
      }

      await fetchJson("/api/setup/complete", { method: "POST" });
      goNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const finishSetup = () => {
    router.push("/");
  };

  /* ── Render ───────────────────────────────────────────── */

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        {/* Progress bar */}
        <div className="mb-8">
          <div className="flex justify-between mb-2">
            {STEPS.map((s, i) => (
              <div
                key={s}
                className={`h-1.5 flex-1 mx-0.5 rounded-full transition-colors ${
                  i <= currentIndex ? "bg-emerald-500" : "bg-zinc-800"
                }`}
              />
            ))}
          </div>
          <p className="text-xs text-zinc-500 text-center">
            Step {currentIndex + 1} of {STEPS.length}
          </p>
        </div>

        {/* Step content */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 min-h-[400px] flex flex-col">
          {step === "welcome" && <WelcomeStep />}
          {step === "prereqs" && (
            <PrereqsStep prereqs={prereqs} loading={loading} />
          )}
          {step === "auth" && (
            <AuthStep
              githubToken={githubToken}
              onGithubTokenChange={setGithubToken}
            />
          )}
          {step === "platform" && prereqs && (
            <PlatformStep platform={prereqs.platform} />
          )}
          {step === "config" && (
            <ConfigStep
              telegramToken={telegramToken}
              discordToken={discordToken}
              onTelegramChange={setTelegramToken}
              onDiscordChange={setDiscordToken}
            />
          )}
          {step === "complete" && <CompleteStep />}

          {error && (
            <div className="mt-4 p-3 bg-red-900/30 border border-red-700 rounded text-red-300 text-sm">
              {error}
            </div>
          )}

          {/* Navigation */}
          <div className="mt-auto pt-6 flex justify-between items-center">
            <div>
              {currentIndex > 0 && step !== "complete" && (
                <button
                  onClick={goBack}
                  className="flex items-center gap-1 text-zinc-400 hover:text-zinc-200 text-sm transition-colors"
                >
                  <ChevronLeft size={16} /> Back
                </button>
              )}
            </div>

            <div className="flex items-center gap-3">
              {step !== "complete" && step !== "welcome" && step !== "config" && (
                <button
                  onClick={goNext}
                  className="flex items-center gap-1 text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
                >
                  <SkipForward size={14} /> Skip
                </button>
              )}

              {step === "welcome" && (
                <button
                  onClick={goNext}
                  className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2.5 rounded-lg font-medium transition-colors"
                >
                  Get Started <ChevronRight size={16} />
                </button>
              )}

              {step === "prereqs" && (
                <button
                  onClick={goNext}
                  className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2.5 rounded-lg font-medium transition-colors"
                >
                  Continue <ChevronRight size={16} />
                </button>
              )}

              {step === "auth" && (
                <button
                  onClick={goNext}
                  className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2.5 rounded-lg font-medium transition-colors"
                >
                  Continue <ChevronRight size={16} />
                </button>
              )}

              {step === "platform" && (
                <button
                  onClick={goNext}
                  className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2.5 rounded-lg font-medium transition-colors"
                >
                  Continue <ChevronRight size={16} />
                </button>
              )}

              {step === "config" && (
                <button
                  onClick={saveConfig}
                  disabled={saving}
                  className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white px-6 py-2.5 rounded-lg font-medium transition-colors"
                >
                  {saving ? (
                    <><Loader2 size={16} className="animate-spin" /> Saving...</>
                  ) : (
                    <>Finish Setup <ChevronRight size={16} /></>
                  )}
                </button>
              )}

              {step === "complete" && (
                <button
                  onClick={finishSetup}
                  className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2.5 rounded-lg font-medium transition-colors"
                >
                  Open OpenZigs <ChevronRight size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Step Components ───────────────────────────────────────── */

function WelcomeStep() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center">
      <h1 className="text-3xl font-bold mb-3">Welcome to OpenZigs</h1>
      <p className="text-zinc-400 max-w-md">
        Let&apos;s get your local AI agent platform set up. This wizard will check
        prerequisites, configure authentication, and help you get started.
      </p>
      <p className="text-zinc-500 text-sm mt-4">
        You can skip any step and configure everything later in the Admin panel.
      </p>
    </div>
  );
}

function PrereqsStep({ prereqs, loading }: { prereqs: Prerequisites | null; loading: boolean }) {
  if (loading || !prereqs) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-zinc-400" />
        <span className="ml-3 text-zinc-400">Checking prerequisites...</span>
      </div>
    );
  }

  return (
    <div className="flex-1">
      <h2 className="text-2xl font-bold mb-2">Prerequisites</h2>
      <p className="text-zinc-400 mb-6 text-sm">
        Checking your system for required dependencies.
      </p>

      <div className="space-y-3">
        <PrereqRow
          label="Node.js"
          ok={prereqs.node.ok}
          detail={`${prereqs.node.version} (requires ${prereqs.node.required})`}
        />
        <PrereqRow
          label="Docker"
          ok={prereqs.docker.available}
          detail={prereqs.docker.version ?? "Not found — optional, needed for sidecars"}
          optional
        />
        <PrereqRow
          label="Git"
          ok={prereqs.git.available}
          detail={prereqs.git.version ?? "Not found — optional, needed for memory"}
          optional
        />
        <PrereqRow
          label="Chrome/Chromium"
          ok={!!prereqs.platform.chromePath}
          detail={prereqs.platform.chromePath ?? "Not found — optional, needed for browser automation"}
          optional
        />

        <div className="mt-6 p-4 bg-zinc-800/50 rounded-lg">
          <h3 className="text-sm font-medium text-zinc-300 mb-1">Platform</h3>
          <p className="text-sm text-zinc-400">
            {prereqs.platform.os} / {prereqs.platform.arch}
            {prereqs.platform.sidecarsSupported && (
              <span className="ml-2 text-emerald-400">(Apple Silicon — all sidecars supported)</span>
            )}
            {!prereqs.platform.sidecarsSupported && (
              <span className="ml-2 text-amber-400">(Native AI sidecars unavailable — core agent works fully)</span>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

function PrereqRow({ label, ok, detail, optional }: {
  label: string;
  ok: boolean;
  detail: string;
  optional?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 p-3 bg-zinc-800/30 rounded-lg">
      {ok ? (
        <CheckCircle2 size={20} className="text-emerald-400 mt-0.5 flex-shrink-0" />
      ) : (
        <AlertCircle
          size={20}
          className={`mt-0.5 flex-shrink-0 ${optional ? "text-amber-400" : "text-red-400"}`}
        />
      )}
      <div>
        <span className="font-medium text-zinc-200">{label}</span>
        {optional && !ok && (
          <span className="ml-2 text-xs text-zinc-500">(optional)</span>
        )}
        <p className="text-sm text-zinc-400 mt-0.5">{detail}</p>
      </div>
    </div>
  );
}

function AuthStep({
  githubToken,
  onGithubTokenChange,
}: {
  githubToken: string;
  onGithubTokenChange: (v: string) => void;
}) {
  return (
    <div className="flex-1">
      <h2 className="text-2xl font-bold mb-2">Authentication</h2>
      <p className="text-zinc-400 mb-6 text-sm">
        Configure GitHub Copilot authentication. You can skip this and use device
        auth flow later, or set it up via{" "}
        <code className="text-zinc-300 bg-zinc-800 px-1 rounded">.env</code> file.
      </p>

      <div className="space-y-4">
        <div>
          <label
            htmlFor="github-token"
            className="block text-sm font-medium text-zinc-300 mb-1"
          >
            GitHub Token{" "}
            <span className="text-zinc-500 font-normal">(optional)</span>
          </label>
          <input
            id="github-token"
            type="password"
            value={githubToken}
            onChange={(e) => onGithubTokenChange(e.target.value)}
            placeholder="ghp_..."
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2.5 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500"
          />
          <p className="text-xs text-zinc-500 mt-1">
            Leave blank to use device auth flow (recommended for personal use).
          </p>
        </div>

        <div className="p-4 bg-blue-900/20 border border-blue-800/50 rounded-lg">
          <p className="text-sm text-blue-300">
            <strong>Device Auth Flow:</strong> If no token is provided, OpenZigs
            will show a device code when you start a chat session. Visit{" "}
            <a
              href="https://github.com/login/device"
              target="_blank"
              rel="noopener noreferrer"
              className="underline inline-flex items-center gap-1"
            >
              github.com/login/device <ExternalLink size={12} />
            </a>{" "}
            and enter the code to authenticate.
          </p>
        </div>
      </div>
    </div>
  );
}

function PlatformStep({ platform }: {
  platform: Prerequisites["platform"];
}) {
  const isMac = platform.os === "darwin";
  const isWindows = platform.os === "win32";
  const isAppleSilicon = isMac && platform.arch === "arm64";

  return (
    <div className="flex-1">
      <h2 className="text-2xl font-bold mb-2">Platform Guide</h2>
      <p className="text-zinc-400 mb-6 text-sm">
        Feature availability based on your platform.
      </p>

      <div className="space-y-4">
        <FeatureCard
          title="Core Agent"
          available
          description="Text chat, tool execution, task engine, scheduling — fully supported."
        />
        <FeatureCard
          title="Docker Sidecars"
          available
          description="MCP server sidecars run in Docker containers."
        />
        <FeatureCard
          title="Browser Automation"
          available={!!platform.chromePath}
          description={
            platform.chromePath
              ? "Chrome detected — web search, screenshots, navigation supported."
              : "Install Chrome or Chromium for browser automation features."
          }
        />
        <FeatureCard
          title="Native AI Sidecars"
          available={isAppleSilicon}
          description={
            isAppleSilicon
              ? "Apple Silicon detected — Voice Lab, Image Gen, Music Studio available."
              : isWindows
              ? "Requires Apple Silicon Mac. Voice Lab, Image Gen, Music Studio are not available on Windows."
              : "Requires Apple Silicon Mac. These features are not available on Intel Macs."
          }
        />
      </div>
    </div>
  );
}

function FeatureCard({ title, available, description }: {
  title: string;
  available: boolean;
  description: string;
}) {
  return (
    <div className={`p-4 rounded-lg border ${
      available
        ? "bg-emerald-900/10 border-emerald-800/30"
        : "bg-zinc-800/30 border-zinc-700/50"
    }`}>
      <div className="flex items-center gap-2 mb-1">
        {available ? (
          <CheckCircle2 size={16} className="text-emerald-400" />
        ) : (
          <AlertCircle size={16} className="text-zinc-500" />
        )}
        <span className="font-medium text-zinc-200">{title}</span>
      </div>
      <p className="text-sm text-zinc-400 ml-6">{description}</p>
    </div>
  );
}

function ConfigStep({
  telegramToken,
  discordToken,
  onTelegramChange,
  onDiscordChange,
}: {
  telegramToken: string;
  discordToken: string;
  onTelegramChange: (v: string) => void;
  onDiscordChange: (v: string) => void;
}) {
  return (
    <div className="flex-1">
      <h2 className="text-2xl font-bold mb-2">Channels</h2>
      <p className="text-zinc-400 mb-6 text-sm">
        Optionally configure messaging channels. You can add these later in the
        Admin panel or via{" "}
        <code className="text-zinc-300 bg-zinc-800 px-1 rounded">.env</code>.
      </p>

      <div className="space-y-4">
        <div>
          <label
            htmlFor="telegram-token"
            className="block text-sm font-medium text-zinc-300 mb-1"
          >
            Telegram Bot Token{" "}
            <span className="text-zinc-500 font-normal">(optional)</span>
          </label>
          <input
            id="telegram-token"
            type="password"
            value={telegramToken}
            onChange={(e) => onTelegramChange(e.target.value)}
            placeholder="123456:ABC-DEF..."
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2.5 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500"
          />
        </div>

        <div>
          <label
            htmlFor="discord-token"
            className="block text-sm font-medium text-zinc-300 mb-1"
          >
            Discord Bot Token{" "}
            <span className="text-zinc-500 font-normal">(optional)</span>
          </label>
          <input
            id="discord-token"
            type="password"
            value={discordToken}
            onChange={(e) => onDiscordChange(e.target.value)}
            placeholder="MTIz..."
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2.5 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500"
          />
        </div>

        <div className="p-4 bg-zinc-800/50 rounded-lg">
          <p className="text-sm text-zinc-400">
            All fields are optional. You can configure these and many more settings
            in the{" "}
            <strong className="text-zinc-300">Admin panel</strong> after setup, or
            by editing{" "}
            <code className="text-zinc-300 bg-zinc-800 px-1 rounded">
              ~/.openzigs/config.json
            </code>{" "}
            or your{" "}
            <code className="text-zinc-300 bg-zinc-800 px-1 rounded">.env</code>{" "}
            file directly.
          </p>
        </div>
      </div>
    </div>
  );
}

function CompleteStep() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center">
      <CheckCircle2 size={48} className="text-emerald-400 mb-4" />
      <h2 className="text-2xl font-bold mb-2">Setup Complete</h2>
      <p className="text-zinc-400 max-w-md">
        OpenZigs is ready to use. You can always change settings in the{" "}
        <strong className="text-zinc-300">Admin panel</strong> or re-run this wizard
        from Admin → Reset Setup Wizard.
      </p>
    </div>
  );
}
