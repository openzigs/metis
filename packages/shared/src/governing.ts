/**
 * Epic #1866 (#1868) — governing documents: a workspace's own policies and
 * control frameworks, the revisions uploaded of each, the atomic rules
 * extracted from a revision, and each rule's edit history.
 *
 * The wire shapes of the `Governing*` Prisma models (`server/prisma/schema.prisma`).
 * Dates are ISO strings. A revision's `storagePath` (a server file path) and
 * its `extractedText` (the whole policy) are deliberately not in its shape: a
 * revisions list would otherwise carry every revision's full text, and the
 * path is the server's business. A rule carries its own `clauseExcerpt`.
 */
import { z } from "zod";
import { DOCUMENT_INDEX_STATES } from "./rag-hardening.js";

/** Rule extraction from a revision (#1870). */
export const GOVERNING_EXTRACTION_STATES = ["pending", "running", "done", "failed"] as const;
export type GoverningExtractionState = (typeof GOVERNING_EXTRACTION_STATES)[number];
/** The longest extraction error a revision carries; longer messages are cut. */
export const GOVERNING_EXTRACTION_ERROR_MAX = 500;
/**
 * #1947 — a `running` extraction that began longer ago than this is presumed
 * dead (the job is in-process, so a server restart mid-run leaves the row
 * `running` with nothing behind it) and may be started again. Generous: a
 * revision of up to `MAX_SECTIONS` sections (`rule-extraction.ts`) is that many
 * model calls. Shared so the page offers a retry exactly when the route takes one (#1996).
 */
export const GOVERNING_EXTRACTION_STALE_MS = 60 * 60 * 1000;

/** One row of a rule's edit history: a change to its fields, or its soft delete. */
export const GOVERNING_RULE_EDIT_KINDS = ["edit", "delete"] as const;
export type GoverningRuleEditKind = (typeof GOVERNING_RULE_EDIT_KINDS)[number];

const id = z.string().min(1).max(64);
const timestamp = z.iso.datetime();

export const governingDocumentSchema = z.object({
  id,
  workspaceId: id,
  title: z.string().min(1).max(300),
  /** Free text, e.g. "Internal security policy", "SOC 2 (customer copy)". */
  framework: z.string().min(1).max(200).nullable(),
  currentRevisionId: id.nullable(),
  createdById: id,
  createdAt: timestamp,
  deletedAt: timestamp.nullable(),
});
export type GoverningDocument = z.infer<typeof governingDocumentSchema>;

export const governingDocumentRevisionSchema = z.object({
  id,
  documentId: id,
  /** The policy's own revision name, e.g. "v3"; one per document. */
  revisionLabel: z.string().min(1).max(64),
  effectiveDate: timestamp,
  contentHash: z.string().min(1).max(128),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().min(0),
  /** The quarantine lifecycle `Document` uses (Epic #157). */
  indexState: z.enum(DOCUMENT_INDEX_STATES),
  extractionState: z.enum(GOVERNING_EXTRACTION_STATES),
  /** Why rule extraction failed (#1870); null unless `extractionState` is `failed`. */
  extractionError: z.string().min(1).max(GOVERNING_EXTRACTION_ERROR_MAX).nullable(),
  /**
   * When the latest extraction run began (#1947); null before any run. A
   * `running` revision past {@link GOVERNING_EXTRACTION_STALE_MS} may be retried.
   */
  extractionStartedAt: timestamp.nullable(),
  /**
   * Rules the model returned whose clause excerpt is not in the revision's text
   * verbatim (whitespace aside), dropped rather than stored with an invented citation.
   */
  droppedUnverified: z.number().int().min(0),
  uploadedById: id,
  createdAt: timestamp,
});
export type GoverningDocumentRevision = z.infer<typeof governingDocumentRevisionSchema>;

export const governingRuleSchema = z
  .object({
    id,
    revisionId: id,
    /** The policy's own control id (`AC-2`, `4.3.1`), or a generated `METIS-012` (#1947). */
    controlId: z.string().min(1).max(64),
    /** One line. */
    summary: z.string().min(1).max(500),
    /** The clause's section anchor in the policy. */
    clauseRef: z.string().min(1).max(200),
    /** Offsets into the revision's text: the excerpt is `text.slice(clauseStart, clauseEnd)`. */
    clauseStart: z.number().int().min(0),
    clauseEnd: z.number().int().min(1),
    clauseExcerpt: z.string().min(1),
    category: z.string().min(1).max(64).nullable(),
    editedById: id.nullable(),
    editedAt: timestamp.nullable(),
    deletedAt: timestamp.nullable(),
    createdAt: timestamp,
  })
  .refine((rule) => rule.clauseEnd > rule.clauseStart, {
    message: "clauseEnd must be after clauseStart",
    path: ["clauseEnd"],
  });
export type GoverningRule = z.infer<typeof governingRuleSchema>;

export const governingRuleEditSchema = z.object({
  id,
  ruleId: id,
  kind: z.enum(GOVERNING_RULE_EDIT_KINDS),
  editedById: id,
  /** The edited fields' values before and after (stored as JSON text). */
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
  createdAt: timestamp,
});
export type GoverningRuleEdit = z.infer<typeof governingRuleEditSchema>;
