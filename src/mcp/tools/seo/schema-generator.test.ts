import { describe, it, expect } from "vitest";
import {
  generateSchemaMarkup,
  getSchemaFields,
  SUPPORTED_SCHEMA_TYPES,
} from "./schema-generator.js";

describe("Schema Markup Generator (#879)", () => {
  it("exports all supported schema types", () => {
    expect(SUPPORTED_SCHEMA_TYPES).toContain("Article");
    expect(SUPPORTED_SCHEMA_TYPES).toContain("Product");
    expect(SUPPORTED_SCHEMA_TYPES).toContain("LocalBusiness");
    expect(SUPPORTED_SCHEMA_TYPES).toContain("FAQPage");
    expect(SUPPORTED_SCHEMA_TYPES).toContain("HowTo");
    expect(SUPPORTED_SCHEMA_TYPES).toContain("Recipe");
    expect(SUPPORTED_SCHEMA_TYPES).toContain("Event");
    expect(SUPPORTED_SCHEMA_TYPES).toContain("Organization");
    expect(SUPPORTED_SCHEMA_TYPES).toContain("BreadcrumbList");
  });

  it("returns field definitions for each type", () => {
    for (const type of SUPPORTED_SCHEMA_TYPES) {
      const fields = getSchemaFields(type);
      expect(fields.length).toBeGreaterThan(0);
      expect(fields.some((f) => f.required)).toBe(true);
    }
  });

  describe("generateSchemaMarkup", () => {
    it("generates Article schema", () => {
      const json = generateSchemaMarkup("Article", {
        headline: "Test Article",
        author: "John Doe",
        datePublished: "2026-01-15",
        image: "https://example.com/img.jpg",
      });
      const parsed = JSON.parse(json);
      expect(parsed["@context"]).toBe("https://schema.org");
      expect(parsed["@type"]).toBe("Article");
      expect(parsed.headline).toBe("Test Article");
      expect(parsed.author).toEqual({ "@type": "Person", name: "John Doe" });
      expect(parsed.datePublished).toBe("2026-01-15");
      expect(parsed.image).toBe("https://example.com/img.jpg");
    });

    it("generates Product schema with offers", () => {
      const json = generateSchemaMarkup("Product", {
        name: "Widget",
        price: 29.99,
        priceCurrency: "USD",
        brand: "WidgetCo",
      });
      const parsed = JSON.parse(json);
      expect(parsed["@type"]).toBe("Product");
      expect(parsed.name).toBe("Widget");
      expect(parsed.brand).toEqual({ "@type": "Brand", name: "WidgetCo" });
      expect(parsed.offers.price).toBe(29.99);
      expect(parsed.offers.priceCurrency).toBe("USD");
    });

    it("generates LocalBusiness schema with geo", () => {
      const json = generateSchemaMarkup("LocalBusiness", {
        name: "Joe's Coffee",
        address: "123 Main St",
        latitude: 40.7128,
        longitude: -74.006,
      });
      const parsed = JSON.parse(json);
      expect(parsed["@type"]).toBe("LocalBusiness");
      expect(parsed.geo.latitude).toBe(40.7128);
      expect(parsed.geo.longitude).toBe(-74.006);
    });

    it("generates FAQPage schema", () => {
      const questions = [
        { question: "What is SEO?", answer: "Search Engine Optimization." },
      ];
      const json = generateSchemaMarkup("FAQPage", {
        questions: JSON.stringify(questions),
      });
      const parsed = JSON.parse(json);
      expect(parsed["@type"]).toBe("FAQPage");
      expect(parsed.mainEntity).toHaveLength(1);
      expect(parsed.mainEntity[0]["@type"]).toBe("Question");
      expect(parsed.mainEntity[0].name).toBe("What is SEO?");
    });

    it("generates HowTo schema", () => {
      const steps = [{ name: "Step 1", text: "Do this first." }];
      const json = generateSchemaMarkup("HowTo", {
        name: "How to Test",
        steps: JSON.stringify(steps),
        totalTime: "PT30M",
      });
      const parsed = JSON.parse(json);
      expect(parsed["@type"]).toBe("HowTo");
      expect(parsed.step).toHaveLength(1);
      expect(parsed.step[0]["@type"]).toBe("HowToStep");
      expect(parsed.totalTime).toBe("PT30M");
    });

    it("generates Recipe schema", () => {
      const json = generateSchemaMarkup("Recipe", {
        name: "Cookies",
        author: "Jane",
        prepTime: "PT15M",
        cookTime: "PT12M",
        recipeIngredient: JSON.stringify(["flour", "sugar"]),
        recipeInstructions: JSON.stringify(["Mix", "Bake"]),
      });
      const parsed = JSON.parse(json);
      expect(parsed["@type"]).toBe("Recipe");
      expect(parsed.recipeIngredient).toEqual(["flour", "sugar"]);
      expect(parsed.recipeInstructions).toHaveLength(2);
    });

    it("generates Event schema", () => {
      const json = generateSchemaMarkup("Event", {
        name: "Tech Conference",
        startDate: "2026-06-15",
        location: "SF Convention Center",
        organizer: "TechCorp",
      });
      const parsed = JSON.parse(json);
      expect(parsed["@type"]).toBe("Event");
      expect(parsed.location["@type"]).toBe("Place");
      expect(parsed.organizer["@type"]).toBe("Organization");
    });

    it("generates Organization schema", () => {
      const json = generateSchemaMarkup("Organization", {
        name: "ExampleCorp",
        url: "https://example.com",
        logo: "https://example.com/logo.png",
        sameAs: JSON.stringify(["https://twitter.com/example"]),
      });
      const parsed = JSON.parse(json);
      expect(parsed["@type"]).toBe("Organization");
      expect(parsed.sameAs).toEqual(["https://twitter.com/example"]);
    });

    it("generates BreadcrumbList schema", () => {
      const items = [
        { name: "Home", url: "https://example.com" },
        { name: "Products", url: "https://example.com/products" },
      ];
      const json = generateSchemaMarkup("BreadcrumbList", {
        items: JSON.stringify(items),
      });
      const parsed = JSON.parse(json);
      expect(parsed["@type"]).toBe("BreadcrumbList");
      expect(parsed.itemListElement).toHaveLength(2);
      expect(parsed.itemListElement[0].position).toBe(1);
      expect(parsed.itemListElement[1].position).toBe(2);
    });

    it("omits undefined/empty optional fields", () => {
      const json = generateSchemaMarkup("Article", {
        headline: "Test",
        author: "John",
        datePublished: "2026-01-01",
      });
      const parsed = JSON.parse(json);
      expect(parsed.image).toBeUndefined();
      expect(parsed.description).toBeUndefined();
    });

    it("always includes @context and @type", () => {
      for (const type of SUPPORTED_SCHEMA_TYPES) {
        const json = generateSchemaMarkup(type, {});
        const parsed = JSON.parse(json);
        expect(parsed["@context"]).toBe("https://schema.org");
        expect(parsed["@type"]).toBe(type);
      }
    });
  });
});
