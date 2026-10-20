/**
 * #1276 — what a draft's stored body becomes on the published issue, beyond
 * the marker block `injectMarker` appends. Two additions, both made at publish
 * time because neither is known, or wanted, inside METIS:
 *
 *  1. **The parent epic's number and link.** A sub-issue body opens with
 *     `> Parent epic: **<title>**` (`draft-generator.ts`), written before any
 *     issue number exists. When the epic is published in the same batch the
 *     sub-issue is attached to it through the sub-issues API and the body is
 *     left as it is. When the epic was published by an EARLIER batch, nothing
 *     else names it, so the line gets the epic's `#N` and link.
 *  2. **One sentence in place of the `unverified` label.** The label stays on
 *     the draft and the requirement inside METIS, and is never sent
 *     (`publishableLabels`); the issue says in plain words what it meant.
 *
 * Both are pure, idempotent, and undone by their `without…` twin, which
 * drift detection (`reconcile-service.ts`) applies to the tracker's body so a
 * published issue does not read as changed against the draft it came from.
 */
import { UNVERIFIED_LABEL } from "./label-sync.js";

/** The sentence a published issue carries when its draft is labelled `unverified`. */
export const UNVERIFIED_PUBLISHED_NOTE =
  "METIS could not confirm the code references behind this item; check them before relying on them.";

/** The parent line exactly as the draft generator writes it. */
const PARENT_LINE_RE = /^> Parent epic: \*\*.+\*\*$/;

/** The same line after {@link withParentEpicLink}: ` ([#N](https://…))` or ` (#N)` appended. */
const FILLED_PARENT_LINE_RE =
  /^(> Parent epic: \*\*.+\*\*) \((?:\[#\d+\]\(https:\/\/[^\s()<>]+\)|#\d+)\)$/;

/** A link target safe to put inside `(…)` in Markdown: https, no space, paren or angle bracket. */
const SAFE_URL_RE = /^https:\/\/[^\s()<>]+$/;

const ACCEPTANCE_HEADING_RE = /^##\s+Acceptance criteria\s*$/i;

/** The GitHub issue a draft's parent epic was published as. */
export interface ParentEpicIssue {
  issueNumber: number;
  htmlUrl: string;
}

function splitFirstLine(body: string): [string, string] {
  const nl = body.indexOf("\n");
  return nl < 0 ? [body, ""] : [body.slice(0, nl), body.slice(nl)];
}

/**
 * The body with its generated parent line naming `epic` by number and link.
 * Only the first line is considered, and only in the exact shape the generator
 * writes it: a body a reviewer rewrote, or one that already names a number, is
 * returned unchanged. A recorded URL that is not a plain https URL is left out
 * and the bare `#N` (which GitHub links within the repository) is written.
 */
export function withParentEpicLink(body: string, epic: ParentEpicIssue): string {
  if (!Number.isSafeInteger(epic.issueNumber) || epic.issueNumber <= 0) return body;
  const [first, rest] = splitFirstLine(body);
  if (!PARENT_LINE_RE.test(first)) return body;
  const ref = SAFE_URL_RE.test(epic.htmlUrl)
    ? `[#${epic.issueNumber}](${epic.htmlUrl})`
    : `#${epic.issueNumber}`;
  return `${first} (${ref})${rest}`;
}

/** {@link withParentEpicLink} undone: the parent line as the generator wrote it. */
export function withoutParentEpicLink(body: string): string {
  const [first, rest] = splitFirstLine(body);
  const filled = FILLED_PARENT_LINE_RE.exec(first);
  return filled ? `${filled[1]}${rest}` : body;
}

/** Whether a draft's labels include `unverified`, in any case. */
export function carriesUnverifiedLabel(labels: readonly string[]): boolean {
  return labels.some((l) => l.trim().toLowerCase() === UNVERIFIED_LABEL);
}

/**
 * The body with {@link UNVERIFIED_PUBLISHED_NOTE} when `labels` include
 * `unverified`: directly above the acceptance criteria, where the other
 * cautions sit (#1110), or at the end of a body without that heading. A body
 * that already holds the sentence is returned unchanged.
 */
export function withUnverifiedNote(body: string, labels: readonly string[]): string {
  if (!carriesUnverifiedLabel(labels) || body.includes(UNVERIFIED_PUBLISHED_NOTE)) return body;
  const lines = body.split("\n");
  const at = lines.findIndex((l) => ACCEPTANCE_HEADING_RE.test(l));
  if (at >= 0) {
    lines.splice(at, 0, UNVERIFIED_PUBLISHED_NOTE, "");
    return lines.join("\n");
  }
  return `${body.trimEnd()}\n\n${UNVERIFIED_PUBLISHED_NOTE}`;
}

/** {@link withUnverifiedNote} undone, wherever it put the sentence. */
export function withoutUnverifiedNote(body: string): string {
  if (!body.includes(UNVERIFIED_PUBLISHED_NOTE)) return body;
  const lines = body.split("\n");
  const at = lines.indexOf(UNVERIFIED_PUBLISHED_NOTE);
  if (at < 0) return body;
  if (lines[at + 1] === "") {
    lines.splice(at, 2);
    return lines.join("\n");
  }
  // Appended at the end, after a blank line.
  lines.splice(at, 1);
  if (at > 0 && lines[at - 1] === "" && at - 1 === lines.length - 1) lines.pop();
  return lines.join("\n");
}

/**
 * Everything {@link withParentEpicLink} and {@link withUnverifiedNote} add, for
 * one draft: the text that is published in front of the marker block.
 */
export function publishedDraftBody(
  draft: { body: string; labels: readonly string[] },
  parentEpic: ParentEpicIssue | null | undefined,
): string {
  const linked = parentEpic ? withParentEpicLink(draft.body, parentEpic) : draft.body;
  return withUnverifiedNote(linked, draft.labels);
}
