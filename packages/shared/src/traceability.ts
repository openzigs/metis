/**
 * Requirement ↔ data (table/column) traceability — Epic #889 (Item B).
 *
 * Shared between the server (Zod validation) and the UI (form types / API
 * contracts) for the `RequirementDataMapping` model added in #891. A mapping
 * links a single requirement to a database table (and optionally a column)
 * exposed by a project's `DatabaseConnection`, with a confidence score and
 * provenance (`manual` vs `llm-suggested`).
 */
import { z } from "zod";
import type { RequirementLinkType } from "./requirement-links.js";

// ---- Constants -------------------------------------------------------------

/** Provenance of a mapping. */
export const DATA_MAPPING_SOURCES = ["manual", "llm-suggested"] as const;
export type RequirementDataMappingSource = (typeof DATA_MAPPING_SOURCES)[number];

// Identifier length guard — generous enough for real schema/table/column names
// (Postgres caps identifiers at 63 chars; quoted/other engines can be longer).
const identifierSchema = z.string().trim().min(1).max(255);

// ---- Create input ----------------------------------------------------------

export const createRequirementDataMappingSchema = z.object({
  /** Target connector (must belong to the same project as the requirement). */
  dbConnectorId: z.string().trim().min(1, "dbConnectorId is required").max(64),
  /** Null/omitted => the connector's default schema. */
  schemaName: identifierSchema.nullable().optional(),
  tableName: identifierSchema,
  /** Null/omitted => a table-level mapping. */
  columnName: identifierSchema.nullable().optional(),
  /** 0–1; defaults to 0.7 at the DB layer when omitted. */
  confidence: z.number().min(0).max(1).optional(),
  /** Provenance; defaults to "manual". */
  source: z.enum(DATA_MAPPING_SOURCES).optional(),
  /** Optional free-text rationale / provenance note. */
  note: z.string().trim().max(2_000).nullable().optional(),
});
export type CreateRequirementDataMappingInput = z.infer<typeof createRequirementDataMappingSchema>;

// ---- API response ----------------------------------------------------------

export interface RequirementDataMappingDetail {
  id: string;
  requirementId: string;
  dbConnectorId: string;
  /** Resolved connector label (joined for display); null if connector removed. */
  dbConnectorLabel: string | null;
  schemaName: string | null;
  tableName: string;
  columnName: string | null;
  confidence: number;
  source: RequirementDataMappingSource;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---- LLM suggest (#893) ----------------------------------------------------

/** A single LLM-proposed candidate mapping (not yet persisted). */
export interface SuggestedDataMappingCandidate {
  dbConnectorId: string;
  dbConnectorLabel: string | null;
  schemaName: string | null;
  tableName: string;
  columnName: string | null;
  /** Normalized 0–1 confidence. */
  confidence: number;
  /** Flagged when confidence falls below the low-confidence threshold. */
  lowConfidence: boolean;
  /** Short model rationale for the suggestion. */
  rationale: string;
  /** Always "llm-suggested" for candidates from the suggest pass. */
  source: RequirementDataMappingSource;
}

/** Result of a budget-bounded suggest-mappings run. */
export interface SuggestDataMappingsResult {
  candidates: SuggestedDataMappingCandidate[];
  /** True when the LLM call/token budget was exhausted before all schema was processed. */
  budgetExhausted: boolean;
  /** Human-readable note (budget exhaustion, empty schema, or error); null otherwise. */
  note: string | null;
}

// ===========================================================================
// Requirement → Spec → Code traceability spine — Epic #207 (#226/#227/#229).
//
// The "spec" entity IS an existing GeneratedDocument row (specifically one with
// isSpec-style intent / scope). These DTOs are shared between the server (Zod
// validation + query results) and the UI (api client + traceability view).
// ===========================================================================

/**
 * Provenance of a requirement↔spec or spec↔code mapping.
 * `analysis-grounding` marks a requirement→code spine row auto-seeded from the
 * analysis CODE agent's finding citations (see seed-code-links-from-findings).
 */
export const SPEC_MAPPING_SOURCES = [
  "derived",
  "semantic",
  "manual",
  "analysis-grounding",
] as const;
export type SpecMappingSource = (typeof SPEC_MAPPING_SOURCES)[number];

// ---- Requirement ↔ Spec (#226) --------------------------------------------

/** Create input for a requirement→spec link. */
export const createRequirementSpecMappingSchema = z.object({
  /** Target spec document (must belong to the same project as the requirement). */
  specDocumentId: z.string().trim().min(1, "specDocumentId is required").max(64),
  /** 0–1; defaults to 0.7 at the DB layer when omitted. */
  confidence: z.number().min(0).max(1).optional(),
  /** Provenance; defaults to "manual" at the route layer. */
  source: z.enum(SPEC_MAPPING_SOURCES).optional(),
});
export type CreateRequirementSpecMappingInput = z.infer<typeof createRequirementSpecMappingSchema>;

/** A persisted requirement→spec link, with the joined spec title for display. */
export interface RequirementSpecMappingDetail {
  id: string;
  requirementId: string;
  specDocumentId: string;
  /** Joined spec document title; null if the spec was removed. */
  specTitle: string | null;
  projectId: string;
  confidence: number;
  source: SpecMappingSource;
  createdAt: string;
}

// ---- Spec ↔ Code (#227) ----------------------------------------------------

/** Create input for a spec→code link (mirrors RequirementCodeMapping shape). */
export const createSpecCodeMappingSchema = z.object({
  /** Optional resolved symbol; null/omitted => a file-only hit. */
  codeSymbolId: z.string().trim().min(1).max(64).nullable().optional(),
  filePath: z.string().trim().min(1, "filePath is required").max(1_024),
  startLine: z.number().int().min(0).nullable().optional(),
  endLine: z.number().int().min(0).nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.enum(SPEC_MAPPING_SOURCES).optional(),
});
export type CreateSpecCodeMappingInput = z.infer<typeof createSpecCodeMappingSchema>;

/** A persisted spec→code link. */
export interface SpecCodeMappingDetail {
  id: string;
  specDocumentId: string;
  projectId: string;
  codeSymbolId: string | null;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  confidence: number;
  source: SpecMappingSource;
  createdAt: string;
}

// ---- Backfill (#228) -------------------------------------------------------

/** Idempotent backfill summary (counts of rows created vs skipped). */
export interface BackfillSpecLinksResult {
  /** Distinct spec documents considered. */
  specsConsidered: number;
  /** New requirement→spec links created this run. */
  requirementSpecLinksCreated: number;
  /** Requirement→spec links that already existed (skipped). */
  requirementSpecLinksSkipped: number;
  /** New spec→code links created this run. */
  specCodeLinksCreated: number;
  /** Spec→code links that already existed (skipped). */
  specCodeLinksSkipped: number;
}

// ---- Traceability query (#229) --------------------------------------------

/** A code location in a traceability chain. */
export interface TraceabilityCodeNode {
  codeSymbolId: string | null;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  confidence: number;
  source: SpecMappingSource;
}

/** A spec node plus the code it links to. */
export interface TraceabilitySpecNode {
  specDocumentId: string;
  specTitle: string | null;
  /** Confidence of the requirement→spec link that reached this spec. */
  confidence: number;
  source: SpecMappingSource;
  code: TraceabilityCodeNode[];
}

/** The full requirement → spec → code chain for one requirement. */
export interface RequirementTraceabilityChain {
  requirementId: string;
  requirementTitle: string;
  projectId: string;
  specs: TraceabilitySpecNode[];
  /** Direct requirement→code links (the pre-existing RequirementCodeMapping spine). */
  directCode: TraceabilityCodeNode[];
}

// ===========================================================================
// Workspace-level traceability rollup — Epic #610 (#626).
//
// Extends the single-requirement, single-project spine (#229) with a workspace
// layer: a per-requirement chain may traverse `RequirementLink` edges into
// sibling projects (access-checked, depth-capped), and a workspace summary
// aggregates per-project coverage plus the cross-project link map. The spine
// itself is unchanged; these DTOs describe the composed responses.
// ===========================================================================

/** Hard ceiling on how many `RequirementLink` hops a linked-chain walk follows. */
export const MAX_TRACEABILITY_LINK_DEPTH = 3;

/**
 * A single `RequirementLink` edge reached while traversing out from a
 * requirement, plus the counterpart requirement's rendering context.
 */
export interface TraceabilityLinkEdge {
  linkId: string;
  type: RequirementLinkType;
  sourceRequirementId: string;
  targetRequirementId: string;
  /** The OTHER endpoint (the requirement being stitched in). */
  requirement: {
    id: string;
    title: string;
    projectId: string;
    projectName: string;
  };
}

/**
 * A linked requirement's chain reached via one `RequirementLink` edge. When the
 * caller cannot access the counterpart's project, `chain` is null and
 * `restricted` is true — the edge is still surfaced, but no content leaks.
 */
export interface LinkedRequirementChain {
  link: TraceabilityLinkEdge;
  chain: RequirementTraceabilityChain | null;
  restricted: boolean;
}

/** A requirement chain plus its 1..N-hop linked chains (#626). */
export interface RequirementChainWithLinks extends RequirementTraceabilityChain {
  /** Depth actually applied (post-cap). */
  depth: number;
  linkedChains: LinkedRequirementChain[];
}

/** Per-project traceability coverage row in the workspace summary. */
export interface WorkspaceProjectTraceability {
  projectId: string;
  name: string;
  /** Non-deleted requirements in the project. */
  requirements: number;
  /** Requirements in this project that participate in a cross-project link. */
  linkedCrossProject: number;
  /** Fraction (0–1) of requirements with ≥1 requirement→spec mapping. */
  specCoverage: number;
  /** Fraction (0–1) of requirements with ≥1 direct requirement→code mapping. */
  codeCoverage: number;
}

/** A cross-project `RequirementLink` edge in the workspace link map. */
export interface CrossProjectLinkEdge {
  linkId: string;
  type: RequirementLinkType;
  source: { requirementId: string; projectId: string };
  target: { requirementId: string; projectId: string };
}

/** The workspace traceability rollup response (#626). */
export interface WorkspaceTraceabilitySummary {
  projects: WorkspaceProjectTraceability[];
  crossProjectLinks: CrossProjectLinkEdge[];
}
