/**
 * Epic #609 (#619) — client-side helpers for the publish/export approval
 * gate. The server blocks gated operations with:
 *
 *   409 APPROVAL_REQUIRED          — items lack an approved, current review
 *   503 APPROVAL_GATE_UNAVAILABLE  — the gate check itself failed (fail-closed)
 *
 * `extractApprovalGateBlock` normalizes an unknown error (typically an
 * `ApiError`) into a renderable block descriptor, or `null` when the error
 * is unrelated to the gate.
 */
import { ApiError } from "@/lib/api-client";

export const APPROVAL_REQUIRED = "APPROVAL_REQUIRED";
export const APPROVAL_GATE_UNAVAILABLE = "APPROVAL_GATE_UNAVAILABLE";

export interface ApprovalGateBlock {
  code: typeof APPROVAL_REQUIRED | typeof APPROVAL_GATE_UNAVAILABLE;
  message: string;
  /** Requirements lacking an approved, still-current review. */
  requirementIds: string[];
  /** Drafts that trace to no requirement at all (blocked while gate is on). */
  unlinkedDraftIds: string[];
  /** Generated documents (specs) lacking an approved, current review. */
  documentIds: string[];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function extractApprovalGateBlock(err: unknown): ApprovalGateBlock | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code !== APPROVAL_REQUIRED && err.code !== APPROVAL_GATE_UNAVAILABLE) return null;
  const details = (err.details ?? {}) as Record<string, unknown>;
  return {
    code: err.code,
    message: err.message,
    requirementIds: stringArray(details.requirementIds),
    unlinkedDraftIds: stringArray(details.unlinkedDraftIds),
    documentIds: stringArray(details.documentIds),
  };
}
