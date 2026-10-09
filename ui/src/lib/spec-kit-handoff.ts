/**
 * #789 — "Start analysis with these artifacts" after `/speckit.implement`.
 *
 * The analysis run takes free-text `extraInstructions` (the requirements to
 * evaluate against the code), capped at `MAX_EXTRA_INSTRUCTIONS`, and splits
 * them into one requirement per paragraph or bullet.
 *
 * #994 — the handoff used to send the first 4,096 characters of `spec.md`, cut
 * mid-sentence, and a 15 KB spec lost most of its criteria. A METIS spec's
 * requirements are its `## Acceptance criteria` (`AC-1`, …, each with
 * Given/When/Then sub-bullets) and its `## Non-functional requirements`, so the
 * handoff now sends those as a structured summary: one paragraph per
 * requirement, so each becomes exactly one requirement (its Given/When/Then
 * sub-bullets used to split into one requirement per line). A requirement that
 * does not fit is left out whole, never cut, and named in `omitted`; the caller
 * records that on the run so the analysis page says so (#1101: never trim in
 * silence). A spec with no acceptance criteria is sent as before, cut at a
 * paragraph boundary.
 */
import { MAX_EXTRA_INSTRUCTIONS, SPEC_KIT_HANDOFF_MAX_LABELS } from "@metis/shared";

export interface HandoffInstructions {
  text: string;
  /** True when anything the spec holds was not sent. */
  truncated: boolean;
  /** The requirements sent, by label (`AC-1`, `NFR-1`, …). */
  sent: string[];
  /**
   * What was left out: requirement labels, or `the end of spec.md`. Capped at
   * {@link SPEC_KIT_HANDOFF_MAX_LABELS} entries, the last a `+N more` when the
   * list was longer, so the run's record always passes the server's schema.
   */
  omitted: string[];
  /** How many parts were left out, uncapped. */
  omittedCount: number;
}

/** Named in `omitted` when an unstructured spec is cut. */
export const SPEC_TAIL_OMITTED = "the end of spec.md";

/**
 * Why a handoff's other artifacts (plan.md, tasks.md, constitution.md) are not
 * sent: only spec.md's requirements are. Stated wherever those files are named,
 * so naming them never implies they were sent (#994).
 */
export const CONTEXT_NOT_SENT_REASON = "context; see #1027";

/** The handoff artifacts that are not spec.md, and so were not sent. */
export function contextNotSent(artifacts: string[]): string[] {
  return artifacts.filter((a) => a.split("/").pop() !== "spec.md");
}

/** ` Not sent: plan.md, tasks.md (context; see #1027).`, or "" when there are none. */
function notSentNote(context: string[]): string {
  const rest = contextNotSent(context);
  return rest.length > 0 ? ` Not sent: ${rest.join(", ")} (${CONTEXT_NOT_SENT_REASON}).` : "";
}

/** At most the schema's limit, the last entry `+N more` when there were more. */
function capOmitted(omitted: string[]): string[] {
  if (omitted.length <= SPEC_KIT_HANDOFF_MAX_LABELS) return omitted;
  const kept = omitted.slice(0, SPEC_KIT_HANDOFF_MAX_LABELS - 1);
  return [...kept, `+${omitted.length - kept.length} more`];
}

interface SpecRequirement {
  label: string;
  text: string;
}

export function buildHandoffInstructions(
  context: string[],
  spec: string | null,
): HandoffInstructions {
  const body = spec?.trim() ?? "";
  if (body.length === 0) {
    const text = `Spec Kit handoff: no spec.md was available, so no requirements were sent.${notSentNote(context)}`;
    return { ...cutAtBoundary(text), sent: [], omitted: [], omittedCount: 0 };
  }
  const requirements = specRequirements(body);
  if (!requirements.some((r) => r.label.startsWith("AC-"))) return unstructured(context, body);

  // A bare heading names the next block rather than becoming a requirement.
  const header = `# Spec Kit handoff: evaluate these requirements from spec.md against the current implementation. Only spec.md's requirements are sent.${notSentNote(context)}`;
  let text = header;
  const sent: string[] = [];
  const omitted: string[] = [];
  for (const r of requirements) {
    const block = `\n\n${r.label}: ${r.text}`;
    if (text.length + block.length < MAX_EXTRA_INSTRUCTIONS) {
      text += block;
      sent.push(r.label);
    } else {
      omitted.push(r.label);
    }
  }
  return {
    text,
    truncated: omitted.length > 0,
    sent,
    omitted: capOmitted(omitted),
    omittedCount: omitted.length,
  };
}

/** The pre-#994 shape for a spec without acceptance criteria, cut between paragraphs. */
function unstructured(context: string[], spec: string): HandoffInstructions {
  const header = `Spec Kit handoff. Evaluate the requirements in this spec.md against the current implementation; only spec.md is sent.${notSentNote(context)}`;
  const cut = cutAtBoundary(`${header}\n\n${spec}`);
  const omitted = cut.truncated ? [SPEC_TAIL_OMITTED] : [];
  return { ...cut, sent: [], omitted, omittedCount: omitted.length };
}

/**
 * `full` if it fits the cap; else cut at the last line break or sentence end
 * that fits, so nothing is cut mid-sentence (or through a surrogate pair). The
 * header always ends a sentence before the spec, so there is always one.
 */
function cutAtBoundary(full: string): { text: string; truncated: boolean } {
  if (full.length < MAX_EXTRA_INSTRUCTIONS) return { text: full, truncated: false };
  // A text of exactly the cap is flagged by the server as truncated
  // (inputTruncated is `>=`), so the cap itself is not usable.
  const room = full.slice(0, MAX_EXTRA_INSTRUCTIONS);
  let at = 0;
  for (const m of room.matchAll(/\n|[.!?](?=\s)/g)) at = m.index! + (m[0] === "\n" ? 0 : 1);
  return { text: full.slice(0, at).trimEnd(), truncated: true };
}

const SECTION_RE = /^#{1,6}\s+(.*\S)\s*$/;
const BULLET_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const AC_START_RE = /^(?:[-*+]\s+|#{1,6}\s+)?\**\s*(AC-\d+)\s*\**\s*[:.—-]?\s*(.*)$/i;

/** The acceptance criteria, then the non-functional requirements, of a spec. */
export function specRequirements(spec: string): SpecRequirement[] {
  const sections = splitSections(spec);
  const acLines = sections.find((s) => /^acceptance criteria\b/i.test(s.title))?.lines ?? [];
  const nfrLines =
    sections.find((s) => /^non-functional requirements\b/i.test(s.title))?.lines ?? [];
  return [...acceptanceCriteria(acLines), ...nonFunctional(nfrLines)];
}

function splitSections(spec: string): Array<{ title: string; lines: string[] }> {
  const out: Array<{ title: string; lines: string[] }> = [];
  for (const line of spec.split(/\r?\n/)) {
    const h = SECTION_RE.exec(line);
    // `### AC-3` inside the criteria section is a criterion, not a section.
    if (h && !(out.length > 0 && /^\**\s*AC-\d+/i.test(h[1]!))) {
      out.push({ title: h[1]!.replace(/[*_`]/g, "").trim(), lines: [] });
    } else if (out.length > 0) {
      out[out.length - 1]!.lines.push(line);
    }
  }
  return out;
}

function acceptanceCriteria(lines: string[]): SpecRequirement[] {
  const out: SpecRequirement[] = [];
  let current: { label: string; parts: string[] } | null = null;
  const flush = () => {
    if (current) out.push({ label: current.label, text: sentence(current.parts) });
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const start = AC_START_RE.exec(line);
    if (start) {
      flush();
      current = { label: start[1]!.toUpperCase(), parts: [start[2] ?? ""] };
    } else if (current) {
      current.parts.push(BULLET_RE.exec(raw)?.[2] ?? line);
    }
  }
  flush();
  return out;
}

function nonFunctional(lines: string[]): SpecRequirement[] {
  const items: string[][] = [];
  for (const raw of lines) {
    if (raw.trim().length === 0) continue;
    const bullet = BULLET_RE.exec(raw);
    if (bullet && bullet[1]!.length === 0) items.push([bullet[2]!]);
    else if (items.length > 0) items[items.length - 1]!.push(bullet?.[2] ?? raw.trim());
  }
  return items.map((parts, i) => ({ label: `NFR-${i + 1}`, text: sentence(parts) }));
}

/** Join a requirement's lines into one paragraph, each ending in punctuation. */
function sentence(parts: string[]): string {
  return parts
    .map((p) => p.replace(/\*\*|__/g, "").trim())
    .filter((p) => p.length > 0)
    .map((p) => (/[.!?:;]$/.test(p) ? p : `${p}.`))
    .join(" ");
}
