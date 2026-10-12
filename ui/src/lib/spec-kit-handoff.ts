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
 *
 * #1027 — plan.md and tasks.md cannot ride in that text: the server splits it
 * into requirements, so plan headings and task titles would become requirements
 * and push the spec's criteria out. They go in a separate `agentContext` field
 * the code agent reads as background ({@link buildHandoffContext}): the plan's
 * components and the tasks' ids and titles, within its own limit, with what did
 * not fit named the same way.
 */
import {
  MAX_ANALYSIS_AGENT_CONTEXT,
  MAX_EXTRA_INSTRUCTIONS,
  SPEC_KIT_HANDOFF_MAX_LABELS,
} from "@metis/shared";

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
 * Why a handoff artifact is named as not sent: the analysis read nothing from
 * it. Stated wherever such a file is named, so naming it never implies it was
 * sent (#994).
 */
export const CONTEXT_NOT_SENT_REASON = "not read by this analysis";

const baseName = (artifact: string): string => artifact.split("/").pop() ?? artifact;

/**
 * The handoff artifacts nothing was sent from: every file but spec.md and the
 * files named in `sentAsContext` (`plan.md`, `tasks.md` when the handoff sent
 * context from them, #1027).
 */
export function contextNotSent(artifacts: string[], sentAsContext: string[] = []): string[] {
  return artifacts.filter((a) => {
    const name = baseName(a);
    return name !== "spec.md" && !sentAsContext.includes(name);
  });
}

/** The artifacts context was sent from, as the handoff named them. */
function sentAsContextNote(context: string[], sentAsContext: string[]): string {
  const files = context.filter((a) => sentAsContext.includes(baseName(a)));
  return files.length > 0
    ? ` Sent separately as context, not as requirements: ${files.join(", ")}.`
    : "";
}

/** ` Not sent: constitution.md (not read by this analysis).`, or "" when there are none. */
function notSentNote(context: string[], sentAsContext: string[]): string {
  const rest = contextNotSent(context, sentAsContext);
  const note = rest.length > 0 ? ` Not sent: ${rest.join(", ")} (${CONTEXT_NOT_SENT_REASON}).` : "";
  return `${sentAsContextNote(context, sentAsContext)}${note}`;
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

/**
 * @param sentAsContext the files context was sent from (`plan.md`, `tasks.md`),
 *   so the text never says a file was not sent when part of it was (#1027).
 */
export function buildHandoffInstructions(
  context: string[],
  spec: string | null,
  sentAsContext: string[] = [],
): HandoffInstructions {
  const note = notSentNote(context, sentAsContext);
  const body = spec?.trim() ?? "";
  if (body.length === 0) {
    const text = `Spec Kit handoff: no spec.md was available, so no requirements were sent.${note}`;
    return { ...cutAtBoundary(text), sent: [], omitted: [], omittedCount: 0 };
  }
  const requirements = specRequirements(body);
  if (!requirements.some((r) => r.label.startsWith("AC-"))) return unstructured(note, body);

  // A bare heading names the next block rather than becoming a requirement.
  const header = `# Spec Kit handoff: evaluate these requirements from spec.md against the current implementation. Only spec.md's requirements are sent.${note}`;
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
function unstructured(note: string, spec: string): HandoffInstructions {
  const header = `Spec Kit handoff. Evaluate the requirements in this spec.md against the current implementation; only spec.md is sent.${note}`;
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

// ── #1027 — plan.md and tasks.md as context ────────────────────────────────

export interface HandoffContext {
  /** The text for `agentContext`, or null when there was nothing to send. */
  text: string | null;
  /** The plan components sent, by name. */
  components: string[];
  /** The tasks sent, by id (`T01`, …). */
  tasks: string[];
  /**
   * The components and tasks left out for {@link MAX_ANALYSIS_AGENT_CONTEXT},
   * capped like {@link HandoffInstructions.omitted}.
   */
  omitted: string[];
  /** How many were left out, uncapped. */
  omittedCount: number;
  /** The files something was sent from: `plan.md`, `tasks.md`. */
  files: string[];
}

interface ContextItem {
  label: string;
  line: string;
}

const COMPONENTS_HEADING = "Plan components (plan.md):";
const TASKS_HEADING = "Tasks (tasks.md):";
const LABEL_MAX = 64;
const TASK_ID_RE = /\bT\d{1,4}\b/i;
const TASK_BULLET_RE = /^\s*[-*+]\s*(?:\[[ xX]\]\s*)?(?=T\d)/;
const TABLE_RULE_RE = /^\s*\|[\s|:-]+\|\s*$/;

/**
 * The context a handoff sends from plan.md and tasks.md: one line per component
 * of the plan's `## Components` section and one per task (its id and title, not
 * the description beneath it). An item that does not fit the limit is left out
 * whole and named. Components may take at most half the limit when the tasks
 * would otherwise be crowded out; whatever one list leaves, the other may use.
 */
export function buildHandoffContext(plan: string | null, tasks: string | null): HandoffContext {
  const components = planComponents(plan ?? "");
  const taskItems = taskLines(tasks ?? "");
  // What the whole task list would add after the components: its heading, a
  // line break before it, and each line with its break.
  const tasksCost =
    taskItems.length === 0
      ? 0
      : TASKS_HEADING.length + 1 + taskItems.reduce((n, i) => n + i.line.length + 1, 0);
  const componentRoom = Math.max(
    Math.floor(MAX_ANALYSIS_AGENT_CONTEXT / 2),
    MAX_ANALYSIS_AGENT_CONTEXT - tasksCost,
  );

  const omitted: string[] = [];
  const lines: string[] = [];
  let length = 0;
  const fill = (items: ContextItem[], heading: string, room: number): string[] => {
    const sent: string[] = [];
    for (const item of items) {
      // The heading is paid for with the list's first item; each line costs its
      // text and the line break before it.
      const extra =
        item.line.length +
        1 +
        (sent.length === 0 ? heading.length + (lines.length > 0 ? 1 : 0) : 0);
      if (length + extra > room) {
        omitted.push(item.label);
        continue;
      }
      if (sent.length === 0) lines.push(heading);
      lines.push(item.line);
      length += extra;
      sent.push(item.label);
    }
    return sent;
  };
  const sentComponents = fill(components, COMPONENTS_HEADING, componentRoom);
  const sentTasks = fill(taskItems, TASKS_HEADING, MAX_ANALYSIS_AGENT_CONTEXT);

  return {
    text: lines.length > 0 ? lines.join("\n") : null,
    components: sentComponents,
    tasks: sentTasks,
    omitted: capOmitted(omitted),
    omittedCount: omitted.length,
    files: [
      ...(sentComponents.length > 0 ? ["plan.md"] : []),
      ...(sentTasks.length > 0 ? ["tasks.md"] : []),
    ],
  };
}

/** The top-level bullets of the plan's `## Components` section, one line each. */
function planComponents(plan: string): ContextItem[] {
  const lines = splitSections(plan).find((s) => /^components\b/i.test(s.title))?.lines ?? [];
  const items: string[][] = [];
  for (const raw of lines) {
    if (raw.trim().length === 0) continue;
    const bullet = BULLET_RE.exec(raw);
    if (bullet && bullet[1]!.length === 0) items.push([bullet[2]!]);
    else if (items.length > 0) items[items.length - 1]!.push(bullet?.[2] ?? raw.trim());
  }
  return items.map((parts, i) => {
    const first = parts[0]!;
    const named = /^\*\*(.+?)\*\*/.exec(first)?.[1] ?? /^`([^`]+)`/.exec(first)?.[1];
    const label = (named ?? `component ${i + 1}`).trim().slice(0, LABEL_MAX);
    return {
      label: label.length > 0 ? label : `component ${i + 1}`,
      line: `- ${parts.map((p) => p.replace(/\*\*|__/g, "").trim()).join(" ")}`,
    };
  });
}

/** One `- T01: title` line per task of a tasks.md, bullet or table form. */
function taskLines(tasks: string): ContextItem[] {
  const out: ContextItem[] = [];
  for (const raw of tasks.split(/\r?\n/)) {
    if (TABLE_RULE_RE.test(raw)) continue;
    let rest: string | null = null;
    if (raw.trim().startsWith("|")) {
      const cells = raw
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      // A row whose first cell holds no task id (the header) is dropped below.
      if (cells.length >= 2) rest = `${cells[0]} ${cells[1]}`;
    } else if (TASK_BULLET_RE.test(raw)) {
      rest = raw.replace(TASK_BULLET_RE, "").trim();
    }
    const id = rest === null ? null : TASK_ID_RE.exec(rest);
    if (rest === null || !id) continue;
    const title = rest
      .slice(id.index + id[0].length)
      .replace(/^[\s:.—–-]+/, "")
      .trim();
    const label = id[0].toUpperCase();
    out.push({ label, line: title.length > 0 ? `- ${label}: ${title}` : `- ${label}` });
  }
  return out;
}
