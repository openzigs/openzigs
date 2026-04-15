/**
 * Schema Markup Generator (#879)
 *
 * Generates valid JSON-LD templates for common Schema.org types.
 * Uses property definitions from structured-data-validator.ts.
 */

import * as z from "zod";
import type { ToolDefinition } from "../../tool-registry.js";

// ── Types ────────────────────────────────────────────────────────────────

export type SchemaType =
  | "Article"
  | "Product"
  | "LocalBusiness"
  | "FAQPage"
  | "HowTo"
  | "Recipe"
  | "Event"
  | "Organization"
  | "BreadcrumbList";

export interface SchemaFieldDefinition {
  name: string;
  required: boolean;
  description: string;
  type: "string" | "number" | "url" | "date" | "array" | "object";
  example?: string;
}

// ── Schema Property Definitions ──────────────────────────────────────────

const SCHEMA_FIELDS: Record<SchemaType, SchemaFieldDefinition[]> = {
  Article: [
    {
      name: "headline",
      required: true,
      description: "Article title",
      type: "string",
      example: "How to Optimize Your Website for SEO",
    },
    {
      name: "author",
      required: true,
      description: "Author name or object",
      type: "string",
      example: "John Doe",
    },
    {
      name: "datePublished",
      required: true,
      description: "Publication date (ISO 8601)",
      type: "date",
      example: "2026-01-15",
    },
    {
      name: "dateModified",
      required: false,
      description: "Last modification date",
      type: "date",
      example: "2026-03-01",
    },
    {
      name: "image",
      required: false,
      description: "Article image URL",
      type: "url",
      example: "https://example.com/image.jpg",
    },
    {
      name: "description",
      required: false,
      description: "Short description",
      type: "string",
      example: "A comprehensive guide to SEO optimization",
    },
    {
      name: "publisher",
      required: false,
      description: "Publisher name",
      type: "string",
      example: "Example Publishing",
    },
  ],
  Product: [
    {
      name: "name",
      required: true,
      description: "Product name",
      type: "string",
      example: "Premium Widget",
    },
    {
      name: "description",
      required: false,
      description: "Product description",
      type: "string",
      example: "A high-quality widget for everyday use",
    },
    {
      name: "image",
      required: false,
      description: "Product image URL",
      type: "url",
      example: "https://example.com/product.jpg",
    },
    {
      name: "brand",
      required: false,
      description: "Brand name",
      type: "string",
      example: "WidgetCo",
    },
    {
      name: "sku",
      required: false,
      description: "Product SKU",
      type: "string",
      example: "WDG-001",
    },
    {
      name: "price",
      required: false,
      description: "Price amount",
      type: "number",
      example: "29.99",
    },
    {
      name: "priceCurrency",
      required: false,
      description: "Currency code (ISO 4217)",
      type: "string",
      example: "USD",
    },
    {
      name: "availability",
      required: false,
      description: "Availability status",
      type: "string",
      example: "InStock",
    },
  ],
  LocalBusiness: [
    {
      name: "name",
      required: true,
      description: "Business name",
      type: "string",
      example: "Joe's Coffee Shop",
    },
    {
      name: "address",
      required: true,
      description: "Street address",
      type: "string",
      example: "123 Main St, City, State 12345",
    },
    {
      name: "telephone",
      required: false,
      description: "Phone number",
      type: "string",
      example: "+1-555-123-4567",
    },
    {
      name: "openingHours",
      required: false,
      description: "Opening hours (e.g., Mo-Fr 09:00-17:00)",
      type: "string",
      example: "Mo-Fr 09:00-17:00",
    },
    {
      name: "image",
      required: false,
      description: "Business image URL",
      type: "url",
      example: "https://example.com/business.jpg",
    },
    {
      name: "url",
      required: false,
      description: "Website URL",
      type: "url",
      example: "https://example.com",
    },
    {
      name: "latitude",
      required: false,
      description: "Geo latitude",
      type: "number",
      example: "40.7128",
    },
    {
      name: "longitude",
      required: false,
      description: "Geo longitude",
      type: "number",
      example: "-74.0060",
    },
  ],
  FAQPage: [
    {
      name: "questions",
      required: true,
      description: "FAQ entries (JSON array of {question, answer})",
      type: "array",
      example:
        '[{"question":"What is SEO?","answer":"SEO is Search Engine Optimization."}]',
    },
  ],
  HowTo: [
    {
      name: "name",
      required: true,
      description: "How-to title",
      type: "string",
      example: "How to Change a Tire",
    },
    {
      name: "description",
      required: false,
      description: "Brief description",
      type: "string",
      example: "Step-by-step guide to changing a flat tire",
    },
    {
      name: "totalTime",
      required: false,
      description: "Total time (ISO 8601 duration)",
      type: "string",
      example: "PT30M",
    },
    {
      name: "steps",
      required: true,
      description: "Steps (JSON array of {name, text})",
      type: "array",
      example:
        '[{"name":"Loosen lug nuts","text":"Use a wrench to loosen the lug nuts."}]',
    },
    {
      name: "image",
      required: false,
      description: "Image URL",
      type: "url",
      example: "https://example.com/howto.jpg",
    },
  ],
  Recipe: [
    {
      name: "name",
      required: true,
      description: "Recipe name",
      type: "string",
      example: "Chocolate Chip Cookies",
    },
    {
      name: "image",
      required: false,
      description: "Recipe image URL",
      type: "url",
      example: "https://example.com/cookies.jpg",
    },
    {
      name: "author",
      required: false,
      description: "Recipe author",
      type: "string",
      example: "Jane Baker",
    },
    {
      name: "prepTime",
      required: false,
      description: "Prep time (ISO 8601 duration)",
      type: "string",
      example: "PT15M",
    },
    {
      name: "cookTime",
      required: false,
      description: "Cook time (ISO 8601 duration)",
      type: "string",
      example: "PT12M",
    },
    {
      name: "recipeIngredient",
      required: false,
      description: "Ingredients (JSON array of strings)",
      type: "array",
      example: '["2 cups flour","1 cup sugar","1 cup butter"]',
    },
    {
      name: "recipeInstructions",
      required: false,
      description: "Instructions (JSON array of strings)",
      type: "array",
      example: '["Mix dry ingredients","Add wet ingredients","Bake at 350°F"]',
    },
  ],
  Event: [
    {
      name: "name",
      required: true,
      description: "Event name",
      type: "string",
      example: "Tech Conference 2026",
    },
    {
      name: "startDate",
      required: true,
      description: "Start date (ISO 8601)",
      type: "date",
      example: "2026-06-15T09:00:00",
    },
    {
      name: "endDate",
      required: false,
      description: "End date (ISO 8601)",
      type: "date",
      example: "2026-06-17T17:00:00",
    },
    {
      name: "location",
      required: true,
      description: "Event location",
      type: "string",
      example: "Convention Center, San Francisco, CA",
    },
    {
      name: "description",
      required: false,
      description: "Event description",
      type: "string",
      example: "Annual technology conference",
    },
    {
      name: "image",
      required: false,
      description: "Event image URL",
      type: "url",
      example: "https://example.com/event.jpg",
    },
    {
      name: "organizer",
      required: false,
      description: "Organizer name",
      type: "string",
      example: "TechCorp",
    },
  ],
  Organization: [
    {
      name: "name",
      required: true,
      description: "Organization name",
      type: "string",
      example: "Example Corp",
    },
    {
      name: "url",
      required: false,
      description: "Website URL",
      type: "url",
      example: "https://example.com",
    },
    {
      name: "logo",
      required: false,
      description: "Logo URL",
      type: "url",
      example: "https://example.com/logo.png",
    },
    {
      name: "contactPoint",
      required: false,
      description: "Contact info (phone or email)",
      type: "string",
      example: "+1-555-123-4567",
    },
    {
      name: "sameAs",
      required: false,
      description: "Social profile URLs (JSON array)",
      type: "array",
      example:
        '["https://twitter.com/example","https://linkedin.com/company/example"]',
    },
  ],
  BreadcrumbList: [
    {
      name: "items",
      required: true,
      description: "Breadcrumb items (JSON array of {name, url})",
      type: "array",
      example:
        '[{"name":"Home","url":"https://example.com"},{"name":"Products","url":"https://example.com/products"}]',
    },
  ],
};

export const SUPPORTED_SCHEMA_TYPES: SchemaType[] = Object.keys(
  SCHEMA_FIELDS,
) as SchemaType[];

export function getSchemaFields(type: SchemaType): SchemaFieldDefinition[] {
  return SCHEMA_FIELDS[type] ?? [];
}

// ── Schema Generation ────────────────────────────────────────────────────

/**
 * Generate a JSON-LD schema markup from the given type and data.
 */
export function generateSchemaMarkup(
  type: SchemaType,
  data: Record<string, unknown>,
): string {
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": type,
  };

  switch (type) {
    case "Article":
      buildArticle(jsonLd, data);
      break;
    case "Product":
      buildProduct(jsonLd, data);
      break;
    case "LocalBusiness":
      buildLocalBusiness(jsonLd, data);
      break;
    case "FAQPage":
      buildFAQPage(jsonLd, data);
      break;
    case "HowTo":
      buildHowTo(jsonLd, data);
      break;
    case "Recipe":
      buildRecipe(jsonLd, data);
      break;
    case "Event":
      buildEvent(jsonLd, data);
      break;
    case "Organization":
      buildOrganization(jsonLd, data);
      break;
    case "BreadcrumbList":
      buildBreadcrumbList(jsonLd, data);
      break;
  }

  return JSON.stringify(jsonLd, null, 2);
}

function setIfPresent(
  obj: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined && value !== null && value !== "") {
    obj[key] = value;
  }
}

function buildArticle(
  jsonLd: Record<string, unknown>,
  data: Record<string, unknown>,
): void {
  setIfPresent(jsonLd, "headline", data.headline);
  if (data.author) {
    jsonLd["author"] = { "@type": "Person", name: data.author };
  }
  setIfPresent(jsonLd, "datePublished", data.datePublished);
  setIfPresent(jsonLd, "dateModified", data.dateModified);
  setIfPresent(jsonLd, "image", data.image);
  setIfPresent(jsonLd, "description", data.description);
  if (data.publisher) {
    jsonLd["publisher"] = { "@type": "Organization", name: data.publisher };
  }
}

function buildProduct(
  jsonLd: Record<string, unknown>,
  data: Record<string, unknown>,
): void {
  setIfPresent(jsonLd, "name", data.name);
  setIfPresent(jsonLd, "description", data.description);
  setIfPresent(jsonLd, "image", data.image);
  if (data.brand) {
    jsonLd["brand"] = { "@type": "Brand", name: data.brand };
  }
  setIfPresent(jsonLd, "sku", data.sku);
  if (data.price !== undefined && data.price !== "") {
    jsonLd["offers"] = {
      "@type": "Offer",
      price: data.price,
      priceCurrency: data.priceCurrency || "USD",
      availability: data.availability
        ? `https://schema.org/${data.availability}`
        : "https://schema.org/InStock",
    };
  }
}

function buildLocalBusiness(
  jsonLd: Record<string, unknown>,
  data: Record<string, unknown>,
): void {
  setIfPresent(jsonLd, "name", data.name);
  if (data.address) {
    jsonLd["address"] = {
      "@type": "PostalAddress",
      streetAddress: data.address,
    };
  }
  setIfPresent(jsonLd, "telephone", data.telephone);
  setIfPresent(jsonLd, "openingHours", data.openingHours);
  setIfPresent(jsonLd, "image", data.image);
  setIfPresent(jsonLd, "url", data.url);
  if (
    data.latitude !== undefined &&
    data.longitude !== undefined &&
    data.latitude !== "" &&
    data.longitude !== ""
  ) {
    jsonLd["geo"] = {
      "@type": "GeoCoordinates",
      latitude: Number(data.latitude),
      longitude: Number(data.longitude),
    };
  }
}

function buildFAQPage(
  jsonLd: Record<string, unknown>,
  data: Record<string, unknown>,
): void {
  let questions: Array<{ question: string; answer: string }> = [];
  if (typeof data.questions === "string") {
    try {
      questions = JSON.parse(data.questions);
    } catch {
      /* noop */
    }
  } else if (Array.isArray(data.questions)) {
    questions = data.questions as Array<{ question: string; answer: string }>;
  }
  jsonLd["mainEntity"] = questions.map((q) => ({
    "@type": "Question",
    name: q.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: q.answer,
    },
  }));
}

function buildHowTo(
  jsonLd: Record<string, unknown>,
  data: Record<string, unknown>,
): void {
  setIfPresent(jsonLd, "name", data.name);
  setIfPresent(jsonLd, "description", data.description);
  setIfPresent(jsonLd, "totalTime", data.totalTime);
  setIfPresent(jsonLd, "image", data.image);
  let steps: Array<{ name: string; text: string }> = [];
  if (typeof data.steps === "string") {
    try {
      steps = JSON.parse(data.steps);
    } catch {
      /* noop */
    }
  } else if (Array.isArray(data.steps)) {
    steps = data.steps as Array<{ name: string; text: string }>;
  }
  jsonLd["step"] = steps.map((s) => ({
    "@type": "HowToStep",
    name: s.name,
    text: s.text,
  }));
}

function buildRecipe(
  jsonLd: Record<string, unknown>,
  data: Record<string, unknown>,
): void {
  setIfPresent(jsonLd, "name", data.name);
  setIfPresent(jsonLd, "image", data.image);
  if (data.author) {
    jsonLd["author"] = { "@type": "Person", name: data.author };
  }
  setIfPresent(jsonLd, "prepTime", data.prepTime);
  setIfPresent(jsonLd, "cookTime", data.cookTime);
  let ingredients: string[] = [];
  if (typeof data.recipeIngredient === "string") {
    try {
      ingredients = JSON.parse(data.recipeIngredient);
    } catch {
      /* noop */
    }
  } else if (Array.isArray(data.recipeIngredient)) {
    ingredients = data.recipeIngredient as string[];
  }
  if (ingredients.length > 0) jsonLd["recipeIngredient"] = ingredients;
  let instructions: string[] = [];
  if (typeof data.recipeInstructions === "string") {
    try {
      instructions = JSON.parse(data.recipeInstructions);
    } catch {
      /* noop */
    }
  } else if (Array.isArray(data.recipeInstructions)) {
    instructions = data.recipeInstructions as string[];
  }
  if (instructions.length > 0) {
    jsonLd["recipeInstructions"] = instructions.map((text) => ({
      "@type": "HowToStep",
      text: text,
    }));
  }
}

function buildEvent(
  jsonLd: Record<string, unknown>,
  data: Record<string, unknown>,
): void {
  setIfPresent(jsonLd, "name", data.name);
  setIfPresent(jsonLd, "startDate", data.startDate);
  setIfPresent(jsonLd, "endDate", data.endDate);
  if (data.location) {
    jsonLd["location"] = {
      "@type": "Place",
      name: data.location,
    };
  }
  setIfPresent(jsonLd, "description", data.description);
  setIfPresent(jsonLd, "image", data.image);
  if (data.organizer) {
    jsonLd["organizer"] = { "@type": "Organization", name: data.organizer };
  }
}

function buildOrganization(
  jsonLd: Record<string, unknown>,
  data: Record<string, unknown>,
): void {
  setIfPresent(jsonLd, "name", data.name);
  setIfPresent(jsonLd, "url", data.url);
  setIfPresent(jsonLd, "logo", data.logo);
  if (data.contactPoint) {
    jsonLd["contactPoint"] = {
      "@type": "ContactPoint",
      telephone: data.contactPoint,
    };
  }
  let sameAs: string[] = [];
  if (typeof data.sameAs === "string") {
    try {
      sameAs = JSON.parse(data.sameAs);
    } catch {
      /* noop */
    }
  } else if (Array.isArray(data.sameAs)) {
    sameAs = data.sameAs as string[];
  }
  if (sameAs.length > 0) jsonLd["sameAs"] = sameAs;
}

function buildBreadcrumbList(
  jsonLd: Record<string, unknown>,
  data: Record<string, unknown>,
): void {
  let items: Array<{ name: string; url: string }> = [];
  if (typeof data.items === "string") {
    try {
      items = JSON.parse(data.items);
    } catch {
      /* noop */
    }
  } else if (Array.isArray(data.items)) {
    items = data.items as Array<{ name: string; url: string }>;
  }
  jsonLd["itemListElement"] = items.map((item, idx) => ({
    "@type": "ListItem",
    position: idx + 1,
    name: item.name,
    item: item.url,
  }));
}

// ── Zod Schema ───────────────────────────────────────────────────────────

const schemaGeneratorSchema = z.object({
  type: z
    .enum([
      "Article",
      "Product",
      "LocalBusiness",
      "FAQPage",
      "HowTo",
      "Recipe",
      "Event",
      "Organization",
      "BreadcrumbList",
    ])
    .describe("Schema.org type to generate"),
  data: z.record(z.unknown()).describe("Property values for the schema"),
});

// ── Tool Factory ─────────────────────────────────────────────────────────

export function createSchemaGeneratorTool(): ToolDefinition {
  return {
    name: "seo-schema-generator",
    description:
      "Generate valid JSON-LD structured data markup for common Schema.org types. " +
      "Supports: Article, Product, LocalBusiness, FAQPage, HowTo, Recipe, Event, Organization, BreadcrumbList.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "Schema.org type to generate",
          enum: SUPPORTED_SCHEMA_TYPES,
        },
        data: {
          type: "object",
          description: "Property values for the schema",
        },
      },
      required: ["type", "data"],
    },
    zodSchema: schemaGeneratorSchema,
    category: "search",
    riskLevel: "low",
    handler: async (args) => {
      const { type, data } = schemaGeneratorSchema.parse(args);
      const jsonLd = generateSchemaMarkup(
        type as SchemaType,
        data as Record<string, unknown>,
      );
      return { text: jsonLd };
    },
  };
}
