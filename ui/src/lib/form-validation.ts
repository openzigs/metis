/**
 * Friendly form-validation helpers (#426, epic #407).
 *
 * Two responsibilities, both deliberately framework-agnostic so they are unit
 * testable away from the (coverage-excluded) page components that consume them:
 *
 *  1. `mapFieldErrors` — turn the server's safe validation summary
 *     (`error.details.fields = [{ field, message }]`, produced by the global
 *     error handler in `server/src/middleware/error-handler.ts`) into a
 *     `Record<field, message>` the UI can index when rendering inline messages.
 *     The server NEVER sends a raw Zod array; this helper also defends against
 *     a malformed payload by ignoring anything that isn't a `{ field, message }`.
 *
 *  2. `requiredFieldErrors` — client-side "required field" checks so a form can
 *     disable submit and show inline messages BEFORE hitting the network (the
 *     "New project" empty-Name defect).
 */
import { ApiError } from "./api-client";

/** A single safe field summary as emitted by the server error envelope. */
export interface FieldError {
  field: string;
  message: string;
}

/** Map of field name → first inline error message. */
export type FieldErrorMap = Record<string, string>;

function isFieldError(value: unknown): value is FieldError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { field?: unknown }).field === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/**
 * Extract the per-field inline messages from a thrown error.
 *
 * Reads `ApiError.details.fields` (the friendly server summary). Returns an
 * empty map for any non-validation error or a payload missing the summary, so
 * callers can safely fall back to a top-level message/toast. The first message
 * per field wins (the server already deduplicates, but we guard anyway).
 */
export function mapFieldErrors(error: unknown): FieldErrorMap {
  if (!(error instanceof ApiError)) return {};
  const details = error.details;
  if (typeof details !== "object" || details === null) return {};
  const fields = (details as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return {};
  const map: FieldErrorMap = {};
  for (const entry of fields) {
    if (isFieldError(entry) && !(entry.field in map)) {
      map[entry.field] = entry.message;
    }
  }
  return map;
}

/** Human-readable label for a field key, falling back to the raw key. */
function labelFor(field: string, labels?: Record<string, string>): string {
  return labels?.[field] ?? field;
}

/**
 * Build a `{ field: message }` map for any required field whose trimmed value is
 * empty. Drives both "disable submit until valid" and inline messages without a
 * network round-trip.
 *
 * @param values  Current field values keyed by field name.
 * @param required  Field names that must be non-empty.
 * @param labels  Optional display labels for friendlier messages.
 */
export function requiredFieldErrors(
  values: Record<string, string | undefined>,
  required: readonly string[],
  labels?: Record<string, string>,
): FieldErrorMap {
  const errors: FieldErrorMap = {};
  for (const field of required) {
    if ((values[field] ?? "").trim() === "") {
      errors[field] = `${labelFor(field, labels)} is required`;
    }
  }
  return errors;
}

/** True when every required field has a non-empty trimmed value. */
export function hasRequiredValues(
  values: Record<string, string | undefined>,
  required: readonly string[],
): boolean {
  return required.every((field) => (values[field] ?? "").trim() !== "");
}
