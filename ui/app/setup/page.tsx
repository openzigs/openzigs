"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { fetchJson, buildUrl } from "@/lib/api";

/* ───── Types ───── */

type WizardStep =
  | "welcome"
  | "prereqs"
  | "sidecars"
  | "social"
  | "byok"
  | "recipes"
  | "complete";

const STEPS: WizardStep[] = [
  "welcome",
  "prereqs",
  "sidecars",
  "social",
  "byok",
  "recipes",
  "complete",
];

const STEP_LABELS: Record<WizardStep, string> = {
  welcome: "Welcome",
  prereqs: "Prerequisites",
  sidecars: "Sidecars",
  social: "Social",
  byok: "API Keys",
  recipes: "Recipes",
  complete: "Done",
};

interface WizardState {
  currentStep: WizardStep;
  completedSteps: WizardStep[];
  data: Record<string, unknown>;
  updatedAt: string;
}

interface SidecarStatus {
  name: string;
  installed: boolean;
  hasServer: boolean;
  hasVenv: boolean;
  description: string;
}

interface SocialPlatform {
  id: string;
  label: string;
  description: string;
  authMode: "oauth" | "manual_token";
  authorizeRoute: string | null;
  docsUrl: string;
  connected: boolean;
  connectedAt: string | null;
}

interface RecipeMeta {
  id: string;
  name: string;
  description: string;
  tags: string[];
  stageCount: number;
}

interface ByokTestResult {
  provider: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  message: string;
}

const BYOK_PROVIDERS = ["openai", "anthropic", "google", "groq"] as const;
type ByokProvider = (typeof BYOK_PROVIDERS)[number];

/* ───── Helpers ───── */

const post = <T,>(path: string, body?: unknown) =>
  fetchJson<T>(path, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });

/* ───── Page ───── */

export default function SetupPage() {
  const router = useRouter();
  const [state, setState] = useState<WizardState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    try {
      const s = await fetchJson<WizardState>("/api/admin/setup/state");
      setState(s);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const goToStep = useCallback(
    async (next: WizardStep, markCurrentComplete = true) => {
      if (!state) return;
      const completed = new Set(state.completedSteps);
      if (markCurrentComplete) completed.add(state.currentStep);
      const updated = await post<WizardState>("/api/admin/setup/state", {
        currentStep: next,
        completedSteps: Array.from(completed),
      });
      setState(updated);
    },
    [state],
  );

  const reset = useCallback(async () => {
    await post("/api/admin/setup/state/reset");
    await loadState();
  }, [loadState]);

  if (loadError) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold">Setup unavailable</h1>
        <p className="mt-2 text-red-600">{loadError}</p>
        <button
          onClick={() => void loadState()}
          className="mt-4 inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-white"
        >
          <RefreshCw className="h-4 w-4" /> Retry
        </button>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-gray-500" />
      </main>
    );
  }

  const idx = STEPS.indexOf(state.currentStep);
  const prev = idx > 0 ? STEPS[idx - 1] : null;
  const next = idx < STEPS.length - 1 ? STEPS[idx + 1] : null;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <ProgressBar
        current={state.currentStep}
        completed={state.completedSteps}
      />

      <div className="mt-8 rounded-lg border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        {state.currentStep === "welcome" && <WelcomeStep />}
        {state.currentStep === "prereqs" && <PrereqsStep />}
        {state.currentStep === "sidecars" && <SidecarsStep />}
        {state.currentStep === "social" && <SocialStep />}
        {state.currentStep === "byok" && <ByokStep />}
        {state.currentStep === "recipes" && <RecipesStep />}
        {state.currentStep === "complete" && (
          <CompleteStep onReset={reset} onGoToApp={() => router.push("/")} />
        )}
      </div>

      <div className="mt-6 flex items-center justify-between">
        <button
          disabled={!prev}
          onClick={() => prev && void goToStep(prev, false)}
          className="inline-flex items-center gap-2 rounded border border-gray-300 px-4 py-2 text-sm font-medium disabled:opacity-40 dark:border-gray-700"
        >
          <ChevronLeft className="h-4 w-4" /> Back
        </button>
        <span className="text-xs text-gray-500">
          Step {idx + 1} of {STEPS.length} · saved{" "}
          {new Date(state.updatedAt).toLocaleTimeString()}
        </span>
        <button
          disabled={!next}
          onClick={() => next && void goToStep(next)}
          className="inline-flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {next === "complete" ? "Finish" : "Next"}{" "}
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </main>
  );
}

/* ───── Progress bar ───── */

function ProgressBar({
  current,
  completed,
}: {
  current: WizardStep;
  completed: WizardStep[];
}) {
  const completedSet = useMemo(() => new Set(completed), [completed]);
  return (
    <ol
      className="flex items-center justify-between"
      data-testid="wizard-progress"
    >
      {STEPS.map((step, i) => {
        const isCurrent = step === current;
        const isDone = completedSet.has(step);
        return (
          <li
            key={step}
            className="flex flex-1 items-center"
            data-step={step}
            data-current={isCurrent || undefined}
            data-completed={isDone || undefined}
          >
            <span
              className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold ${
                isCurrent
                  ? "bg-blue-600 text-white"
                  : isDone
                    ? "bg-green-600 text-white"
                    : "bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
              }`}
            >
              {isDone ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
            </span>
            <span className="ml-2 hidden text-xs font-medium sm:inline">
              {STEP_LABELS[step]}
            </span>
            {i < STEPS.length - 1 && (
              <span className="mx-2 h-px flex-1 bg-gray-200 dark:bg-gray-800" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ───── Steps ───── */

function WelcomeStep() {
  return (
    <section data-testid="step-welcome">
      <h1 className="text-3xl font-semibold">Welcome to OpenZigs</h1>
      <p className="mt-3 text-gray-600 dark:text-gray-400">
        We&apos;ll walk you through installing sidecars, connecting your social
        accounts, registering your AI provider keys, and importing starter
        recipes. Your progress is saved as you go — you can pick up where you
        left off.
      </p>
      <ul className="mt-6 list-disc space-y-1 pl-6 text-sm text-gray-600 dark:text-gray-400">
        <li>Prerequisite checks</li>
        <li>Optional sidecar installation</li>
        <li>Social platform OAuth + manual tokens</li>
        <li>BYOK (bring your own API keys)</li>
        <li>One-click starter recipes</li>
      </ul>
    </section>
  );
}

function PrereqsStep() {
  return (
    <section data-testid="step-prereqs">
      <h2 className="text-2xl font-semibold">Prerequisites</h2>
      <p className="mt-2 text-gray-600 dark:text-gray-400">
        OpenZigs runs best on macOS (Apple Silicon) or Linux with Node ≥ 22.
        Docker is recommended for sidecars. You can continue regardless — the
        wizard will note what&apos;s missing.
      </p>
    </section>
  );
}

function SidecarsStep() {
  const [sidecars, setSidecars] = useState<SidecarStatus[]>([]);
  const [supported, setSupported] = useState(true);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [installing, setInstalling] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetchJson<{
      sidecars: SidecarStatus[];
      supported: boolean;
    }>("/api/admin/setup/sidecars");
    setSidecars(res.sidecars);
    setSupported(res.supported);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const install = useCallback(
    async (name: string) => {
      setInstalling(name);
      setLogs((prev) => ({ ...prev, [name]: "" }));
      try {
        const res = await fetch(
          buildUrl(`/api/admin/setup/sidecars/${name}/install`),
          {
            method: "POST",
            headers: {
              Authorization: process.env.NEXT_PUBLIC_OPENZIGS_TOKEN
                ? `Bearer ${process.env.NEXT_PUBLIC_OPENZIGS_TOKEN}`
                : "",
            },
          },
        );
        const reader = res.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          setLogs((prev) => ({ ...prev, [name]: (prev[name] ?? "") + chunk }));
        }
      } finally {
        setInstalling(null);
        void load();
      }
    },
    [load],
  );

  return (
    <section data-testid="step-sidecars">
      <h2 className="text-2xl font-semibold">Sidecars</h2>
      {!supported && (
        <p className="mt-2 rounded bg-yellow-50 p-3 text-sm text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200">
          Your platform isn&apos;t supported for automated sidecar install. You
          can skip this step.
        </p>
      )}
      <ul className="mt-4 space-y-3">
        {sidecars.map((s) => (
          <li
            key={s.name}
            data-testid={`sidecar-${s.name}`}
            className="flex items-start justify-between gap-4 rounded border border-gray-200 p-3 dark:border-gray-800"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{s.name}</span>
                {s.installed && (
                  <span
                    className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900 dark:text-green-200"
                    data-installed
                  >
                    installed
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                {s.description}
              </p>
              {logs[s.name] && (
                <pre className="mt-2 max-h-40 overflow-auto rounded bg-gray-100 p-2 text-xs dark:bg-gray-800">
                  {logs[s.name]}
                </pre>
              )}
            </div>
            <button
              disabled={!supported || installing !== null}
              onClick={() => void install(s.name)}
              className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
              data-testid={`install-${s.name}`}
            >
              {installing === s.name
                ? "Installing…"
                : s.installed
                  ? "Reinstall"
                  : "Install"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SocialStep() {
  const [platforms, setPlatforms] = useState<SocialPlatform[]>([]);
  const [tokenInput, setTokenInput] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetchJson<{ platforms: SocialPlatform[] }>(
      "/api/admin/setup/social",
    );
    setPlatforms(res.platforms);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connectOAuth = (p: SocialPlatform) => {
    if (!p.authorizeRoute) return;
    window.open(
      buildUrl(p.authorizeRoute),
      "_blank",
      "noopener,width=600,height=700",
    );
  };

  const submitToken = async (p: SocialPlatform) => {
    const token = (tokenInput[p.id] ?? "").trim();
    if (!token) {
      setError(`Token required for ${p.label}`);
      return;
    }
    setError(null);
    setBusy(p.id);
    try {
      await post(`/api/admin/setup/social/${p.id}/manual-token`, { token });
      setTokenInput((prev) => ({ ...prev, [p.id]: "" }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section data-testid="step-social">
      <h2 className="text-2xl font-semibold">Social platforms</h2>
      {error && (
        <p className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
          {error}
        </p>
      )}
      <ul className="mt-4 space-y-3">
        {platforms.map((p) => (
          <li
            key={p.id}
            data-testid={`social-${p.id}`}
            data-connected={p.connected || undefined}
            className="rounded border border-gray-200 p-3 dark:border-gray-800"
          >
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium">{p.label}</span>
                {p.connected && (
                  <span className="ml-2 rounded bg-green-100 px-2 py-0.5 text-xs text-green-800 dark:bg-green-900 dark:text-green-200">
                    connected
                  </span>
                )}
                <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
                  {p.description}
                </p>
              </div>
              <a
                href={p.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:underline"
              >
                Docs <ExternalLink className="inline h-3 w-3" />
              </a>
            </div>

            {p.authMode === "oauth" ? (
              <button
                onClick={() => connectOAuth(p)}
                className="mt-3 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white"
                data-testid={`connect-${p.id}`}
              >
                Connect
              </button>
            ) : (
              <div className="mt-3 flex gap-2">
                <input
                  type="password"
                  value={tokenInput[p.id] ?? ""}
                  onChange={(e) =>
                    setTokenInput((prev) => ({
                      ...prev,
                      [p.id]: e.target.value,
                    }))
                  }
                  placeholder="Paste access token"
                  className="flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
                  data-testid={`token-input-${p.id}`}
                />
                <button
                  disabled={busy === p.id}
                  onClick={() => void submitToken(p)}
                  className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                  data-testid={`save-token-${p.id}`}
                >
                  {busy === p.id ? "Saving…" : "Save"}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ByokStep() {
  const [provider, setProvider] = useState<ByokProvider>("openai");
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ByokTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runTest = async () => {
    setError(null);
    setTesting(true);
    try {
      const r = await post<ByokTestResult>("/api/admin/setup/byok/test", {
        provider,
        apiKey,
      });
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      await post("/api/admin/setup/byok/save", { provider, apiKey });
      setApiKey("");
      setResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-testid="step-byok">
      <h2 className="text-2xl font-semibold">Bring your own API keys</h2>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        Test a provider key before saving it. Keys are stored encrypted at rest.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as ByokProvider)}
          className="rounded border border-gray-300 px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          data-testid="byok-provider"
        >
          {BYOK_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="API key"
          className="flex-1 rounded border border-gray-300 px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          data-testid="byok-key"
        />
        <button
          disabled={testing || !apiKey}
          onClick={() => void runTest()}
          className="rounded bg-gray-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          data-testid="byok-test"
        >
          {testing ? "Testing…" : "Test"}
        </button>
        <button
          disabled={saving || !result?.ok}
          onClick={() => void save()}
          className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          data-testid="byok-save"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {result && (
        <p
          className={`mt-3 text-sm ${result.ok ? "text-green-700 dark:text-green-300" : "text-red-700 dark:text-red-300"}`}
          data-testid="byok-result"
        >
          {result.message} ({result.latencyMs}ms)
        </p>
      )}
      {error && (
        <p className="mt-2 text-sm text-red-700 dark:text-red-300">{error}</p>
      )}
    </section>
  );
}

function RecipesStep() {
  const [recipes, setRecipes] = useState<RecipeMeta[]>([]);
  const [importing, setImporting] = useState<string | null>(null);
  const [imported, setImported] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetchJson<{ recipes: RecipeMeta[] }>(
          "/api/admin/setup/recipes",
        );
        setRecipes(res.recipes);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const importRecipe = async (id: string) => {
    setError(null);
    setImporting(id);
    try {
      await post(`/api/admin/setup/recipes/${id}/import`);
      setImported((prev) => new Set(prev).add(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(null);
    }
  };

  return (
    <section data-testid="step-recipes">
      <h2 className="text-2xl font-semibold">Starter recipes</h2>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        One-click templates to get you started. You can customize them later.
      </p>
      {error && (
        <p className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700 dark:bg-red-900/40 dark:text-red-200">
          {error}
        </p>
      )}
      <ul className="mt-4 space-y-3">
        {recipes.map((r) => (
          <li
            key={r.id}
            data-testid={`recipe-${r.id}`}
            className="flex items-start justify-between gap-4 rounded border border-gray-200 p-3 dark:border-gray-800"
          >
            <div>
              <span className="font-medium">{r.name}</span>
              <span className="ml-2 text-xs text-gray-500">
                {r.stageCount} stage{r.stageCount === 1 ? "" : "s"}
              </span>
              <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                {r.description}
              </p>
            </div>
            <button
              disabled={importing !== null || imported.has(r.id)}
              onClick={() => void importRecipe(r.id)}
              className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
              data-testid={`import-${r.id}`}
            >
              {imported.has(r.id)
                ? "Imported"
                : importing === r.id
                  ? "Importing…"
                  : "Import"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CompleteStep({
  onReset,
  onGoToApp,
}: {
  onReset: () => void;
  onGoToApp: () => void;
}) {
  return (
    <section data-testid="step-complete" className="text-center">
      <CheckCircle2 className="mx-auto h-12 w-12 text-green-600" />
      <h2 className="mt-4 text-2xl font-semibold">You&apos;re all set</h2>
      <p className="mt-2 text-gray-600 dark:text-gray-400">
        Your workspace is configured. You can revisit this wizard any time from
        the admin panel.
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <button
          onClick={onGoToApp}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white"
          data-testid="go-to-app"
        >
          Go to dashboard
        </button>
        <button
          onClick={() => void onReset()}
          className="rounded border border-gray-300 px-4 py-2 text-sm dark:border-gray-700"
          data-testid="reset-wizard"
        >
          Reset wizard
        </button>
      </div>
    </section>
  );
}
