"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/api";

/** Supported schema types from the backend. */
const SCHEMA_TYPES = [
  "Article",
  "Product",
  "LocalBusiness",
  "FAQPage",
  "HowTo",
  "Recipe",
  "Event",
  "Organization",
  "BreadcrumbList",
] as const;

type SchemaType = (typeof SCHEMA_TYPES)[number];

interface SchemaField {
  name: string;
  required: boolean;
  description: string;
  type: string;
  example: string;
}

/**
 * Schema Generator panel (#879).
 *
 * Lets users pick a Schema.org type, fill in fields via a dynamic form,
 * and get a live JSON-LD preview they can copy.
 */
export function SchemaGeneratorPanel() {
  const [selectedType, setSelectedType] = useState<SchemaType>("Article");
  const [fields, setFields] = useState<SchemaField[]>([]);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [generatedJson, setGeneratedJson] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Fetch fields when type changes
  const loadFields = async (type: SchemaType) => {
    setSelectedType(type);
    setGeneratedJson("");
    setFormData({});
    try {
      const data = await fetchJson<
        Array<{ type: string; fields: SchemaField[] }>
      >("/api/seo/schema/types");
      const match = data.find((t) => t.type === type);
      setFields(match?.fields ?? []);
    } catch {
      setFields([]);
    }
  };

  // Load fields for the default selected type on mount so the form
  // is populated immediately rather than waiting for an explicit click.
  useEffect(() => {
    void loadFields(selectedType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generateSchema = async () => {
    setLoading(true);
    try {
      const res = await fetchJson<{ raw: string }>("/api/seo/schema/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: selectedType, data: formData }),
      });
      setGeneratedJson(res.raw);
    } catch (err) {
      setGeneratedJson(JSON.stringify({ error: "Generation failed" }, null, 2));
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(generatedJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      {/* Type selector */}
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
          Schema Type
        </label>
        <div className="flex flex-wrap gap-1.5">
          {SCHEMA_TYPES.map((type) => (
            <button
              key={type}
              onClick={() => loadFields(type)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                selectedType === type
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background hover:bg-muted border-input"
              }`}
            >
              {type}
            </button>
          ))}
        </div>
      </div>

      {/* Dynamic form */}
      {fields.length > 0 && (
        <div className="grid gap-3">
          {fields.map((field) => (
            <div key={field.name}>
              <label className="text-xs font-medium text-muted-foreground mb-0.5 block">
                {field.name}
                {field.required && (
                  <span className="text-destructive ml-0.5">*</span>
                )}
              </label>
              <input
                type="text"
                placeholder={field.example || field.description}
                value={formData[field.name] ?? ""}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    [field.name]: e.target.value,
                  }))
                }
                className="w-full rounded-md border border-input px-3 py-1.5 text-sm bg-background"
              />
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {field.description}
              </p>
            </div>
          ))}

          <button
            onClick={generateSchema}
            disabled={loading}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Generating…" : "Generate Schema"}
          </button>
        </div>
      )}

      {/* JSON-LD output */}
      {generatedJson && (
        <div className="relative">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-muted-foreground">
              JSON-LD Output
            </span>
            <button
              onClick={copyToClipboard}
              className="text-xs px-2 py-1 rounded border bg-background hover:bg-muted"
            >
              {copied ? "✓ Copied" : "Copy"}
            </button>
          </div>
          <pre className="rounded-lg border bg-muted/30 p-3 text-xs overflow-x-auto max-h-80">
            <code>{generatedJson}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
