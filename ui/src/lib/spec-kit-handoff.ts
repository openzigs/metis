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

/** The two files the handoff reads context from (#1027). */
export type HandoffContextFile = "plan.md" | "tasks.md";

/**
 * Why a file that WAS read sent nothing: its Markdown did not have the shape
 * the handoff recognises. Saying "not read" there would be untrue, and would
 * send the reader looking for a missing file instead of at its headings.
 */
export const CONTEXT_UNRECOGNISED_REASON: Record<HandoffContextFile, string> = {
  "plan.md": "read, but no components were recognised",
  "tasks.md": "read, but no tasks were recognised",
};

const isContextFile = (name: string): name is HandoffContextFile =>
  name === "plan.md" || name === "tasks.md";

/**
 * `constitution.md (not read by this analysis)`, with each file under its own
 * reason: `a.md (not read by this analysis); plan.md (read, but no components
 * were recognised)`. "" when every artifact was sent.
 *
 * @param unrecognised the files read with nothing recognised in them
 */
export function notSentPhrase(
  artifacts: string[],
  sentAsContext: string[] = [],
  unrecognised: readonly string[] = [],
): string {
  const byReason = new Map<string, string[]>();
  for (const artifact of contextNotSent(artifacts, sentAsContext)) {
    const name = baseName(artifact);
    const reason =
      isContextFile(name) && unrecognised.includes(name)
        ? CONTEXT_UNRECOGNISED_REASON[name]
        : CONTEXT_NOT_SENT_REASON;
    byReason.set(reason, [...(byReason.get(reason) ?? []), artifact]);
  }
  return [...byReason].map(([reason, files]) => `${files.join(", ")} (${reason})`).join("; ");
}

/** ` Not sent: constitution.md (not read by this analysis).`, or "" when there are none. */
function notSentNote(context: string[], sentAsContext: string[], unrecognised: string[]): string {
  const phrase = notSentPhrase(context, sentAsContext, unrecognised);
  const note = phrase.length > 0 ? ` Not sent: ${phrase}.` : "";
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
 * @param unrecognised the files read with nothing recognised in them, so the
 *   text gives that as the reason rather than "not read".
 */
export function buildHandoffInstructions(
  context: string[],
  spec: string | null,
  sentAsContext: string[] = [],
  unrecognised: string[] = [],
): HandoffInstructions {
  const note = notSentNote(context, sentAsContext, unrecognised);
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

/**
 * A Markdown heading: its `#`s and its title. The title starts at a non-space
 * character, so the spaces after the `#`s can only be read one way. The earlier
 * `^#{1,6}\s+(.*\S)\s*$` let `\s+` and `.*` share them, and a heading line of
 * 40,000 spaces took 700 ms (quadratic); it now also runs over plan.md.
 */
const HEADING_RE = /^(#{1,6})[ \t]+(\S(?:.*\S)?)\s*$/;
const BULLET_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
// One run of spaces and asterisks on each side of the id, for the same reason:
// `\s+…\**\s*` shared the spaces after a bullet between three quantifiers.
const AC_START_RE = /^(?:[-*+](?=\s)|#{1,6}(?=\s))?[\s*]*(AC-\d+)[\s*]*[:.—-]?\s*(.*)$/i;

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
    const h = HEADING_RE.exec(line);
    // `### AC-3` inside the criteria section is a criterion, not a section.
    if (h && !(out.length > 0 && /^\**\s*AC-\d+/i.test(h[2]!))) {
      out.push({ title: h[2]!.replace(/[*_`]/g, "").trim(), lines: [] });
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
  /**
   * The plan components sent, by name. Every label is text that appears in
   * `text`, so the server can check the list against what was sent
   * (`specKitHandoffLabelsNotInContext`).
   */
  components: string[];
  /** The tasks sent, by id (`T01`, …). Each appears in `text`, as above. */
  tasks: string[];
  /**
   * The components and tasks left out for {@link MAX_ANALYSIS_AGENT_CONTEXT}
   * or for the record's {@link SPEC_KIT_HANDOFF_MAX_LABELS} labels per list,
   * capped like {@link HandoffInstructions.omitted}.
   */
  omitted: string[];
  /** How many were left out, uncapped. */
  omittedCount: number;
  /** The files something was sent from: `plan.md`, `tasks.md`. */
  files: string[];
  /**
   * The files that had content but nothing the handoff recognises as a
   * component or a task, so a reader is told that rather than "not read".
   */
  unrecognised: HandoffContextFile[];
}

interface ContextItem {
  label: string;
  line: string;
}

const COMPONENTS_HEADING = "Plan components (plan.md):";
const TASKS_HEADING = "Tasks (tasks.md):";
const LABEL_MAX = 64;
const TABLE_RULE_RE = /^\s*\|[\s|:-]+\|\s*$/;
/**
 * The plan section that lists components: `Components`, `2. Components`,
 * `Component breakdown`, `Architecture and components`. A title must start
 * with the word or end with it, so `Non-component concerns` is not one.
 */
const COMPONENTS_TITLE_RE = /^(?:\d+(?:\.\d+)*[.)]?[ \t]+)?(?:components?\b|.*\bcomponents$)/i;
/**
 * A task line: a bullet (with or without a checkbox), a numbered item or a
 * heading whose first word is a task id, plain or in bold or code. The id is
 * an upper-case `T` and digits, here and in a table cell alike (as the server's
 * bullet form requires): `- t2 instances …` is not a task. Nor is
 * `- Task T03: …`, which is prose about one.
 */
const TASK_LINE_RE =
  /^[ \t]*(?:[-*+][ \t]*|\d{1,9}[.)][ \t]+|#{1,6}[ \t]+)(?:\[[ xX]\][ \t]*)?(?:\*\*|__|`)?(T\d{1,4})(?![A-Za-z0-9])(.*)$/;
/** A table cell that is a task id and nothing else. */
const TASK_ID_CELL_RE = /^T\d{1,4}$/;

const stripEmphasis = (text: string): string => text.replace(/\*\*|__/g, "").trim();

/** At most {@link LABEL_MAX} UTF-16 units, never ending inside a surrogate pair. */
function clipLabel(text: string): string {
  const cut = text.slice(0, LABEL_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  return (last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut).trim();
}

/** The cells of a Markdown table row, or null when the line is not one. */
function tableCells(raw: string): string[] | null {
  if (!raw.trim().startsWith("|")) return null;
  return raw
    .split("|")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * The context a handoff sends from plan.md and tasks.md: one line per component
 * of the plan's components section and one per task (its id and title, not the
 * description beneath it). An item that does not fit the limit is left out
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
      // The run's record holds at most SPEC_KIT_HANDOFF_MAX_LABELS labels per
      // list. 600 tasks with no title fit the character limit, and the record
      // naming all of them was refused whole with a 400, so no run started.
      if (length + extra > room || sent.length >= SPEC_KIT_HANDOFF_MAX_LABELS) {
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
    unrecognised: [
      ...((plan ?? "").trim().length > 0 && components.length === 0 ? (["plan.md"] as const) : []),
      ...((tasks ?? "").trim().length > 0 && taskItems.length === 0 ? (["tasks.md"] as const) : []),
    ],
  };
}

/** A component before it is a line: the name it was given, if any, and its text. */
interface ComponentDraft {
  name: string | null;
  parts: string[];
}

/**
 * The components of a plan, one line each. The plan is model-written Markdown,
 * so the section is found by its title ({@link COMPONENTS_TITLE_RE}) at any
 * heading level and read in the three shapes a plan uses: top-level bullets
 * (the template's), a `### Name` sub-heading per component, and a table with
 * the name in its first column. The section ends at the next heading of its
 * own level or above.
 */
function planComponents(plan: string): ContextItem[] {
  const lines = plan.split(/\r?\n/);
  const drafts: ComponentDraft[] = [];
  let sectionLevel = 0;
  // The component a sub-heading opened: it takes the first line beneath it.
  // Only headings of the first level seen beneath the section are components;
  // a deeper one is detail of the component above it.
  let componentLevel = 0;
  let underHeading: ComponentDraft | null = null;
  // The indent of the section's first bullet: bullets at it are components,
  // deeper ones are detail of the component above.
  let bulletIndent: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const heading = HEADING_RE.exec(raw);
    if (heading) {
      const level = heading[1]!.length;
      const title = heading[2]!.replace(/[*_`]/g, "").trim();
      if (sectionLevel === 0) {
        // Never the document's own `# Title`: a plan called "… components"
        // would make every section of it a component.
        if (level > 1 && COMPONENTS_TITLE_RE.test(title)) sectionLevel = level;
      } else if (level <= sectionLevel) {
        break;
      } else if (componentLevel === 0 || level <= componentLevel) {
        componentLevel = level;
        underHeading = { name: title, parts: [] };
        drafts.push(underHeading);
      }
      continue;
    }
    if (sectionLevel === 0 || raw.trim().length === 0) continue;
    const bullet = BULLET_RE.exec(raw);
    if (underHeading) {
      const text = bullet?.[2] ?? raw.trim();
      // One line per component: the first line of prose or the first bullet.
      if (underHeading.parts.length === 0 && !/^(?:```|~~~|\|)/.test(text)) {
        underHeading.parts.push(text);
      }
      continue;
    }
    const cells = tableCells(raw);
    if (cells) {
      // The row above a rule is the table's header; the rule is not a row.
      if (TABLE_RULE_RE.test(raw) || TABLE_RULE_RE.test(lines[i + 1] ?? "")) continue;
      if (cells.length > 0) drafts.push({ name: cells[0]!, parts: cells.slice(1, 2) });
      continue;
    }
    if (bullet && bulletIndent === null) bulletIndent = bullet[1]!.length;
    if (bullet && bullet[1]!.length <= bulletIndent!) {
      drafts.push({ name: null, parts: [bullet[2]!] });
    } else if (drafts.length > 0) {
      drafts[drafts.length - 1]!.parts.push(bullet?.[2] ?? raw.trim());
    }
  }
  return drafts.flatMap((draft) => {
    const body = draft.parts.map(stripEmphasis).filter((p) => p.length > 0);
    const name = draft.name === null ? null : stripEmphasis(draft.name);
    const text = [...(name ? [name] : []), ...body].join(name ? " — " : " ");
    if (text.length === 0) return [];
    // A bullet names its component in bold or in code: `- **FeedStore** — …`.
    const first = draft.parts[0] ?? "";
    const named =
      name ?? /^\*\*(.+?)\*\*/.exec(first)?.[1] ?? /^`([^`]+)`/.exec(first)?.[1] ?? null;
    const candidate = named === null ? "" : clipLabel(stripEmphasis(named));
    // The label must be text of the line it names; an unnamed component is
    // labelled by the start of its line.
    const label = candidate.length > 0 && text.includes(candidate) ? candidate : clipLabel(text);
    return [{ label, line: `- ${text}` }];
  });
}

/**
 * One `- T01: title` line per task of a tasks.md.
 *
 * This is a second tasks.md parser. The first is
 * `server/src/lib/spec-kit/tasks-parser.ts`, which `/speckit.taskstoissues`
 * uses to build issues and which reads far more of a row (dependencies, files,
 * story, `[P]`, `satisfies`). This one lives in the UI because the handoff is
 * assembled in the browser from artifacts the page already holds, the server
 * module is not part of `@metis/shared`, and all it needs is an id and a
 * title. It is deliberately the more forgiving of the two, since a line it
 * misses is context the code agent does not get: it also takes a bold id, a
 * numbered item and a `### T01` heading. A change to the task line format
 * belongs in both.
 */
function taskLines(tasks: string): ContextItem[] {
  const out: ContextItem[] = [];
  const seen = new Set<string>();
  for (const raw of tasks.split(/\r?\n/)) {
    if (TABLE_RULE_RE.test(raw)) continue;
    let id: string | null = null;
    let rest = "";
    const cells = tableCells(raw);
    if (cells) {
      // Only a row whose FIRST cell is a task id and nothing else is a task. A
      // traceability row (`| AC-1 | T01, T02 |`) names tasks without being one.
      const first = stripEmphasis(cells[0] ?? "").replace(/`/g, "");
      if (TASK_ID_CELL_RE.test(first)) {
        id = first;
        rest = cells[1] ?? "";
      }
    } else {
      const line = TASK_LINE_RE.exec(raw);
      if (line) {
        id = line[1]!;
        rest = line[2]!;
      }
    }
    if (id === null) continue;
    // The first line of a task wins; a later line with the same id is not a
    // second task.
    if (seen.has(id)) continue;
    seen.add(id);
    const title = rest
      // The marker that closed a bold or code id, and one closing a bold title.
      .replace(/^(?:\*\*|__|`)/, "")
      .replace(/(?:\*\*|__)$/, "")
      .replace(/^[\s:.—–-]+/, "")
      .trim();
    out.push({ label: id, line: title.length > 0 ? `- ${id}: ${title}` : `- ${id}` });
  }
  return out;
}
