/**
 * Epic #396 (MVP-4) — `tasks.md` row parser for `/speckit.taskstoissues`.
 *
 * Upstream Spec Kit `tasks.md` format (research §"Command-by-Command
 * Artifact Spec"): one row per atomic task. We accept the union of the
 * formats observed in upstream + METIS v1.2:
 *
 *   - Markdown table:
 *       | # | Title | Story Points | Dependencies | Notes |
 *       | --- | --- | --- | --- | --- |
 *       | T01 | Build login form | 3 | none | |
 *       | T02 | Wire auth API [P] | 5 | T01 | files: src/api/auth.ts |
 *
 *   - Bullet list (upstream form):
 *       - [ ] T01 — Build login form (depends-on: none) [P]  files: src/login.tsx
 *
 *   - Bullet list (METIS `/speckit.tasks` form, #993):
 *       - [ ] T03 — Change `Foo` in a.go (a.go:12-30) (satisfies: AC-1) depends-on: T01
 *
 * Returned `Task` rows carry `{id, title, parallelizable, files[],
 * dependsOn[], userStorySlug?, satisfies[], text}`. The handler upserts GitHub
 * issues by `(featureSlug, taskId)`.
 */

export interface ParsedTask {
  id: string;
  title: string;
  parallelizable: boolean;
  files: string[];
  dependsOn: string[];
  userStorySlug: string | null;
  storyPoints: number | null;
  notes: string;
  /** #993 — the spec AC ids the task names in a trailing `(satisfies: …)` group. */
  satisfies: string[];
  /**
   * #993 — the task's full text as written (the line without its checkbox, plus
   * any indented lines beneath it), carried into the issue body.
   */
  text: string;
}

const ID_RE = /\bT\d{1,4}\b/i;
const PARALLEL_RE = /\[P\]/;
const FILE_RE = /(?:files?:\s*)([^|]+?)(?=$|\(|\[|\bdepends-on:|\bowner:)/i;
const DEPENDS_RE = /depends?-on:\s*([^)|]+)/i;
const STORY_PTS_RE = /^\s*(\d+)\s*$/;
const STORY_HEADER_RE = /^##+\s+(?:Story\s+)?(US\d+|user\s+story\s+\S+)\b/i;
const TASK_BULLET_RE = /^\s*-\s*(\[[ xX]\])?\s*T\d/;

export function parseTasksMarkdown(markdown: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const lines = markdown.split(/\r?\n/);
  let currentStory: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const storyMatch = STORY_HEADER_RE.exec(line);
    if (storyMatch) {
      currentStory = storyMatch[1]!.toLowerCase().replace(/\s+/g, "-");
      continue;
    }
    // Skip table separator rows like `| --- | --- |`.
    if (/^\s*\|[\s|:-]+\|\s*$/.test(line)) continue;
    if (line.trim().startsWith("|") && line.includes("|")) {
      const row = parseTableRow(line, currentStory);
      if (row) tasks.push(row);
      continue;
    }
    if (TASK_BULLET_RE.test(line)) {
      // #993 — indented lines beneath a task (its description, files,
      // acceptance) belong to it; blank lines between them do not end it.
      const extra: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (next.trim() === "") continue;
        if (!/^\s+\S/.test(next) || TASK_BULLET_RE.test(next)) break;
        extra.push(next.trim());
        i = j;
      }
      const row = parseBulletRow(line, currentStory, extra);
      if (row) tasks.push(row);
    }
  }
  return tasks;
}

function parseTableRow(line: string, story: string | null): ParsedTask | null {
  const cells = line
    .split("|")
    .map((c) => c.trim())
    .filter(
      (_, i, arr) =>
        !(i === 0 && arr[0] === "") && !(i === arr.length - 1 && arr[arr.length - 1] === ""),
    );
  if (cells.length < 2) return null;
  const idCell = cells[0]!;
  if (!ID_RE.test(idCell)) return null;
  const id = ID_RE.exec(idCell)![0]!.toUpperCase();
  const titleRaw = cells[1] ?? "";
  const title = titleRaw.replace(PARALLEL_RE, "").trim();
  const parallelizable = PARALLEL_RE.test(titleRaw) || PARALLEL_RE.test(line);
  let storyPoints: number | null = null;
  let depCell = "";
  let notesCell = "";
  if (cells.length >= 3) {
    const sp = STORY_PTS_RE.exec(cells[2] ?? "");
    if (sp) storyPoints = Number.parseInt(sp[1]!, 10);
  }
  if (cells.length >= 4) depCell = cells[3] ?? "";
  if (cells.length >= 5) notesCell = cells[4] ?? "";
  const dependsOn = parseDeps(depCell);
  const files = parseFiles(notesCell);
  return {
    id,
    title,
    parallelizable,
    files,
    dependsOn,
    userStorySlug: story,
    storyPoints,
    notes: notesCell.trim(),
    satisfies: [],
    // The table's Notes cell is already rendered as its own section.
    text: title,
  };
}

function parseBulletRow(line: string, story: string | null, extra: string[]): ParsedTask | null {
  const idMatch = ID_RE.exec(line);
  if (!idMatch) return null;
  const id = idMatch[0]!.toUpperCase();
  const afterId = line.slice(line.indexOf(idMatch[0]) + idMatch[0].length);
  // Upstream spec-kit form: `T001 [P] [US1] Description` — leading markers.
  const lead = /^\s*((?:\[(?:P|US\d+)\]\s*)+)/i.exec(afterId);
  const { title, tail } = splitTaskTitle(lead ? afterId.slice(lead[0].length) : afterId);
  const fullLine = line.replace(/^\s*-\s*(\[[ xX]\])?\s*/, "").trim();
  return {
    id,
    title,
    parallelizable: PARALLEL_RE.test(tail) || (lead !== null && PARALLEL_RE.test(lead[1]!)),
    files: parseFiles(tail),
    dependsOn: parseDeps(tail),
    userStorySlug: story,
    storyPoints: null,
    notes: "",
    satisfies: parseSatisfies(tail),
    text: [fullLine, ...extra].join("\n"),
  };
}

/**
 * #993 — the metadata a task line may end with, in any order: `[P]`, a
 * `(depends-on: …)` group or a bare `depends-on: …`, `(satisfies: …)`, and
 * `files: …`. Only these, and only at the end of the line, are metadata: the
 * title keeps every other parenthesis (METIS's `/speckit.tasks` puts file:line
 * spans in them), where it used to be cut at the first `(`.
 */
const TRAILING_META_RES = [
  /\s*\[P\]\s*$/i,
  /\s*\(\s*depends?-on:[^()]*\)\s*$/i,
  /\s*\bdepends?-on:[^()[\]]*$/i,
  /\s*\(\s*satisfies:[^()]*\)\s*$/i,
  /\s*\bfiles:[^()[\]]*$/i,
];

/** Split the text after a task id into its title and its trailing metadata. */
export function splitTaskTitle(afterId: string): { title: string; tail: string } {
  let rest = afterId.replace(/^\s*[—-]\s*/, "").trimEnd();
  let tail = "";
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of TRAILING_META_RES) {
      const m = re.exec(rest);
      // A match at 0 is a line with no title at all: keep it as the title.
      if (m && m.index > 0) {
        tail = `${m[0].trim()} ${tail}`.trim();
        rest = rest.slice(0, m.index).trimEnd();
        changed = true;
      }
    }
  }
  return { title: rest.trim(), tail: tail.trim() };
}

function parseSatisfies(input: string): string[] {
  const m = /\(\s*satisfies:([^()]*)\)/i.exec(input);
  if (!m) return [];
  return m[1]!
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseDeps(input: string): string[] {
  const m = DEPENDS_RE.exec(input);
  let raw: string;
  if (m) {
    raw = m[1]!.trim();
  } else if (/^[\sT0-9,]+$/i.test(input.trim()) && /T\d/i.test(input)) {
    // Raw column form (table cell): "T01" or "T01, T02, T03".
    raw = input.trim();
  } else {
    return [];
  }
  if (raw.toLowerCase() === "none" || raw.length === 0) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^T\d+$/i.test(s));
}

function parseFiles(input: string): string[] {
  const m = FILE_RE.exec(input);
  if (!m) return [];
  return m[1]!
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /[./]/.test(s));
}
