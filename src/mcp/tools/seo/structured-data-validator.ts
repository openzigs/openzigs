/**
 * Structured Data (JSON-LD) Validator (#860)
 *
 * Validates JSON-LD blocks against common Schema.org types:
 * - Checks required properties for each type
 * - Validates URLs, dates, and nesting
 * - Reports missing or invalid fields
 */

// ── Types ────────────────────────────────────────────────────────────────

export interface StructuredDataIssue {
  severity: "error" | "warning" | "info";
  category: string;
  message: string;
  schemaType?: string;
}

export interface StructuredDataValidationResult {
  typesFound: string[];
  issues: StructuredDataIssue[];
  totalBlocks: number;
}

// ── Required properties per Schema.org type ──────────────────────────────

const SCHEMA_REQUIRED_PROPS: Record<
  string,
  { required: string[]; recommended: string[] }
> = {
  Article: {
    required: ["headline", "author", "datePublished"],
    recommended: ["image", "publisher", "dateModified", "description"],
  },
  NewsArticle: {
    required: ["headline", "author", "datePublished"],
    recommended: ["image", "publisher", "dateModified"],
  },
  BlogPosting: {
    required: ["headline", "author", "datePublished"],
    recommended: ["image", "publisher", "dateModified"],
  },
  Product: {
    required: ["name"],
    recommended: ["image", "description", "offers", "brand", "sku"],
  },
  LocalBusiness: {
    required: ["name", "address"],
    recommended: ["telephone", "openingHours", "image", "url", "geo"],
  },
  Organization: {
    required: ["name"],
    recommended: ["url", "logo", "contactPoint", "sameAs"],
  },
  BreadcrumbList: {
    required: ["itemListElement"],
    recommended: [],
  },
  FAQPage: {
    required: ["mainEntity"],
    recommended: [],
  },
  HowTo: {
    required: ["name", "step"],
    recommended: ["description", "image", "totalTime"],
  },
  WebSite: {
    required: ["name", "url"],
    recommended: ["potentialAction"],
  },
  WebPage: {
    required: ["name"],
    recommended: ["description", "url"],
  },
  Person: {
    required: ["name"],
    recommended: ["url", "image", "jobTitle"],
  },
  Event: {
    required: ["name", "startDate", "location"],
    recommended: ["description", "endDate", "image", "organizer"],
  },
  Recipe: {
    required: ["name"],
    recommended: [
      "image",
      "author",
      "prepTime",
      "cookTime",
      "recipeIngredient",
      "recipeInstructions",
    ],
  },
  VideoObject: {
    required: ["name", "description", "thumbnailUrl", "uploadDate"],
    recommended: ["contentUrl", "duration", "embedUrl"],
  },
};

// ── Validator ────────────────────────────────────────────────────────────

const MAX_DEPTH = 10;

/**
 * Validate a single JSON-LD block (parsed JS object).
 */
export function validateJsonLdBlock(
  parsed: unknown,
  issues: StructuredDataIssue[],
  depth = 0,
): string[] {
  const typesFound: string[] = [];
  if (depth > MAX_DEPTH || parsed == null || typeof parsed !== "object") {
    return typesFound;
  }

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      typesFound.push(...validateJsonLdBlock(item, issues, depth + 1));
    }
    return typesFound;
  }

  const record = parsed as Record<string, unknown>;

  // Handle @graph
  if (Array.isArray(record["@graph"])) {
    for (const entry of record["@graph"]) {
      typesFound.push(...validateJsonLdBlock(entry, issues, depth + 1));
    }
    return typesFound;
  }

  const rawType = record["@type"];
  if (!rawType) return typesFound;

  const types = Array.isArray(rawType) ? rawType : [rawType];
  for (const type of types) {
    if (typeof type !== "string") continue;
    typesFound.push(type);

    const spec = SCHEMA_REQUIRED_PROPS[type];
    if (!spec) continue;

    // Check required properties
    for (const prop of spec.required) {
      if (record[prop] == null || record[prop] === "") {
        issues.push({
          severity: "error",
          category: "structured-data",
          message: `${type}: missing required property "${prop}"`,
          schemaType: type,
        });
      }
    }

    // Check recommended properties
    for (const prop of spec.recommended) {
      if (record[prop] == null || record[prop] === "") {
        issues.push({
          severity: "warning",
          category: "structured-data",
          message: `${type}: missing recommended property "${prop}"`,
          schemaType: type,
        });
      }
    }

    // Validate URL fields
    for (const urlField of ["url", "image", "logo", "thumbnailUrl"]) {
      const val = record[urlField];
      if (typeof val === "string" && val && !isValidUrl(val)) {
        issues.push({
          severity: "error",
          category: "structured-data",
          message: `${type}: invalid URL in "${urlField}": ${val}`,
          schemaType: type,
        });
      }
    }

    // Validate date fields
    for (const dateField of [
      "datePublished",
      "dateModified",
      "startDate",
      "endDate",
      "uploadDate",
    ]) {
      const val = record[dateField];
      if (typeof val === "string" && val && !isValidDate(val)) {
        issues.push({
          severity: "error",
          category: "structured-data",
          message: `${type}: invalid date in "${dateField}": ${val}`,
          schemaType: type,
        });
      }
    }
  }

  // Recurse into nested typed objects
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith("@")) continue;
    if (value != null && typeof value === "object") {
      typesFound.push(...validateJsonLdBlock(value, issues, depth + 1));
    }
  }

  return typesFound;
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function isValidDate(dateStr: string): boolean {
  return (
    /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?)?)?)?$/.test(
      dateStr,
    ) && !isNaN(Date.parse(dateStr))
  );
}

/**
 * Validate all JSON-LD blocks extracted from a page.
 */
export function validateStructuredData(
  jsonLdBlocks: Array<{ parsed: unknown }>,
): StructuredDataValidationResult {
  const issues: StructuredDataIssue[] = [];
  const allTypes: string[] = [];

  for (const block of jsonLdBlocks) {
    const types = validateJsonLdBlock(block.parsed, issues);
    allTypes.push(...types);
  }

  return {
    typesFound: [...new Set(allTypes)],
    issues,
    totalBlocks: jsonLdBlocks.length,
  };
}
