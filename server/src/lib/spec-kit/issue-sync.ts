/**
 * Issue #433 — bidirectional sync from GitHub issue events back to the
 * per-feature `tasks.md` artifact.
 *
 * Flow: when a GitHub issue created via `/speckit.taskstoissues` is
 * `closed`, `reopened`, or `edited`, we look up the originating
 * `(featureSlug, taskId)` via the `SpecKitTaskExport` row and rewrite the
 * matching task line in `tasks.md` to flip the `[ ]`/`[x]` checkbox or
 * update the title text. The artifact is bumped with a new version row so
 * downstream `/speckit.analyze` runs see the change.
 *
 * The webhook handler in `routes/webhooks-github.ts` calls into here
 * after verifying the HMAC signature and parsing the `issues` event
 * payload.
 */
import { prisma } from "../prisma.js";
import { writeFeatureArtifact, getFeatureArtifact } from "./feature-artifacts.js";
import { audit } from "../audit/audit-service.js";

export type IssuesEventAction =
  | "closed"
  | "reopened"
  | "edited"
  | "opened"
  | "assigned"
  | "unassigned"
  | "labeled"
  | "unlabeled"
  | string;

export interface IssueSyncInput {
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  action: IssuesEventAction;
  /** Issue title at the time of the event — used by the `edited` action. */
  newTitle?: string;
  /** Optional changes block from the GitHub `edited` payload. */
  changes?: { title?: { from: string } };
}

export type IssueSyncOutcome =
  | {
      handled: true;
      featureSlug: string;
      taskId: string;
      change: "checkbox" | "title" | "noop";
      tasksMdVersion: number;
    }
  | { handled: false; reason: string };

const TASK_ID_LINE_RE = /\b(T\d{1,4})\b/i;

/**
 * Apply a single issue event to the `tasks.md` content.
 *
 * Pure helper exposed for unit testing. Returns the new content and the
 * change kind. If the line cannot be located the original content is
 * returned with `change: 'noop'`.
 */
export function applyIssueEventToTasksMarkdown(
  content: string,
  taskId: string,
  action: IssuesEventAction,
  newTitle?: string,
  issueNumber?: number,
): { content: string; change: "checkbox" | "title" | "noop" } {
  const target = taskId.toUpperCase();
  const lines = content.split(/\r?\n/);
  let change: "checkbox" | "title" | "noop" = "noop";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const idMatch = TASK_ID_LINE_RE.exec(line);
    if (!idMatch) continue;
    if (idMatch[1]!.toUpperCase() !== target) continue;
    if (action === "closed") {
      const next = toggleCheckbox(line, true, issueNumber);
      if (next !== line) {
        lines[i] = next;
        change = "checkbox";
      }
      break;
    }
    if (action === "reopened") {
      const next = toggleCheckbox(line, false, issueNumber);
      if (next !== line) {
        lines[i] = next;
        change = "checkbox";
      }
      break;
    }
    if (action === "edited" && newTitle && newTitle.trim().length > 0) {
      const next = renameTaskInLine(line, target, newTitle);
      if (next !== line) {
        lines[i] = next;
        change = "title";
      }
      break;
    }
    break;
  }
  return { content: lines.join("\n"), change };
}

function toggleCheckbox(line: string, closed: boolean, issueNumber?: number): string {
  // Bullet-list: `- [ ] T01 — ...`
  const bulletRe = /^(\s*-\s*)\[([ xX])\](\s*)/;
  const m = bulletRe.exec(line);
  if (m) {
    const target = closed ? "x" : " ";
    if (m[2] === target || (closed && m[2]?.toLowerCase() === "x")) return line;
    return line.replace(bulletRe, `${m[1]}[${target}]${m[3]}`);
  }
  // Markdown table form `| T01 | ... | ✅ | ... |` — append/replace a status
  // marker in the trailing notes cell instead of mutating column shape.
  if (line.trim().startsWith("|") && line.includes("|")) {
    // Issue #438 — substitute the real issue number instead of literal `#N`.
    // Fallback to `#N` when the caller did not pass one (older test paths).
    const ref = typeof issueNumber === "number" && issueNumber > 0 ? `#${issueNumber}` : "#N";
    const marker = closed ? `<!-- closed via ${ref} -->` : "<!-- open -->";
    if (line.includes("<!-- closed") || line.includes("<!-- open")) {
      return line.replace(/<!--\s*(closed[^>]*|open[^>]*)\s*-->/, marker);
    }
    // Append the marker just before the trailing `|`.
    return line.replace(/\|\s*$/, ` ${marker} |`);
  }
  return line;
}

/**
 * Issue #438 — sanitise a user-controlled title before writing it into a
 * markdown table or bullet line. Pipes break the table column layout and
 * newlines truncate the row entirely; both come straight from the GitHub
 * `issues.edited` payload so the webhook handler MUST scrub them.
 */
function sanitiseTitleForTasksMd(raw: string): string {
  return (
    raw
      .replace(/\r\n|\r|\n/g, " ") // collapse newlines to a single space
      // Issue #17.2 — strip HTML comments outright. A title containing
      // `<!-- closed via #N -->` (or any `<!-- ... -->`) would otherwise be
      // mistaken for the status markers this module writes into table rows, or
      // smuggle a comment into the rendered tasks.md. Handle unterminated
      // comments too (`<!--` with no closing `-->`).
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<!--[\s\S]*$/g, "")
      // Issue #17.2 — neutralise any remaining angle brackets so a malicious
      // title (e.g. `<script>`, `<img onerror=...>`) cannot inject inline HTML
      // when the markdown is rendered. Encode to HTML entities so the original
      // text is still legible as literal characters.
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\|/g, "\\|") // escape pipes so they don't break table cells
      .replace(/\s+/g, " ") // collapse runs of whitespace from the prior step
      .trim()
  );
}

/** Escape regex metacharacters so an id can be embedded as a literal. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renameTaskInLine(line: string, taskId: string, newTitle: string): string {
  const cleanTitle = sanitiseTitleForTasksMd(newTitle);
  if (cleanTitle.length === 0) return line;
  // taskId originates from a stored SpecKitTaskExport row, but escape it
  // defensively so it is always treated as a literal token (no ReDoS / no
  // regex injection) when interpolated into the matchers below.
  const safeTaskId = escapeRegExp(taskId);
  // Table form first: lines that begin with `|` are pipe-delimited rows;
  // mutating them via the bullet regex would smash other cells.
  if (line.trim().startsWith("|")) {
    const cells = line.split("|");
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- taskId is regex-escaped (escapeRegExp) so the pattern is a literal anchored token; no ReDoS/injection.
    if (cells.length >= 4 && cells[1] && new RegExp(`\\b${safeTaskId}\\b`, "i").test(cells[1])) {
      cells[2] = ` ${cleanTitle} `;
      return cells.join("|");
    }
    return line;
  }
  // Bullet form: replace the title segment between the task id and the next
  // metadata marker `(` `[` `files:` `depends-on:`. Issue #438 — the
  // replacement is passed via the FUNCTION form of `String.replace` so a
  // `$1` / `$&` / `$$` sequence inside `cleanTitle` is treated as literal
  // text instead of a backreference.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- taskId is regex-escaped (escapeRegExp); surrounding pattern is a static literal, so no ReDoS/injection.
  const bulletRe = new RegExp(
    `(\\b${safeTaskId}\\b\\s*[\u2014-]?\\s*)([^()\\[]+?)(?=\\s*[\\(\\[]|\\s+files:|\\s+depends-on:|$)`,
    "i",
  );
  if (bulletRe.test(line)) {
    return line.replace(bulletRe, (_match, prefix: string) => `${prefix}${cleanTitle} `);
  }
  return line;
}

export async function syncIssueEvent(
  input: IssueSyncInput,
  deps: {
    findExport?: typeof defaultFindExport;
    findFeature?: typeof defaultFindFeature;
  } = {},
): Promise<IssueSyncOutcome> {
  const findExport = deps.findExport ?? defaultFindExport;
  const findFeature = deps.findFeature ?? defaultFindFeature;
  const exp = await findExport({
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    issueNumber: input.issueNumber,
  });
  if (!exp) {
    return { handled: false, reason: "NO_TASK_EXPORT" };
  }
  const feature = await findFeature({
    projectId: exp.projectId,
    slug: exp.featureSlug,
  });
  if (!feature) {
    return { handled: false, reason: "FEATURE_MISSING" };
  }
  const tasksMd = await getFeatureArtifact(feature.id, "tasks.md");
  if (!tasksMd) {
    return { handled: false, reason: "TASKS_MD_MISSING" };
  }
  const result = applyIssueEventToTasksMarkdown(
    tasksMd.content,
    exp.taskId,
    input.action,
    input.newTitle,
    input.issueNumber,
  );
  if (result.change === "noop") {
    return {
      handled: true,
      featureSlug: exp.featureSlug,
      taskId: exp.taskId,
      change: "noop",
      tasksMdVersion: tasksMd.version,
    };
  }
  const written = await writeFeatureArtifact({
    featureId: feature.id,
    key: "tasks.md",
    content: result.content,
    actorId: null,
  });
  audit({
    actor: { id: null },
    action: "speckit.tasks_md.synced_from_issue",
    target: { type: "spec_kit_feature", id: feature.id },
    metadata: {
      projectId: exp.projectId,
      featureSlug: exp.featureSlug,
      taskId: exp.taskId,
      issueNumber: input.issueNumber,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      githubAction: input.action,
      change: result.change,
      newVersion: written.version,
    },
  });
  return {
    handled: true,
    featureSlug: exp.featureSlug,
    taskId: exp.taskId,
    change: result.change,
    tasksMdVersion: written.version,
  };
}

interface FindExportInput {
  repoOwner: string;
  repoName: string;
  issueNumber: number;
}

interface ExportRow {
  projectId: string;
  featureSlug: string;
  taskId: string;
}

async function defaultFindExport(input: FindExportInput): Promise<ExportRow | null> {
  const row = await prisma.specKitTaskExport.findFirst({
    where: {
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      issueNumber: input.issueNumber,
    },
    select: { projectId: true, featureSlug: true, taskId: true },
  });
  return row;
}

interface FindFeatureInput {
  projectId: string;
  slug: string;
}

async function defaultFindFeature(input: FindFeatureInput): Promise<{ id: string } | null> {
  const row = await prisma.specKitFeature.findUnique({
    where: { projectId_slug: { projectId: input.projectId, slug: input.slug } },
    select: { id: true },
  });
  return row;
}
