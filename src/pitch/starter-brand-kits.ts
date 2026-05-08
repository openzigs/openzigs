/**
 * Starter Brand Kits — 8 built-in brand presets seeded on first run.
 *
 * Sub-issue #953 (Epic #951 / Studio Pitch). Idempotent: inserts only kits
 * whose `id` is not already present so re-running the seed (e.g. server
 * restart) does not produce duplicates or clobber user edits.
 *
 * All kits use system-safe fonts per research §10 — pptxgenjs embeds font
 * *names*, not files, so unfamiliar fonts fall back to the recipient's
 * default. Stick to fonts present on Windows + macOS + common web stacks.
 */
import type { BrandKit, BrandKitRepository } from "../video/brand-kit.js";

/** A starter kit prior to insertion (no createdAt/updatedAt yet). */
type StarterBrandKit = Omit<BrandKit, "createdAt" | "updatedAt">;

export const STARTER_BRAND_KITS: readonly StarterBrandKit[] = [
  {
    id: "starter-modern-minimal",
    name: "Modern Minimal",
    primaryColor: "#111111",
    secondaryColor: "#ffffff",
    accentColor: "#0066ff",
    fontFamily: "Inter",
    fontHeading: "Inter",
    fontBody: "Inter",
    footerText: null,
    logoPath: null,
    watermarkPath: null,
    introTemplateId: null,
    outroTemplateId: null,
    defaultLogoPlacement: null,
    showSlideNumbers: null,
  },
  {
    id: "starter-corporate-blue",
    name: "Corporate Blue",
    primaryColor: "#0a3d91",
    secondaryColor: "#f4f6fa",
    accentColor: "#3b82f6",
    fontFamily: "Calibri",
    fontHeading: "Calibri",
    fontBody: "Calibri",
    footerText: null,
    logoPath: null,
    watermarkPath: null,
    introTemplateId: null,
    outroTemplateId: null,
    defaultLogoPlacement: null,
    showSlideNumbers: null,
  },
  {
    id: "starter-startup-vibrant",
    name: "Startup Vibrant",
    primaryColor: "#7c3aed",
    secondaryColor: "#fdf4ff",
    accentColor: "#f472b6",
    fontFamily: "Poppins",
    fontHeading: "Poppins",
    fontBody: "Inter",
    footerText: null,
    logoPath: null,
    watermarkPath: null,
    introTemplateId: null,
    outroTemplateId: null,
    defaultLogoPlacement: null,
    showSlideNumbers: null,
  },
  {
    id: "starter-academic",
    name: "Academic",
    primaryColor: "#1f2937",
    secondaryColor: "#f9fafb",
    accentColor: "#92400e",
    fontFamily: "Cambria",
    fontHeading: "Cambria",
    fontBody: "Georgia",
    footerText: null,
    logoPath: null,
    watermarkPath: null,
    introTemplateId: null,
    outroTemplateId: null,
    defaultLogoPlacement: null,
    showSlideNumbers: null,
  },
  {
    id: "starter-dark-tech",
    name: "Dark Tech",
    primaryColor: "#0b1020",
    secondaryColor: "#e2e8f0",
    accentColor: "#22d3ee",
    fontFamily: "IBM Plex Sans",
    fontHeading: "Space Grotesk",
    fontBody: "IBM Plex Sans",
    footerText: null,
    logoPath: null,
    watermarkPath: null,
    introTemplateId: null,
    outroTemplateId: null,
    defaultLogoPlacement: null,
    showSlideNumbers: null,
  },
  {
    id: "starter-warm-creative",
    name: "Warm Creative",
    primaryColor: "#7c2d12",
    secondaryColor: "#fef3c7",
    accentColor: "#ea580c",
    fontFamily: "Playfair Display",
    fontHeading: "Playfair Display",
    fontBody: "Source Sans Pro",
    footerText: null,
    logoPath: null,
    watermarkPath: null,
    introTemplateId: null,
    outroTemplateId: null,
    defaultLogoPlacement: null,
    showSlideNumbers: null,
  },
  {
    id: "starter-medical-clinical",
    name: "Medical / Clinical",
    primaryColor: "#075985",
    secondaryColor: "#f0f9ff",
    accentColor: "#14b8a6",
    fontFamily: "Helvetica",
    fontHeading: "Helvetica",
    fontBody: "Helvetica",
    footerText: null,
    logoPath: null,
    watermarkPath: null,
    introTemplateId: null,
    outroTemplateId: null,
    defaultLogoPlacement: null,
    showSlideNumbers: null,
  },
  {
    id: "starter-pitch-deck-classic",
    name: "Pitch Deck Classic",
    primaryColor: "#0f172a",
    secondaryColor: "#ffffff",
    accentColor: "#f59e0b",
    fontFamily: "Inter",
    fontHeading: "Inter",
    fontBody: "Inter",
    footerText: null,
    logoPath: null,
    watermarkPath: null,
    introTemplateId: null,
    outroTemplateId: null,
    defaultLogoPlacement: null,
    showSlideNumbers: null,
  },
] as const;

export interface SeedResult {
  inserted: string[];
  skipped: string[];
}

/**
 * Idempotently insert starter brand kits.
 *
 * For each kit, checks `repo.getById(id)` first and only inserts when missing.
 * If a kit is already present (e.g. seeded on a previous boot, or hand-edited
 * by the user), it is left untouched.
 */
export function seedStarterBrandKits(repo: BrandKitRepository): SeedResult {
  const inserted: string[] = [];
  const skipped: string[] = [];
  for (const kit of STARTER_BRAND_KITS) {
    if (repo.getById(kit.id)) {
      skipped.push(kit.id);
      continue;
    }
    repo.create(kit);
    inserted.push(kit.id);
  }
  return { inserted, skipped };
}
