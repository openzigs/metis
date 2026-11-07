/**
 * Epic #1866 (#1870) — extract a governing revision's atomic rules, each cited
 * to the exact clause it came from.
 *
 * After a revision is stored (#1869), {@link runRuleExtraction} sets its
 * `extractionState` to `running`, splits `extractedText` by section and sends
 * each section to the model through the provider layer as fenced, untrusted
 * data (`prompts.ts`). Every rule the model returns passes a deterministic
 * check before it is stored: its `clauseExcerpt` must be in `extractedText`
 * verbatim, whitespace aside (`clause-verify.ts`), and the stored excerpt and
 * offsets are the source's own. A rule that fails is dropped and counted
 * (`droppedUnverified`), never stored with an invented citation.
 *
 * Control ids are the policy's own where the text has them: a `controlId` the
 * model gives is kept only when it appears in `extractedText`. Every other rule
 * gets `R-001`, `R-002`, ... in clause order, stable within the revision.
 *
 * The rules are stored in one transaction with `extractionState=done`. Any
 * failure (no provider, a provider error, a reply with no rules array) sets
 * `failed` with a reason safe to show every member in `extractionError` (never
 * the upstream's own text, #1059); the revision itself, stored
 * before extraction began, is untouched. A new revision gets its own run, and
 * the previous revision's rules stay for the findings that cite them. Usable
 * at once: no rule waits for analyst review (owner, 2026-11-06).
 */
import { GOVERNING_EXTRACTION_ERROR_MAX } from "@metis/shared";
import { loadAIConfig } from "../ai/config.js";
import { AIError, AIProviderError, describeProviderErrorSafely } from "../ai/errors.js";
import { buildProvider } from "../ai/providers/factory.js";
import type { AIProvider } from "../ai/types.js";
import { extractJsonObject, resolveFinalAnswerMaxOutputTokens } from "../analysis/agent-runner.js";
import { createChildLogger } from "../logger.js";
import { clauseLocator, type VerifiedClause } from "./clause-verify.js";
import { isGoverningDocsEnabled } from "./flag.js";
import {
  beginRuleExtraction,
  completeRuleExtraction,
  failRuleExtraction,
} from "./governing-store.js";
import { buildRuleExtractionPrompt } from "./prompts.js";

const log = createChildLogger("governing-rule-extraction");

/** A section longer than this is split at paragraph breaks before it is sent. */
export const MAX_SECTION_CHARS = 8000;
/** Model calls one revision may cost: one per section. */
export const MAX_SECTIONS = 250;
const MAX_SUMMARY_CHARS = 500;
const MAX_CLAUSE_REF_CHARS = 200;
const MAX_CONTROL_ID_CHARS = 64;

/** One span of `extractedText` sent to the model on its own. */
export interface PolicySection {
  start: number;
  end: number;
  heading: string;
  text: string;
}

/** A rule as stored: verified offsets into the revision's text. */
export interface ExtractedRule extends VerifiedClause {
  controlId: string;
  summary: string;
  clauseRef: string;
}

export interface RuleExtractionResult {
  rules: ExtractedRule[];
  /** Rules the model returned that could not be stored with a verified citation. */
  droppedUnverified: number;
  sections: number;
}

// Greedy to the end of the line, then trimmed by hand: a lazy capture followed
// by a `[ \t#]*$` tail backtracks quadratically on a long run of blanks.
const HEADING = /^#{1,6}[ \t]+(.*)$/gm;

/** `s` without trailing spaces, tabs and `#`, in one linear pass. */
function stripHeadingTail(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === " " || s[end - 1] === "\t" || s[end - 1] === "#")) end--;
  return s.slice(0, end).trim();
}

/** `id` occurring in `text` not inside a longer alphanumeric run. */
function containsToken(text: string, id: string): boolean {
  const isWord = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9]/.test(ch);
  for (let at = text.indexOf(id); at !== -1; at = text.indexOf(id, at + 1)) {
    if (!isWord(text[at - 1]) && !isWord(text[at + id.length])) return true;
  }
  return false;
}

/**
 * `text` split at its Markdown headings, each section running to the next
 * heading; a section over {@link MAX_SECTION_CHARS} is split again at
 * paragraph breaks. Text with no heading is one section. Blank sections are left out.
 */
export function splitSections(text: string): PolicySection[] {
  const marks: Array<{ at: number; heading: string }> = [];
  for (const m of text.matchAll(HEADING)) {
    const heading = stripHeadingTail(m[1]);
    if (heading) marks.push({ at: m.index, heading });
  }
  if (marks.length === 0 || marks[0].at > 0) marks.unshift({ at: 0, heading: "(start)" });

  const out: PolicySection[] = [];
  for (const [i, mark] of marks.entries()) {
    const end = i + 1 < marks.length ? marks[i + 1].at : text.length;
    for (const piece of splitLong(text, mark.at, end)) {
      const pieceText = text.slice(piece.start, piece.end);
      if (pieceText.trim().length === 0) continue;
      out.push({ ...piece, heading: mark.heading, text: pieceText });
    }
  }
  return out;
}

/** `[start, end)` in pieces of at most {@link MAX_SECTION_CHARS}, cut after a blank line where one exists. */
function splitLong(
  text: string,
  start: number,
  end: number,
): Array<{ start: number; end: number }> {
  const pieces: Array<{ start: number; end: number }> = [];
  let from = start;
  while (end - from > MAX_SECTION_CHARS) {
    const window = text.slice(from, from + MAX_SECTION_CHARS);
    const lastBreak = window.lastIndexOf("\n\n");
    // No blank line: cut after the later of the last line end and the last
    // sentence end, so a clause is not halved mid-sentence where it can be avoided.
    const lastLine = window.lastIndexOf("\n") + 1;
    const lastSentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n")) + 2;
    const softCut = Math.max(lastLine, lastSentence);
    const cut =
      lastBreak > 0
        ? from + lastBreak + 2
        : softCut > 2
          ? from + softCut
          : from + MAX_SECTION_CHARS;
    pieces.push({ start: from, end: cut });
    from = cut;
  }
  pieces.push({ start: from, end });
  return pieces;
}

/** A reply METIS could not read; its message is METIS's own, so safe to show. */
export class RuleExtractionReplyError extends Error {
  override name = "RuleExtractionReplyError";
}

interface Candidate {
  controlId?: string;
  summary: string;
  clauseExcerpt: string;
  clauseRef?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Read a reply's rules. An entry with no summary or no excerpt is counted as
 * `malformed`; a reply with no `rules` array throws.
 */
export function parseRuleExtractionReply(raw: string): {
  candidates: Candidate[];
  malformed: number;
} {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(raw);
  } catch {
    throw new RuleExtractionReplyError("The model's reply contained no JSON object.");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.rules)) {
    throw new RuleExtractionReplyError("The model's reply had no rules array.");
  }
  const candidates: Candidate[] = [];
  let malformed = 0;
  for (const entry of parsed.rules) {
    const summary = isRecord(entry) ? str(entry.summary) : "";
    const clauseExcerpt = isRecord(entry) ? str(entry.clauseExcerpt) : "";
    if (!isRecord(entry) || !summary || !clauseExcerpt) {
      malformed++;
      continue;
    }
    const controlId = str(entry.controlId);
    const clauseRef = str(entry.clauseRef);
    candidates.push({
      summary,
      clauseExcerpt,
      ...(controlId ? { controlId } : {}),
      ...(clauseRef ? { clauseRef } : {}),
    });
  }
  return { candidates, malformed };
}

export interface ExtractRulesInput {
  text: string;
  title: string;
  revisionLabel: string;
  provider: AIProvider;
  signal?: AbortSignal;
}

/** Extract and verify the rules of one revision's text. Throws on a provider error or an unreadable reply. */
export async function extractRulesFromText(
  input: ExtractRulesInput,
): Promise<RuleExtractionResult> {
  const { text, provider } = input;
  const locate = clauseLocator(text);
  const sections = splitSections(text);
  if (sections.length > MAX_SECTIONS) {
    throw new RuleExtractionReplyError(
      `The document has ${sections.length} sections; rule extraction reads at most ${MAX_SECTIONS}. Split the document and upload the parts.`,
    );
  }
  const found: Array<Omit<ExtractedRule, "controlId"> & { controlId?: string }> = [];
  let droppedUnverified = 0;

  for (const section of sections) {
    const prompt = buildRuleExtractionPrompt({
      title: input.title,
      revisionLabel: input.revisionLabel,
      heading: section.heading,
      sectionText: section.text,
    });
    const reply = await provider.chat([{ role: "user", content: prompt.userMessage }], {
      systemMessage: prompt.systemMessage,
      disableTools: true,
      maxTokens: resolveFinalAnswerMaxOutputTokens(provider.model, provider.key),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const { candidates, malformed } = parseRuleExtractionReply(reply.content);
    droppedUnverified += malformed;
    for (const c of candidates) {
      const clause = locate(c.clauseExcerpt, section);
      if (!clause) {
        droppedUnverified++;
        continue;
      }
      const controlId =
        c.controlId &&
        c.controlId.length <= MAX_CONTROL_ID_CHARS &&
        containsToken(text, c.controlId)
          ? c.controlId
          : undefined;
      found.push({
        ...clause,
        summary: c.summary.slice(0, MAX_SUMMARY_CHARS),
        clauseRef: (c.clauseRef || section.heading).slice(0, MAX_CLAUSE_REF_CHARS),
        ...(controlId ? { controlId } : {}),
      });
    }
  }

  // The same rule returned twice (same id and clause) is stored once.
  const seen = new Set<string>();
  const unique = found
    .sort((a, b) => a.clauseStart - b.clauseStart || a.clauseEnd - b.clauseEnd)
    .filter((r) => {
      const key = `${r.controlId ?? ""}\u0000${r.clauseStart}\u0000${r.clauseEnd}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  let generated = 0;
  const rules = unique.map((r) => ({
    ...r,
    controlId: r.controlId ?? `R-${String(++generated).padStart(3, "0")}`,
  }));
  return { rules, droppedUnverified, sections: sections.length };
}

export interface RunRuleExtractionInput {
  workspaceId: string;
  revisionId: string;
  /** The provider to call; default the deployment's configured one. */
  provider?: AIProvider;
}

function defaultProvider(): AIProvider {
  return buildProvider({ config: loadAIConfig() });
}

/** The reason a failed extraction shows, within the wire cap. */
function failureMessage(err: unknown): string {
  // Shown to every member of the workspace, so never an upstream's own text or
  // a configuration detail (#1059): those go to the server log.
  let message: string;
  if (err instanceof RuleExtractionReplyError) message = err.message;
  else if (err instanceof AIProviderError) message = describeProviderErrorSafely(err);
  else if (err instanceof AIError) {
    message = `The AI provider is not available (${err.code}). The detail is in the server log.`;
  } else message = "Rule extraction failed. The detail is in the server log.";
  return message.slice(0, GOVERNING_EXTRACTION_ERROR_MAX);
}

/**
 * The extraction job for one stored revision of this workspace. Never throws:
 * the outcome is the revision's `extractionState`. Does nothing with the flag
 * off or when the revision is not this workspace's.
 */
export async function runRuleExtraction(input: RunRuleExtractionInput): Promise<void> {
  if (!isGoverningDocsEnabled()) return;
  const { workspaceId, revisionId } = input;
  const revision = await beginRuleExtraction(workspaceId, revisionId);
  if (!revision) return;
  try {
    const result = await extractRulesFromText({
      text: revision.extractedText,
      title: revision.title,
      revisionLabel: revision.revisionLabel,
      provider: input.provider ?? defaultProvider(),
    });
    await completeRuleExtraction(workspaceId, revisionId, result.rules, result.droppedUnverified);
    log.info("governing rules extracted", {
      workspaceId,
      revisionId,
      rules: result.rules.length,
      droppedUnverified: result.droppedUnverified,
      sections: result.sections,
    });
  } catch (err) {
    const message = failureMessage(err);
    log.warn("governing rule extraction failed", {
      workspaceId,
      revisionId,
      error: message,
      cause: String(err),
    });
    await failRuleExtraction(workspaceId, revisionId, message).catch((writeErr: unknown) => {
      log.error("could not record a failed governing rule extraction", {
        workspaceId,
        revisionId,
        error: String(writeErr),
      });
    });
  }
}
