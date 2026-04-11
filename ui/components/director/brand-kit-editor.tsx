"use client";

import { useState, useEffect, useCallback } from "react";
import { Palette, Plus, Trash2, Loader2, Save, Pencil, X } from "lucide-react";
import { fetchJson } from "@/lib/api";
import { showToast } from "@/components/toast";
import { BrandTemplateEditor } from "./brand-template-editor";

interface BrandKit {
  id: string;
  name: string;
  primaryColor: string;
  secondaryColor: string | null;
  accentColor: string | null;
  fontFamily: string | null;
  logoPath: string | null;
  watermarkPath: string | null;
  introTemplateId: string | null;
  outroTemplateId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BrandKitFormData {
  name: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  fontFamily: string;
}

const FONT_OPTIONS = [
  "Inter",
  "Roboto",
  "Open Sans",
  "Montserrat",
  "Poppins",
  "Lato",
  "Playfair Display",
  "Oswald",
  "Raleway",
  "Source Sans Pro",
];

const DEFAULT_FORM: BrandKitFormData = {
  name: "",
  primaryColor: "#3B82F6",
  secondaryColor: "#1E40AF",
  accentColor: "#F59E0B",
  fontFamily: "Inter",
};

function ColorInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-24 rounded-md border border-border bg-background px-2 py-1 text-xs font-mono"
          placeholder="#000000"
          maxLength={7}
        />
      </div>
    </div>
  );
}

export function BrandKitEditor() {
  const [kits, setKits] = useState<BrandKit[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<BrandKitFormData>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetchJson<{ brandKits: BrandKit[] }>(
        "/api/admin/director/brand-kits",
      );
      setKits(res.brandKits);
    } catch {
      showToast("Failed to load brand kits", "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleEdit = (kit: BrandKit) => {
    setEditingId(kit.id);
    setForm({
      name: kit.name,
      primaryColor: kit.primaryColor,
      secondaryColor: kit.secondaryColor ?? "#1E40AF",
      accentColor: kit.accentColor ?? "#F59E0B",
      fontFamily: kit.fontFamily ?? "Inter",
    });
    setShowForm(true);
  };

  const handleNew = () => {
    setEditingId(null);
    setForm(DEFAULT_FORM);
    setShowForm(true);
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(DEFAULT_FORM);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      showToast("Brand kit name is required", "error");
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await fetchJson(`/api/admin/director/brand-kits/${editingId}`, {
          method: "PUT",
          body: JSON.stringify(form),
        });
        showToast("Brand kit updated", "success");
      } else {
        await fetchJson("/api/admin/director/brand-kits", {
          method: "POST",
          body: JSON.stringify(form),
        });
        showToast("Brand kit created", "success");
      }
      handleCancel();
      load();
    } catch {
      showToast("Failed to save brand kit", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      await fetchJson(`/api/admin/director/brand-kits/${id}`, {
        method: "DELETE",
      });
      setKits((prev) => prev.filter((k) => k.id !== id));
      showToast("Brand kit deleted", "success");
    } catch {
      showToast("Failed to delete brand kit", "error");
    } finally {
      setDeleting(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Palette className="h-4 w-4" />
          Brand Kits
        </h3>
        {!showForm && (
          <button
            onClick={handleNew}
            className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-3 w-3" />
            New Kit
          </button>
        )}
      </div>

      {/* Form */}
      {showForm && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">
              {editingId ? "Edit" : "Create"} Brand Kit
            </h4>
            <button
              onClick={handleCancel}
              className="rounded p-1 hover:bg-muted"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Name
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="My Brand"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <ColorInput
              label="Primary"
              value={form.primaryColor}
              onChange={(v) => setForm({ ...form, primaryColor: v })}
            />
            <ColorInput
              label="Secondary"
              value={form.secondaryColor}
              onChange={(v) => setForm({ ...form, secondaryColor: v })}
            />
            <ColorInput
              label="Accent"
              value={form.accentColor}
              onChange={(v) => setForm({ ...form, accentColor: v })}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Font Family
            </label>
            <select
              value={form.fontFamily}
              onChange={(e) => setForm({ ...form, fontFamily: e.target.value })}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              {FONT_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>

          {/* Preview */}
          <div className="rounded-md border border-border p-3">
            <p className="text-xs text-muted-foreground mb-2">Preview</p>
            <div className="flex items-center gap-2">
              <div
                className="h-8 w-8 rounded"
                style={{ backgroundColor: form.primaryColor }}
              />
              <div
                className="h-8 w-8 rounded"
                style={{ backgroundColor: form.secondaryColor }}
              />
              <div
                className="h-8 w-8 rounded"
                style={{ backgroundColor: form.accentColor }}
              />
              <span
                className="ml-2 text-sm"
                style={{ fontFamily: form.fontFamily }}
              >
                {form.name || "Brand Kit"}
              </span>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              onClick={handleCancel}
              className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Save className="h-3 w-3" />
              )}
              {editingId ? "Update" : "Create"}
            </button>
          </div>
        </div>
      )}

      {/* List */}
      {kits.length === 0 && !showForm ? (
        <div className="flex h-32 flex-col items-center justify-center gap-2 text-muted-foreground">
          <Palette className="h-6 w-6" />
          <p className="text-xs">No brand kits yet</p>
        </div>
      ) : (
        <div className="space-y-2">
          {kits.map((kit) => (
            <div key={kit.id} className="space-y-2">
              <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 transition hover:border-primary/30">
                {/* Color swatches */}
                <div className="flex gap-1">
                  <div
                    className="h-6 w-6 rounded"
                    style={{ backgroundColor: kit.primaryColor }}
                  />
                  {kit.secondaryColor && (
                    <div
                      className="h-6 w-6 rounded"
                      style={{ backgroundColor: kit.secondaryColor }}
                    />
                  )}
                  {kit.accentColor && (
                    <div
                      className="h-6 w-6 rounded"
                      style={{ backgroundColor: kit.accentColor }}
                    />
                  )}
                </div>

                {/* Info */}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{kit.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {kit.fontFamily ?? "Default font"}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleEdit(kit)}
                    className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title="Edit"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(kit.id)}
                    disabled={deleting === kit.id}
                    className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                    title="Delete"
                  >
                    {deleting === kit.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
              {/* Brand template gallery for this kit */}
              <div className="mt-2">
                <BrandTemplateEditor brandKitId={kit.id} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
