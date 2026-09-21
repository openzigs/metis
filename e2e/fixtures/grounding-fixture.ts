/**
 * Deterministic fixture constants for the analysis grounding e2e spec
 * (Epic #912 / sub-issue #920).
 *
 * These mirror the finding shapes seeded by
 * `server/scripts/e2e-seed-analysis-grounding.ts`. Keep both in lock-step: the
 * spec asserts the UI renders exactly these requirement ids, filenames,
 * excerpts and badge text.
 */
export const GROUNDING_FIXTURE = {
  /** Requirement a grounded finding traces to → "Grounded in REQ-001". */
  reqGrounded: "REQ-001",
  /** Requirement with no evidence → "Gap for REQ-002" + empty-context note. */
  reqGap: "REQ-002",

  grounded: {
    title: "Password reset flow lacks rate limiting",
    filename: "auth-spec.md",
    snippet: "resetPassword(token) updates the credential store",
  },
  gap: {
    title: "No grounded evidence for REQ-002",
  },
  plain: {
    title: "Service layer mixes transport and domain concerns",
    filename: "architecture-notes.md",
    snippet: "ProjectController calls prisma directly",
  },

  /** Rendered badge text. */
  groundedBadge: "Grounded in REQ-001",
  gapBadge: "Gap for REQ-002",
  /** Empty-context note rendered for a gap finding with no citations. */
  noEvidenceNote: "No supporting evidence retrieved from the selected documents.",
} as const;
