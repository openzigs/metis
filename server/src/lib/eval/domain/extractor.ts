/**
 * Epic #803 (Epic 09) — BA-pipeline extractor seam.
 *
 * The domain eval runs the BA pipeline (ingest → analyze → synthesize) against
 * each corpus document and compares the extracted requirements to the golden
 * set. The pipeline is injected as a {@link DomainExtractor} so the runner stays
 * hermetic: production wires the real LLM pipeline, while CI uses the
 * deterministic {@link createOfflineExtractor} below (offline-stub) which needs
 * no model, no network, and no API budget.
 *
 * The offline extractor is a genuine heuristic over the prose — it mines
 * requirement statements (modal verbs: shall / must / should / will / …),
 * derives a title, classifies type + priority, and assigns a confidence from
 * the strength of the modal signal. It is intentionally imperfect so the suite
 * produces meaningful precision/recall, ROUGE-L, and calibration data and can
 * actually surface a regression.
 */
import type { DomainRequirement } from "@metis/shared";
import type { DomainCorpusItem } from "./corpus.js";

export interface ExtractionResult {
  requirements: DomainRequirement[];
  tokens: number;
  costCents: number;
  latencyMs: number;
}

export interface DomainExtractor {
  /** Stable model/extractor identifier persisted on the run (e.g. offline-stub). */
  name: string;
  extract(item: DomainCorpusItem): Promise<ExtractionResult> | ExtractionResult;
}

// Local aliases so the file documents intent even though the shared enums are
// plain string unions.
type DomainReqType = DomainRequirement["type"];
type DomainPriority = DomainRequirement["priority"];

const MODAL_SIGNALS: { re: RegExp; priority: DomainPriority; confidence: number }[] = [
  {
    re: /\b(must not|must|shall|is required to|are required to|required to)\b/i,
    priority: "high",
    confidence: 0.9,
  },
  { re: /\bcritical\b/i, priority: "critical", confidence: 0.95 },
  { re: /\b(should|will|needs to|need to)\b/i, priority: "medium", confidence: 0.7 },
  {
    re: /\b(may|might|could|optionally|optional|nice to have)\b/i,
    priority: "low",
    confidence: 0.5,
  },
];

function classifyType(sentence: string): DomainReqType {
  const s = sentence.toLowerCase();
  if (/\b(bug|defect|fix|error|crash|regression|incorrect)\b/.test(s)) return "bug";
  if (
    /\b(refactor|cleanup|clean up|migrate|migration|upgrade|deprecate|chore|maintenance)\b/.test(s)
  ) {
    return "chore";
  }
  return "feature";
}

function classifyPriority(sentence: string): { priority: DomainPriority; confidence: number } {
  for (const sig of MODAL_SIGNALS) {
    if (sig.re.test(sentence)) return { priority: sig.priority, confidence: sig.confidence };
  }
  return { priority: "medium", confidence: 0.6 };
}

function isRequirementSentence(sentence: string): boolean {
  return MODAL_SIGNALS.some((sig) => sig.re.test(sentence));
}

/** Split a document into candidate requirement statements (lines + sentences). */
export function splitStatements(document: string): string[] {
  const out: string[] = [];
  for (const rawLine of document.split(/\r?\n/)) {
    // Strip markdown bullet / numbering / heading markers.
    const line = rawLine
      .replace(/^\s{0,6}([-*+]|\d+[.)])\s+/, "")
      .replace(/^\s{0,6}#{1,6}\s+/, "")
      .trim();
    if (!line) continue;
    // Skip obvious headings / metadata lines (no trailing modal verb anyway).
    for (const sentence of line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)) {
      const trimmed = sentence.trim().replace(/^[-–—•]\s*/, "");
      if (trimmed.length >= 8) out.push(trimmed);
    }
  }
  return out;
}

function deriveTitle(sentence: string): string {
  // Drop a leading "The system / users / it" subject, keep the verb phrase.
  let body = sentence
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "");
  const words = body.split(" ");
  if (words.length > 12) body = `${words.slice(0, 12).join(" ")}…`;
  // Title-case the first character for readability.
  return body.charAt(0).toUpperCase() + body.slice(1);
}

export interface OfflineExtractorOptions {
  /** Modal-signal confidence multiplier — lets a "degraded" run be simulated. */
  confidenceScale?: number;
  name?: string;
}

/**
 * Deterministic offline extractor used by CI. Mines modal requirement
 * statements from the document prose. Pure and synchronous.
 */
export function createOfflineExtractor(opts: OfflineExtractorOptions = {}): DomainExtractor {
  const scale = opts.confidenceScale ?? 1;
  return {
    name: opts.name ?? "offline-stub",
    extract(item: DomainCorpusItem): ExtractionResult {
      const statements = splitStatements(item.document).filter(isRequirementSentence);
      // De-duplicate near-identical statements (same lowercased title).
      const seen = new Set<string>();
      const requirements: DomainRequirement[] = [];
      let idx = 0;
      for (const sentence of statements) {
        const title = deriveTitle(sentence);
        const key = title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        idx += 1;
        const { priority, confidence } = classifyPriority(sentence);
        requirements.push({
          id: `R${idx}`,
          type: classifyType(sentence),
          title,
          description: sentence.replace(/\s+/g, " ").trim(),
          priority,
          confidence: Math.max(0, Math.min(1, confidence * scale)),
        });
      }
      const tokens = Math.ceil(item.document.length / 4);
      return { requirements, tokens, costCents: 0, latencyMs: 0 };
    },
  };
}
