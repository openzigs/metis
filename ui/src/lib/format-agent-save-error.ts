/**
 * #470 (epic #459) — turn an agent/skill save failure into a specific,
 * user-readable message instead of the generic envelope ("Invalid agent
 * payload"). The server carries the real reason under `error.details`:
 *   - `details.fields`        — friendly field errors (#426 central mapping)
 *   - `details.issues.*`      — a Zod `.flatten()` from the route payload schema
 *   - else                    — a specific `error.message` (e.g. a 400
 *                               FrontmatterError like "[VALIDATION_ERROR] …").
 */
import { ApiError } from "@/lib/api-client";

interface FriendlyField {
  field: string;
  message: string;
}

interface ZodFlatten {
  fieldErrors?: Record<string, string[] | undefined>;
  formErrors?: string[];
}

export function formatLibrarySaveError(err: unknown, fallback = "Save failed"): string {
  if (!(err instanceof ApiError)) return fallback;

  const details = err.details as { fields?: FriendlyField[]; issues?: ZodFlatten } | undefined;

  // Friendly field errors from the centralized validation mapper.
  if (details?.fields?.length) {
    return details.fields.map((f) => `${f.field}: ${f.message}`).join("; ");
  }

  // Zod flatten() shape from the route payload schema.
  const issues = details?.issues;
  if (issues) {
    const parts: string[] = [];
    for (const [field, msgs] of Object.entries(issues.fieldErrors ?? {})) {
      if (msgs && msgs.length) parts.push(`${field}: ${msgs.join(", ")}`);
    }
    if (issues.formErrors?.length) parts.push(...issues.formErrors);
    if (parts.length) return parts.join("; ");
  }

  // A specific server message (e.g. a 400 FrontmatterError) is already useful.
  return err.message || fallback;
}
