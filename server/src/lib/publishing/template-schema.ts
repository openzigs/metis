/**
 * Template JSON Schema — Epic #595 / Issue #610.
 *
 * Defines the schema for configurable issue templates. Templates specify
 * which sections an LLM must populate when generating issue drafts, with
 * validation rules, platform-specific field mappings, and default values.
 */

/** Supported section content types. */
export const SECTION_TYPES = ["text", "markdown", "checklist", "number", "select", "tags"] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

/** Target platforms for templates. */
export const TEMPLATE_PLATFORMS = ["github", "jira", "universal"] as const;
export type TemplatePlatform = (typeof TEMPLATE_PLATFORMS)[number];

/** Issue types a template can target. */
export const TEMPLATE_TYPES = ["epic", "feature", "story", "bug", "task"] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

/** Validation rules for a template section. */
export interface SectionValidation {
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  minItems?: number;
  pattern?: string;
  min?: number;
  max?: number;
  options?: string[];
}

/** A single section definition within a template schema. */
export interface TemplateSection {
  key: string;
  label: string;
  type: SectionType;
  required: boolean;
  validation?: SectionValidation;
  defaultValue?: unknown;
  placeholder?: string;
}

/** Platform-specific field mappings (e.g. Jira custom fields). */
export interface PlatformFieldMapping {
  jiraField?: string;
  githubField?: string;
}

/** The complete template schema definition. */
export interface TemplateSchema {
  name: string;
  platform: TemplatePlatform;
  templateType: TemplateType;
  sections: TemplateSection[];
  platformFields?: Record<string, PlatformFieldMapping>;
}

/**
 * Well-known section keys. Templates MAY use these or define custom keys.
 * Used by default templates and the draft generator for structure recognition.
 */
export const WELL_KNOWN_SECTIONS = [
  "title",
  "description",
  "acceptanceCriteria",
  "storyPoints",
  "priority",
  "component",
  "labels",
  "evidenceBlock",
  "architectureDiagram",
  "technicalNotes",
  "stepsToReproduce",
  "expectedBehavior",
  "actualBehavior",
  "severity",
  "environment",
  "subIssues",
  "dependencies",
] as const;
export type WellKnownSectionKey = (typeof WELL_KNOWN_SECTIONS)[number];
