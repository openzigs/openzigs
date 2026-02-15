/**
 * Director Mode — Template Registry
 * Issue #236: Central registry for all video templates.
 * Implements the TemplateRegistry interface.
 */

import type { TemplateId } from "../manifest/manifest-types.js";
import type { TemplateDefinition, TemplateRegistry } from "./template-types.js";
import {
  MinimalistTemplate,
  ContentCreatorTemplate,
  CorporateTemplate,
  TechDemoTemplate,
} from "./template-definitions.js";

const BUILT_IN_TEMPLATES: TemplateDefinition[] = [
  MinimalistTemplate,
  ContentCreatorTemplate,
  CorporateTemplate,
  TechDemoTemplate,
];

/**
 * Create a template registry pre-populated with the 4 built-in templates.
 */
export function createTemplateRegistry(): TemplateRegistry {
  const templateMap = new Map<TemplateId, TemplateDefinition>();
  for (const template of BUILT_IN_TEMPLATES) {
    templateMap.set(template.id, template);
  }

  return {
    get(id: TemplateId): TemplateDefinition | undefined {
      return templateMap.get(id);
    },

    getAll(): TemplateDefinition[] {
      return Array.from(templateMap.values());
    },

    getDefault(): TemplateDefinition {
      return MinimalistTemplate;
    },

    getByTag(tag: string): TemplateDefinition[] {
      const lowerTag = tag.toLowerCase();
      return Array.from(templateMap.values()).filter((t) =>
        t.tags.some((tTag) => tTag.toLowerCase().includes(lowerTag)),
      );
    },
  };
}

/** All valid template IDs. */
export const TEMPLATE_IDS: TemplateId[] = BUILT_IN_TEMPLATES.map((t) => t.id);
