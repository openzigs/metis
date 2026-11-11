/**
 * Issue #2236 — what makes two clarifying questions the same question, so a
 * settled answer is reused by a later analysis of the project instead of being
 * asked again.
 *
 * The question's own wording is the model's and changes from run to run, so it
 * is the weakest identity there is and is used only where nothing better
 * exists. In order of preference:
 *
 *   1. `source`      — the paragraph of the document it was asked about (#2235's
 *                      citation, the source's own verified text) and the
 *                      ambiguous field. Same paragraph, same field: same
 *                      question. When the document changes, the paragraph's
 *                      text changes, the key changes, and the question is asked
 *                      again (see {@link sourceSlot} for how the old answer is
 *                      then marked reopened).
 *   2. `governing`   — the governing rules it settles and its question.
 *   3. `requirement` — the requirement's title and the ambiguous field.
 *   4. `spec-kit`    — the Spec Kit feature and the `/clarify` question.
 *
 * Deterministic and model-free: no model is asked whether two questions match,
 * so a reuse can always be explained by the text it was keyed on.
 */
import { createHash } from "node:crypto";

/** The parts of a question its key is made from. */
export interface KeyableQuestion {
  question: string;
  ambiguityField?: string;
  /** The title of the requirement it was asked about. */
  requirementTitle?: string;
  citation?: { documentId?: string; headingPath: readonly string[]; quote: string };
  governing?: { ruleIds: readonly string[] };
  /** For a Spec Kit `/clarify` question: the feature slug, or null for `.specify/`. */
  specKitFeature?: string | null;
}

/** Case-, punctuation- and whitespace-insensitive form of `text`. */
export function normaliseForKey(text: string | undefined | null): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/** The key of a Spec Kit `/clarify` question. */
export function specKitClarificationKey(feature: string | null, question: string): string {
  return hash(["spec-kit", feature ?? "", normaliseForKey(question)]);
}

/** The key that identifies `q` across analyses of one project. */
export function clarificationKey(q: KeyableQuestion): string {
  if (q.specKitFeature !== undefined) return specKitClarificationKey(q.specKitFeature, q.question);
  if (q.governing && q.governing.ruleIds.length > 0) {
    return hash([
      "governing",
      [...q.governing.ruleIds].sort().join(","),
      normaliseForKey(q.question),
    ]);
  }
  const quote = normaliseForKey(q.citation?.quote);
  if (quote.length > 0) {
    return hash(["source", quote, normaliseForKey(q.ambiguityField)]);
  }
  const title = normaliseForKey(q.requirementTitle);
  if (title.length > 0) {
    return hash(["requirement", title, normaliseForKey(q.ambiguityField)]);
  }
  return hash(["question", normaliseForKey(q.question)]);
}

/**
 * Where in a document a question was asked: the document, the section and the
 * field, without the paragraph's text. Two questions in the same slot with
 * different keys are the same question about a paragraph that changed, so the
 * earlier answer is reopened. `null` for a question with no cited document.
 */
export function sourceSlot(q: Pick<KeyableQuestion, "citation" | "ambiguityField">): string | null {
  const documentId = q.citation?.documentId;
  if (!documentId) return null;
  return hash([
    "slot",
    documentId,
    (q.citation?.headingPath ?? []).map(normaliseForKey).join("/"),
    normaliseForKey(q.ambiguityField),
  ]);
}
