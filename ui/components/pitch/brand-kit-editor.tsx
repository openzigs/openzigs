"use client";

/**
 * Brand kit editor — modal dialog for create / edit / duplicate-starter
 * flows (Phase 5, sub-issue #970).
 *
 * Backend contract:
 *   POST   /api/admin/pitch/brand-kits           — create
 *   PATCH  /api/admin/pitch/brand-kits/:id       — update (starter ⇒ 403)
 *   POST   /api/admin/pitch/brand-kits/:id/logo  — multipart upload
 *
 * Starter kits open in read-only mode with a "Duplicate to customize"
 * button that POSTs a copy named "<starter> copy" and re-opens it
 * editable. Logo upload is a separate multipart endpoint — we POST it
 * AFTER create so a brand new (uncreated) kit just hides the dropzone
 * until saved.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { buildUrl, fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import type { BrandKitListEntry } from "./brand-kit-picker";

const HEX_RE = /^#[0-9a-f]{6}$/i;
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_LOGO_MIMES = ["image/png", "image/jpeg", "image/webp"];

const AUTH_TOKEN =
  typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? ""
    : "";

export interface BrandKitEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing kit to edit (null = create mode). */
  kit: BrandKitListEntry | null;
  /** Called after a successful save with the kit id (new or existing). */
  onSaved?: (kitId: string) => void;
}

interface FormState {
  name: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  fontHeading: string;
  fontBody: string;
  footerText: string;
}

const FONT_SUGGESTIONS = [
  "Inter",
  "Roboto",
  "Source Sans 3",
  "Helvetica",
  "Georgia",
  "Lora",
  "Merriweather",
  "JetBrains Mono",
];

const blankForm = (): FormState => ({
  name: "",
  primaryColor: "#000000",
  secondaryColor: "#ffffff",
  accentColor: "#0066ff",
  fontHeading: "Inter",
  fontBody: "Inter",
  footerText: "",
});

export const BrandKitEditor = ({
  open,
  onOpenChange,
  kit,
  onSaved,
}: BrandKitEditorProps) => {
  const queryClient = useQueryClient();
  const isStarter = kit?.isStarter === true;
  const isCreate = kit === null;
  const [form, setForm] = useState<FormState>(blankForm());
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Prime form when the dialog opens or the target kit changes.
  useEffect(() => {
    if (!open) return;
    if (kit) {
      setForm({
        name: kit.name,
        primaryColor: kit.primaryColor,
        secondaryColor: kit.secondaryColor,
        accentColor: kit.accentColor,
        fontHeading: kit.fontHeading ?? "Inter",
        fontBody: kit.fontBody ?? "Inter",
        footerText: "",
      });
    } else {
      setForm(blankForm());
    }
    setLogoError(null);
  }, [open, kit]);

  const colourErrors = {
    primaryColor: !HEX_RE.test(form.primaryColor),
    secondaryColor: !HEX_RE.test(form.secondaryColor),
    accentColor: !HEX_RE.test(form.accentColor),
  };
  const hasErrors =
    !form.name.trim() ||
    colourErrors.primaryColor ||
    colourErrors.secondaryColor ||
    colourErrors.accentColor;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        primaryColor: form.primaryColor,
        secondaryColor: form.secondaryColor,
        accentColor: form.accentColor,
        fontHeading: form.fontHeading,
        fontBody: form.fontBody,
        footerText: form.footerText || undefined,
      };
      if (isCreate) {
        // Create requires fontFamily (no .optional() on backend); send a
        // sensible default to avoid drift.
        body.fontFamily = form.fontHeading || "Inter";
        const res = await fetchJson<{ brandKit: { id: string } }>(
          `/api/admin/pitch/brand-kits`,
          {
            method: "POST",
            body: JSON.stringify(body),
          },
        );
        return res.brandKit.id;
      }
      if (!kit) throw new Error("missing kit");
      await fetchJson(`/api/admin/pitch/brand-kits/${kit.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      return kit.id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["pitch", "brand-kits"] });
      showToast("Brand kit saved.", "success");
      onSaved?.(id);
      onOpenChange(false);
    },
    onError: (err) =>
      showToast(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      ),
  });

  const duplicateMutation = useMutation({
    mutationFn: async () => {
      if (!kit) throw new Error("missing kit");
      const res = await fetchJson<{ brandKit: { id: string } }>(
        `/api/admin/pitch/brand-kits`,
        {
          method: "POST",
          body: JSON.stringify({
            name: `${kit.name} copy`,
            primaryColor: kit.primaryColor,
            secondaryColor: kit.secondaryColor,
            accentColor: kit.accentColor,
            fontHeading: kit.fontHeading ?? "Inter",
            fontBody: kit.fontBody ?? "Inter",
            fontFamily: kit.fontHeading ?? "Inter",
          }),
        },
      );
      return res.brandKit.id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["pitch", "brand-kits"] });
      showToast("Starter duplicated. Editing copy.", "success");
      onSaved?.(id);
      onOpenChange(false);
    },
    onError: (err) =>
      showToast(
        `Duplicate failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      ),
  });

  const handleLogoFile = async (file: File) => {
    if (!ALLOWED_LOGO_MIMES.includes(file.type)) {
      setLogoError("Logo must be PNG, JPEG, or WebP.");
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setLogoError("Logo exceeds 2 MB cap.");
      return;
    }
    if (!kit) {
      setLogoError("Save the kit first, then upload a logo.");
      return;
    }
    setLogoError(null);
    const fd = new FormData();
    fd.append("logo", file);
    const url = buildUrl(`/api/admin/pitch/brand-kits/${kit.id}/logo`);
    const headers: HeadersInit = AUTH_TOKEN
      ? { Authorization: `Bearer ${AUTH_TOKEN}` }
      : {};
    try {
      const res = await fetch(url, { method: "POST", headers, body: fd });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      queryClient.invalidateQueries({ queryKey: ["pitch", "brand-kits"] });
      showToast("Logo uploaded.", "success");
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="pitch-brand-kit-editor"
        className="sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>
            {isCreate ? "New brand kit" : isStarter ? "Starter brand kit" : "Edit brand kit"}
          </DialogTitle>
          <DialogDescription>
            Define brand colors, fonts, and footer text. New decks pick
            up these defaults; existing decks are unaffected until you
            switch their brand kit.
          </DialogDescription>
        </DialogHeader>

        {isStarter && (
          <p
            data-testid="pitch-brand-kit-starter-notice"
            className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700"
          >
            Starter kits are read-only. Duplicate to customize.
          </p>
        )}

        <div className="space-y-3 text-xs">
          <label className="block">
            <span className="mb-1 block font-semibold">Name</span>
            <input
              type="text"
              data-testid="pitch-bk-name"
              value={form.name}
              maxLength={80}
              readOnly={isStarter}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full rounded border border-border bg-background px-2 py-1"
            />
          </label>

          <div className="grid grid-cols-3 gap-2">
            {(["primaryColor", "secondaryColor", "accentColor"] as const).map(
              (key) => (
                <label key={key} className="block">
                  <span className="mb-1 block font-semibold capitalize">
                    {key.replace("Color", "")}
                  </span>
                  <input
                    type="color"
                    data-testid={`pitch-bk-${key}-picker`}
                    value={form[key]}
                    disabled={isStarter}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, [key]: e.target.value }))
                    }
                    className="h-8 w-full"
                  />
                  <input
                    type="text"
                    data-testid={`pitch-bk-${key}-hex`}
                    value={form[key]}
                    readOnly={isStarter}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, [key]: e.target.value }))
                    }
                    className={`mt-1 w-full rounded border bg-background px-2 py-1 ${
                      colourErrors[key] ? "border-red-500" : "border-border"
                    }`}
                  />
                  {colourErrors[key] && (
                    <span
                      data-testid={`pitch-bk-${key}-error`}
                      className="mt-0.5 block text-[10px] text-red-500"
                    >
                      Must be #rrggbb
                    </span>
                  )}
                </label>
              ),
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block font-semibold">Heading font</span>
              <input
                type="text"
                data-testid="pitch-bk-font-heading"
                list="pitch-bk-fonts"
                value={form.fontHeading}
                maxLength={60}
                readOnly={isStarter}
                onChange={(e) =>
                  setForm((f) => ({ ...f, fontHeading: e.target.value }))
                }
                className="w-full rounded border border-border bg-background px-2 py-1"
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-semibold">Body font</span>
              <input
                type="text"
                data-testid="pitch-bk-font-body"
                list="pitch-bk-fonts"
                value={form.fontBody}
                maxLength={60}
                readOnly={isStarter}
                onChange={(e) =>
                  setForm((f) => ({ ...f, fontBody: e.target.value }))
                }
                className="w-full rounded border border-border bg-background px-2 py-1"
              />
            </label>
            <datalist id="pitch-bk-fonts">
              {FONT_SUGGESTIONS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>

          <label className="block">
            <span className="mb-1 block font-semibold">Footer text</span>
            <input
              type="text"
              data-testid="pitch-bk-footer"
              value={form.footerText}
              maxLength={120}
              readOnly={isStarter}
              onChange={(e) =>
                setForm((f) => ({ ...f, footerText: e.target.value }))
              }
              className="w-full rounded border border-border bg-background px-2 py-1"
            />
          </label>

          {!isCreate && !isStarter && kit && (
            <div>
              <span className="mb-1 block font-semibold">Logo</span>
              <input
                ref={fileInputRef}
                type="file"
                data-testid="pitch-bk-logo-input"
                accept={ALLOWED_LOGO_MIMES.join(",")}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) await handleLogoFile(file);
                  e.target.value = "";
                }}
                className="text-[11px]"
              />
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                PNG / JPEG / WebP, ≤ 2 MB.
              </p>
              {logoError && (
                <p
                  data-testid="pitch-bk-logo-error"
                  className="mt-0.5 text-[10px] text-red-500"
                >
                  {logoError}
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded border border-border px-3 py-1 text-xs hover:bg-muted/40"
          >
            Close
          </button>
          {isStarter ? (
            <button
              type="button"
              data-testid="pitch-bk-duplicate"
              disabled={duplicateMutation.isPending}
              onClick={() => duplicateMutation.mutate()}
              className="rounded border border-primary bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
            >
              {duplicateMutation.isPending
                ? "Duplicating…"
                : "Duplicate to customize"}
            </button>
          ) : (
            <button
              type="button"
              data-testid="pitch-bk-save"
              disabled={hasErrors || saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
              className="rounded border border-primary bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
            >
              {saveMutation.isPending ? "Saving…" : "Save"}
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
