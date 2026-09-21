/**
 * Epic #1107 / Issue #1108 — the labelled corpus behind `pnpm eval:verification`.
 *
 * A case is EXACTLY what a verifier sees at the seam between agent completion and
 * synthesis (`finding-verification.ts`): the finding's text, the citations that
 * SURVIVED the #734 grounding gate, the citations that gate DROPPED, and the
 * run's #773 absence-evidence health. It additionally carries the source
 * `evidence` the agent was actually given — which the DETERMINISTIC arm cannot
 * read, and which is the whole reason an LLM panel might be worth paying for.
 *
 * `expected.supported` is the ground truth: does the run's evidence actually back
 * this finding's claim? A `false` case is one a reader should be warned about.
 *
 * ── THE CORPUS IS DELIBERATELY HARD-CASE ENRICHED ───────────────────────────
 *
 * Half the committed cases are unsupported, which is nothing like the base rate of
 * a real run. The absolute precision/recall this harness prints are therefore NOT
 * a population estimate of production quality; they are a COMPARATIVE YARDSTICK
 * between verifier arms measured on identical inputs. The A1 (#1109) default-on
 * decision must read the DELTA between arms, not the level of either.
 *
 * ── PROVENANCE ──────────────────────────────────────────────────────────────
 *
 * #1108 warns that "a corpus written by the same reasoning that writes the
 * verifier will flatter it", so real METIS failures were preferred wherever one
 * existed. Nine of twelve cases come from logged runs — #773's dogfood run of
 * 2026-07-11 and #1101's UI Vision walkthrough — with ground truth verified
 * against files that exist in this repository at the cited lines. The remaining
 * three cover verdict paths no logged run isolated cleanly and each declares
 * `origin: "synthesised"` in its own manifest entry, so a reader can discount
 * them individually rather than having to trust the set as a whole.
 *
 * The loader FAILS LOUD when any of the four hard cases #1108 names is missing
 * ({@link REQUIRED_HARD_CASES}) — a corpus that quietly lost the case an arm is
 * bad at would turn this harness into a rubber stamp.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { citationSchema, type Citation } from "@metis/shared";
import type { DroppedCitation } from "../../analysis/code-citations.js";

/**
 * The verdict path a case is built to exercise. The first four are the hard cases
 * #1108 requires; `hallucinated-citation` and `doc-only` cover the two remaining
 * branches of the deterministic rule so the baseline is measured on its own
 * strengths too, not only where it is weak.
 */
export const HARD_CASE_KINDS = [
  /** Evidence exists and was retrieved, but does not back the CLAIM. */
  "semantic-mismatch",
  /** An absence claim the run's evidence genuinely backs. */
  "absence-supported",
  /** An absence claim the retrieved evidence contradicts. */
  "absence-contradicted",
  /** A well-grounded finding that must NOT be down-weighted. */
  "well-grounded",
  /** A code citation the #734 gate dropped as never-retrieved. */
  "hallucinated-citation",
  /** A finding grounded only in document citations, which the gate never validates. */
  "doc-only",
] as const;

export type HardCaseKind = (typeof HARD_CASE_KINDS)[number];

/**
 * The four hard cases #1108 names. The corpus loader refuses to run without all
 * four present, because the value of this harness is entirely in the cases the
 * free gate cannot judge.
 */
export const REQUIRED_HARD_CASES: readonly HardCaseKind[] = [
  "semantic-mismatch",
  "absence-supported",
  "absence-contradicted",
  "well-grounded",
];

/** Where a case came from, so a reader can weigh real failures above invented ones. */
export interface CaseProvenance {
  /** `real` — drawn from a logged METIS run; `synthesised` — written for this corpus. */
  origin: "real" | "synthesised";
  /** The run, issue or walkthrough it came from. */
  source: string;
  /** How the ground-truth label was established. */
  groundTruth: string;
}

/** One source excerpt the agent was given. Only an evidence-READING arm can use it. */
export interface CaseEvidence {
  filePath: string;
  startLine: number;
  endLine: number;
  excerpt: string;
}

/** One labelled finding with a known verdict. */
export interface VerificationCase {
  id: string;
  hardCase: HardCaseKind;
  /** One-line human summary, rendered in the per-case report row. */
  title: string;
  provenance: CaseProvenance;
  /** The finding as the agent emitted it. */
  finding: { title: string; body: string; tags?: string[] };
  /** Citations that SURVIVED the #734 grounding gate. */
  groundedCitations: Citation[];
  /** Citations the #734 gate DROPPED for this finding. */
  droppedCitations: DroppedCitation[];
  /** Did the run's retrieval clear the #773 `absenceIsConfirmable` threshold? */
  absenceConfirmable: boolean;
  /** The retrieved source the agent read. Empty is legal (a citation-free claim). */
  evidence: CaseEvidence[];
  expected: {
    /** GROUND TRUTH — does the run's evidence actually back the claim? */
    supported: boolean;
    /** Why, in enough detail that a reader can dispute the label. */
    rationale: string;
  };
}

/** A loaded, validated corpus. */
export interface VerificationCorpus {
  id: string;
  description: string;
  /** The hard-case-enrichment caveat, reproduced verbatim in every report. */
  warning: string;
  provenanceNote: string;
  cases: VerificationCase[];
}

/**
 * Registered corpora, mirroring the impact-recall registry: names map 1:1 to
 * `eval-data/corpus/<name>/manifest.json` so `--corpus <name>` resolves without a
 * filesystem probe.
 */
export const VERIFICATION_CORPORA = ["verification-01-finding-verdicts"] as const;

export type VerificationCorpusName = (typeof VERIFICATION_CORPORA)[number];

export const DEFAULT_VERIFICATION_CORPUS: VerificationCorpusName =
  "verification-01-finding-verdicts";

/** Absolute path of the `eval-data/corpus` root (repo-relative to this module). */
function corpusRoot(): string {
  // server/src/lib/eval/verification → repo root is six levels up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../../eval-data/corpus");
}

/**
 * Resolve a registered corpus name to its absolute directory. Throws with the
 * known names on a typo, rather than silently loading the default.
 */
export function resolveVerificationCorpusDir(name: string): string {
  if (!(VERIFICATION_CORPORA as readonly string[]).includes(name)) {
    throw new Error(
      `unknown verification corpus: ${JSON.stringify(name)}. ` +
        `Known corpora: ${VERIFICATION_CORPORA.join(", ")}.`,
    );
  }
  return path.join(corpusRoot(), name);
}

/** Parse `--corpus <name>` from an argv slice, defaulting to the committed corpus. */
export function parseVerificationCorpusName(argv: string[]): string {
  const i = argv.indexOf("--corpus");
  const next = i >= 0 ? argv[i + 1] : undefined;
  return next && !next.startsWith("--") ? next : DEFAULT_VERIFICATION_CORPUS;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`verification corpus: ${what} must be a non-empty string`);
  }
  return value;
}

function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`verification corpus: ${what} must be an array`);
  return value;
}

/**
 * Validate citations against PRODUCTION's own `citationSchema` rather than
 * casting. A corpus whose citations are shaped differently from what the agents
 * actually emit would measure a world that does not exist — the #1016 lesson,
 * applied at the input side instead of the output side.
 */
function requireCitations(value: unknown, what: string): Citation[] {
  return requireArray(value, what).map((raw, i) => {
    const parsed = citationSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `verification corpus: ${what}[${i}] is not a valid Citation — ${parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    return parsed.data;
  });
}

const DROP_REASONS = new Set(["file-not-retrieved", "code-graph-id-unresolved"]);

/** Validate dropped citations against the #734 gate's own `DroppedCitation` shape. */
function requireDroppedCitations(value: unknown, what: string): DroppedCitation[] {
  return requireArray(value, what).map((raw, i) => {
    const d = raw as Partial<DroppedCitation>;
    if (typeof d?.filePath !== "string" || !DROP_REASONS.has(String(d?.reason))) {
      throw new Error(
        `verification corpus: ${what}[${i}] must be { filePath, reason } with reason one of ` +
          `${[...DROP_REASONS].join(", ")}.`,
      );
    }
    return { filePath: d.filePath, reason: d.reason as DroppedCitation["reason"] };
  });
}

function parseCase(raw: unknown, index: number): VerificationCase {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`verification corpus: case[${index}] must be an object`);
  }
  const c = raw as Record<string, unknown>;
  const id = requireString(c.id, `case[${index}].id`);
  const hardCase = requireString(c.hardCase, `case ${id}: hardCase`);
  if (!(HARD_CASE_KINDS as readonly string[]).includes(hardCase)) {
    throw new Error(
      `verification corpus: case ${id} has unknown hardCase ${JSON.stringify(hardCase)}. ` +
        `Known kinds: ${HARD_CASE_KINDS.join(", ")}.`,
    );
  }
  const finding = c.finding as Record<string, unknown> | undefined;
  if (!finding) throw new Error(`verification corpus: case ${id} has no finding`);
  const expected = c.expected as Record<string, unknown> | undefined;
  if (!expected || typeof expected.supported !== "boolean") {
    throw new Error(`verification corpus: case ${id} must label expected.supported (boolean)`);
  }
  if (typeof c.absenceConfirmable !== "boolean") {
    throw new Error(`verification corpus: case ${id} must label absenceConfirmable (boolean)`);
  }
  const provenance = c.provenance as Record<string, unknown> | undefined;
  if (!provenance || (provenance.origin !== "real" && provenance.origin !== "synthesised")) {
    throw new Error(
      `verification corpus: case ${id} must declare provenance.origin as "real" or "synthesised" — ` +
        "an unattributed case cannot be weighed against a real failure (#1108).",
    );
  }
  return {
    id,
    hardCase: hardCase as HardCaseKind,
    title: requireString(c.title, `case ${id}: title`),
    provenance: {
      origin: provenance.origin,
      source: requireString(provenance.source, `case ${id}: provenance.source`),
      groundTruth: requireString(provenance.groundTruth, `case ${id}: provenance.groundTruth`),
    },
    finding: {
      title: requireString(finding.title, `case ${id}: finding.title`),
      body: requireString(finding.body, `case ${id}: finding.body`),
      tags: Array.isArray(finding.tags) ? (finding.tags as string[]) : undefined,
    },
    groundedCitations: requireCitations(c.groundedCitations ?? [], `case ${id}: groundedCitations`),
    droppedCitations: requireDroppedCitations(
      c.droppedCitations ?? [],
      `case ${id}: droppedCitations`,
    ),
    absenceConfirmable: c.absenceConfirmable,
    evidence: requireArray(c.evidence ?? [], `case ${id}: evidence`) as CaseEvidence[],
    expected: {
      supported: expected.supported,
      rationale: requireString(expected.rationale, `case ${id}: expected.rationale`),
    },
  };
}

/**
 * Validate a parsed corpus: unique ids, at least one case, and every hard case
 * #1108 requires present. Exported so a future corpus can be checked without
 * touching the filesystem.
 */
export function validateVerificationCorpus(corpus: VerificationCorpus): VerificationCorpus {
  if (corpus.cases.length === 0) {
    throw new Error("verification corpus: no cases");
  }
  const seen = new Set<string>();
  for (const c of corpus.cases) {
    if (seen.has(c.id)) throw new Error(`verification corpus: duplicate case id ${c.id}`);
    seen.add(c.id);
  }
  const kinds = new Set(corpus.cases.map((c) => c.hardCase));
  const missing = REQUIRED_HARD_CASES.filter((k) => !kinds.has(k));
  if (missing.length > 0) {
    throw new Error(
      `verification corpus ${corpus.id} is missing required hard case(s): ${missing.join(", ")}. ` +
        "#1108 requires all four; a corpus that lost the case an arm is bad at is a rubber stamp.",
    );
  }
  return corpus;
}

/** Load + validate a corpus from its directory. */
export async function loadVerificationCorpus(dir: string): Promise<VerificationCorpus> {
  const raw = await fs.readFile(path.join(dir, "manifest.json"), "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const corpus: VerificationCorpus = {
    id: requireString(parsed.id, "id"),
    description: requireString(parsed.description, "description"),
    warning: requireString(parsed.warning, "warning"),
    provenanceNote: requireString(parsed.provenanceNote, "provenanceNote"),
    cases: requireArray(parsed.cases, "cases").map(parseCase),
  };
  return validateVerificationCorpus(corpus);
}

/** Count cases by provenance origin, reported so the real/synthesised mix is visible. */
export function provenanceMix(corpus: VerificationCorpus): { real: number; synthesised: number } {
  let real = 0;
  let synthesised = 0;
  for (const c of corpus.cases) {
    if (c.provenance.origin === "real") real += 1;
    else synthesised += 1;
  }
  return { real, synthesised };
}
