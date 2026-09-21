/**
 * Template Validator — Epic #595 / Issue #610.
 *
 * Validates:
 *   1. TemplateSchema structure (meta-schema validation)
 *   2. Populated template data against a TemplateSchema (output validation)
 */
import safeRegex from "safe-regex2";
import {
  SECTION_TYPES,
  TEMPLATE_PLATFORMS,
  TEMPLATE_TYPES,
  type SectionType,
  type TemplateSchema,
  type TemplateSection,
} from "./template-schema.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a TemplateSchema object (meta-schema validation).
 * Ensures the schema itself is well-formed before storing it.
 */
export function validateTemplateSchema(schema: unknown): ValidationResult {
  const errors: string[] = [];

  if (!schema || typeof schema !== "object") {
    return { valid: false, errors: ["schema must be a non-null object"] };
  }

  const s = schema as Record<string, unknown>;

  // name
  if (typeof s.name !== "string" || s.name.trim().length === 0) {
    errors.push("schema.name must be a non-empty string");
  } else if (s.name.length > 128) {
    errors.push("schema.name must be ≤128 characters");
  }

  // platform
  if (!TEMPLATE_PLATFORMS.includes(s.platform as never)) {
    errors.push(`schema.platform must be one of: ${TEMPLATE_PLATFORMS.join(", ")}`);
  }

  // templateType
  if (!TEMPLATE_TYPES.includes(s.templateType as never)) {
    errors.push(`schema.templateType must be one of: ${TEMPLATE_TYPES.join(", ")}`);
  }

  // sections
  if (!Array.isArray(s.sections)) {
    errors.push("schema.sections must be an array");
  } else if (s.sections.length === 0) {
    errors.push("schema.sections must have at least one section");
  } else if (s.sections.length > 50) {
    errors.push("schema.sections must have at most 50 sections");
  } else {
    const keys = new Set<string>();
    for (let i = 0; i < s.sections.length; i++) {
      const sec = s.sections[i];
      const prefix = `schema.sections[${i}]`;
      if (!sec || typeof sec !== "object") {
        errors.push(`${prefix} must be an object`);
        continue;
      }
      const section = sec as Record<string, unknown>;
      if (typeof section.key !== "string" || section.key.trim().length === 0) {
        errors.push(`${prefix}.key must be a non-empty string`);
      } else if (keys.has(section.key as string)) {
        errors.push(`${prefix}.key "${section.key}" is duplicated`);
      } else {
        keys.add(section.key as string);
      }
      if (typeof section.label !== "string" || section.label.trim().length === 0) {
        errors.push(`${prefix}.label must be a non-empty string`);
      }
      if (!SECTION_TYPES.includes(section.type as SectionType)) {
        errors.push(`${prefix}.type must be one of: ${SECTION_TYPES.join(", ")}`);
      }
      if (typeof section.required !== "boolean") {
        errors.push(`${prefix}.required must be a boolean`);
      }

      // Validate validation rules if present
      if (section.validation !== undefined) {
        if (typeof section.validation !== "object" || section.validation === null) {
          errors.push(`${prefix}.validation must be an object`);
        } else {
          validateSectionValidation(section.validation as Record<string, unknown>, prefix, errors);
        }
      }
    }
  }

  // platformFields (optional)
  if (s.platformFields !== undefined) {
    if (typeof s.platformFields !== "object" || s.platformFields === null) {
      errors.push("schema.platformFields must be an object");
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateSectionValidation(
  v: Record<string, unknown>,
  prefix: string,
  errors: string[],
): void {
  if (v.minLength !== undefined && (typeof v.minLength !== "number" || v.minLength < 0)) {
    errors.push(`${prefix}.validation.minLength must be a non-negative number`);
  }
  if (v.maxLength !== undefined && (typeof v.maxLength !== "number" || v.maxLength < 0)) {
    errors.push(`${prefix}.validation.maxLength must be a non-negative number`);
  }
  if (v.maxItems !== undefined && (typeof v.maxItems !== "number" || v.maxItems < 0)) {
    errors.push(`${prefix}.validation.maxItems must be a non-negative number`);
  }
  if (v.minItems !== undefined && (typeof v.minItems !== "number" || v.minItems < 0)) {
    errors.push(`${prefix}.validation.minItems must be a non-negative number`);
  }
  if (v.pattern !== undefined) {
    if (typeof v.pattern !== "string") {
      errors.push(`${prefix}.validation.pattern must be a string`);
    } else {
      try {
        // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- this IS the validator that rejects unsafe patterns: the compiled regex is immediately checked with safeRegex() and never executed on input here.
        const re = new RegExp(v.pattern);
        if (!safeRegex(re)) {
          errors.push(`${prefix}.validation.pattern is unsafe (potential ReDoS)`);
        }
      } catch {
        errors.push(`${prefix}.validation.pattern is not a valid regular expression`);
      }
    }
  }
  if (v.options !== undefined) {
    if (!Array.isArray(v.options) || !v.options.every((o: unknown) => typeof o === "string")) {
      errors.push(`${prefix}.validation.options must be an array of strings`);
    }
  }
}

/**
 * Validates populated template data against a TemplateSchema.
 * Used to verify that LLM output conforms to the template's required sections.
 */
export function validateTemplateData(
  data: Record<string, unknown>,
  schema: TemplateSchema,
): ValidationResult {
  const errors: string[] = [];

  for (const section of schema.sections) {
    const value = data[section.key];

    // Required check
    if (section.required && (value === undefined || value === null || value === "")) {
      errors.push(`missing required section: ${section.key}`);
      continue;
    }

    // Skip validation for absent optional fields
    if (value === undefined || value === null) continue;

    validateSectionValue(value, section, errors);
  }

  return { valid: errors.length === 0, errors };
}

function validateSectionValue(value: unknown, section: TemplateSection, errors: string[]): void {
  const { key, type, validation } = section;

  switch (type) {
    case "text":
    case "markdown": {
      if (typeof value !== "string") {
        errors.push(`${key}: expected string, got ${typeof value}`);
        return;
      }
      if (validation?.minLength && value.length < validation.minLength) {
        errors.push(`${key}: minimum length is ${validation.minLength}`);
      }
      if (validation?.maxLength && value.length > validation.maxLength) {
        errors.push(`${key}: maximum length is ${validation.maxLength}`);
      }
      if (validation?.pattern) {
        try {
          // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- the pattern is only tested when safeRegex(re) confirms it is not ReDoS-prone; unsafe patterns are skipped.
          const re = new RegExp(validation.pattern);
          if (safeRegex(re) && !re.test(value)) {
            errors.push(`${key}: does not match pattern ${validation.pattern}`);
          }
        } catch {
          // Pattern itself invalid — skip runtime pattern check
        }
      }
      break;
    }
    case "checklist": {
      if (!Array.isArray(value)) {
        errors.push(`${key}: expected array for checklist, got ${typeof value}`);
        return;
      }
      if (validation?.minItems && value.length < validation.minItems) {
        errors.push(`${key}: minimum items is ${validation.minItems}`);
      }
      if (validation?.maxItems && value.length > validation.maxItems) {
        errors.push(`${key}: maximum items is ${validation.maxItems}`);
      }
      break;
    }
    case "number": {
      if (typeof value !== "number") {
        errors.push(`${key}: expected number, got ${typeof value}`);
        return;
      }
      if (validation?.min !== undefined && value < validation.min) {
        errors.push(`${key}: minimum value is ${validation.min}`);
      }
      if (validation?.max !== undefined && value > validation.max) {
        errors.push(`${key}: maximum value is ${validation.max}`);
      }
      break;
    }
    case "select": {
      if (typeof value !== "string") {
        errors.push(`${key}: expected string for select, got ${typeof value}`);
        return;
      }
      if (validation?.options && !validation.options.includes(value)) {
        errors.push(`${key}: value "${value}" not in allowed options`);
      }
      break;
    }
    case "tags": {
      if (!Array.isArray(value)) {
        errors.push(`${key}: expected array for tags, got ${typeof value}`);
        return;
      }
      if (!value.every((v: unknown) => typeof v === "string")) {
        errors.push(`${key}: all tags must be strings`);
      }
      if (validation?.maxItems && value.length > validation.maxItems) {
        errors.push(`${key}: maximum tags is ${validation.maxItems}`);
      }
      break;
    }
  }
}
