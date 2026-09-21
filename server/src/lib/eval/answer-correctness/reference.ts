/**
 * Epic #1316 / Issue #1319 — human-authored reference answers (`reference.json`).
 *
 * ── WHY THIS FILE IS MOSTLY VALIDATION ──────────────────────────────────────
 *
 * METIS's ground truth covers retrieved CONTEXTS (the span-anchored `quote` in
 * `queries.json`) and EXTRACTIONS (`expected.json`). It does not cover ANSWERS.
 * Every metric is therefore reference-free — "is this answer supported by what
 * we retrieved?" — and never "is this answer right?". A confidently wrong answer
 * that cites real retrieved text scores clean on faithfulness.
 *
 * A gold answer closes that gap. The trap is where the gold answer comes from. A
 * model-generated "gold" answer measures the judge against itself: it produces a
 * confident number that means nothing, in every circumstance including a broken
 * one, and nothing downstream would ever reveal it. That is worse than having no
 * metric, because a number gets quoted in a decision and an absence does not.
 * #1319 says so explicitly — *"Reference answers are authored by a human and
 * reviewed."*
 *
 * So the validator's job is not really shape-checking. It is REFUSING INPUT THAT
 * CANNOT BE GROUND TRUTH: {@link assertHumanAuthorship} rejects an author or
 * reviewer that names a model, {@link validateReferenceSet} rejects a
 * self-review and a snapshot mismatch, and {@link checkAnswerStyle} rejects
 * prose that does not follow the agreed reference style.
 *
 * ── WHAT IS DELIBERATELY NOT IN THIS REPOSITORY YET ─────────────────────────
 *
 * `eval-data/corpus/docretrieval-01-metis-docs/reference.json` ships with an
 * EMPTY `answers` array. The schema, loader, validator, metric and authoring
 * instructions are all here and all tested; the forty-three gold answers are a
 * human deliverable and are not fabricated to close a checkbox.
 * {@link loadReferenceSet} therefore has a well-defined "no answers yet" state
 * and the runner reports the metric as NOT REPORTED rather than as a number.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Sentinel for `license` while the licence question is UNRESOLVED.
 *
 * **No committed corpus uses it today.** `docretrieval-01-metis-docs` did, because
 * its source documents are METIS's own `OPERATIONS.md`, `SECURITY.md`,
 * `data-model.md` and seven others rather than invented content like the synthetic
 * `brd-*`/`prd-*` corpora, so its licence was genuinely open (#1322 E4, #1300).
 * #1382 answered it: the corpus is the repository owner's own documentation, the
 * file now ships in the published tree where an unlicensed file cannot go, and it
 * declares `CC0-1.0` like the other two `reference.json` files.
 *
 * The sentinel stays, for a corpus whose licence really is undecided. The field is
 * REQUIRED so nobody can omit the question, and this value states plainly that it
 * has not been answered. What it must never become is a way to defer a decision
 * that is ours to make — picking a licence to make a file look finished and
 * declaring PENDING to avoid choosing are the same failure pointed two ways.
 */
export const LICENSE_PENDING = "PENDING";

/** Marker for an item the author could not answer from the snapshot. */
export const FLAG_PREFIX = "FLAG:";

/**
 * Maximum sentences in a reference answer (decision 4: 1–3 sentences).
 *
 * KEPT after #1342, which found that a terse gold answer depresses the metric's
 * precision against METIS's paragraph-length output — the first real run scored
 * `recall 1.000, precision 0.433`. The rule and the metric agree again because
 * the METRIC changed what it leads with, not because the gold answers got
 * longer: recall is the headline, and a crisply-scoped reference is what recall
 * tests best. Padding gold answers to match METIS's length would have cost 48
 * answers of authoring effort and made them worse ground truth. See
 * `docs/decisions/0013-answer-correctness-reports-precision-and-recall.md`.
 */
export const MAX_REFERENCE_SENTENCES = 3;

/** Canonical filename inside a corpus directory. */
export const REFERENCE_FILENAME = "reference.json";

/**
 * Provenance of ONE reference answer.
 *
 * `author` and `date` are REQUIRED — #1319's acceptance criterion is "who
 * authored each reference, when, and against which commit", and the commit is
 * the set-level {@link referenceSetSchema.shape.snapshotCommit}, which is what
 * the answers were actually written against.
 *
 * Review is OPTIONAL but, when recorded, is validated. Requiring it would block
 * an author from committing work in progress and would push review evidence out
 * of the file and into a PR thread nothing reads.
 */
export const referenceProvenanceSchema = z.object({
  /** Who wrote it — a person. A GitHub handle (`gh:octocat`) or an email. */
  author: z.string().trim().min(1).max(200),
  /** ISO date (YYYY-MM-DD) the answer was written. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be an ISO date (YYYY-MM-DD)"),
  /** Who reviewed it, if reviewed. MUST be a different person from `author`. */
  reviewedBy: z.string().trim().min(1).max(200).optional(),
  /** ISO date (YYYY-MM-DD) of the review. May not precede `date`. */
  reviewedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "reviewedAt must be an ISO date (YYYY-MM-DD)")
    .optional(),
});
export type ReferenceProvenance = z.infer<typeof referenceProvenanceSchema>;

/** One human-authored gold answer — or one `FLAG:` finding — for one query. */
export const referenceAnswerSchema = z.object({
  /** Must match a `queries[].id` in the same corpus. */
  queryId: z.string().trim().min(1).max(200),
  /** The gold answer in the author's own words, or `FLAG: <why>`. */
  answer: z.string().trim().min(1).max(8_000),
  provenance: referenceProvenanceSchema,
  /** Optional free-text note from the author (scope, deliberate omissions). */
  note: z.string().max(2_000).optional(),
});
export type ReferenceAnswer = z.infer<typeof referenceAnswerSchema>;

/** A corpus's whole `reference.json`. */
export const referenceSetSchema = z.object({
  corpusId: z.string().trim().min(1),
  /**
   * SPDX identifier, or {@link LICENSE_PENDING} while the question is open.
   * Required — see {@link LICENSE_PENDING} for why it may not simply be omitted.
   */
  license: z.string().trim().min(1),
  /** Why the licence is what it is; mandatory reading when it is PENDING. */
  licenseNote: z.string().max(4_000).optional(),
  /** The corpus snapshot these answers were written against. */
  snapshotCommit: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,40}$/, "snapshotCommit must be a git SHA"),
  note: z.string().max(4_000).optional(),
  answers: z.array(referenceAnswerSchema),
});

/** A validated reference set, with the licence question resolved to a flag. */
export type ReferenceSet = z.infer<typeof referenceSetSchema> & {
  /** True when {@link LICENSE_PENDING} — the licence is an OPEN decision. */
  licensePending: boolean;
};

/**
 * Substrings that mark an "author" as a model rather than a person.
 *
 * Deliberately blunt and deliberately over-broad. A false positive costs one
 * reviewer one minute of annoyance; a false negative silently makes the whole
 * answer-correctness metric circular, and the number would look perfectly
 * healthy while meaning nothing.
 */
export const MODEL_AUTHOR_PATTERNS: readonly string[] = [
  "model:",
  "llm:",
  "ai:",
  "bot:",
  "generated",
  "synthetic",
  "claude",
  "gpt",
  "copilot",
  "gemini",
  "llama",
  "mistral",
  "anthropic",
  "openai",
];

/** Thrown when a reference set is structurally or provenantially invalid. */
export class ReferenceValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`reference.json is invalid:\n  - ${problems.join("\n  - ")}`);
    this.name = "ReferenceValidationError";
  }
}

/** True when `answer` is a `FLAG:` finding rather than a gold answer. */
export function isFlagged(answer: string): boolean {
  return answer.trimStart().toUpperCase().startsWith(FLAG_PREFIX);
}

/** The author's explanation, with the `FLAG:` marker stripped. */
export function flagText(answer: string): string {
  return answer.trimStart().slice(FLAG_PREFIX.length).trim();
}

/**
 * Return a problem string when `who` looks like a model, else `null`.
 * @internal exported for testing.
 */
export function assertHumanAuthorship(field: string, who: string): string | null {
  const lower = who.toLowerCase();
  const hit = MODEL_AUTHOR_PATTERNS.find((p) => lower.includes(p));
  return hit
    ? `${field} ${JSON.stringify(who)} looks like a model (matched ${JSON.stringify(hit)}). ` +
        "Reference answers must be written and reviewed by people — a model-authored gold " +
        "answer makes answer-correctness a measurement of the judge against itself."
    : null;
}

/**
 * Sentence-boundary masks, applied before counting.
 *
 * Without them a legal one-sentence answer that names a document
 * (`OPERATIONS.md`), quotes a decimal (`1.5 seconds`) or uses `e.g.` counts as
 * two or three and is rejected. A validator that rejects correct input is a
 * validator authors route around.
 */
const SENTENCE_MASKS: readonly RegExp[] = [
  /\b\d+(?:\.\d+)+/g, // decimals and dotted versions
  /\b[A-Za-z0-9_-]+\.(?:md|json|ts|tsx|js|mjs|yml|yaml|sh|sql|txt|toml)\b/gi, // filenames
  /\b(?:e\.g|i\.e|etc|vs|cf|approx|no|fig|dr|mr|mrs|ms|st|jr|sr)\./gi, // abbreviations
];

/**
 * Count sentences in `text`.
 *
 * A boundary is terminal punctuation followed by whitespace or end of string;
 * trailing text with no terminator counts as one more. Exported because the
 * masking above is the part most likely to be wrong, and it is worth asserting
 * directly rather than only through the validator.
 */
export function countSentences(text: string): number {
  let masked = text;
  for (const mask of SENTENCE_MASKS) masked = masked.replace(mask, (m) => "x".repeat(m.length));
  let count = 0;
  let sawContent = false;
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i] as string;
    if (".!?".includes(ch)) {
      const next = masked[i + 1];
      if (sawContent && (next === undefined || /\s/.test(next))) {
        count += 1;
        sawContent = false;
      }
      continue;
    }
    if (!/\s/.test(ch)) sawContent = true;
  }
  return sawContent ? count + 1 : count;
}

/** Non-prose constructs a reference answer may not contain (decision 4). */
const NON_PROSE_RULES: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /^\s*[-*+]\s+/m, what: "a bullet list" },
  { re: /^\s*\d+[.)]\s+/m, what: "a numbered list" },
  { re: /^\s*\|.*\|/m, what: "a table" },
  { re: /^\s*#{1,6}\s+/m, what: "a heading" },
  { re: /```/, what: "a code fence" },
];

/** Citation markup a reference answer may not contain (decision 4). */
const CITATION_RULES: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /\[\^[^\]]+\]/, what: "a footnote marker" },
  { re: /\[\d+\]/, what: "a bracketed citation" },
  { re: /\[[^\]]+\]\([^)]+\)/, what: "a markdown link" },
  { re: /<sup\b/i, what: "a superscript" },
  { re: /\[cite[:\s]/i, what: "a cite tag" },
];

/**
 * Phrasings that make an answer a POINTER rather than a fact.
 *
 * Anchored to the start of the answer on purpose. Decision 4 asks for "Up to 5
 * minutes", not "see the RPO row in OPERATIONS.md" — but an answer is perfectly
 * entitled to *mention* a document as part of the fact it states ("the runbook
 * OPERATIONS.md is the deploy source of truth"). Matching anywhere would reject
 * that, so the rule catches the shape that opens with a redirection.
 */
const POINTER_OPENERS =
  /^\s*(?:see|refer to|as (?:described|documented|stated|noted) in|according to|documented in|described in|per)\b/i;

/**
 * Check one gold answer against the agreed reference style, returning every
 * problem. `FLAG:` items are exempt — a flag is a note about the corpus, not a
 * gold answer, and forcing it into answer shape would lose the explanation.
 */
export function checkAnswerStyle(queryId: string, answer: string): string[] {
  if (isFlagged(answer)) {
    return flagText(answer).length === 0
      ? [
          `${queryId}: a ${FLAG_PREFIX} item must explain why the anchored quote does not ` +
            "answer the question — the text after the marker is the corpus finding.",
        ]
      : [];
  }
  const problems: string[] = [];
  const sentences = countSentences(answer);
  if (sentences > MAX_REFERENCE_SENTENCES) {
    problems.push(
      `${queryId}: answer is ${sentences} sentences; a reference answer is 1–${MAX_REFERENCE_SENTENCES}. ` +
        "Put anything out of scope in `note`, not in `answer`.",
    );
  }
  for (const { re, what } of NON_PROSE_RULES) {
    if (re.test(answer)) {
      problems.push(
        `${queryId}: answer contains ${what}. A reference answer is self-contained prose — ` +
          "the metric decomposes it into claims, and list or table markup decomposes badly.",
      );
    }
  }
  for (const { re, what } of CITATION_RULES) {
    if (re.test(answer)) {
      problems.push(
        `${queryId}: answer contains citation markup (${what}). A reference answer carries no ` +
          "citations — where the fact lives is `queries.json`'s job, not the gold answer's.",
      );
    }
  }
  if (POINTER_OPENERS.test(answer)) {
    problems.push(
      `${queryId}: answer opens by pointing at a location. A reference answer states the fact, ` +
        'not where to find it — "Up to five minutes", not "see the RPO row in OPERATIONS.md".',
    );
  }
  return problems;
}

export interface ValidateReferenceOptions {
  /** Query ids the corpus defines. Referential integrity is checked against these. */
  knownQueryIds?: readonly string[];
  /** The corpus's own snapshot commit. A mismatch is an error, not a warning. */
  expectedSnapshotCommit?: string;
  /** The corpus id the file must declare. */
  expectedCorpusId?: string;
}

/**
 * Validate a parsed reference set. Returns the validated set, or throws with
 * EVERY problem found, so an author fixes one file once rather than iterating
 * against a validator that reports one error at a time.
 */
export function validateReferenceSet(
  raw: unknown,
  opts: ValidateReferenceOptions = {},
): ReferenceSet {
  const parsed = referenceSetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReferenceValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const set = parsed.data;
  const problems: string[] = [];

  if (opts.expectedCorpusId && set.corpusId !== opts.expectedCorpusId) {
    problems.push(
      `corpusId is ${JSON.stringify(set.corpusId)} but this corpus is ${JSON.stringify(opts.expectedCorpusId)}`,
    );
  }
  if (opts.expectedSnapshotCommit && set.snapshotCommit !== opts.expectedSnapshotCommit) {
    // A gold answer written against a different snapshot may be answering a
    // question about text that no longer exists in the corpus.
    problems.push(
      `snapshotCommit ${set.snapshotCommit} does not match the corpus snapshot ` +
        `${opts.expectedSnapshotCommit}. Re-review the answers against the current snapshot.`,
    );
  }

  const seen = new Set<string>();
  const known = opts.knownQueryIds ? new Set(opts.knownQueryIds) : null;
  for (const a of set.answers) {
    if (seen.has(a.queryId)) problems.push(`duplicate answer for query ${a.queryId}`);
    seen.add(a.queryId);
    if (known && !known.has(a.queryId)) {
      problems.push(`answer references unknown query id ${JSON.stringify(a.queryId)}`);
    }

    const { author, date, reviewedBy, reviewedAt } = a.provenance;
    const authorProblem = assertHumanAuthorship(`${a.queryId}: provenance.author`, author);
    if (authorProblem) problems.push(authorProblem);

    if (reviewedBy !== undefined || reviewedAt !== undefined) {
      // Half a review is not evidence of a review; it is a field somebody meant
      // to finish. Reject it rather than silently treating it as unreviewed.
      if (reviewedBy === undefined) {
        problems.push(`${a.queryId}: provenance.reviewedAt is set but reviewedBy is missing`);
      }
      if (reviewedAt === undefined) {
        problems.push(`${a.queryId}: provenance.reviewedBy is set but reviewedAt is missing`);
      }
    }
    if (reviewedBy !== undefined) {
      const reviewerProblem = assertHumanAuthorship(
        `${a.queryId}: provenance.reviewedBy`,
        reviewedBy,
      );
      if (reviewerProblem) problems.push(reviewerProblem);
      if (author.trim().toLowerCase() === reviewedBy.trim().toLowerCase()) {
        // #1319 requires the answer be authored by a human AND reviewed; one
        // person doing both is one opinion, not two.
        problems.push(
          `${a.queryId}: provenance.reviewedBy is the same person as the author. A reference ` +
            "answer must be reviewed by someone other than its author.",
        );
      }
    }
    if (reviewedAt !== undefined && reviewedAt < date) {
      problems.push(
        `${a.queryId}: reviewedAt (${reviewedAt}) precedes the authoring date (${date})`,
      );
    }

    problems.push(...checkAnswerStyle(a.queryId, a.answer));
  }

  if (problems.length > 0) throw new ReferenceValidationError(problems);
  return { ...set, licensePending: set.license === LICENSE_PENDING };
}

/** The gold answers that can be scored — everything that is not a `FLAG:`. */
export function scorableAnswers(set: ReferenceSet): ReferenceAnswer[] {
  return set.answers.filter((a) => !isFlagged(a.answer));
}

/** One corpus finding raised by an author via a `FLAG:` item. */
export interface CorpusFinding {
  queryId: string;
  /** The author's explanation, marker stripped. */
  finding: string;
  author: string;
  date: string;
}

/**
 * The `FLAG:` items, as corpus findings.
 *
 * These are EXCLUDED from the metric and reported separately: a query whose
 * anchored `quote` does not answer its question is a defect in `queries.json`,
 * not a wrong answer by the system, and scoring it would blame the system for
 * the corpus.
 */
export function flaggedFindings(set: ReferenceSet): CorpusFinding[] {
  return set.answers
    .filter((a) => isFlagged(a.answer))
    .map((a) => ({
      queryId: a.queryId,
      finding: flagText(a.answer),
      author: a.provenance.author,
      date: a.provenance.date,
    }));
}

/** The outcome of looking for a corpus's reference answers. */
export type ReferenceLookup =
  /** No `reference.json` at all — this corpus has no answer ground truth. */
  | { status: "absent"; path: string }
  /** Valid, but carries no SCORABLE answers yet (empty, or only `FLAG:` items). */
  | { status: "empty"; path: string; set: ReferenceSet }
  | { status: "present"; path: string; set: ReferenceSet };

/**
 * Load and validate a corpus's `reference.json`.
 *
 * `absent` and `empty` are DISTINCT and both are legitimate. Neither is an
 * error, and neither may be reported as a score: a corpus with no gold answers
 * has an UNMEASURED answer-correctness, not a bad one.
 */
export async function loadReferenceSet(
  corpusDir: string,
  opts: ValidateReferenceOptions = {},
): Promise<ReferenceLookup> {
  const file = path.join(corpusDir, REFERENCE_FILENAME);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent", path: file };
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ReferenceValidationError([`${file} is not valid JSON: ${(err as Error).message}`]);
  }
  const set = validateReferenceSet(json, opts);
  return scorableAnswers(set).length === 0
    ? { status: "empty", path: file, set }
    : { status: "present", path: file, set };
}
