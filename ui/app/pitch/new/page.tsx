"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { fetchJson, buildUrl } from "@/lib/api";
import { showToast } from "@/components/toast";

interface BrandKit {
  id: string;
  name: string;
}

interface BrandKitsResponse {
  brandKits: BrandKit[];
}

const SCRIPT_BYTE_CAP = 50_000;
const DRAFT_TIMEOUT_MS = 90_000;

const AUTH_TOKEN =
  typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? ""
    : "";

type WizardStep = "kit" | "script" | "options";

// Tone literals MUST match `DeckToneEnum` in `src/pitch/pitch-schema.ts`.
// Backend uses `.strict()` validation and 400s on unknown values — the
// contract test in `src/pitch/pitch-schema.test.ts` (DraftDeckBodySchema
// block) iterates this set against the backend enum to catch drift.
type Tone = "formal" | "casual" | "technical" | "sales" | "educational";

const TONE_OPTIONS: ReadonlyArray<{ value: Tone; label: string }> = [
  { value: "formal", label: "Formal" },
  { value: "casual", label: "Casual" },
  { value: "technical", label: "Technical" },
  { value: "sales", label: "Sales / Persuasive" },
  { value: "educational", label: "Educational" },
];

export default function NewPitchDeckPage() {
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>("kit");
  const [brandKitId, setBrandKitId] = useState<string | null>(null);
  const [script, setScript] = useState<string>("");
  const [slideCount, setSlideCount] = useState<number>(10);
  const [audience, setAudience] = useState<string>("");
  const [tone, setTone] = useState<Tone>("formal");
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const kitsQuery = useQuery({
    queryKey: ["pitch", "brand-kits"],
    queryFn: () =>
      fetchJson<BrandKitsResponse>("/api/admin/pitch/brand-kits"),
  });

  const scriptBytes = new Blob([script]).size;
  const scriptOverCap = scriptBytes > SCRIPT_BYTE_CAP;

  const goNext = () => {
    if (step === "kit") setStep("script");
    else if (step === "script") setStep("options");
  };
  const goBack = () => {
    if (step === "options") setStep("script");
    else if (step === "script") setStep("kit");
  };

  const handleFileDrop = async (file: File) => {
    if (!/\.(txt|md)$/i.test(file.name)) {
      showToast("Only .txt or .md files are accepted.", "error");
      return;
    }
    if (file.size > SCRIPT_BYTE_CAP) {
      showToast("Script exceeds the 50 KB cap.", "error");
      return;
    }
    const text = await file.text();
    setScript(text);
  };

  const handleSubmit = async () => {
    if (!brandKitId) {
      showToast("Pick a brand kit first.", "error");
      return;
    }
    if (!script.trim()) {
      showToast("Provide a script.", "error");
      return;
    }
    setSubmitting(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DRAFT_TIMEOUT_MS);
    try {
      const url = buildUrl("/api/admin/pitch/decks/draft");
      const headers: HeadersInit = {
        "Content-Type": "application/json",
      };
      if (AUTH_TOKEN) headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
      const res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          script,
          brandKitId,
          options: {
            // Field name MUST stay aligned with `DraftDeckBodySchema` in
            // `src/pitch/pitch-schema.ts` — the backend body is `.strict()`
            // and silently 400s on unknown keys. See contract test in
            // `src/pitch/pitch-schema.test.ts`.
            targetSlideCount: slideCount,
            audience: audience || undefined,
            tone,
          },
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { deck: { id: string } };
      router.push(`/pitch/${data.deck.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Could not draft deck: ${msg}`, "error");
    } finally {
      clearTimeout(timer);
      setSubmitting(false);
    }
  };

  return (
    <div
      className="mx-auto w-full max-w-2xl px-6 py-8"
      data-testid="new-deck-wizard"
    >
      <h1 className="text-2xl font-semibold">New Pitch Deck</h1>
      <ol className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <Step active={step === "kit"} done={step !== "kit"}>1. Brand kit</Step>
        <Step
          active={step === "script"}
          done={step === "options"}
        >
          2. Script
        </Step>
        <Step active={step === "options"} done={false}>3. Options</Step>
      </ol>

      <div className="mt-6 rounded-lg border border-border bg-card p-6">
        {step === "kit" && (
          <div data-testid="wizard-step-kit">
            <h2 className="text-sm font-semibold">Pick a brand kit</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Decks inherit fonts, colors, logo, and footer from the chosen kit.
            </p>
            {kitsQuery.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading kits…</div>
            ) : kitsQuery.isError ? (
              <div className="text-sm text-red-500">Could not load kits.</div>
            ) : (
              <ul className="grid grid-cols-1 gap-2">
                {(kitsQuery.data?.brandKits ?? []).map((k) => (
                  <li key={k.id}>
                    <button
                      type="button"
                      data-testid={`wizard-kit-${k.id}`}
                      onClick={() => setBrandKitId(k.id)}
                      className={`w-full rounded-md border p-3 text-left text-sm ${
                        brandKitId === k.id
                          ? "border-primary bg-primary/10"
                          : "border-border hover:bg-muted/40"
                      }`}
                    >
                      {k.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              data-testid="wizard-create-kit-stub"
              onClick={() =>
                showToast("Brand kit creation arrives in Phase 5.", "info")
              }
              className="mt-3 text-xs text-primary hover:underline"
            >
              + Create new kit
            </button>
          </div>
        )}

        {step === "script" && (
          <div data-testid="wizard-step-script">
            <h2 className="text-sm font-semibold">Provide your script</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Paste up to 50 KB of text or drop a `.txt`/`.md` file.
            </p>
            <div
              data-testid="wizard-dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={async (e) => {
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if (file) await handleFileDrop(file);
              }}
              className="mb-2 rounded border border-dashed border-border p-3 text-center text-xs text-muted-foreground"
            >
              Drag & drop a script file here, or
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="ml-1 text-primary hover:underline"
              >
                choose a file
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,text/plain,text/markdown"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) await handleFileDrop(f);
                  e.target.value = "";
                }}
              />
            </div>
            <textarea
              data-testid="wizard-script-textarea"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder="Paste your script…"
              className="h-48 w-full resize-y rounded border border-border bg-background p-2 text-sm"
            />
            <div
              data-testid="wizard-script-bytes"
              className={`mt-1 text-xs ${
                scriptOverCap ? "text-red-500" : "text-muted-foreground"
              }`}
            >
              {scriptBytes.toLocaleString()} / {SCRIPT_BYTE_CAP.toLocaleString()} bytes
            </div>
          </div>
        )}

        {step === "options" && (
          <div data-testid="wizard-step-options">
            <h2 className="text-sm font-semibold">Generation options</h2>
            <div className="mt-3">
              <label className="text-xs font-semibold">Slide count target</label>
              <div className="mt-1 flex gap-2" data-testid="wizard-slide-count">
                {[5, 10, 15, 20].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setSlideCount(n)}
                    data-testid={`wizard-slide-count-${n}`}
                    className={`rounded border px-3 py-1 text-sm ${
                      slideCount === n
                        ? "border-primary bg-primary/10"
                        : "border-border hover:bg-muted/40"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-4">
              <label htmlFor="wizard-audience" className="text-xs font-semibold">
                Audience
              </label>
              <input
                id="wizard-audience"
                data-testid="wizard-audience"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                placeholder="e.g. enterprise CTOs"
                className="mt-1 w-full rounded border border-border bg-background p-2 text-sm"
              />
            </div>
            <div className="mt-4">
              <span className="text-xs font-semibold">Tone</span>
              <div
                className="mt-1 flex flex-wrap gap-3 text-sm"
                data-testid="wizard-tone"
              >
                {TONE_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className="inline-flex items-center gap-1"
                  >
                    <input
                      type="radio"
                      name="tone"
                      value={opt.value}
                      checked={tone === opt.value}
                      onChange={() => setTone(opt.value)}
                      data-testid={`wizard-tone-${opt.value}`}
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="mt-6 flex items-center justify-between">
          <button
            type="button"
            onClick={goBack}
            disabled={step === "kit" || submitting}
            data-testid="wizard-back"
            className="rounded border border-border px-3 py-1 text-xs disabled:opacity-50"
          >
            Back
          </button>
          {step !== "options" ? (
            <button
              type="button"
              onClick={goNext}
              data-testid="wizard-next"
              disabled={
                (step === "kit" && !brandKitId) ||
                (step === "script" && (!script.trim() || scriptOverCap))
              }
              className="rounded bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              data-testid="wizard-generate"
              className="inline-flex items-center gap-2 rounded bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              {submitting && (
                <span
                  data-testid="wizard-spinner"
                  className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
                />
              )}
              Generate
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const Step = ({
  active,
  done,
  children,
}: {
  active: boolean;
  done: boolean;
  children: React.ReactNode;
}) => (
  <li
    className={`rounded-full border px-2 py-0.5 ${
      active
        ? "border-primary bg-primary/10 text-primary"
        : done
          ? "border-emerald-500/50 text-emerald-600"
          : "border-border"
    }`}
  >
    {children}
  </li>
);
