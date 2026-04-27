"use client";

import { useRef, useState, type ClipboardEvent } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, buildUrl } from "@/lib/api";
import { showToast } from "@/components/toast";
import { BrandKitEditor } from "@/components/pitch/brand-kit-editor";

interface BrandKit {
  id: string;
  name: string;
}

interface BrandKitsResponse {
  brandKits: BrandKit[];
}

const SCRIPT_BYTE_CAP = 50_000;
// Hard cap on raw file uploads / oversize content fed into the AI
// condensation endpoint (`POST /api/admin/pitch/script/condense`). This
// MUST stay in sync with `CONDENSE_HARD_CEILING_BYTES` in
// `src/pitch/pitch-condense.ts` — the backend rejects > 2 MB with 413.
const FILE_BYTE_CAP = 2_000_000;
// Direct-paste cap on the textarea. We let users paste up to 200 KB
// without hitting the file-drop flow; anything above the script cap but
// under this still triggers the "Condense with AI" panel.
const RAW_PASTE_BYTE_CAP = 200_000;
const DRAFT_TIMEOUT_MS = 240_000;

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
  const [createKitOpen, setCreateKitOpen] = useState(false);
  // Condense panel state — set when the user drops/pastes content over
  // the 50 KB draft cap but under the 2 MB hard ceiling. The user must
  // explicitly click "Condense" (LLM cost transparency — we never
  // auto-bill them tokens).
  const [pendingCondense, setPendingCondense] = useState<
    { name: string; bytes: number; text: string } | null
  >(null);
  const [condensing, setCondensing] = useState(false);
  const [condenseInfo, setCondenseInfo] = useState<
    { originalBytes: number; condensedBytes: number; chunks: number } | null
  >(null);
  const queryClient = useQueryClient();
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
    if (file.size > FILE_BYTE_CAP) {
      showToast(
        `File exceeds the ${(FILE_BYTE_CAP / 1_000_000).toFixed(0)} MB hard cap.`,
        "error",
      );
      return;
    }
    const text = await file.text();
    const bytes = new Blob([text]).size;
    if (bytes <= SCRIPT_BYTE_CAP) {
      // Small enough to use directly — no LLM call needed.
      setScript(text);
      setPendingCondense(null);
      setCondenseInfo(null);
      return;
    }
    // Over the draft cap but under the hard ceiling — stage for explicit
    // user-confirmed condensation.
    setPendingCondense({ name: file.name, bytes, text });
    setCondenseInfo(null);
  };

  const handleCondense = async () => {
    if (!pendingCondense) return;
    setCondensing(true);
    try {
      const url = buildUrl("/api/admin/pitch/script/condense");
      const headers: HeadersInit = { "Content-Type": "application/json" };
      if (AUTH_TOKEN) headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: pendingCondense.text }),
      });
      if (res.status === 413) {
        showToast("File exceeds 2 MB hard cap.", "error");
        return;
      }
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as {
            detail?: string;
            error?: { message?: string } | string;
          };
          if (body?.detail) detail = body.detail;
          else if (typeof body?.error === "string") detail = body.error;
          else if (body?.error && typeof body.error === "object" && body.error.message)
            detail = body.error.message;
        } catch {
          /* fall through */
        }
        showToast(`Could not condense script: ${detail}`, "error");
        return;
      }
      const data = (await res.json()) as {
        condensed: string;
        originalBytes: number;
        condensedBytes: number;
        chunks: number;
      };
      setScript(data.condensed);
      setCondenseInfo({
        originalBytes: data.originalBytes,
        condensedBytes: data.condensedBytes,
        chunks: data.chunks,
      });
      setPendingCondense(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Could not condense script: ${msg}`, "error");
    } finally {
      setCondensing(false);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (!pasted) return;
    const bytes = new Blob([pasted]).size;
    // Only intercept oversize pastes — below RAW_PASTE_BYTE_CAP we let
    // the textarea handle it normally.
    if (bytes <= RAW_PASTE_BYTE_CAP) return;
    if (bytes > FILE_BYTE_CAP) {
      e.preventDefault();
      showToast(
        `Pasted content exceeds the ${(FILE_BYTE_CAP / 1_000_000).toFixed(0)} MB hard cap.`,
        "error",
      );
      return;
    }
    e.preventDefault();
    setPendingCondense({ name: "clipboard.txt", bytes, text: pasted });
    setCondenseInfo(null);
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
        // Try to surface the backend's structured `{ error: { message } }`
        // envelope; fall back to plain text so we never throw "undefined".
        let detail = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as {
            error?: { message?: string };
          };
          if (body?.error?.message) detail = body.error.message;
        } catch {
          const text = await res.text().catch(() => "");
          if (text) detail = text;
        }
        throw new Error(detail);
      }
      const data = (await res.json()) as { deck: { id: string } };
      router.push(`/pitch/${data.deck.id}`);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        showToast(
          `Generation timed out after ${Math.round(DRAFT_TIMEOUT_MS / 1000)}s. The model may be cold-starting — please try again.`,
          "error",
        );
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        showToast(`Could not draft deck: ${msg}`, "error");
      }
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
              onClick={() => setCreateKitOpen(true)}
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
              Paste up to 50 KB, or drop a `.txt`/`.md` file up to 2 MB and we&apos;ll
              condense it with AI.
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
            {pendingCondense && (
              <div
                data-testid="wizard-condense-panel"
                role="region"
                aria-label="Condense oversize script with AI"
                className="mb-2 rounded border border-primary/40 bg-primary/5 p-3 text-xs"
              >
                <div className="font-semibold text-foreground">
                  AI condense required
                </div>
                <div className="mt-1 text-muted-foreground">
                  <span data-testid="wizard-condense-filename">
                    {pendingCondense.name}
                  </span>{" "}
                  &mdash;{" "}
                  <span data-testid="wizard-condense-bytes">
                    {(pendingCondense.bytes / 1000).toFixed(1)} KB
                  </span>
                  . Exceeds the 50 KB draft cap.
                </div>
                <div className="mt-1 text-muted-foreground">
                  Condense (uses ~30s and 1 LLM call per ~30 KB).
                </div>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    data-testid="wizard-condense-confirm"
                    onClick={handleCondense}
                    disabled={condensing}
                    className="inline-flex items-center gap-2 rounded bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                  >
                    {condensing && (
                      <span
                        data-testid="wizard-condense-spinner"
                        className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
                      />
                    )}
                    {condensing
                      ? `Condensing ${(pendingCondense.bytes / 1000).toFixed(1)} KB script — ${Math.max(
                          1,
                          Math.ceil(pendingCondense.bytes / 30_000),
                        )} chunks…`
                      : "Condense with AI"}
                  </button>
                  <button
                    type="button"
                    data-testid="wizard-condense-cancel"
                    onClick={() => setPendingCondense(null)}
                    disabled={condensing}
                    className="rounded border border-border px-3 py-1 text-xs disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {condenseInfo && (
              <div
                data-testid="wizard-condense-chip"
                className="mb-2 inline-flex items-center rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] text-foreground"
              >
                Condensed from {(condenseInfo.originalBytes / 1000).toFixed(1)} KB
                → {(condenseInfo.condensedBytes / 1000).toFixed(1)} KB via AI
              </div>
            )}
            <textarea
              data-testid="wizard-script-textarea"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              onPaste={handlePaste}
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
                {[5, 8, 10, 15, 20].map((n) => (
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
        {submitting && step === "options" && (
          <div
            data-testid="wizard-progress"
            role="status"
            aria-live="polite"
            className="mt-4 flex items-start gap-2 rounded border border-primary/30 bg-primary/5 p-3 text-xs text-foreground"
          >
            <span
              className="mt-0.5 inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent"
              aria-hidden="true"
            />
            <span>
              Generating ~{slideCount} slides &mdash; this can take up to 3 minutes
              while the model warms up. Please don&apos;t close this tab.
            </span>
          </div>
        )}
      </div>
      <BrandKitEditor
        open={createKitOpen}
        onOpenChange={setCreateKitOpen}
        kit={null}
        onSaved={(id) => {
          setBrandKitId(id);
          queryClient.invalidateQueries({ queryKey: ["pitch", "brand-kits"] });
        }}
      />
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
