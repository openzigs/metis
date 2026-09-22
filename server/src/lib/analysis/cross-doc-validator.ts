/**
 * Reusable cross-document consistency validator (Epic #203 / Issue #218).
 *
 * Generalizes the spec-kit `/analyze` cross-phase consistency check
 * (`spec-kit/commands/analyze.ts`) so the same QA-lead reasoning runs over an
 * arbitrary set of document segments — most importantly the *ingested customer
 * documents* in the main analysis pipeline, not just the spec/plan/tasks
 * artifacts.
 *
 * Structured output follows the METIS house pattern: a single
 * `provider.chat(messages, { disableTools: true })` call with a Markdown-shaped
 * prompt, parsed + validated client-side by `parseConsistencyReport()`
 * (modeled on `requirements-extractor.ts`). There is no vendor structured-output
 * API in this stack.
 */
import type { AIProvider, TokenUsage } from "../ai/types.js";
import type { ChatMessage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("cross-doc-validator");

/** A single unit of text to validate (a document, a chunk, or an artifact). */
export interface DocSegment {
  /** Stable identifier used as an evidence reference (document/chunk id). */
  id: string;
  /** Human-readable label (filename / artifact name) shown in the report. */
  label: string;
  /** The text content of this segment. */
  content: string;
}

/** Top-level verdict parsed from the report's `## Summary` block. */
export type ConsistencyVerdict = "OK" | "WARN" | "BLOCK" | "UNKNOWN";

/** Structured form of the Markdown consistency report. */
export interface ConsistencyReport {
  verdict: ConsistencyVerdict;
  uncoveredAcceptanceCriteria: string[];
  orphanComponents: string[];
  contradictions: string[];
  nextActions: string[];
  /** The raw Markdown the model produced (for archival / spec-kit append). */
  raw: string;
}

export interface CrossDocValidatorResult {
  report: ConsistencyReport;
  usage: TokenUsage;
}

export interface CrossDocValidatorDeps {
  provider: AIProvider;
  model?: string;
}

export interface ValidateOptions {
  signal?: AbortSignal;
  /**
   * Override the per-segment content cap (characters). Keeps the prompt
   * bounded over large ingested corpora. Defaults to {@link DEFAULT_SEGMENT_CAP}.
   */
  segmentCharCap?: number;
}

/** Default per-segment truncation to keep the prompt bounded. */
export const DEFAULT_SEGMENT_CAP = 4000;

export const CONSISTENCY_SYSTEM_PROMPT = [
  "You are a QA Lead running a cross-document consistency check over a set of",
  "documents. Compare every document against the others and emit Markdown ONLY.",
  "",
  "Required sections (in this order):",
  "  1. `## Summary` — `OK` (no gaps), `WARN` (minor gaps), or `BLOCK` (major gaps).",
  "  2. `## Uncovered acceptance criteria` — bullets or `- none`.",
  "  3. `## Orphan components` — components defined but never used/covered, or `- none`.",
  "  4. `## Contradictions` — bullets pointing at conflicting statements across documents.",
  "  5. `## Next actions` — concrete bullets for the operator, or `- none`.",
  "",
  "When every section is empty, the summary MUST be exactly `OK`.",
].join("\n");

const SECTION_TITLES: Record<keyof Omit<ConsistencyReport, "verdict" | "raw">, RegExp> = {
  uncoveredAcceptanceCriteria: /##\s*Uncovered acceptance criteria/i,
  orphanComponents: /##\s*Orphan components/i,
  contradictions: /##\s*Contradictions/i,
  nextActions: /##\s*Next actions/i,
};

function parseVerdict(report: string): ConsistencyVerdict {
  const m = report.match(/##\s*Summary\s*\n+\s*([A-Za-z]+)/);
  const v = m?.[1]?.toUpperCase() ?? "";
  if (v === "OK" || v === "WARN" || v === "BLOCK") return v;
  return "UNKNOWN";
}

/**
 * Extract the bullet lines under the Markdown header matched by `headerRe`.
 * A single `- none` (case-insensitive) bullet is treated as an empty section.
 * Stops at the next `##` header.
 */
function extractSection(report: string, headerRe: RegExp): string[] {
  const lines = report.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => headerRe.test(l));
  if (startIdx < 0) return [];
  const bullets: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*##\s/.test(line)) break;
    const m = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (m && m[1]) bullets.push(m[1].trim());
  }
  // `- none` sentinel → empty section.
  if (bullets.length === 1 && /^none\.?$/i.test(bullets[0]!)) return [];
  return bullets;
}

/**
 * Parse a Markdown consistency report into a structured shape. Tolerant of
 * missing sections and stray prose — anything the model omits becomes empty.
 * @internal — exposed for testing.
 */
export function parseConsistencyReport(raw: string): ConsistencyReport {
  return {
    verdict: parseVerdict(raw),
    uncoveredAcceptanceCriteria: extractSection(raw, SECTION_TITLES.uncoveredAcceptanceCriteria),
    orphanComponents: extractSection(raw, SECTION_TITLES.orphanComponents),
    contradictions: extractSection(raw, SECTION_TITLES.contradictions),
    nextActions: extractSection(raw, SECTION_TITLES.nextActions),
    raw,
  };
}

function emptyReport(): ConsistencyReport {
  return {
    verdict: "OK",
    uncoveredAcceptanceCriteria: [],
    orphanComponents: [],
    contradictions: [],
    nextActions: [],
    raw: "## Summary\nOK\n",
  };
}

function makeAbortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Build the user prompt from the supplied segments. Each segment is fenced and
 * labelled so the model can reference it by id/label in the report.
 */
export function buildConsistencyUserPrompt(segments: DocSegment[], cap: number): string {
  const blocks = segments.map((s) => {
    const body = s.content.length > cap ? `${s.content.slice(0, cap)}\n…[truncated]` : s.content;
    return [`### ${s.label} (id=${s.id})`, "```", body, "```"].join("\n");
  });
  return [
    `Documents to compare (${segments.length}):`,
    "",
    ...blocks,
    "",
    "Run the cross-document consistency check now.",
  ].join("\n");
}

export class CrossDocValidator {
  private readonly provider: AIProvider;
  private readonly model: string | undefined;

  constructor(deps: CrossDocValidatorDeps) {
    this.provider = deps.provider;
    this.model = deps.model;
  }

  /**
   * Validate consistency across the supplied segments. With fewer than one
   * segment there is nothing to compare, so we short-circuit to an empty OK
   * report without calling the model.
   */
  async validate(
    segments: DocSegment[],
    opts: ValidateOptions = {},
  ): Promise<CrossDocValidatorResult> {
    if (opts.signal?.aborted) throw makeAbortError();

    const usable = segments.filter((s) => s.content.trim().length > 0);
    if (usable.length < 1) {
      return { report: emptyReport(), usage: zeroUsage() };
    }

    const cap = opts.segmentCharCap ?? DEFAULT_SEGMENT_CAP;
    const messages: ChatMessage[] = [
      { role: "system", content: CONSISTENCY_SYSTEM_PROMPT },
      { role: "user", content: buildConsistencyUserPrompt(usable, cap) },
    ];

    log.info("Running cross-doc consistency check", { segments: usable.length });

    const response = await this.provider.chat(messages, {
      model: this.model,
      signal: opts.signal,
      disableTools: true,
    });

    const report = parseConsistencyReport(response.content);
    log.info("Cross-doc consistency check complete", {
      verdict: report.verdict,
      contradictions: report.contradictions.length,
      uncoveredAcceptanceCriteria: report.uncoveredAcceptanceCriteria.length,
    });

    return { report, usage: response.usage ?? zeroUsage() };
  }
}

function zeroUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}
